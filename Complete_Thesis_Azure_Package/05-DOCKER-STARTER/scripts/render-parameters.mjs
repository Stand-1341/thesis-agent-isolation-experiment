#!/usr/bin/env node
/**
 * Turn the example parameter file into a deployable one.
 *
 * The example exists to document every knob. It is not deployable: it carries five
 * placeholder values, a documentation-range controller IP, and every optional component
 * switched off. This renders a real file from a small number of supplied facts and refuses
 * to emit anything still containing a placeholder.
 *
 * It also enforces three constraints that fail silently or expensively at deploy time:
 *   - sandbox reserved address ranges (a VNet connection provisions fine and then cannot
 *     reach those addresses)
 *   - the fixture-store role trap (store deployed without a role, composition incomplete)
 *   - image references that are tags rather than content digests
 */

import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const PLACEHOLDER = /REPLACE|<[^>\n]+>|CHANGEME|example-only/i;

/** Ranges the sandbox platform reserves for its own internal networking. */
export const RESERVED_RANGES = Object.freeze([
  {name: '192.168.0.0/24', network: [192, 168, 0, 0], prefix: 24},
  {name: '100.65.0.0/23', network: [100, 65, 0, 0], prefix: 23}
]);

/** Flags selectable via --enable, mapped to their parameter names. */
export const COMPONENT_FLAGS = Object.freeze({
  'sandbox-groups': ['deploySandboxGroups'],
  'vm': ['deployVmArm'],
  'p3-firewall': ['deployP3Firewall'],
  'nsg': ['deployEnvironmentNsg'],
  'evidence-store': ['deployEvidenceStore'],
  'fixtures': ['deploySyntheticFixtures'],
  'registry-pe': ['deployRegistryPrivateEndpoint'],
  'registry-metadata': ['deployRegistryMetadataReader'],
  'research-host': ['deployResearchHost'],
  'vault-secret': ['linkVaultSecretReader']
});

export function parseCidr(value) {
  const match = CIDR.exec(value ?? '');
  if (!match) throw new TypeError(`not a CIDR: ${value}`);
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some(o => o > 255) || prefix > 32) throw new TypeError(`not a CIDR: ${value}`);
  return {octets, prefix};
}

function toInt(octets) {
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

function blockRange({octets, prefix}) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (toInt(octets) & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  return {start: network, end: network + size - 1};
}

/** True when two CIDRs share any address. */
export function cidrsOverlap(a, b) {
  const left = blockRange(parseCidr(a));
  const right = blockRange(parseCidr(b));
  return left.start <= right.end && right.start <= left.end;
}

/** Which reserved sandbox range a CIDR collides with, or undefined. */
export function reservedCollision(cidr) {
  for (const reserved of RESERVED_RANGES) {
    if (cidrsOverlap(cidr, reserved.name)) return reserved.name;
  }
  return undefined;
}

export function parseArgs(argv = []) {
  const options = {help: false, enable: [], out: undefined, base: undefined};
  const single = {
    subscription: 'subscriptionId', region: 'region', 'ssh-key': 'sshKeyPath',
    'vm-image-version': 'vmImageVersion', registry: 'registryName', digest: 'imageDigest',
    'controller-ip': 'controllerIp', out: 'out', base: 'base',
    'record-update-role-id': 'recordUpdateRoleId', prefix: 'namePrefix'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error('positional arguments are not accepted');
    const name = arg.slice(2);
    if (name === 'enable') {
      const value = argv[++i];
      if (typeof value !== 'string' || !value || value.startsWith('--'))
        throw new Error('--enable requires a comma-separated value');
      options.enable.push(...value.split(',').map(s => s.trim()).filter(Boolean));
      continue;
    }
    const key = single[name];
    if (!key) throw new Error(`unknown argument: ${/^[A-Za-z0-9-]+$/.test(name) ? arg : 'positional argument'}`);
    const value = argv[++i];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    options[key] = value;
  }
  return options;
}

/**
 * Render a deployable parameter document.
 *
 * Pure: no filesystem, no network. Everything comes in as arguments so the whole thing is
 * testable, and so a dry render cannot half-write a file.
 */
export function renderParameters({
  base, subscriptionId, region, sshPublicKey, vmImageVersion,
  registryName, imageDigest, controllerIp, enable = [], recordUpdateRoleId, namePrefix
}) {
  const problems = [];
  const filled = [];

  if (!region || !REGION.test(region)) problems.push('region must be a lowercase Azure region name');
  if (region && region !== 'centralus') {
    // Not an error; worth stating because every shipped example is eastern US.
    filled.push(`region=${region} (examples ship eastus/eastus2 — verify the sandbox deployment config matches)`);
  }
  if (!sshPublicKey || !/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+/.test(sshPublicKey.trim()))
    problems.push('sshPublicKey must be a single ssh-ed25519 or ssh-rsa public key');
  if (!vmImageVersion) problems.push('vmImageVersion is required (resolve it with: az vm image show ...)');
  else if (PLACEHOLDER.test(vmImageVersion)) problems.push('vmImageVersion still looks like a placeholder');
  if (!registryName || !/^[a-z0-9]{5,50}$/.test(registryName))
    problems.push('registryName must be 5-50 lowercase alphanumerics');
  if (!imageDigest || !DIGEST.test(imageDigest ?? ''))
    problems.push('imageDigest must be a content digest: @sha256:<64 hex> (a tag will drift silently)');
  if (!controllerIp) problems.push('controllerIp is required (your egress address, /32)');
  else {
    if (!CIDR.test(controllerIp)) problems.push('controllerIp must be a CIDR');
    else if (/^203\.0\.113\./.test(controllerIp) || /^198\.51\.100\./.test(controllerIp))
      problems.push('controllerIp is a documentation range and will lock you out of the registry');
  }

  const unknown = enable.filter(name => !Object.hasOwn(COMPONENT_FLAGS, name));
  if (unknown.length) problems.push(`unknown --enable value(s): ${unknown.join(', ')}`);

  const params = structuredClone(base?.parameters ?? {});
  const set = (key, value) => {
    if (!Object.hasOwn(params, key)) problems.push(`base parameter file has no "${key}" to set`);
    else params[key] = {value};
  };

  if (namePrefix) set('namePrefix', namePrefix);
  if (region) set('location', region);
  if (sshPublicKey) set('sshPublicKey', sshPublicKey.trim());
  if (vmImageVersion) set('vmImageVersion', vmImageVersion);
  if (registryName && imageDigest) {
    const reference = `${registryName}.azurecr.io/thesis/agent@${imageDigest.replace(/^@/, '')}`;
    for (const key of ['agentImageP1', 'agentImageP2', 'agentImageP3']) set(key, reference);
    filled.push(`agent images -> ${reference}`);
  }
  if (controllerIp) set('trustedControllerPublicIp', controllerIp);

  // Every optional component starts off; only what was asked for is enabled.
  for (const keys of Object.values(COMPONENT_FLAGS)) for (const key of keys) set(key, false);
  // Unknown names were already reported as problems; skip them so a typo produces a
  // readable refusal instead of a TypeError from iterating undefined.
  const known = enable.filter(name => Object.hasOwn(COMPONENT_FLAGS, name));
  for (const name of known) for (const key of COMPONENT_FLAGS[name]) set(key, true);
  if (known.length) filled.push(`enabled: ${known.join(', ')}`);

  if (recordUpdateRoleId) set('recordUpdateRoleId', recordUpdateRoleId);

  // Constraint: a fixture store with no way to grant the record-update role is incomplete.
  const fixturesOn = params.deploySyntheticFixtures?.value === true;
  const roleOn = params.createRecordUpdateRole?.value === true;
  const roleExisting = typeof params.recordUpdateRoleId?.value === 'string' && params.recordUpdateRoleId.value.length > 0;
  if (fixturesOn && !roleOn && !roleExisting)
    problems.push('deploySyntheticFixtures requires createRecordUpdateRole=true or an existing recordUpdateRoleId');

  if (params.linkVaultSecretReader?.value === true && !params.vaultName?.value)
    problems.push('linkVaultSecretReader requires a vaultName');

  // Constraint: nothing sandboxes must reach may sit in a reserved range.
  for (const key of ['controllerSourcePrefixes', 'researchSourcePrefixes', 'collectorSourcePrefixes', 'operatorSourcePrefixes']) {
    const value = params[key]?.value;
    if (!Array.isArray(value)) continue;
    for (const cidr of value) {
      if (typeof cidr !== 'string' || !CIDR.test(cidr)) { problems.push(`${key} contains a non-CIDR entry`); continue; }
      const hit = reservedCollision(cidr);
      if (hit) problems.push(`${key} entry ${cidr} overlaps sandbox-reserved range ${hit}`);
    }
  }
  for (const key of ['researchServicePrivateIp', 'collectorPrivateIp', 'evidenceEndpointPrivateIp', 'fixtureEndpointPrivateIp']) {
    const value = params[key]?.value;
    if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) continue;
    const hit = reservedCollision(`${value}/32`);
    if (hit) problems.push(`${key} ${value} falls inside sandbox-reserved range ${hit}`);
  }

  // Final gate: no placeholder may survive anywhere.
  const leftovers = [];
  for (const [key, entry] of Object.entries(params)) {
    for (const text of flatten(entry?.value)) {
      if (PLACEHOLDER.test(text)) leftovers.push(`${key}: ${text}`);
    }
  }
  if (leftovers.length) problems.push(`placeholder values remain: ${leftovers.join('; ')}`);

  return {problems, filled, parameters: params};
}

function* flatten(value) {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* flatten(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) yield* flatten(item);
}

const USAGE = [
  'Render a deployable Azure parameter file from the example.',
  '',
  'Usage: node scripts/render-parameters.mjs --region <region> --ssh-key <path> \\',
  '         --vm-image-version <version> --registry <acrname> --digest <@sha256:...> \\',
  '         --controller-ip <cidr> [--enable sandbox-groups,vm,p3-firewall,...] \\',
  '         [--record-update-role-id <id>] [--out infra/azure-supported-three-arm.parameters.json]',
  '',
  'Nothing is deployed. The output file is gitignored.'
].join('\n');

export async function main({argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 5;
  }
  if (options.help) { stdout.write(`${USAGE}\n`); return 0; }

  const basePath = options.base ?? 'infra/azure-supported-three-arm.parameters.example.json';
  let base;
  try {
    base = JSON.parse(await readFile(basePath, 'utf8'));
  } catch {
    stderr.write(`cannot read base parameter file: ${basePath}\n`);
    return 5;
  }

  let sshPublicKey;
  if (options.sshKeyPath) {
    try {
      sshPublicKey = (await readFile(options.sshKeyPath.replace(/^~/, process.env.HOME ?? '~'), 'utf8'))
        .split('\n').find(line => /^ssh-(ed25519|rsa) /.test(line.trim()));
    } catch {
      stderr.write(`cannot read ssh public key: ${options.sshKeyPath}\n`);
      return 5;
    }
    if (!sshPublicKey) { stderr.write(`${options.sshKeyPath} contains no ssh-ed25519/ssh-rsa public key\n`); return 5; }
  }

  let sshKeyLine = sshPublicKey;
  const {problems, filled, parameters} = renderParameters({
    base, subscriptionId: options.subscriptionId, region: options.region,
    sshPublicKey: sshKeyLine, vmImageVersion: options.vmImageVersion,
    registryName: options.registryName, imageDigest: options.imageDigest,
    controllerIp: options.controllerIp, enable: options.enable,
    recordUpdateRoleId: options.recordUpdateRoleId, namePrefix: options.namePrefix
  });

  if (problems.length) {
    stderr.write('Cannot render a deployable parameter file:\n');
    for (const problem of problems) stderr.write(`  - ${problem}\n`);
    return 4;
  }

  const outPath = options.out ?? 'infra/azure-supported-three-arm.parameters.json';
  await writeFile(outPath, `${JSON.stringify({...base, parameters}, null, 2)}\n`, 'utf8');
  stdout.write(`wrote ${outPath}\n`);
  for (const line of filled) stdout.write(`  ${line}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
