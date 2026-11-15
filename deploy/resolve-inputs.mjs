#!/usr/bin/env node
/**
 * Input resolution — the "no manual configuration" half of preprovision.
 *
 * Before the first `azd provision`, three values would otherwise require
 * hand-editing: the SSH public key, the trusted controller IP, and the pinned
 * VM image version. This script resolves each from the machine or from Azure
 * and records it in the azd environment. Idempotent: existing values are never
 * overwritten (resolve-once semantics; force with --refresh).
 *
 * Sources, in priority order:
 *   sshPublicKey       existing env value → config/deployment.json
 *                      vm.sshPublicKeyPath (~/.ssh/id_ed25519.pub) → generate a
 *                      dedicated key pair under .azure/<env>/ (never overwrite)
 *   trustedControllerIp existing env value → config/deployment.json
 *                      trustedControllerIp → this machine's egress IP (a /32)
 *   vmImageVersion      existing env value → latest pinned version of the
 *                      Ubuntu Jammy image used by the VM templates
 */
import {readAzdEnv, makeStepLogger, execCommand, makeAzRunner} from './common.mjs';
import {readFile, writeFile, mkdir, access, chmod} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {ensureResearchHostCa} from './research-host-bootstrap.mjs';

// Must match the image references used by both deployed VM templates.
export const VM_IMAGE = {publisher:'Canonical', offer:'0001-com-ubuntu-server-jammy', sku:'22_04-lts-gen2'};

export function defaultResourcePrefix(subscriptionId) {
  const token = subscriptionId ? createHash('sha256').update(String(subscriptionId)).digest('hex').slice(0, 8) : '';
  return token ? `th${token}` : undefined;
}

export function isOperatorIpv4HostCidr(value) {
  const match=/^((?:\d{1,3}\.){3}\d{1,3})\/32$/.exec(String(value??''));
  if(!match) return false;
  return match[1].split('.').every(octet=>Number(octet)<=255);
}

function routeRegionMap(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') { try { const parsed=JSON.parse(value); return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed : undefined; } catch {} }
  return undefined;
}

function sourcePrefixes(value,key) {
  let parsed=value;
  if(typeof parsed==='string') {
    try { parsed=JSON.parse(parsed); }
    catch { parsed=parsed.split(',').map(item=>item.trim()).filter(Boolean); }
  }
  if(!Array.isArray(parsed)||!parsed.length||parsed.some(item=>typeof item!=='string'||!item.trim()||item.includes(',')))
    throw new Error(`${key} must resolve to a non-empty list of CIDRs without commas`);
  return parsed.map(item=>item.trim());
}

/** Resolve P3 location from the actual azd route map as well as file config. */
export function deriveP3RegionLocation({configured, routeRegions, configRouteRegions} = {}) {
  if (typeof configured==='string' && configured.trim()) return configured.trim();
  const map=routeRegionMap(routeRegions) ?? routeRegionMap(configRouteRegions);
  const aliases={azure_vm:['azure_vm'],azure_functions_flex:['azure_functions_flex'],azure_container_apps_jobs:['azure_container_apps_jobs','aca_jobs'],azure_container_apps_sandboxes:['azure_container_apps_sandboxes','aca_sandboxes']};
  const p3Regions=Object.values(aliases).map(names=>{
    for(const name of names) {
      const profiles=map?.[name];
      const region=profiles?.P3??profiles?.p3;
      if(typeof region==='string'&&region.trim()) return region.trim();
    }
    return undefined;
  }).filter(Boolean);
  const unique=[...new Set(p3Regions.map(region=>region.toLowerCase()))];
  return unique.length===1?p3Regions[0]:undefined;
}

function controllerHostPrefix(value) {
  if(typeof value!=='string') return undefined;
  const [address,prefix]=value.trim().split('/');
  if(!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) || (prefix!==undefined&&prefix!=='32')) return undefined;
  const octets=address.split('.').map(Number);
  if(octets.some(octet=>octet<0||octet>255)) return undefined;
  return `${address}/32`;
}

/**
 * Exact subnet defaults from the entry and regional P3 Bicep modules. The
 * collector deliberately excludes every P3 source subnet.
 */
export function defaultNetworkSourcePrefixes({trustedControllerIp, location, p3RegionLocation, serverlessRuntime='functions_flex'} = {}) {
  const operator=controllerHostPrefix(trustedControllerIp);
  const primary=serverlessRuntime==='aca_jobs'
    ?['10.48.0.0/24','10.48.7.0/24','10.48.12.0/27']
    :['10.48.0.0/24','10.48.7.0/24','10.48.3.0/24','10.48.5.0/24','10.48.12.0/27'];
  const regional=serverlessRuntime==='aca_jobs'&&typeof p3RegionLocation==='string'&&p3RegionLocation.trim()&&p3RegionLocation.toLowerCase()!==String(location??'centralus').toLowerCase();
  const localP3=serverlessRuntime==='aca_jobs'?['10.48.8.0/24','10.48.12.32/27']:['10.48.8.0/24','10.48.6.0/24'];
  const research=[...primary,...(regional?['10.52.2.0/24','10.52.12.0/27']:localP3)];
  return {
    ...(operator?{controller:[operator],operator:[operator]}:{}),
    research,
    collector:primary
  };
}

export async function loadDeploymentConfig({read = readFile} = {}) {
  try {
    return JSON.parse(await read('config/deployment.json', 'utf8'));
  } catch {
    return {};
  }
}

export async function resolveSshPublicKey({config, envDir, env, refresh = false, read = readFile, exec = execCommand} = {}) {
  const publicKeyPath = path.join(envDir, 'deployment-ssh.pub');
  const configKey = config?.vm?.sshPublicKeyPath?.replace(/^~/, process.env.HOME ?? '~');
  const candidates = [configKey, path.join(process.env.HOME ?? '', '.ssh', 'id_ed25519.pub'), path.join(process.env.HOME ?? '', '.ssh', 'id_rsa.pub')].filter(Boolean);

  for (const candidate of candidates) {
    const text = await read(candidate, 'utf8').catch(() => undefined);
    if (text) {
      const line = text.split('\n').find(l => /^ssh-(ed25519|rsa) /.test(l.trim()));
      if (line) return {value: line.trim(), source: candidate};
    }
  }

  // No existing usable key: generate a dedicated one for this environment.
  try {
    await access(publicKeyPath);
    if (!refresh) return {value: (await read(publicKeyPath, 'utf8')).trim(), source: publicKeyPath};
  } catch { /* not present — generate */ }
  await exec(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', 'thesis-deployment', '-f', publicKeyPath.replace(/\.pub$/, ''), '-q']);
  await chmod(publicKeyPath.replace(/\.pub$/, ''), 0o600).catch(() => {});
  return {value: (await read(publicKeyPath, 'utf8')).trim(), source: publicKeyPath};
}

export async function resolveEgressIp({config, fetchImpl = fetch} = {}) {
  if (config?.trustedControllerIp) return {value: config.trustedControllerIp, source: 'config'};
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const response = await fetchImpl(url, {signal: AbortSignal.timeout(8000)});
      const text = (await response.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return {value: `${text}/32`, source: url};
    } catch { /* try next */ }
  }
  return undefined;
}

export async function resolveVmImageVersion({az = makeAzRunner(), region, subscriptionId} = {}) {
  try {
    if (!region || !subscriptionId) return undefined;
    const versions = await az(['vm', 'image', 'list', '--all', '--subscription', subscriptionId, '--location', region,
      '--publisher', VM_IMAGE.publisher, '--offer', VM_IMAGE.offer, '--sku', VM_IMAGE.sku, '--query', '[].version'], {timeoutMs:120000});
    const valid = Array.isArray(versions) ? versions.filter(v => typeof v === 'string' && /^\d+(?:\.\d+)+$/.test(v)) : [];
    valid.sort((a,b) => {
      const left = a.split('.').map(Number), right = b.split('.').map(Number);
      for (let i=0; i<Math.max(left.length,right.length); i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
      return 0;
    });
    if (valid.length) return {value: valid.at(-1), source: 'az vm image list'};
  } catch { /* az unavailable or offline — leave unset, render-parameters will demand it */ }
  return undefined;
}

export async function main({env = process.env, stdout = process.stdout, stderr = process.stderr, refresh = false, az = makeAzRunner()} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const envName = process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default';
  const envDir = path.join(process.cwd(), '.azure', envName);
  await mkdir(envDir, {recursive: true});
  const config = await loadDeploymentConfig();
  const resolved = {};

  // The public CA must be available for image construction and its matching
  // private key for the post-foundation vault seed. Fail before preflight can
  // launch a deployment if either input is missing or inconsistent.
  const ca=await ensureResearchHostCa({caCertificatePath:values.THESIS_RESEARCH_CA_CERT,
    caPrivateKeyPath:values.THESIS_RESEARCH_CA_KEY,repositoryRoot:process.cwd()});
  if(!values.THESIS_RESEARCH_CA_CERT) resolved.THESIS_RESEARCH_CA_CERT=ca.caCertificatePath;
  if(!values.THESIS_RESEARCH_CA_KEY) resolved.THESIS_RESEARCH_CA_KEY=ca.caPrivateKeyPath;
  if (!values.PROVISION_STAGE) resolved.PROVISION_STAGE = 'foundation';
  if (!values.EVIDENCE_RETENTION_DAYS) resolved.EVIDENCE_RETENTION_DAYS = String(config?.evidence?.retentionDays ?? 7);
  if (!values.SSH_PUBLIC_KEY || refresh) {
    const key = await resolveSshPublicKey({config, envDir, env: values, refresh});
    if (key) resolved.SSH_PUBLIC_KEY = key.value;
  }
  if (!values.TRUSTED_CONTROLLER_IP || refresh) {
    const ip = await resolveEgressIp({config});
    if (ip) resolved.TRUSTED_CONTROLLER_IP = ip.value;
  }
  const operatorIp=values.TRUSTED_CONTROLLER_IP??resolved.TRUSTED_CONTROLLER_IP;
  if(!isOperatorIpv4HostCidr(operatorIp))
    throw new Error('TRUSTED_CONTROLLER_IP must be the operator\'s exact public IPv4 /32; the bootstrap lock container is network-restricted to this address');
  if (!values.VM_IMAGE_VERSION || refresh) {
    const version = await resolveVmImageVersion({region: values.AZURE_LOCATION, subscriptionId: values.AZURE_SUBSCRIPTION_ID});
    if (version) resolved.VM_IMAGE_VERSION = version.value;
  }
  if (!values.AZURE_NAME_PREFIX) {
    const prefix = config?.namePrefix ?? defaultResourcePrefix(values.AZURE_SUBSCRIPTION_ID);
    if (prefix) resolved.AZURE_NAME_PREFIX = prefix;
  }
  if(!values.AZURE_OPERATOR_PRINCIPAL_ID) {
    try {
      const objectId=String(await az(['ad','signed-in-user','show','--query','id','-o','tsv'])).trim();
      if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId))
        resolved.AZURE_OPERATOR_PRINCIPAL_ID=objectId;
    } catch {
      if(values.AZURE_CLIENT_ID) {
        try {
          const objectId=String(await az(['ad','sp','show','--id',values.AZURE_CLIENT_ID,'--query','id','-o','tsv'])).trim();
          if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(objectId))
            resolved.AZURE_OPERATOR_PRINCIPAL_ID=objectId;
        } catch { /* preflight reports the missing deployment input */ }
      }
    }
  }
  if (!values.VM_VM_SIZE) resolved.VM_VM_SIZE = config?.vm?.vmSize ?? 'Standard_F1as_v7';
  if (!values.RESEARCH_HOST_VM_SIZE) resolved.RESEARCH_HOST_VM_SIZE = config?.vm?.researchHostVmSize ?? values.VM_VM_SIZE ?? resolved.VM_VM_SIZE;
  if(config?.serverlessRuntime&&!values.SERVERLESS_RUNTIME) resolved.SERVERLESS_RUNTIME=config.serverlessRuntime;
  if(config?.network?.existingVnetResourceId&&!values.USE_EXISTING_VNET_ID) resolved.USE_EXISTING_VNET_ID=config.network.existingVnetResourceId;
  if(config?.registry?.existingRegistryName&&!values.AGENT_REGISTRY_NAME) resolved.AGENT_REGISTRY_NAME=config.registry.existingRegistryName;
  if(config?.preflight?.skipBudgetCheck===true&&!values.AZD_PREFLIGHT_SKIP_BUDGET) resolved.AZD_PREFLIGHT_SKIP_BUDGET='1';
  if(config?.preflight?.allowPolicyAssignments===true&&!values.AZD_PREFLIGHT_ALLOW_POLICY_ASSIGNMENTS)
    resolved.AZD_PREFLIGHT_ALLOW_POLICY_ASSIGNMENTS='1';
  if (config?.region && !values.AZURE_LOCATION) resolved.AZURE_LOCATION = config.region;
  if(!values.VNET_ADDRESS_PREFIX) resolved.VNET_ADDRESS_PREFIX=config?.network?.vnetAddressPrefix??'10.48.0.0/16';
  if(!values.SERVERLESS_RUNTIME) resolved.SERVERLESS_RUNTIME='functions_flex';
  if (config?.routeRegions && !values.AZURE_ROUTE_REGIONS) resolved.AZURE_ROUTE_REGIONS = JSON.stringify(config.routeRegions);
  const routeRegions=routeRegionMap(values.AZURE_ROUTE_REGIONS)??config?.routeRegions;
  const p3RegionLocation=deriveP3RegionLocation({configured:values.P3_REGION_LOCATION,routeRegions,configRouteRegions:config?.routeRegions});
  if (!values.P3_REGION_LOCATION && p3RegionLocation) resolved.P3_REGION_LOCATION=p3RegionLocation;
  if (Array.isArray(config?.network?.sharedPrivateDnsZoneResourceIds) && !values.SHARED_PRIVATE_DNS_ZONE_RESOURCE_IDS)
    resolved.SHARED_PRIVATE_DNS_ZONE_RESOURCE_IDS=JSON.stringify(config.network.sharedPrivateDnsZoneResourceIds);
  // Use exact subnet CIDRs from the checked-in hub/regional Bicep defaults.
  // The machine egress IP is a safe /32 fallback for controller/operator paths;
  // a separately configured network remains an explicit owner-supplied override.
  const sourceDefaults=defaultNetworkSourcePrefixes({
    trustedControllerIp:values.TRUSTED_CONTROLLER_IP??resolved.TRUSTED_CONTROLLER_IP,
    location:values.AZURE_LOCATION??config?.region??'centralus',
    p3RegionLocation:p3RegionLocation??values.AZURE_LOCATION??config?.region??'centralus',
    serverlessRuntime:values.SERVERLESS_RUNTIME??resolved.SERVERLESS_RUNTIME
  });
  const serviceAddressDefaults={
    RESEARCH_SERVICE_PRIVATE_IP:'10.48.9.4',
    COLLECTOR_PRIVATE_IP:'10.48.9.5',
    RESTRICTED_SERVICE_PRIVATE_IP:'10.48.9.6'
  };
  for(const [key,value] of Object.entries(serviceAddressDefaults)) if(!values[key]) resolved[key]=value;
  const prefixMap = {
    CONTROLLER_SOURCE_PREFIXES: config?.network?.controllerSourcePrefixes??sourceDefaults.controller,
    RESEARCH_SOURCE_PREFIXES: config?.network?.researchSourcePrefixes??sourceDefaults.research,
    COLLECTOR_SOURCE_PREFIXES: config?.network?.collectorSourcePrefixes??sourceDefaults.collector,
    OPERATOR_SOURCE_PREFIXES: config?.network?.operatorSourcePrefixes??sourceDefaults.operator
  };
  for (const [key, prefixes] of Object.entries(prefixMap)) {
    if (!values[key] && Array.isArray(prefixes) && prefixes.length) resolved[key] = JSON.stringify(prefixes);
  }
  // azd interpolates parameter files before parsing JSON. JSON array strings
  // inside quoted `value` fields break that parse, so provide CSV companion
  // strings for Bicep's split() while preserving the original JSON arrays for
  // preflight and the deployment tooling.
  for(const key of Object.keys(prefixMap)) {
    const effective=values[key]??resolved[key];
    resolved[`${key}_CSV`]=sourcePrefixes(effective,key).join(',');
  }

  if (Object.keys(resolved).length === 0) {
    log('resolve-inputs', 'noop', {note: 'all inputs already resolved'});
    return 0;
  }
  for (const [key, value] of Object.entries(resolved)) {
    await execCommand(['azd', 'env', 'set', key, value], {timeoutMs: 60000}).catch(async error => {
      // azd not on PATH during unit/manual runs: persist to .env directly.
      stderr.write(`(azd env set unavailable — writing ${key} to ${envDir}/.env directly)\n`);
      const envFile = path.join(envDir, '.env');
      const existing = await readFile(envFile, 'utf8').catch(() => '');
      const updated = existing.split('\n').filter(line => line && !line.startsWith(`${key}=`));
      updated.push(`${key}=${value}`);
      await writeFile(envFile, `${updated.join('\n')}\n`);
    });
  }
  log('resolve-inputs', 'resolved', {note: Object.keys(resolved).join(', ')});
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main({refresh: process.argv.includes('--refresh')});
}
