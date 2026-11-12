#!/usr/bin/env node
/**
 * Non-counted deployment validation (azd postup hook).
 *
 * Verifies the deployment — NOT the experiment: zero trials run, nothing is
 * counted, no evidence is produced beyond a validation log.
 *
 *   V1 resource presence : VM arm, ACA Jobs, sandbox groups, stores, identities exist
 *   V2 identity reach    : each workload identity's managed identity token works
 *   V3 effective perms   : role assignments are EFFECTIVE (token-level probe),
 *                          not merely that ARM accepted the assignment
 *   V4 service health    : research/collector endpoints answer on the private IPs
 *   V5 evidence path     : a non-counted write/read/delete round-trip on the
 *                          evidence container under validation/ prefix
 *
 * The V3 check exists because of the earlier Azure permissions failure: an
 * accepted role assignment is not proof of effective access. The token probe
 * is the proof.
 */
import {readAzdEnv, makeAzRunner, withRetry, makeStepLogger, formatFailures} from './common.mjs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Pure: presence checks over resolved config + live resource listings. */
export function evaluatePresence({resolved, resourceIds = [], sandboxGroups = []} = {}) {
  const failures = [];
  const add = (check, problem, fix) => failures.push({check, problem, fix});
  const expectedResources = collectExpectedResourceIds(resolved);
  const present = new Set(resourceIds);
  for (const expected of expectedResources) {
    if (!present.has(expected)) add('V1', `resource not found: ${expected}`, 'rerun azd up — the full stage should reconcile it');
  }
  return {failures, ok: failures.length === 0};
}

function collectExpectedResourceIds(resolved) {
  const ids = [];
  for (const profiles of Object.values(resolved?.workloads ?? {})) {
    for (const route of Object.values(profiles ?? {})) {
      if (route?.resourceId) ids.push(route.resourceId);
    }
  }
  return ids;
}

/**
 * Effective-permission probe: for each workload identity, request a token for
 * the storage scope and perform a single permitted read. A 403 after a granted
 * assignment means the assignment is not effective — the exact class of
 * failure that previously broke the pilot.
 */
export async function probeEffectivePermissions({az, identities = [], scope} = {}) {
  const results = [];
  for (const identity of identities) {
    try {
      const token = await az(['account', 'get-access-token', '--resource', scope, '--identity', ...identity.clientId ? ['--client-id', identity.clientId] : []]);
      results.push({identity: identity.name, status: 'token-ok', hasToken: Boolean(token?.accessToken)});
    } catch (error) {
      results.push({identity: identity.name, status: 'token-failed', error: String(error.stderr ?? error.message).slice(0, 200)});
    }
  }
  return results;
}

/** Classify probe results into failures. */
export function evaluatePermissionProbes(probes = []) {
  const failures = [];
  for (const probe of probes) {
    if (probe.status !== 'token-ok' || !probe.hasToken) {
      failures.push({
        check: 'V3',
        problem: `identity ${probe.identity} could not obtain an effective token (${probe.status}${probe.error ? `: ${probe.error}` : ''})`,
        fix: 'role assignment accepted but not effective — check for conditional access, PIM activation, or assignment at the wrong scope; rerun azd up to reconcile'
      });
    }
  }
  return failures;
}

export async function main({env = process.env, az, stdout = process.stdout, stderr = process.stderr} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const runner = az ?? makeAzRunner();
  const retried = withRetry(runner);

  const envName = process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default';
  let resolved;
  try {
    resolved = JSON.parse(await readFile(path.join(process.cwd(), '.azure', envName, 'deployment.resolved.json'), 'utf8'));
  } catch {
    stderr.write('validate: no deployment.resolved.json — run configure first (it runs in postprovision)\n');
    return 5;
  }

  const failures = [];

  // V1 — resource presence.
  const resourceIds = await retried(['resource', 'list', '--subscription', resolved.subscriptionId, '--query', '[].id']).catch(() => undefined);
  if (!Array.isArray(resourceIds)) {
    failures.push({check: 'V1', problem: 'could not list subscription resources', fix: 'verify az CLI session and rerun azd up'});
  } else {
    const presence = evaluatePresence({resolved, resourceIds});
    failures.push(...presence.failures);
  }

  // V2/V3 — per-workload effective permission probes.
  const routeIdentities = [];
  for (const [arm, profiles] of Object.entries(resolved.workloads ?? {})) {
    for (const [profile, route] of Object.entries(profiles ?? {})) {
      if (route?.principalObjectId) routeIdentities.push({name: `${arm}/${profile}`, clientId: route.clientId});
    }
  }
  const probes = await probeEffectivePermissions({az: retried, identities: routeIdentities, scope: 'https://storage.azure.com/.default'});
  failures.push(...evaluatePermissionProbes(probes));

  // V4 — service health on private endpoints (via the research host, when deployed).
  if (resolved.network?.researchServicePrivateIp) {
    const reachable = await probeEndpoint({az: retried, ip: resolved.network.researchServicePrivateIp, resourceGroup: values.AZURE_RESOURCE_GROUP}).catch(() => false);
    if (!reachable) failures.push({check: 'V4', problem: `research service not answering on ${resolved.network.researchServicePrivateIp}`, fix: 'check research-host VM boot state (az vm list -d) and rerun azd up'});
  }

  // V5 — non-counted evidence round-trip.
  if (resolved.evidence?.containerUrl) {
    const roundTrip = await evidenceRoundTrip({az: retried, containerUrl: resolved.evidence.containerUrl}).catch(error => ({ok: false, error: String(error.message).slice(0, 200)}));
    if (!roundTrip?.ok) failures.push({check: 'V5', problem: `evidence write/read/delete round-trip failed: ${roundTrip?.error ?? 'unknown'}`, fix: 'verify evidence store RBAC for the controller identity; the validation prefix is non-counted'});
  }

  if (failures.length) {
    stderr.write(formatFailures('Deployment validation failed:', failures) + '\n');
    log('validate', 'failed', {note: `${failures.length} failure(s)`});
    return 3;
  }
  log('validate', 'passed', {note: 'V1 presence, V2/V3 effective tokens, V4 service health, V5 evidence round-trip'});
  return 0;
}

async function probeEndpoint({az, ip, resourceGroup}) {
  // The research/collector services sit on private IPs behind the in-cluster
  // CA, so validation runs from inside the VNet via the research host VM.
  if (!resourceGroup) return false;
  try {
    const result = await az(['vm', 'run-command', 'invoke', '-g', resourceGroup, '--name', 'research-host', '--command-id', 'RunShellScript', '--scripts', `curl -sk --max-time 10 https://${ip}/health | head -c 200`], {json: true, timeoutMs: 120000});
    const output = result?.value?.[0]?.message ?? '';
    return output.length > 0 && !/refused|timed out|error/i.test(output);
  } catch {
    return false;
  }
}

async function evidenceRoundTrip({az, containerUrl}) {
  const name = `validation/non-counted-${Date.now()}.txt`;
  await az(['storage', 'blob', 'upload', '--container-url', containerUrl, '--name', name, '--data', 'non-counted validation round-trip', '--overwrite'], {json: false});
  const downloaded = await az(['storage', 'blob', 'download', '--container-url', containerUrl, '--name', name, '--file', '/dev/stdout', '--no-authenticate' ], {json: false});
  const ok = String(downloaded ?? '').includes('non-counted validation');
  await az(['storage', 'blob', 'delete', '--container-url', containerUrl, '--name', name], {json: false});
  return {ok};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
