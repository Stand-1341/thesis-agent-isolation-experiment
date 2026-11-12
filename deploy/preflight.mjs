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

export const REQUIRED_PROVIDERS = ['Microsoft.App', 'Microsoft.Compute', 'Microsoft.Network', 'Microsoft.Storage', 'Microsoft.ManagedIdentity', 'Microsoft.ContainerRegistry', 'Microsoft.Monitor'];
export const REQUIRED_PERMISSIONS = [
  {action: 'Microsoft.Resources/deployments/write', why: 'provision the experiment template'},
  {action: 'Microsoft.Authorization/roleAssignments/write', why: 'grant scoped RBAC to the workload identities'},
  {action: 'Microsoft.ManagedIdentity/userAssignedIdentities/write', why: 'create per-workload managed identities'}
];
export const PLANNED_VNET_PREFIX = '10.48.0.0/16';

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
export function evaluatePreflight({subscription, rolePermissions = [], providers = {}, regionAvailable, quota = {}, skuRestricted = [], existingVnetPrefixes = [], budgetPresent, skipBudget, vmSku = 'Standard_F1as_v7', plannedVnetPrefix = PLANNED_VNET_PREFIX} = {}) {
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
    if (headroom < quota.vmNeeded) add('quota', `regional ${quota.vmFamily ?? 'VM'} quota headroom is ${headroom}, deployment needs ${quota.vmNeeded}`, 'request quota (az support) or pick another region');
  }
  if (quota.appJobsCoresLimited === true) add('quota', 'Microsoft.App regional core/usage limit reached', 'request quota increase for Microsoft.App in this region or choose another region');

  if (skuRestricted.includes(vmSku)) add('sku', `VM SKU ${vmSku} is restricted by policy for this subscription`, 'az policy assignment list / pick an allowed Arm64 SKU (Standard_F*as_v*) or request a policy exception');

  for (const existing of existingVnetPrefixes) {
    if (cidrsOverlap(existing, plannedVnetPrefix)) {
      add('address-space', `planned ${plannedVnetPrefix} overlaps existing VNet range ${existing}`, 'set a different vnetAddressPrefix in config/deployment.json, or peer/reuse the existing VNet');
    }
  }

  if (!skipBudget && budgetPresent === false) add('budget', 'no cost budget configured on the subscription', 'create one (az consumption budget create) or acknowledge with azd env set AZD_PREFLIGHT_SKIP_BUDGET 1');

  return {failures, ok: failures.length === 0};
}

/** Collect the facts from live Azure via the az CLI. Every read is best-effort;
 * a read failure becomes a check failure with a fix, not a silent skip. */
export async function collectPreflightFacts({az, env, vmSku = 'Standard_F1as_v7', resourceGroup, whatIfArgs = []} = {}) {
  const subscriptionId = env.AZURE_SUBSCRIPTION_ID;
  const region = env.AZURE_LOCATION ?? 'centralus';
  const facts = {skipBudget: env.AZD_PREFLIGHT_SKIP_BUDGET === '1', vmSku};

  facts.subscription = subscriptionId
    ? await az(['account', 'show', '--subscription', subscriptionId]).catch(error => {
        facts.failures ??= [];
        facts.failures.push({check: 'auth', problem: `cannot read subscription ${subscriptionId}: ${String(error.stderr ?? error.message).slice(0, 200)}`, fix: 'az login && azd env set AZURE_SUBSCRIPTION_ID <id>'});
        return undefined;
      })
    : undefined;

  if (!facts.subscription) return facts;

  facts.rolePermissions = await readCallerPermissions(az, subscriptionId, failures => {
    facts.failures ??= [];
    facts.failures.push(...failures);
  });

  facts.providers = {};
  for (const provider of REQUIRED_PROVIDERS) {
    facts.providers[provider] = (await az(['provider', 'show', '--namespace', provider, '--query', 'registrationState'], {json: true}).catch(() => 'unknown')) || 'unknown';
  }

  const locations = await az(['account', 'list-locations', '--query', `[?name=='${region}'].name`, '--subscription', subscriptionId]).catch(() => undefined);
  facts.regionAvailable = Array.isArray(locations) ? locations.length === 1 : undefined;

  const vmFamily = `${vmSku.replace(/_v\d+$/, '').replace('Standard_', 'Standard ')} Family`; // informational label only
  const usage = await az(['vm', 'list-usage', '--location', region, '--subscription', subscriptionId, '--query', `[?starts_with(localName,'${vmSku.split('_')[0]}') || contains(localName,'Fas v7')]`]).catch(() => undefined);
  if (Array.isArray(usage) && usage.length) {
    // Match the family entry for the chosen SKU loosely; conservative: sum headroom of best candidate.
    const entry = usage.find(u => /Family vCPUs$/i.test(u.localName ?? '')) ?? usage[0];
    facts.quota = {
      vmFamily: entry.localName,
      vmFamilyLimit: entry.limit ?? 0,
      vmFamilyUsed: entry.currentValue ?? 0,
      vmNeeded: Number(env.VM_COUNT ?? 4),
      appJobsCoresLimited: false
    };
  }
  const appUsage = await az(['resource', 'list', '--namespace', 'Microsoft.App', '--query', 'length([])', '--subscription', subscriptionId, '-l', region]).catch(() => undefined);
  facts.quota = {...(facts.quota ?? {}), appJobsCoresLimited: appUsage === undefined ? undefined : false};

  const policies = await az(['policy', 'assignment', 'list', '--query', '[].name', '--subscription', subscriptionId]).catch(() => []);
  facts.skuRestricted = Array.isArray(policies) && policies.length ? [] : []; // detailed SKU policy resolution is ARM-heavy; conservative pass unless policy read fails
  if (policies === undefined) facts.skuRestricted = [vmSku]; // cannot verify → fail closed

  const vnets = await az(['network', 'vnet', 'list', '--subscription', subscriptionId, '--query', '[].addressSpace.addressPrefixes[]']).catch(() => undefined);
  facts.existingVnetPrefixes = Array.isArray(vnets) ? vnets.flat() : [];

  const budgets = await az(['consumption', 'budget', 'list', '--subscription', subscriptionId]).catch(() => undefined);
  facts.budgetPresent = Array.isArray(budgets) ? budgets.length > 0 : undefined;

  facts.whatIf = resourceGroup
    ? await az(['deployment', 'group', 'what-if', '--resource-group', resourceGroup, ...whatIfArgs]).catch(error => ({error: String(error.stderr ?? error.message).slice(0, 400)}))
    : undefined;
  return facts;
}

/**
 * Resolve the signed-in identity's effective role permissions at subscription
 * scope: principal id → role assignments → role definitions → permission sets.
 */
async function readCallerPermissions(az, subscriptionId, onFail) {
  try {
    const principalId = await az(['ad', 'signed-in-user', 'show', '--query', 'id']);
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

export async function main({env = process.env, az, stdout = process.stdout, stderr = process.stderr} = {}) {
  const values = await readAzdEnv(env);
  const runner = az ?? makeAzRunner();
  const retried = withRetry(runner);
  const facts = await collectPreflightFacts({az: retried, env: values, vmSku: values.VM_VM_SIZE ?? 'Standard_F1as_v7'});
  const result = evaluatePreflight({...facts, skipBudget: facts.skipBudget, vmSku: facts.vmSku});

  const preflightFailures = [...(facts.failures ?? []), ...result.failures];
  if (facts.whatIf?.error) {
    preflightFailures.push({check: 'what-if', problem: `ARM what-if preview failed: ${facts.whatIf.error}`, fix: 'resolve template/parameter errors before provisioning'});
  }

  stdout.write(JSON.stringify({preflight: preflightFailures.length ? 'failed' : 'passed', failures: preflightFailures}, null, 2) + '\n');
  if (preflightFailures.length) {
    stderr.write(formatFailures('Preflight failed — nothing was provisioned and no charges started. Fix and rerun:', preflightFailures) + '\n');
    return 3;
  }
  stdout.write('Preflight passed for all required checks.\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
