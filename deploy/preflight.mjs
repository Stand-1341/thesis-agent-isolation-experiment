#!/usr/bin/env node
/**
 * Subscription compatibility preflight — a deployment GATE, not an inventory.
 *
 * Runs before any resource is provisioned (azd preprovision hook). Reuses the
 * read-only inventory logic style from the experiment scripts but every check
 * is a pass/fail with a specific fix, because the objective is: fail fast, on
 * the caller's terms, before Azure starts charging — and never silently deploy
 * a weaker experimental configuration.
 *
 * Checks:
 *   auth            — az CLI has a signed-in identity and a selected subscription
 *   rbac            — caller can create role assignments (Microsoft.Authorization/roleAssignments/write)
 *   providers       — Microsoft.App, Microsoft.Compute, .Network, .Storage, .ManagedIdentity, .Monitor registered
 *   region          — subscription has access to the selected region
 *   quota           — regional usage/quota headroom for the VM SKU family and App.Jobs
 *   sku             — VM SKU restriction policies do not block the chosen SKU
 *   address-space   — planned VNet range does not collide with existing VNets in the resource group scope
 *   what-if         — ARM what-if preview runs and reports no destructive changes
 *   budget (opt)    — an Azure budget exists unless AZD_PREFLIGHT_SKIP_BUDGET=1
 *
 * Exit codes: 0 = pass, 3 = check failed (report printed), 5 = invocation error.
 */
import {readAzdEnv, makeAzRunner, withRetry, formatFailures} from './common.mjs';
import {pathToFileURL} from 'node:url';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deriveP3RegionLocation} from './resolve-inputs.mjs';

export const REQUIRED_PROVIDERS = ['Microsoft.App', 'Microsoft.Compute', 'Microsoft.Network', 'Microsoft.Storage', 'Microsoft.ManagedIdentity', 'Microsoft.ContainerRegistry', 'Microsoft.Monitor', 'Microsoft.KeyVault', 'Microsoft.OperationalInsights', 'Microsoft.Insights', 'Microsoft.Web'];
export const REQUIRED_PERMISSIONS = [
  {action: 'Microsoft.Resources/deployments/write', why: 'provision the experiment template'},
  {action: 'Microsoft.Authorization/roleAssignments/write', why: 'grant scoped RBAC to the workload identities'},
  {action: 'Microsoft.ManagedIdentity/userAssignedIdentities/write', why: 'create per-workload managed identities'}
];
export const PLANNED_VNET_PREFIX = '10.48.0.0/16';
// Regional P3 resources are declared by infra/main. Some ARM What-If responses
// short-circuit top-level nested modules; the post-foundation gate separately
// previews those exact child templates before treating a parent skip as covered.
export const MULTI_REGION_TOPOLOGY_INTEGRATED = true;

export function requestedJobsRegions(value) {
  if (!value) return undefined;
  let map=value;
  if (typeof value==='string') { try { map=JSON.parse(value); } catch { return undefined; } }
  const jobs=map?.azure_container_apps_jobs ?? map?.aca_jobs;
  if (!jobs || typeof jobs!=='object' || Array.isArray(jobs)) return undefined;
  const regions=['P1','P2','P3'].map(profile=>jobs[profile] ?? jobs[profile.toLowerCase()]);
  if (regions.some(region=>typeof region!=='string'||!region.trim())) return undefined;
  return [...new Set(regions.map(region=>region.trim().toLowerCase()))];
}

export function requestedSandboxRegions(value) {
  if (!value) return undefined;
  let map=value;
  if (typeof value==='string') { try { map=JSON.parse(value); } catch { return undefined; } }
  const sandboxes=map?.azure_container_apps_sandboxes ?? map?.aca_sandboxes;
  if (!sandboxes || typeof sandboxes!=='object' || Array.isArray(sandboxes)) return undefined;
  const regions=['P1','P2','P3'].map(profile=>sandboxes[profile] ?? sandboxes[profile.toLowerCase()]);
  if (regions.some(region=>typeof region!=='string'||!region.trim())) return undefined;
  return [...new Set(regions.map(region=>region.trim().toLowerCase()))];
}

function parsePrefixes(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch {}
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export function evaluateWhatIf(result, {allowIgnoreResourceIds = [], allowIgnoreChange = () => false, allowUnsupportedChange = () => false} = {}) {
  if (!result || result.error) return {ok: false, problem: result?.error ?? 'ARM what-if did not run'};
  if(Array.isArray(result.errors)&&result.errors.length) return {ok:false,problem:`ARM what-if returned ${result.errors.length} error diagnostic(s)`};
  const diagnostics=[...(result.diagnostics??[]),...(result.warnings??[]),...(result.errors??[])];
  const skipPattern=/NestedDeploymentShortCircuited|NestedDeploymentSkippedFromInternalExpansion|nested deployment.{0,80}(short.?circuited|skipped)|short.?circuited.{0,80}nested/i;
  const skippedNested=diagnostics.filter(item=>skipPattern.test(typeof item==='string'?item:JSON.stringify(item)));
  if(skippedNested.length) {
    const targets=skippedNested.map(item=>typeof item==='string'?undefined:item.target).filter(Boolean);
    return {ok:false,problem:`ARM what-if did not validate ${skippedNested.length} nested deployment(s)${targets.length?`: ${targets.join(', ')}`:''}`};
  }
  if(skipPattern.test(JSON.stringify(result)))
    return {ok:false,problem:'ARM what-if contains a nested deployment that was skipped during internal expansion'};
  const changes = result.changes ?? result.value;
  if (!Array.isArray(changes)) return {ok: false, problem: 'ARM what-if response did not include a changes array'};
  const skippedChange=changes.find(change=>/NestedDeploymentShortCircuited|NestedDeploymentSkippedFromInternalExpansion/i.test(`${change.changeType??''} ${change.reason??''} ${change.statusMessage??''} ${JSON.stringify(change)}`));
  if(skippedChange) return {ok:false,problem:`ARM what-if contains a nested deployment skipped during internal expansion: ${skippedChange.resourceId??skippedChange.resourceName??'resource'}`};
  const allowedIgnores=new Set(allowIgnoreResourceIds.map(id=>String(id).toLowerCase()));
  const ignored = changes.filter(change => change.changeType === 'Ignore' && !allowedIgnores.has(String(change.resourceId??'').toLowerCase()) && !allowIgnoreChange(change));
  if (ignored.length) return {ok:false,problem:`ARM what-if did not validate ${ignored.length} resource(s) (changeType Ignore): ${ignored.map(c=>c.resourceId??c.resourceName??'resource').join(', ')}`};
  const deletes = changes.filter(change => change.changeType === 'Delete');
  if (deletes.length) return {ok:false,problem:`ARM what-if contains destructive changes: ${deletes.map(c=>`${c.changeType} ${c.resourceId??c.resourceName??'resource'}`).join(', ')}`};
  const indeterminate = changes.filter(change => change.changeType === 'Deploy');
  if (indeterminate.length) return {ok:false,problem:`ARM what-if could not determine whether ${indeterminate.length} resource(s) change (changeType Deploy): ${indeterminate.map(c=>c.resourceId??c.resourceName??'resource').join(', ')}`};
  const unsupported=changes.filter(change=>change.changeType==='Unsupported'&&!allowUnsupportedChange(change));
  if(unsupported.length) return {ok:false,problem:`ARM what-if does not support ${unsupported.length} resource(s): ${unsupported.map(c=>c.resourceId??c.resourceName??'resource').join(', ')}`};
  const unknown=changes.filter(change=>!['Create','Delete','Modify','NoChange','NoEffect','Ignore','Deploy','Unsupported'].includes(change?.changeType));
  if(unknown.length) return {ok:false,problem:`ARM what-if returned ${unknown.length} unknown change type(s)`};
  return {ok: true, changeCount: changes.length};
}

function knownExistingVaultIgnoreIds(env={},resourceGroup) {
  const vaultName=env.WORKLOAD_TOKEN_VAULT_NAME||env.EXISTING_BOOTSTRAP_VAULT_NAME;
  const subscriptionId=env.AZURE_SUBSCRIPTION_ID;
  const ids=[];
  if(vaultName&&subscriptionId&&resourceGroup) ids.push(`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.KeyVault/vaults/${vaultName}`);
  if(typeof env.USE_EXISTING_VNET_ID==='string'&&env.USE_EXISTING_VNET_ID.trim()) ids.push(env.USE_EXISTING_VNET_ID.trim());
  return ids;
}

function knownSupersededJobsIgnoreIds(env={},resourceGroup) {
  if(env.SERVERLESS_RUNTIME!=='functions_flex') return [];
  const subscriptionId=env.AZURE_SUBSCRIPTION_ID,prefix=env.AZURE_NAME_PREFIX;
  if(!subscriptionId||!resourceGroup||!prefix) return [];
  // v3 deliberately leaves the superseded v2 Jobs composition untouched rather
  // than deleting billable workload resources during a topology transition.
  const base=`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers`;
  return [
    ...['p1','p2','p3'].map(profile=>`${base}/Microsoft.App/jobs/${prefix}-job-${profile}`),
    `${base}/Microsoft.App/managedEnvironments/${prefix}-jobs-env`,
    `${base}/Microsoft.App/managedEnvironments/${prefix}-jobs-p3-env`,
    `${base}/Microsoft.Network/networkSecurityGroups/${prefix}-jobs-p3-nsg`
  ];
}

function knownPostFoundationIgnoreIds(env={},resourceGroup) {
  return [...knownExistingVaultIgnoreIds(env,resourceGroup),...knownSupersededJobsIgnoreIds(env,resourceGroup)];
}

function knownFoundationIgnoreIds(env={},resourceGroup) {
  const ids=[...knownPostFoundationIgnoreIds(env,resourceGroup)];
  const subscriptionId=env.AZURE_SUBSCRIPTION_ID,prefix=env.AZURE_NAME_PREFIX;
  if(!subscriptionId||!resourceGroup||!prefix) return ids;
  const base=`/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers`;
  return [...ids,
    `${base}/Microsoft.Network/privateDnsZones/privatelink.azurecr.io`,
    `${base}/Microsoft.Network/privateDnsZones/privatelink.azurecr.io/virtualNetworkLinks/${prefix}-registry-pe-vnet`,
    `${base}/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net`,
    `${base}/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net/virtualNetworkLinks/${prefix}-blob-vnet`,
    `${base}/Microsoft.Network/routeTables/${prefix}-pe-return-routes`,
    `${base}/Microsoft.Network/routeTables/${prefix}-svc-return-routes`
  ];
}

function isKnownStorageExtensionRoleAssignment(change,env={},resourceGroup) {
  if(change?.changeType!=='Unsupported') return false;
  const subscriptionId=env.AZURE_SUBSCRIPTION_ID;
  if(!subscriptionId||!resourceGroup) return false;
  const resourceId=String(change.resourceId??'').toLowerCase();
  const prefix=`[extensionresourceid('/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}/providers/microsoft.storage/storageaccounts/`.toLowerCase();
  return resourceId.startsWith(prefix)&&resourceId.includes('/blobservices/default/containers/')&&
    resourceId.includes("'microsoft.authorization/roleassignments'");
}

function isKnownPlatformManagedIgnore(change,env={},resourceGroup) {
  if(change?.changeType!=='Ignore') return false;
  const subscriptionId=env.AZURE_SUBSCRIPTION_ID,prefix=env.AZURE_NAME_PREFIX;
  if(!subscriptionId||!resourceGroup||!prefix) return false;
  const resourceId=String(change.resourceId??'');
  const base=`/subscriptions/${subscriptionId}/resourcegroups/${resourceGroup}`.toLowerCase();
  const id=resourceId.toLowerCase();
  if(!id.startsWith(`${base}/providers/`)) return false;
  const escaped=prefix.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`^${base}/providers/microsoft\\.compute/disks/${escaped}-[^/]*_osdisk_[^/]+$`).test(id) ||
    new RegExp(`^${base}/providers/microsoft\\.network/networkinterfaces/${escaped}-[^/]*\\.nic\\.[0-9a-f-]+$`).test(id);
}

function postFoundationWhatIfOptions(env,resourceGroup) {
  return {allowIgnoreResourceIds:knownPostFoundationIgnoreIds(env,resourceGroup),
    allowIgnoreChange:change=>isKnownPlatformManagedIgnore(change,env,resourceGroup),
    allowUnsupportedChange:change=>isKnownStorageExtensionRoleAssignment(change,env,resourceGroup)};
}

function foundationWhatIfOptions(env,resourceGroup) {
  return {allowIgnoreResourceIds:knownFoundationIgnoreIds(env,resourceGroup),
    allowIgnoreChange:change=>isKnownPlatformManagedIgnore(change,env,resourceGroup)};
}

function cidrInt(value) {
  const [a, b, c, d] = value.split('.').map(Number);
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

export function cidrsOverlap(a, b) {
  const parse = cidr => {
    const [addr, bits] = cidr.split('/');
    const prefix = Number(bits);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (cidrInt(addr) & mask) >>> 0;
    return {start: network, end: network + 2 ** (32 - prefix) - 1};
  };
  const left = parse(a), right = parse(b);
  return left.start <= right.end && right.start <= left.end;
}

/** Pure check-evaluation over collected facts — unit-testable without Azure. */
export function evaluatePreflight({subscription, rolePermissions = [], providers = {}, regionAvailable, quota = {}, skuRestricted = [], existingVnetPrefixes = [], managedResourceGroup, vnetInventoryVerified, budgetPresent, skipBudget, vmSku = 'Standard_F1as_v7', plannedVnetPrefix = PLANNED_VNET_PREFIX} = {}) {
  const failures = [];
  const add = (check, problem, fix) => failures.push({check, problem, fix});

  if (!subscription) add('auth', 'no subscription selected', 'run `azd login` and `azd env set AZURE_SUBSCRIPTION_ID <id>`');
  if (subscription && subscription.state && subscription.state !== 'Enabled')
    add('auth', `subscription state is ${subscription.state}`, 'use an enabled subscription (account center)');

  const granted = new Set(rolePermissions.flatMap(p => p.actions ?? p.dataActions ?? []));
  const wildcard = rolePermissions.some(p => (p.actions ?? []).includes('*'));
  for (const {action, why} of REQUIRED_PERMISSIONS) {
    if (!wildcard && !granted.has(action)) {
      add('rbac', `missing ${action} — needed to ${why}`, `ask the subscription Owner to grant a role including this action (e.g. Contributor + User Access Administrator), or use a subscription you own`);
    }
  }

  for (const provider of REQUIRED_PROVIDERS) {
    const state = providers[provider];
    if (state === 'NotRegistered') add('providers', `${provider} is not registered`, `az provider register --namespace ${provider} (wait for state Registered)`);
    else if (state !== 'Registered') add('providers', `${provider} registration state is ${state ?? 'unknown'}`, `az provider show --namespace ${provider} --query registrationState`);
  }

  if (regionAvailable === false) add('region', 'selected region is not available to this subscription', 'az account list-locations -o table, then azd env set AZURE_LOCATION <region>');
  if (regionAvailable === undefined) add('region', 'region availability could not be determined', 'az account list-locations --query "[?name==\'' + 'REGION' + '\'].name"');

  if (quota.vmFamilyLimit !== undefined && quota.vmFamilyUsed !== undefined) {
    const headroom = quota.vmFamilyLimit - quota.vmFamilyUsed;
    if (headroom < (quota.vmNeeded ?? 0)) add('quota', `regional ${quota.vmFamily ?? 'VM'} quota headroom is ${headroom} vCPUs, deployment needs ${quota.vmNeeded}`, 'request quota (az support) or pick another region');
  }
  if (quota.regionalCoreLimit !== undefined && quota.regionalCoreUsed !== undefined) {
    const headroom = quota.regionalCoreLimit - quota.regionalCoreUsed;
    if (headroom < (quota.vmNeeded ?? 0)) add('quota', `regional total core quota headroom is ${headroom} vCPUs, deployment needs ${quota.vmNeeded}`, 'request regional core quota (az support) or pick another region');
  }
  if (quota.appJobsCoresLimited === true) add('quota', 'Microsoft.App regional core/usage limit reached', 'request quota increase for Microsoft.App in this region or choose another region');
  if (quota.appManagedEnvironmentLimit !== undefined && quota.appManagedEnvironmentUsed !== undefined) {
    const headroom = quota.appManagedEnvironmentLimit - quota.appManagedEnvironmentUsed;
    if (headroom < (quota.appManagedEnvironmentsNeeded ?? 2)) add('quota', `Microsoft.App managed environment headroom is ${headroom}; deployment needs ${quota.appManagedEnvironmentsNeeded ?? 2}`, 'request additional Microsoft.App managed environment quota or choose another region');
  }
  if (quota.appManagedEnvironmentByRegion) {
    for (const [region, usage] of Object.entries(quota.appManagedEnvironmentByRegion)) {
      if (usage.limit === undefined || usage.used === undefined) {
        add('quota', `Microsoft.App managed-environment quota could not be verified in ${region}`, `query Microsoft.App usage in ${region} and confirm one environment of headroom`);
        continue;
      }
      const headroom=usage.limit-usage.used;
      if (headroom < (usage.needed??1)) add('quota', `Microsoft.App managed environment headroom is ${headroom} in ${region}; deployment needs ${usage.needed??1}`, `request additional Microsoft.App managed environment quota in ${region} or choose another region`);
    }
  }
  for(const [region,usage] of Object.entries(quota.vmQuotaByRegion??{})) {
    if(usage.regionAvailable!==true) add('region',`P3 VM region availability could not be confirmed for ${region}`,'verify subscription access to the requested P3 region');
    if(usage.skuAvailable!==true) add('sku',`VM SKU ${vmSku} could not be confirmed in P3 region ${region}`,'query the exact SKU and architecture in the P3 region');
    if(usage.familyLimit===undefined||usage.familyUsed===undefined||usage.regionalCoreLimit===undefined||usage.regionalCoreUsed===undefined||usage.needed===undefined) {
      add('quota',`P3 VM family or regional core quota could not be verified in ${region}`,'query VM family and regional vCPU usage in the P3 region');
    } else if(usage.familyLimit-usage.familyUsed<usage.needed||usage.regionalCoreLimit-usage.regionalCoreUsed<usage.needed) {
      add('quota',`P3 VM quota headroom is insufficient in ${region}; deployment needs ${usage.needed} vCPUs`,'request additional family and regional vCPU quota in the P3 region');
    }
  }

  if (skuRestricted.includes(vmSku)) add('sku', `VM SKU ${vmSku} is restricted by policy for this subscription`, 'az policy assignment list / pick an allowed x64 SKU or request a policy exception');

  for (const existing of existingVnetPrefixes) {
    if (managedResourceGroup && existing.resourceGroup?.toLowerCase() === managedResourceGroup.toLowerCase()) continue;
    const prefix=typeof existing==='string'?existing:existing.prefix;
    if (cidrsOverlap(prefix, plannedVnetPrefix)) {
      add('address-space', `planned ${plannedVnetPrefix} overlaps existing VNet range ${prefix}`, 'set a different vnetAddressPrefix in config/deployment.json, or peer/reuse the existing VNet');
    }
  }
  if(vnetInventoryVerified!==true) add('address-space','existing VNet inventory could not be verified','restore read access to the subscription VNet inventory and rerun preflight');

  if (!skipBudget && budgetPresent !== true) add('budget', budgetPresent === false ? 'no cost budget configured on the subscription' : 'subscription budget could not be verified', 'verify Azure Cost Management access and configure a budget before provisioning');

  return {failures, ok: failures.length === 0};
}

/** Collect the facts from live Azure via the az CLI. Every read is best-effort;
 * a read failure becomes a check failure with a fix, not a silent skip. */
export async function collectPreflightFacts({az, env, vmSku = 'Standard_F1as_v7', resourceGroup, whatIfArgs = [], whatIfRunner} = {}) {
  const subscriptionId = env.AZURE_SUBSCRIPTION_ID;
  const region = env.AZURE_LOCATION ?? 'centralus';
  const facts = {skipBudget: env.AZD_PREFLIGHT_SKIP_BUDGET === '1', vmSku};
  facts.plannedVnetPrefix=env.VNET_ADDRESS_PREFIX??PLANNED_VNET_PREFIX;

  facts.subscription = subscriptionId
    ? await az(['account', 'show', '--subscription', subscriptionId]).catch(error => {
        facts.failures ??= [];
        facts.failures.push({check: 'auth', problem: `cannot read subscription ${subscriptionId}: ${String(error.stderr ?? error.message).slice(0, 200)}`, fix: 'az login && azd env set AZURE_SUBSCRIPTION_ID <id>'});
        return undefined;
      })
    : undefined;

  if (!facts.subscription) return facts;

  facts.rolePermissions = await readCallerPermissions(az, subscriptionId, env, failures => {
    facts.failures ??= [];
    facts.failures.push(...failures);
  });

  facts.providers = {};
  for (const provider of REQUIRED_PROVIDERS) {
    facts.providers[provider] = (await az(['provider', 'show', '--namespace', provider, '--subscription', subscriptionId, '--query', 'registrationState'], {json: true}).catch(() => 'unknown')) || 'unknown';
  }

  // account list-locations has no --subscription option; query ARM at the
  // selected subscription scope instead of silently using the CLI default.
  const locations = await az(['rest', '--method', 'get', '--url', `https://management.azure.com/subscriptions/${subscriptionId}/locations?api-version=2022-12-01`]).catch(() => undefined);
  facts.regionAvailable = Array.isArray(locations?.value) ? locations.value.some(location => location.name?.toLowerCase() === region.toLowerCase()) : undefined;

  const skuRows = await az(['vm', 'list-skus', '--location', region, '--size', vmSku, '--all', '--subscription', subscriptionId]).catch(() => undefined);
  const exactSkus = Array.isArray(skuRows) ? skuRows.filter(row => row.name?.toLowerCase() === vmSku.toLowerCase()) : [];
  const sku = exactSkus.length === 1 ? exactSkus[0] : undefined;
  facts.skuAvailable = Boolean(sku && (!sku.locations?.length || sku.locations.some(location => location.toLowerCase() === region.toLowerCase())));
  facts.skuRestricted = sku?.restrictions?.length ? [vmSku] : [];
  facts.skuRestrictionsVerified = Boolean(sku && Array.isArray(sku.restrictions));
  facts.vmSkuVcpus = Number(sku?.capabilities?.find(cap => cap.name?.toLowerCase() === 'vcpus')?.value);
  facts.vmSkuArchitecture = sku?.capabilities?.find(cap => cap.name?.toLowerCase() === 'cpuarchitecturetype')?.value;
  const family = sku?.family;
  const usage = await az(['vm', 'list-usage', '--location', region, '--subscription', subscriptionId]).catch(() => undefined);
  const familyKey = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const familyRows = Array.isArray(usage) && family ? usage.filter(row => /family.*vcpu/i.test(row.localName ?? '') && familyKey(row.name?.value) === familyKey(family)) : [];
  const regionalCoreRows = Array.isArray(usage) ? usage.filter(row => familyKey(row.name?.value) === 'cores' && /total.*(regional|vcpus)|total.*cores/i.test(row.localName ?? '')) : [];
  const vmSizes = await az(['vm', 'list', '--show-details', '--subscription', subscriptionId, '--query', "[].{size:hardwareProfile.vmSize,location:location,resourceGroup:resourceGroup}"]).catch(() => undefined);
  const currentStudyVmCount = Array.isArray(vmSizes) && resourceGroup
    ? vmSizes.filter(vm => vm.size?.toLowerCase() === vmSku.toLowerCase() && vm.location?.toLowerCase() === region.toLowerCase() && vm.resourceGroup?.toLowerCase() === resourceGroup.toLowerCase()).length : undefined;
  const targetVmCount = Number(env.VM_COUNT ?? 4);
  const vmNeeded = (Number.isInteger(targetVmCount) && currentStudyVmCount !== undefined)
    ? Math.max(0, targetVmCount - currentStudyVmCount) * facts.vmSkuVcpus : undefined;
  const familyEntry = familyRows.length === 1 ? familyRows[0] : undefined;
  const regionalCoreEntry = regionalCoreRows.length === 1 ? regionalCoreRows[0] : undefined;
  if (Number.isFinite(vmNeeded)) {
    facts.quota = {
      vmNeeded,
      ...(familyEntry ? {vmFamily: familyEntry.localName, vmFamilyLimit: Number(familyEntry.limit), vmFamilyUsed: Number(familyEntry.currentValue)} : {}),
      ...(regionalCoreEntry ? {regionalCoreLimit: Number(regionalCoreEntry.limit), regionalCoreUsed: Number(regionalCoreEntry.currentValue)} : {}),
      appJobsCoresLimited: false
    };
  }
  facts.vmQuotaVerified = Boolean(facts.quota && familyEntry && regionalCoreEntry &&
    Number.isFinite(facts.quota.vmFamilyLimit) && Number.isFinite(facts.quota.vmFamilyUsed) &&
    Number.isFinite(facts.quota.regionalCoreLimit) && Number.isFinite(facts.quota.regionalCoreUsed) &&
    Array.isArray(vmSizes) && facts.vmSkuVcpus > 0);
  facts.currentStudyVmCount = currentStudyVmCount;
  facts.currentRegionalVmCount = Array.isArray(vmSizes) ? vmSizes.filter(vm => vm.location?.toLowerCase() === region.toLowerCase()).length : undefined;
  const multiRegionJobs = requestedJobsRegions(env.AZURE_ROUTE_REGIONS);
  let regionMap=env.AZURE_ROUTE_REGIONS;
  if(typeof regionMap==='string') { try {regionMap=JSON.parse(regionMap);} catch {regionMap=undefined;} }
  const requestedP3Region=(env.P3_REGION_LOCATION??regionMap?.azure_vm?.P3??regionMap?.azure_vm?.p3)?.trim().toLowerCase();
  const jobsMode=env.SERVERLESS_RUNTIME==='aca_jobs';
  const splitByP3Location=jobsMode&&requestedP3Region&&requestedP3Region!==region.toLowerCase();
  const jobsRegions = jobsMode ? (multiRegionJobs?.length > 1 ? multiRegionJobs : splitByP3Location ? [...new Set([region.toLowerCase(),requestedP3Region])] : undefined) : undefined;
  const appRegions = jobsRegions ?? [region];
  const appManagedEnvironmentByRegion = {};
  const jobsMap=regionMap?.azure_container_apps_jobs??regionMap?.aca_jobs;
  const usedRegions=jobsRegions?new Set(['P1','P2','P3'].map(profile=>jobsMap?.[profile]??jobsMap?.[profile.toLowerCase()]).filter(value=>typeof value==='string').map(value=>value.toLowerCase())):new Set(appRegions);
  for (const appRegion of usedRegions) {
    const appUsage = await az(['rest', '--method', 'get', '--url', `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.App/locations/${appRegion}/usages?api-version=2024-03-01`]).catch(() => undefined);
    const rows=appUsage?.value ?? [];
    const envUsage = rows.find(row => row.name?.value === 'ManagedEnvironmentCount');
    appManagedEnvironmentByRegion[appRegion]={limit:envUsage?.limit,used:envUsage?.currentValue,needed:1};
  }
  const baseUsage=appManagedEnvironmentByRegion[region];
  facts.quota = {...(facts.quota ?? {}), appManagedEnvironmentLimit: jobsRegions?undefined:baseUsage?.limit, appManagedEnvironmentUsed: jobsRegions?undefined:baseUsage?.used,
    appManagedEnvironmentsNeeded: jobsRegions ? 1 : Math.max(0,(env.SERVERLESS_RUNTIME === 'aca_jobs' ? 2 : 1)-Number(baseUsage?.used ?? 0)),
    ...(jobsRegions ? {appManagedEnvironmentByRegion}: {})};
  if(jobsRegions) facts.quota.appManagedEnvironmentByRegion=Object.fromEntries(Object.entries(appManagedEnvironmentByRegion).map(([appRegion,usage])=>[appRegion,{...usage,needed:1}]));

  const policies = await az(['policy', 'assignment', 'list', '--subscription', subscriptionId, '--disable-scope-strict-match']).catch(() => undefined);
  facts.policyAssignmentsPresent = Array.isArray(policies) ? policies.length > 0 : undefined;
  facts.policyEffectsOverride=env.AZD_PREFLIGHT_ALLOW_POLICY_ASSIGNMENTS==='1';
  // Azure Policy can deny through inherited definitions, initiatives, aliases, and parameters.
  // Presence means the effective result is ambiguous; never claim it was evaluated
  // unless the operator explicitly accepts that residual risk for this deployment.
  if (!facts.policyEffectsOverride&&(!Array.isArray(policies) || policies.length > 0)) facts.skuRestrictionsVerified = false;

  const vnets = await az(['network', 'vnet', 'list', '--subscription', subscriptionId, '--query', '[].{resourceGroup:resourceGroup,prefixes:addressSpace.addressPrefixes}']).catch(() => undefined);
  facts.existingVnetPrefixes = Array.isArray(vnets) ? vnets.flatMap(vnet=>(vnet.prefixes??[]).map(prefix=>({resourceGroup:vnet.resourceGroup,prefix}))) : [];
  facts.vnetInventoryVerified = Array.isArray(vnets);
  facts.managedResourceGroup = resourceGroup;
  if (jobsRegions && !MULTI_REGION_TOPOLOGY_INTEGRATED) {
    facts.failures ??= [];
    facts.failures.push({check:'region',problem:'split ACA Jobs regions were requested, but the candidate regional P3 module is not integrated into infra/main and no split-region what-if can be produced',fix:'wire the complete multi-region topology into infra/main and run a what-if for every regional resource group before using split region assignments'});
  }
  const sandboxRegions=requestedSandboxRegions(env.AZURE_ROUTE_REGIONS);
  if(splitByP3Location && /^(eastus|eastus2)$/i.test(requestedP3Region)) {
    facts.failures ??= [];
    facts.failures.push({check:'region',problem:'East US is excluded from the requested deployment scope',fix:'select an owner-approved non-East-US region'});
  }
  if(splitByP3Location) {
    const p3Usage=await az(['vm','list-usage','--location',requestedP3Region,'--subscription',subscriptionId]).catch(()=>undefined);
    const p3Skus=await az(['vm','list-skus','--location',requestedP3Region,'--size',vmSku,'--all','--subscription',subscriptionId]).catch(()=>undefined);
    const exact=Array.isArray(p3Skus)?p3Skus.filter(row=>row.name?.toLowerCase()===vmSku.toLowerCase()):[];
    const selected=exact.length===1?exact[0]:undefined;
    const familyKey=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const familyRows=Array.isArray(p3Usage)&&selected?p3Usage.filter(row=>/family.*vcpu/i.test(row.localName??'')&&familyKey(row.name?.value)===familyKey(selected.family)):[];
    const coreRows=Array.isArray(p3Usage)?p3Usage.filter(row=>familyKey(row.name?.value)==='cores'&&/total.*(regional|vcpus)|total.*cores/i.test(row.localName??'')):[];
    const p3Locations=Array.isArray(locations?.value)?locations.value.map(item=>item.name?.toLowerCase()):[];
    const p3VmCount=Array.isArray(vmSizes)?vmSizes.filter(vm=>vm.location?.toLowerCase()===requestedP3Region&&vm.resourceGroup?.toLowerCase()===(resourceGroup??'').toLowerCase()&&vm.size?.toLowerCase()===vmSku.toLowerCase()).length:undefined;
    const vcpus=Number(selected?.capabilities?.find(cap=>cap.name?.toLowerCase()==='vcpus')?.value);
    const family=familyRows.length===1?familyRows[0]:undefined,core=coreRows.length===1?coreRows[0]:undefined;
    facts.quota={...(facts.quota??{}),vmQuotaByRegion:{[requestedP3Region]:{
      regionAvailable:p3Locations.includes(requestedP3Region),
      skuAvailable:Boolean(selected&&(!selected.locations?.length||selected.locations.some(item=>item.toLowerCase()===requestedP3Region))&&Array.isArray(selected.restrictions)&&selected.restrictions.length===0&&selected.capabilities?.find(cap=>cap.name?.toLowerCase()==='cpuarchitecturetype')?.value?.toLowerCase()==='x64'),
      familyLimit:family?Number(family.limit):undefined,familyUsed:family?Number(family.currentValue):undefined,
      regionalCoreLimit:core?Number(core.limit):undefined,regionalCoreUsed:core?Number(core.currentValue):undefined,
      needed:Number.isFinite(vcpus)&&p3VmCount!==undefined?Math.max(0,1-p3VmCount)*vcpus:undefined
    }}};
  }

  const budgets = await az(['consumption', 'budget', 'list', '--subscription', subscriptionId]).catch(() => undefined);
  facts.budgetPresent = Array.isArray(budgets) ? budgets.length > 0 : undefined;

  facts.whatIf = resourceGroup && whatIfRunner
    ? await whatIfRunner({az, resourceGroup, env, args: whatIfArgs}).catch(error => ({error: String(error.stderr ?? error.message).slice(0, 400)}))
    : {error: resourceGroup ? 'ARM what-if runner is not configured' : 'AZURE_RESOURCE_GROUP is required for a resource-group what-if'};
  return facts;
}

/**
 * Resolve the signed-in identity's effective role permissions at subscription
 * scope: principal id → role assignments → role definitions → permission sets.
 */
async function readCallerPermissions(az, subscriptionId, env={}, onFail) {
  try {
    let principalId;
    try { principalId=await az(['ad', 'signed-in-user', 'show', '--query', 'id']); }
    catch {
      if(!env.AZURE_CLIENT_ID) throw new Error('no user or service-principal client ID');
      principalId=await az(['ad','sp','show','--id',env.AZURE_CLIENT_ID,'--query','id']);
    }
    const assignmentRoleIds = await az(['role', 'assignment', 'list', '--assignee', principalId, '--subscription', subscriptionId, '--query', '[].roleDefinitionId']);
    const permissions = [];
    for (const roleId of assignmentRoleIds ?? []) {
      const definition = await az(['role', 'definition', 'show', '--id', roleId]).catch(() => undefined);
      for (const permission of definition?.permissions ?? []) permissions.push(permission);
    }
    return permissions;
  } catch {
    onFail([{check: 'rbac', problem: 'could not read role assignments for the signed-in identity', fix: 'ensure the account can read Microsoft.Authorization/roleAssignments, or run as subscription Owner'}]);
    return [];
  }
}

export async function main({env = process.env, az, stdout = process.stdout, stderr = process.stderr, postFoundationGate = runPostFoundationWhatIfGate} = {}) {
  const values = await readAzdEnv(env);
  const runner = az ?? makeAzRunner();
  const retried = withRetry(runner);
  const fullStage = values.PROVISION_STAGE === 'full';
  const facts = await collectPreflightFacts({az: retried, env: values, vmSku: values.VM_VM_SIZE ?? 'Standard_F1as_v7', resourceGroup: values.AZURE_RESOURCE_GROUP, whatIfRunner: fullStage ? undefined : runTemplateWhatIf});
  const result = evaluatePreflight({...facts, skipBudget: facts.skipBudget, vmSku: facts.vmSku, plannedVnetPrefix:facts.plannedVnetPrefix});

  const preflightFailures = [...(facts.failures ?? []), ...result.failures];
  if (facts.skuRestrictionsVerified !== true) preflightFailures.push({check: 'sku', problem: 'VM SKU policy effects could not be verified from assignment names', fix: 'have the subscription administrator verify that policy does not deny the configured VM SKU'});
  if (facts.vnetInventoryVerified !== true) preflightFailures.push({check:'address-space',problem:'existing VNet inventory could not be verified',fix:'restore subscription VNet inventory access and rerun preflight'});
  if (facts.vmSkuArchitecture?.toLowerCase() !== 'x64') preflightFailures.push({check: 'sku', problem: `VM SKU architecture is ${facts.vmSkuArchitecture ?? 'unknown'} but the configured Ubuntu image is x64`, fix: 'select a compatible x64 VM SKU and rerun preflight'});
  if (facts.skuAvailable !== true) preflightFailures.push({check: 'sku', problem: `VM SKU ${facts.vmSku} could not be confirmed as available in ${values.AZURE_LOCATION ?? 'centralus'}`, fix: 'run az vm list-skus for the exact SKU and region; choose an available x64 SKU'});
  if (facts.vmQuotaVerified !== true) preflightFailures.push({check: 'quota', problem: 'regional VM family quota could not be verified', fix: `query VM usage for ${values.AZURE_LOCATION ?? 'centralus'} and verify enough family vCPU headroom for the configured VM count`});
  const appQuotaMissing=facts.quota?.appManagedEnvironmentByRegion
    ? Object.values(facts.quota.appManagedEnvironmentByRegion).some(usage=>usage.limit===undefined||usage.used===undefined)
    : facts.quota?.appManagedEnvironmentLimit === undefined || facts.quota?.appManagedEnvironmentUsed === undefined;
  if (appQuotaMissing) {
    preflightFailures.push({check: 'quota', problem: 'Microsoft.App managed-environment quota could not be verified', fix: `query Microsoft.App usages in every requested Jobs region and confirm one environment of headroom per region`});
  }
  const allowIgnoreResourceIds=knownFoundationIgnoreIds(values,values.AZURE_RESOURCE_GROUP);
  if(fullStage) {
    if(!values.AZURE_RESOURCE_GROUP) {
      preflightFailures.push({check:'what-if',problem:'AZURE_RESOURCE_GROUP is required for the full-stage preview',fix:'select the azd environment and rerun preflight'});
    } else {
      try {
        const gate=await postFoundationGate({az:retried,resourceGroup:values.AZURE_RESOURCE_GROUP,env:values});
        if(!gate?.ok) preflightFailures.push({check:'what-if',problem:gate?.problem??'full-stage what-if was incomplete',fix:'resolve the reported ARM or child-preview failure and rerun preflight'});
      } catch(error) {
        preflightFailures.push({check:'what-if',problem:String(error?.message??error).slice(0,500),fix:'resolve template/parameter errors and rerun preflight'});
      }
    }
  } else {
    const whatIf = evaluateWhatIf(facts.whatIf,foundationWhatIfOptions(values,values.AZURE_RESOURCE_GROUP));
    if (!whatIf.ok) preflightFailures.push({check: 'what-if', problem: whatIf.problem, fix: 'resolve template/parameter errors and rerun preflight'});
  }

  stdout.write(JSON.stringify({preflight: preflightFailures.length ? 'failed' : 'passed', failures: preflightFailures}, null, 2) + '\n');
  if (preflightFailures.length) {
    stderr.write(formatFailures('Preflight failed — nothing was provisioned and no charges started. Fix and rerun:', preflightFailures) + '\n');
    return 3;
  }
  stdout.write('Preflight passed for all required checks.\n');
  return 0;
}

/** Preview the requested deployment stage. Clean-subscription preflight uses
 * foundation; a full-stage preview must run after foundation has materialized
 * the outputs consumed by the regional modules. */
export async function runTemplateWhatIf({az, resourceGroup, env, stage, args = []} = {}) {
  const names = {
    namePrefix: ['AZURE_NAME_PREFIX', 'thesis'], location: ['AZURE_LOCATION', 'centralus'], serverlessRuntime:['SERVERLESS_RUNTIME','functions_flex'], vnetAddressPrefix:['VNET_ADDRESS_PREFIX','10.48.0.0/16'], useExistingVnetId:['USE_EXISTING_VNET_ID',''], p3RegionLocation: ['P3_REGION_LOCATION', ''], p3NamePrefix:['P3_NAME_PREFIX',''], bootstrapLockStorageAccountName:['BOOTSTRAP_LOCK_STORAGE_ACCOUNT_NAME',''], existingBootstrapVaultName:['EXISTING_BOOTSTRAP_VAULT_NAME',''], researchServicePrivateIp:['RESEARCH_SERVICE_PRIVATE_IP','10.48.9.4'],collectorPrivateIp:['COLLECTOR_PRIVATE_IP','10.48.9.5'],restrictedServicePrivateIp:['RESTRICTED_SERVICE_PRIVATE_IP','10.48.9.6'],sharedPrivateDnsZoneResourceIds: ['SHARED_PRIVATE_DNS_ZONE_RESOURCE_IDS', '[]'], stage: ['PROVISION_STAGE', 'foundation'],
    sshPublicKey: ['SSH_PUBLIC_KEY', ''], vmImageVersion: ['VM_IMAGE_VERSION', ''], vmVmSize:['VM_VM_SIZE','Standard_F1as_v7'], researchHostVmSize:['RESEARCH_HOST_VM_SIZE','Standard_F1as_v7'], trustedControllerPublicIp: ['TRUSTED_CONTROLLER_IP'],
    controllerSourcePrefixesCsv: ['CONTROLLER_SOURCE_PREFIXES'], researchSourcePrefixesCsv: ['RESEARCH_SOURCE_PREFIXES'],
    collectorSourcePrefixesCsv: ['COLLECTOR_SOURCE_PREFIXES'], operatorSourcePrefixesCsv: ['OPERATOR_SOURCE_PREFIXES'], controllerIdentityResourceName:['CONTROLLER_IDENTITY_RESOURCE_NAME',''],
    agentImageDigest: ['AGENT_IMAGE_DIGEST', ''], agentRegistryName: ['AGENT_REGISTRY_NAME', ''], evidenceRetentionDays: ['EVIDENCE_RETENTION_DAYS', '7'], workloadTokenVaultName: ['WORKLOAD_TOKEN_VAULT_NAME', ''], existingBootstrapVaultName:['EXISTING_BOOTSTRAP_VAULT_NAME',''], operatorPrincipalId: ['AZURE_OPERATOR_PRINCIPAL_ID']
  };
  const parameters = {};
  const missing = [];
  for (const [name, [key, fallback]] of Object.entries(names)) {
    let value = name === 'stage' ? (stage ?? env.PROVISION_STAGE ?? 'foundation') : (env[key] ?? fallback);
    if (name.endsWith('SourcePrefixesCsv')) value = parsePrefixes(value).join(',');
    if (value === undefined) missing.push(key);
    else parameters[name] = {value: String(value)};
  }
  if (missing.length) throw new Error(`missing template parameters: ${missing.join(', ')}`);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'azd-whatif-'));
  const parameterFile = path.join(dir, 'parameters.json');
  try {
    await writeFile(parameterFile, JSON.stringify({$schema:'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#', contentVersion:'1.0.0.0', parameters}));
    return await az(['deployment','group','what-if','--subscription',env.AZURE_SUBSCRIPTION_ID,'--resource-group',resourceGroup,'--template-file',path.resolve('infra/main.bicep'),'--parameters',`@${parameterFile}`,'--no-pretty-print',...args]);
  } finally { await rm(dir, {recursive:true, force:true}); }
}

async function runChildTemplateWhatIf({az,resourceGroup,env,templateFile,parameters,args=[],tempPrefix='child-whatif'}={}) {
  if(!az||!resourceGroup||!env?.AZURE_SUBSCRIPTION_ID) throw new Error('child what-if requires az, resourceGroup, and AZURE_SUBSCRIPTION_ID');
  const dir=await mkdtemp(path.join(os.tmpdir(),tempPrefix));
  const parameterFile=path.join(dir,'parameters.json');
  try {
    await writeFile(parameterFile,JSON.stringify({$schema:'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',contentVersion:'1.0.0.0',parameters:Object.fromEntries(Object.entries(parameters).map(([name,value])=>[name,{value}]))}));
    return await az(['deployment','group','what-if','--subscription',env.AZURE_SUBSCRIPTION_ID,'--resource-group',resourceGroup,
      '--template-file',path.resolve(templateFile),'--parameters',`@${parameterFile}`,'--no-pretty-print',...args]);
  } finally { await rm(dir,{recursive:true,force:true}); }
}

export function buildBootstrapWhatIfParameters(env={}) {
  const namePrefix=env.AZURE_NAME_PREFIX??'thesis';
  const location=env.AZURE_LOCATION??'centralus';
  const operatorPrincipalId=env.AZURE_OPERATOR_PRINCIPAL_ID;
  const operatorPublicIp=env.TRUSTED_CONTROLLER_IP;
  if(!operatorPrincipalId||!operatorPublicIp) throw new Error('bootstrap child preview requires AZURE_OPERATOR_PRINCIPAL_ID and TRUSTED_CONTROLLER_IP');
  return {location,namePrefix,operatorPrincipalId,operatorPublicIp,existingVaultName:env.WORKLOAD_TOKEN_VAULT_NAME??'',existingBootstrapVaultName:env.EXISTING_BOOTSTRAP_VAULT_NAME??'',lockStorageAccountName:env.BOOTSTRAP_LOCK_STORAGE_ACCOUNT_NAME??''};
}

export async function runBootstrapWhatIf({az,resourceGroup,env,args=[]}={}) {
  return runChildTemplateWhatIf({az,resourceGroup,env,args,tempPrefix:'bootstrap-whatif-',
    templateFile:'infra/bootstrap-prerequisites.bicep',parameters:buildBootstrapWhatIfParameters(env)});
}

/**
 * Translate the exact `module threeArm.params` contract in infra/main.bicep
 * into a direct child preview. The vault name must be resolved from the
 * foundation bootstrap deployment because it was previously a nested output
 * expression in the root template.
 */
export function buildThreeArmWhatIfParameters(env={},vaultName) {
  const namePrefix=env.AZURE_NAME_PREFIX??'thesis';
  const location=env.AZURE_LOCATION??'centralus';
  const digest=env.AGENT_IMAGE_DIGEST;
  if(!/^sha256:[a-f0-9]{64}$/i.test(digest??'')) throw new Error('full child preview requires a pinned AGENT_IMAGE_DIGEST');
  if(typeof vaultName!=='string'||!vaultName.trim()) throw new Error('three-arm child preview requires the resolved foundation vault name');
  const required={trustedControllerPublicIp:env.TRUSTED_CONTROLLER_IP,sshPublicKey:env.SSH_PUBLIC_KEY,vmImageVersion:env.VM_IMAGE_VERSION,
    operatorSourcePrefixes:parsePrefixes(env.OPERATOR_SOURCE_PREFIXES),controllerSourcePrefixes:parsePrefixes(env.CONTROLLER_SOURCE_PREFIXES),
    researchSourcePrefixes:parsePrefixes(env.RESEARCH_SOURCE_PREFIXES),collectorSourcePrefixes:parsePrefixes(env.COLLECTOR_SOURCE_PREFIXES)};
  const missing=Object.entries(required).filter(([,value])=>value===undefined||value===null||value===''||(Array.isArray(value)&&value.length===0)).map(([key])=>key);
  if(missing.length) throw new Error(`three-arm child preview is missing resolved inputs: ${missing.join(', ')}`);
  const registryServer=env.AGENT_REGISTRY_NAME||`${namePrefix}acr`;
  const agentImage=`${registryServer}.azurecr.io/thesis/agent@${digest}`;
  const p3Region=deriveP3RegionLocation({configured:env.P3_REGION_LOCATION,routeRegions:env.AZURE_ROUTE_REGIONS});
  const functionsMode=env.SERVERLESS_RUNTIME!=='aca_jobs';
  const deployRegionalP3=Boolean(!functionsMode&&p3Region&&p3Region.toLowerCase()!==location.toLowerCase());
  const evidenceRetentionDays=Number(env.EVIDENCE_RETENTION_DAYS??7);
  if(!Number.isInteger(evidenceRetentionDays)||evidenceRetentionDays<1) throw new Error('EVIDENCE_RETENTION_DAYS must be a positive integer for the three-arm child preview');
  return {
    namePrefix,location,
    vnetAddressPrefix:env.VNET_ADDRESS_PREFIX??'10.48.0.0/16',
    existingVnetId:env.USE_EXISTING_VNET_ID??'',
    registryName:env.AGENT_REGISTRY_NAME||`${namePrefix}acr`,
    controllerIdentityResourceName:env.CONTROLLER_IDENTITY_RESOURCE_NAME||`${namePrefix}-controller`,
    vmVmSize:env.VM_VM_SIZE??'Standard_F1as_v7',
    researchHostVmSize:env.RESEARCH_HOST_VM_SIZE??env.VM_VM_SIZE??'Standard_F1as_v7',
    trustedPublicIpRules:[env.TRUSTED_CONTROLLER_IP],
    validationPrincipalId:env.AZURE_OPERATOR_PRINCIPAL_ID,
    sandboxOperatorPrincipalId:env.AZURE_OPERATOR_PRINCIPAL_ID,
    researchServicePrivateIp:env.RESEARCH_SERVICE_PRIVATE_IP??'10.48.9.4',
    collectorPrivateIp:env.COLLECTOR_PRIVATE_IP??'10.48.9.5',
    restrictedServicePrivateIp:env.RESTRICTED_SERVICE_PRIVATE_IP??'10.48.9.6',
    sshPublicKey:required.sshPublicKey,vmImageVersion:required.vmImageVersion,
    trustedControllerPublicIp:required.trustedControllerPublicIp,
    controllerSourcePrefixes:required.controllerSourcePrefixes,
    researchSourcePrefixes:required.researchSourcePrefixes,
    collectorSourcePrefixes:required.collectorSourcePrefixes,
    operatorSourcePrefixes:required.operatorSourcePrefixes,
    deployVmArm:true,deployJobs:!functionsMode,deployFunctionsArm:functionsMode,deploySandboxGroups:true,deployP3Firewall:functionsMode||!deployRegionalP3,
    deployRegionalP3Support:Boolean(!functionsMode&&p3Region&&p3Region.toLowerCase()!==location.toLowerCase()),
    deployP3VmRoute:!deployRegionalP3,deployP3SandboxGroup:!deployRegionalP3,
    deployEnvironmentNsg:!functionsMode,deployEvidenceStore:true,deploySyntheticFixtures:true,
    createRecordUpdateRole:true,deployResearchHost:true,deployRegistryPrivateEndpoint:true,
    deployRegistryMetadataReader:true,linkVaultSecretReader:true,vaultName,
    evidenceRetentionDays,
    agentImageP1:agentImage,agentImageP2:agentImage,agentImageP3:agentImage
  };
}

export async function runThreeArmWhatIf({az,resourceGroup,env,foundationVaultName,args=[]}={}) {
  if(!az||!resourceGroup||!env?.AZURE_SUBSCRIPTION_ID) throw new Error('three-arm what-if requires az, resourceGroup, and AZURE_SUBSCRIPTION_ID');
  let vaultName=foundationVaultName??env.WORKLOAD_TOKEN_VAULT_NAME;
  if(!vaultName) {
    const deployment=await az(['deployment','group','show','--subscription',env.AZURE_SUBSCRIPTION_ID,'--resource-group',resourceGroup,
      '--name','thesis-host-bootstrap-prerequisites']);
    vaultName=unwrapDeploymentOutput(deployment?.properties?.outputs?.vaultName??deployment?.outputs?.vaultName);
  }
  const parameters=buildThreeArmWhatIfParameters(env,vaultName);
  return runChildTemplateWhatIf({az,resourceGroup,env,args,tempPrefix:'three-arm-whatif-',
    templateFile:'Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/azure-supported-three-arm.bicep',parameters});
}

function unwrapDeploymentOutput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value,'value')) return value.value;
  if (Array.isArray(value)) return value.map(unwrapDeploymentOutput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,unwrapDeploymentOutput(item)]));
  return value;
}

function resourceName(resourceId) {
  return String(resourceId??'').split('/').filter(Boolean).at(-1)??'';
}

/**
 * Preview the regional P3 template directly after foundation. This avoids the
 * main template's nested-output parameter short-circuit while binding every
 * value to the recorded foundation deployment outputs. It is read-only.
 */
export async function runRegionalP3WhatIf({az,resourceGroup,env,foundationOutputs,args=[]}={}) {
  if(!az||!resourceGroup||!env?.AZURE_SUBSCRIPTION_ID) throw new Error('regional what-if requires az, resourceGroup, and AZURE_SUBSCRIPTION_ID');
  const raw=foundationOutputs??await az(['deployment','group','show','--subscription',env.AZURE_SUBSCRIPTION_ID,'--resource-group',resourceGroup,'--name','thesis-three-arm-foundation']);
  const outputs=unwrapDeploymentOutput(raw?.properties?.outputs??raw?.outputs??raw);
  if(!outputs?.regionalNetworkSupport||!outputs?.experimentConfigRoutes||!outputs?.routeSecretReaderIdentities)
    throw new Error('foundation deployment outputs are incomplete for regional P3 preview');
  const vmP3=outputs.experimentConfigRoutes.azure_vm?.P3;
  const jobsReader=outputs.routeSecretReaderIdentities.aca_jobs?.P3;
  const required={
    p3Region:env.P3_REGION_LOCATION,
    namePrefix:env.P3_NAME_PREFIX||env.AZURE_NAME_PREFIX,
    logWorkspaceId:outputs.logWorkspaceId,
    registryServer:outputs.registryServer,
    sharedHubVnetId:outputs.virtualNetworkId,
    serviceReturnRouteTableId:outputs.regionalNetworkSupport.serviceReturnRouteTableId,
    privateEndpointReturnRouteTableId:outputs.regionalNetworkSupport.privateEndpointReturnRouteTableId,
    fixtureEndpointPrivateIp:outputs.regionalNetworkSupport.fixtureEndpointPrivateIp,
    evidenceEndpointPrivateIp:outputs.regionalNetworkSupport.evidenceEndpointPrivateIp,
    vmWorkloadIdentityResourceId:vmP3?.workloadIdentityResourceId,
    vmReaderIdentityResourceId:vmP3?.secretReaderIdentityResourceId,
    jobsWorkloadIdentityResourceId:outputs.jobP3WorkloadIdentityResourceId,
    jobsWorkloadIdentityClientId:outputs.jobP3WorkloadClientId,
    jobsWorkloadPrincipalId:outputs.jobP3WorkloadObjectId,
    jobsReaderIdentityResourceId:jobsReader?.resourceId,
    jobsReaderIdentityClientId:jobsReader?.clientId,
    imagePullIdentityResourceId:outputs.imagePullIdentityResourceId,
    sandboxControlIdentityResourceId:outputs.sandboxControlIdentityResourceId,
    sandboxControlPrincipalId:outputs.sandboxControlIdentityObjectId,
    vmImageVersion:env.VM_IMAGE_VERSION,
    sshPublicKey:env.SSH_PUBLIC_KEY
  };
  const missing=Object.entries(required).filter(([,value])=>typeof value!=='string'||!value.trim()).map(([key])=>key);
  if(missing.length) throw new Error(`foundation/config outputs missing for regional P3 preview: ${missing.join(', ')}`);
  const dnsZones=[outputs.regionalNetworkSupport.blobPrivateDnsZoneId,outputs.regionalNetworkSupport.registryPrivateDnsZoneId]
    .filter(value=>typeof value==='string'&&value.trim());
  if(dnsZones.length<2) throw new Error('foundation did not create both Blob and ACR private DNS zones for regional P3 preview');
  const externalDns=env.SHARED_PRIVATE_DNS_ZONE_RESOURCE_IDS?parsePrefixes(env.SHARED_PRIVATE_DNS_ZONE_RESOURCE_IDS):[];
  const zones=[...new Set([...dnsZones,...(externalDns??[])])];
  const digest=env.AGENT_IMAGE_DIGEST;
  const agentImageP3=typeof digest==='string'&&/^sha256:[a-f0-9]{64}$/i.test(digest)
    ? `${outputs.registryServer}/thesis/agent@${digest}` : 'docker.io/library/busybox:latest';
  const parameters={
    namePrefix:env.P3_NAME_PREFIX||env.AZURE_NAME_PREFIX,location:env.P3_REGION_LOCATION,
    vnetAddressPrefix:'10.52.0.0/16',vmP3SubnetPrefix:'10.52.2.0/24',jobsP3EnvironmentSubnetPrefix:'10.52.12.0/27',
    firewallSubnetPrefix:'10.52.0.0/26',firewallManagementSubnetPrefix:'10.52.0.64/26',
    controllerSourcePrefixes:parsePrefixes(env.CONTROLLER_SOURCE_PREFIXES),
    researchServicePrivateIp:env.RESEARCH_SERVICE_PRIVATE_IP??'10.48.9.4',
    collectorPrivateIp:env.COLLECTOR_PRIVATE_IP??'10.48.9.5',
    restrictedServicePrivateIp:env.RESTRICTED_SERVICE_PRIVATE_IP??'10.48.9.6',
    fixtureEndpointPrivateIp:outputs.regionalNetworkSupport.fixtureEndpointPrivateIp,
    evidenceEndpointPrivateIp:outputs.regionalNetworkSupport.evidenceEndpointPrivateIp,
    logAnalyticsWorkspaceId:outputs.logWorkspaceId,
    sharedHubVnetResourceId:outputs.virtualNetworkId,
    sharedHubRouteTableResourceId:outputs.regionalNetworkSupport.serviceReturnRouteTableId,
    sharedHubPrivateEndpointRouteTableResourceId:outputs.regionalNetworkSupport.privateEndpointReturnRouteTableId,
    sharedPrivateDnsZoneResourceIds:zones,
    registryFqdn:outputs.registryServer,logWorkspaceResourceId:outputs.logWorkspaceId,agentImageP3,
    vmWorkloadIdentityName:resourceName(vmP3.workloadIdentityResourceId),
    vmReaderUaiName:resourceName(vmP3.secretReaderIdentityResourceId),
    jobsWorkloadIdentityResourceId:outputs.jobP3WorkloadIdentityResourceId,
    jobsWorkloadIdentityClientId:outputs.jobP3WorkloadClientId,
    jobsWorkloadPrincipalId:outputs.jobP3WorkloadObjectId,
    jobsReaderIdentityResourceId:jobsReader.resourceId,
    jobsReaderIdentityClientId:jobsReader.clientId,
    imagePullIdentityResourceId:outputs.imagePullIdentityResourceId,
    sandboxControlIdentityResourceId:outputs.sandboxControlIdentityResourceId,
    sandboxControlPrincipalId:outputs.sandboxControlIdentityObjectId,
    vmImageVersion:env.VM_IMAGE_VERSION,sshPublicKey:env.SSH_PUBLIC_KEY
  };
  if(!Array.isArray(parameters.controllerSourcePrefixes)||parameters.controllerSourcePrefixes.length===0)
    throw new Error('CONTROLLER_SOURCE_PREFIXES is required for regional P3 preview');
  const dir=await mkdtemp(path.join(os.tmpdir(),'regional-p3-whatif-'));
  const parameterFile=path.join(dir,'parameters.json');
  try {
    await writeFile(parameterFile,JSON.stringify({$schema:'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',contentVersion:'1.0.0.0',parameters:Object.fromEntries(Object.entries(parameters).map(([name,value])=>[name,{value}]))}));
    return await az(['deployment','group','what-if','--subscription',env.AZURE_SUBSCRIPTION_ID,'--resource-group',resourceGroup,
      '--template-file',path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/regional-p3-spoke.bicep'),
      '--parameters',`@${parameterFile}`,'--no-pretty-print',...args]);
  } finally { await rm(dir,{recursive:true,force:true}); }
}

/**
 * Post-foundation read-only gate before full provisioning.
 * A primary full-stage what-if must fully expand, and split P3 is also previewed
 * directly against the recorded foundation outputs. Any skipped/indeterminate
 * coverage blocks continuation.
 */
export async function runPostFoundationWhatIfGate({az,resourceGroup,env,args=[]}={}) {
  const failures=[];
  let primary;
  let deferredNestedShortCircuit=false;
  try {
    primary=await runTemplateWhatIf({az,resourceGroup,env,stage:'full',args});
    const primaryCheck=evaluateWhatIf(primary,postFoundationWhatIfOptions(env,resourceGroup));
    if(!primaryCheck.ok) {
      if(hasRecognizedTopLevelShortCircuit(primary,env,resourceGroup)) deferredNestedShortCircuit=true;
      else failures.push(`primary-full: ${primaryCheck.problem}`);
    }
  } catch(error) { failures.push(`primary-full: ${String(error?.message??error)}`); }
  const location=String(env?.AZURE_LOCATION??'centralus').toLowerCase();
  const p3Region=deriveP3RegionLocation({configured:env?.P3_REGION_LOCATION,routeRegions:env?.AZURE_ROUTE_REGIONS});
  const splitP3=Boolean(env?.SERVERLESS_RUNTIME==='aca_jobs'&&p3Region&&p3Region.toLowerCase()!==location);
  if(!failures.length&&!deferredNestedShortCircuit&&!evaluateWhatIf(primary,postFoundationWhatIfOptions(env,resourceGroup)).ok) {
    // ARM has omitted one or more root modules. Verify the exact children
    // directly with the same resolved inputs; any remaining skip is fatal.
    try {
      const bootstrap=await runBootstrapWhatIf({az,resourceGroup,env,args});
      const bootstrapCheck=evaluateWhatIf(bootstrap,postFoundationWhatIfOptions(env,resourceGroup));
      if(!bootstrapCheck.ok) failures.push(`bootstrap-child: ${bootstrapCheck.problem}`);
      let vaultName=env.WORKLOAD_TOKEN_VAULT_NAME;
      if(!vaultName) {
        const deployment=await az(['deployment','group','show','--subscription',env.AZURE_SUBSCRIPTION_ID,'--resource-group',resourceGroup,
          '--name','thesis-host-bootstrap-prerequisites']);
        vaultName=unwrapDeploymentOutput(deployment?.properties?.outputs?.vaultName??deployment?.outputs?.vaultName);
      }
      const threeArm=await runThreeArmWhatIf({az,resourceGroup,env,foundationVaultName:vaultName,args});
      const threeArmCheck=evaluateWhatIf(threeArm,postFoundationWhatIfOptions(env,resourceGroup));
      if(!threeArmCheck.ok) failures.push(`three-arm-child: ${threeArmCheck.problem}`);
    } catch(error) { failures.push(`direct-child: ${String(error?.message??error)}`); }
  }
  if(!failures.length&&splitP3) {
    try {
      const regionalEnv={...env,P3_REGION_LOCATION:p3Region};
      const regional=await runRegionalP3WhatIf({az,resourceGroup,env:regionalEnv,args});
      const regionalCheck=evaluateWhatIf(regional,postFoundationWhatIfOptions(env,resourceGroup));
      if(!regionalCheck.ok) failures.push(`regional-p3: ${regionalCheck.problem}`);
    } catch(error) { failures.push(`regional-p3: ${String(error?.message??error)}`); }
  }
  return failures.length?{ok:false,stage:'post-foundation',problem:failures.join('; ')}:
    {...(deferredNestedShortCircuit?{warning:'ARM short-circuited nested module expansion; all returned changes were non-destructive and restricted to approved resources'}:{}),ok:true};
}

function expectedRootModuleNames(env={}) {
  const location=String(env.AZURE_LOCATION??'centralus').toLowerCase();
  const p3Region=deriveP3RegionLocation({configured:env.P3_REGION_LOCATION,routeRegions:env.AZURE_ROUTE_REGIONS});
  return new Set(['thesis-host-bootstrap-prerequisites','thesis-three-arm-full',
    ...(env.SERVERLESS_RUNTIME==='aca_jobs'&&p3Region&&p3Region.toLowerCase()!==location?['thesis-regional-p3']:[])]);
}

function hasRecognizedTopLevelShortCircuit(result,env={},resourceGroup) {
  const changes=result?.changes??result?.value;
  if(!result||result.error||!Array.isArray(changes)||result.errors?.length) return false;
  const pattern=/NestedDeploymentShortCircuited|NestedDeploymentSkippedFromInternalExpansion|nested deployment.{0,80}(short.?circuited|skipped)|short.?circuited.{0,80}nested/i;
  const diagnostics=[...(result.diagnostics??[]),...(result.warnings??[]),...(result.errors??[])];
  const skipped=diagnostics.filter(item=>pattern.test(typeof item==='string'?item:JSON.stringify(item)));
  if(!skipped.length||pattern.test(JSON.stringify(result))&&skipped.length===0) return false;
  const expected=expectedRootModuleNames(env);
  const prefix=typeof env?.AZURE_NAME_PREFIX==='string'?env.AZURE_NAME_PREFIX.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'):undefined;
  const recognizedTarget=target=>{
    // ARM diagnostics can omit target entirely. In that case coverage is still
    // attributable because the static root graph contains only the exact child
    // modules that the fallback previews. Any named but unknown target blocks.
    if(target===undefined||target===null||target==='') return true;
    if(typeof target!=='string') return false;
    if([...expected].some(name=>new RegExp(`(?:^|[/\\s])${name}(?:$|[/\\s])`,'i').test(target))) return true;
    // ARM often names the nested module deployment directly, without its root
    // parent prefix. The template's generated child module names are prefixed
    // with the deployment namePrefix; the exact child previews below still
    // validate those modules, so recognize only that bounded namespace.
    return Boolean(prefix&&new RegExp(`(?:^|/)deployments/${prefix}-[^/]+$`,'i').test(target));
  };
  if(skipped.some(item=>!recognizedTarget(typeof item==='string'?undefined:item.target))) return false;
  if(diagnostics.some(item=>!pattern.test(typeof item==='string'?item:JSON.stringify(item))&&
    (item?.level==='Error'||item?.severity==='Error'))) return false;
  // Only unresolved root/child module deployment records may be deferred to the
  // direct child previews. Resource-level Ignore/Deploy is not attributable
  // unless the direct child result later contains that exact resource ID.
  const allowedIgnores=new Set(knownPostFoundationIgnoreIds(env,resourceGroup).map(id=>id.toLowerCase()));
  for(const change of changes) {
    if(change.changeType==='Delete'||change.changeType==='Unsupported') {
      if(change.changeType==='Unsupported'&&isKnownStorageExtensionRoleAssignment(change,env,resourceGroup)) continue;
      return false;
    }
    if(!['Create','Modify','NoChange','NoEffect','Ignore','Deploy'].includes(change.changeType)) return false;
    if(['Ignore','Deploy'].includes(change.changeType)) {
      const id=String(change.resourceId??'');
      if(allowedIgnores.has(id.toLowerCase())) continue;
      if(isKnownPlatformManagedIgnore(change,env,resourceGroup)) continue;
      if(!/\/providers\/Microsoft\.Resources\/deployments\/[^/]+$/i.test(id)) return false;
      const name=id.split('/').at(-1);
      if(!expected.has(name)) return false;
    }
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
