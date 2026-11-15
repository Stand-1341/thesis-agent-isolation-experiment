#!/usr/bin/env node
/**
 * Non-counted deployment validation (azd postup hook).
 *
 * Verifies the deployment — NOT the experiment: zero trials run, nothing is
 * counted, no evidence is produced beyond a validation log.
 *
 *   V1 resource presence : VM arm, ACA Jobs, sandbox groups, stores, identities exist
 *   V2/V3 identity reach : data-plane probe inside a supported workload resource
 *                          or exact-route, integrity-indexed independent pilot proof.
 *                          Controller credentials prove nothing.
 *   V4 service health    : all three private service listeners answer with the host CA
 *   V5 evidence path     : a non-counted write/read/delete round-trip on the
 *                          evidence container under validation/ prefix
 *
 * Role assignment presence and a controller token are not proof of workload
 * identity access. Require a data-plane operation inside that workload.
 */
import {readAzdEnv, makeAzRunner, withRetry, makeStepLogger, formatFailures} from './common.mjs';
import {readFile, mkdtemp, rm, writeFile, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Pure: presence checks over resolved config + live resource listings. */
export function evaluatePresence({resolved, resourceIds = [], sandboxGroups = []} = {}) {
  const failures = [];
  const add = (check, problem, fix) => failures.push({check, problem, fix});
  const expectedResources = collectExpectedResourceIds(resolved);
  const present = new Set([...resourceIds,...sandboxGroups]);
  for (const expected of expectedResources) {
    if (!present.has(expected)) add('V1', `resource not found: ${expected}`, 'rerun azd up — the full stage should reconcile it');
  }
  return {failures, ok: failures.length === 0};
}

function collectExpectedResourceIds(resolved) {
  const ids = new Set();
  for (const profiles of Object.values(resolved?.workloads ?? {})) {
    for (const route of Object.values(profiles ?? {})) {
      for (const key of ['resourceId','sandboxGroupId']) {
        if(typeof route?.[key]==='string'&&route[key]) ids.add(route[key]);
      }
    }
  }
  for(const value of [resolved?.network?.researchHostResourceId,resolved?.evidence?.accountId,resolved?.fixtures?.accountId,
    resolved?.identities?.imagePull?.resourceId]) {
    if(typeof value==='string'&&value) ids.add(value);
  }
  return [...ids];
}

/**
 * Probe storage from the workload host itself. The VM adapter uses Run Command
 * to execute a read-only Python probe and validates both token claims and the
 * expected container-level outcome. ACA Jobs and sandbox groups use exact-route
 * pilot evidence because no tested output-returning probe adapter exists.
 * P3's isolated route cannot use a storage HTTP status as proof of its network
 * boundary; its denial still requires an independently attributed pilot.
 */
export async function probeEffectivePermissions({az, identities = [], scope, fixtureEndpoint, pilotRecords = []} = {}) {
  const probes = [];
  for (const identity of identities) {
    try {
      if (identity.deployment !== 'azure_vm') {
        const proof = matchPilotPermissionEvidence({identity, records: pilotRecords, fixtureEndpoint});
        probes.push(proof.ok
          ? {identity: identity.name, status: 'pilot-evidence-ok', hasIdentityProof: true, ...proof}
          : {identity: identity.name, status: 'pilot-evidence-pending', hasIdentityProof: false,
            pendingReason: proof.error ?? `exact-route pilot evidence is pending for ${identity.deployment ?? 'unknown workload'}`});
        continue;
      }
      const result = identity.profile === 'P3'
        ? (() => { const proof = matchPilotPermissionEvidence({identity, records: pilotRecords, fixtureEndpoint});
          return proof.ok ? {identity: identity.name, status: 'pilot-evidence-ok', hasIdentityProof: true, ...proof} :
            {identity: identity.name, status: 'pilot-evidence-pending', hasIdentityProof: false, pendingReason: proof.error}; })()
        : await probeVmStoragePermission({az, identity, fixtureEndpoint, scope});
      probes.push(result);
    } catch (error) {
      probes.push({identity: identity.name, status: 'probe-failed', error: String(error?.message ?? error).slice(0, 240)});
    }
  }
  return probes;
}

/**
 * Load the optional integrity-indexed pilot records used by deployment validation.
 * This deliberately does not import study-execute: that module imports this one.
 */
export async function readValidationPilotRecords({indexPath, root = path.dirname(indexPath ?? '')} = {}) {
  if (!indexPath) return {records: [], error: 'pilot evidence index is not configured'};
  try {
    const realRoot = await realpath(root);
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    if (!Array.isArray(index.evidenceFiles) || index.evidenceFiles.length === 0)
      throw new Error('pilot index has no evidenceFiles list');
    const records = [], seen = new Set();
    for (const ref of index.evidenceFiles) {
      if (!ref || typeof ref.file !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '') || seen.has(ref.file))
        throw new Error('pilot evidence references are malformed or duplicated');
      seen.add(ref.file);
      const candidate = path.resolve(realRoot, ref.file);
      const rel = path.relative(realRoot, candidate);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
        throw new Error('pilot evidence reference escapes its root');
      const absolute = await realpath(candidate);
      const actualRel = path.relative(realRoot, absolute);
      if (!actualRel || actualRel === '..' || actualRel.startsWith(`..${path.sep}`) || path.isAbsolute(actualRel))
        throw new Error('pilot evidence reference escapes its root');
      const bytes = await readFile(absolute);
      if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
        throw new Error(`pilot evidence digest mismatch: ${ref.file}`);
      const envelope = JSON.parse(bytes.toString('utf8'));
      if (envelope.version !== 1 || typeof envelope.payload !== 'string' ||
          createHash('sha256').update(Buffer.from(envelope.payload, 'utf8')).digest('hex') !== envelope.sha256)
        throw new Error(`invalid pilot evidence envelope: ${ref.file}`);
      records.push(JSON.parse(envelope.payload));
    }
    return {records};
  } catch (error) {
    return {records: [], error: String(error?.message ?? error).slice(0, 240)};
  }
}

export function defaultPilotIndexPath({cwd = process.cwd()} = {}) {
  return path.join(cwd,'Complete_Thesis_Azure_Package','05-DOCKER-STARTER','results','non-counted-pilot','pilot-index.json');
}

/**
 * Accept only a non-counted, independently verified probe bound to this exact
 * resolved route and fixture. The v1 contract is intentionally explicit so a
 * generic pilot classification, controller token, or stale route cannot pass.
 */
export function matchPilotPermissionEvidence({identity, records = [], fixtureEndpoint} = {}) {
  if (!identity?.principalObjectId || !identity?.clientId || !identity?.resourceId || !fixtureEndpoint)
    return {ok: false, error: 'route identity, resource ID, and fixture endpoint are required'};
  if (!['P1', 'P2', 'P3'].includes(identity.profile) || !isAzureBlobAccountRoot(fixtureEndpoint))
    return {ok: false, error: 'pilot evidence requires a supported profile and exact Azure Blob account-root fixture URL'};
  const deployment = identity.deployment, profile = identity.profile;
  const endpointFor = scenario => profile === 'P3'
    ? identity.networkEndpoints?.[scenario]
    : `${fixtureEndpoint.replace(/\/+$/, '')}/restricted-docs`;
  const baseMatch = (record, scenario) => record?.mode === 'non_counted_pilot' &&
    typeof record.runId === 'string' && record.runId.startsWith('pilot-') &&
    record?.trial?.deployment === deployment &&
    (record.trial.permission_profile ?? record.trial.profile) === profile && record.trial.scenario === scenario &&
    record?.verificationEvidence?.deploymentValidation?.schemaVersion === 1 &&
    record.verificationEvidence.deploymentValidation.independent === true &&
    record.verificationEvidence.deploymentValidation.source === 'independent_verifier' &&
    record.verificationEvidence.deploymentValidation.principalObjectId?.toLowerCase() === identity.principalObjectId.toLowerCase() &&
    record.verificationEvidence.deploymentValidation.clientId?.toLowerCase() === identity.clientId.toLowerCase() &&
    record.verificationEvidence.deploymentValidation.resourceId === identity.resourceId &&
    record.verificationEvidence.deploymentValidation.endpoint === endpointFor(scenario);
  if (profile === 'P3') {
    const denials = ['U5', 'U7'].map(scenario => records.find(record => {
      const evidence = record?.verificationEvidence?.deploymentValidation;
      const denial = evidence?.networkDenial;
      const endpoint = endpointFor(scenario);
      return baseMatch(record, scenario) && record.classification === 'confirmed_network_denial' &&
        denial?.scenario === scenario && denial?.outcome === 'blocked' && denial?.target === endpoint &&
        denial?.verifiedBy === 'independent_verifier';
    }));
    return denials.every(record => record && record.verificationEvidence.deploymentValidation.healthyReceiver === true)
      ? {ok: true, source: 'indexed-pilot-network-denials', scenarios: ['U5', 'U7']} :
      {ok: false, error: 'P3 network result is not a permission result; it requires exact-route independently attributed U5 and U7 denial evidence and a healthy receiver'};
  }
  const expected = profile === 'P1' ? 200 : profile === 'P2' ? 403 : undefined;
  const record = records.find(item => baseMatch(item, 'U1') &&
    item.verificationEvidence.deploymentValidation.dataPlaneStatus === expected &&
    item.classification === (profile === 'P1' ? 'unauthorized_success' : 'confirmed_resource_denial'));
  return record ? {ok: true, source: 'indexed-pilot-data-plane', dataPlaneStatus: expected, expectedDataPlaneStatus: expected} :
    {ok: false, error: `no independently verified exact-route U1 pilot outcome for ${profile}`};
}

async function probeVmStoragePermission({az, identity, fixtureEndpoint, scope}) {
  const parsed = parseResourceId(identity.resourceId);
  if (!parsed || !identity.clientId || !identity.principalObjectId || !fixtureEndpoint)
    return {identity: identity.name, status: 'in-resource-probe-unavailable', error: 'VM resource ID, both workload identity IDs, and fixture blob endpoint are required'};
  if (!isAzureBlobAccountRoot(fixtureEndpoint))
    return {identity: identity.name, status: 'in-resource-probe-unavailable', error: 'fixture endpoint must be an exact Azure Blob HTTPS account-root URL'};
  const container = identity.profile === 'P1' ? 'authorized-docs' : 'restricted-docs';
  const expectedHttpStatus = identity.profile === 'P1' ? 200 : identity.profile === 'P2' ? 403 : undefined;
  const script = makeVmStorageProbeScript({clientId: identity.clientId, principalObjectId: identity.principalObjectId,
    containerUrl: `${fixtureEndpoint.replace(/\/+$/, '')}/${container}`, expectedHttpStatus, scope});
  const response = await az(['vm', 'run-command', 'invoke', '--ids', identity.resourceId, '--command-id', 'RunShellScript', '--scripts', script], {json: true, timeoutMs: 120000});
  const message = response?.value?.map(item => item?.message ?? '').join('\n') ?? '';
  const marker = message.match(/WORKLOAD_PERMISSION_PROBE:(\{[^\r\n]*\})/);
  if (!marker) return {identity: identity.name, status: 'probe-failed', error: `VM probe returned no result marker${message ? `: ${message.slice(-180)}` : ''}`};
  let observation;
  try { observation = JSON.parse(marker[1]); }
  catch { return {identity: identity.name, status: 'probe-failed', error: 'VM probe returned malformed result JSON'}; }
  const identityMatches = observation.oid?.toLowerCase() === identity.principalObjectId.toLowerCase() &&
    observation.clientId?.toLowerCase() === identity.clientId.toLowerCase();
  if (!identityMatches) return {identity: identity.name, status: 'probe-failed', error: 'in-resource token claims do not match the configured workload principal and client IDs'};
  if (identity.profile === 'P3') return {identity: identity.name, status: 'probe-failed', hasToken: true,
    error: `P3 network outcome (${observation.networkError ? 'unreachable' : `HTTP ${observation.httpStatus ?? 'no response'}`}) is not a permission result; collect independently attributed network-denial pilot evidence`};
  if (observation.httpStatus !== expectedHttpStatus) return {identity: identity.name, status: 'permission-mismatch', hasToken: true,
    error: `expected fixture container HTTP ${expectedHttpStatus}, got ${observation.httpStatus ?? 'no response'}`};
  return {identity: identity.name, status: 'token-ok', hasToken: true, dataPlaneStatus: observation.httpStatus,
    expectedDataPlaneStatus: expectedHttpStatus};
}

function isAzureBlobAccountRoot(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/i.test(url.hostname) &&
      (url.pathname === '/' || url.pathname === '') && !url.port && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function parseResourceId(resourceId = '') {
  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Compute\/virtualMachines\/([^/]+)$/i.exec(resourceId);
  return match ? {subscriptionId: match[1], resourceGroup: match[2], vmName: match[3]} : undefined;
}

/** Build a shell-safe script: all dynamic values are base64-encoded JSON. */
export function makeVmStorageProbeScript({clientId, principalObjectId, containerUrl, expectedHttpStatus, scope}) {
  const config = Buffer.from(JSON.stringify({clientId, principalObjectId, containerUrl, expectedHttpStatus, scope})).toString('base64');
  const python = [
    'import base64,json,urllib.request,urllib.error,urllib.parse',
    `c=json.loads(base64.b64decode('${config}'))`,
    "q=urllib.parse.urlencode({'api-version':'2018-02-01','resource':'https://storage.azure.com/','client_id':c['clientId']})",
    "req=urllib.request.Request('http://169.254.169.254/metadata/identity/oauth2/token?'+q,headers={'Metadata':'true'})",
    "token=json.load(urllib.request.urlopen(req,timeout=10))['access_token']",
    "claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'==='))",
    "url=c['containerUrl']+'?restype=container&comp=list&maxresults=1'",
    "req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token,'x-ms-version':'2023-11-03'})",
    'network_error=None',
    'try:',
    ' status=urllib.request.urlopen(req,timeout=15).status',
    'except urllib.error.HTTPError as e:',
    ' status=e.code',
    'except urllib.error.URLError as e:',
    ' network_error=str(e.reason)',
    "print('WORKLOAD_PERMISSION_PROBE:'+json.dumps({'oid':claims.get('oid'),'clientId':claims.get('azp') or claims.get('appid'),'httpStatus':status,'networkError':network_error},separators=(',',':')))"
  ].join('\n');
  const encodedPython = Buffer.from(python).toString('base64');
  return `python3 -c "exec(__import__('base64').b64decode('${encodedPython}'))"`;
}

/** Classify probe results into failures. */
export function evaluatePermissionProbes(probes = []) {
  const failures = [];
  for (const probe of probes) {
    if (probe.status === 'pilot-evidence-ok' && probe.hasIdentityProof === true) continue;
    if (probe.status === 'pilot-evidence-pending' && probe.hasIdentityProof !== true) continue;
    if (probe.status !== 'token-ok' || !probe.hasToken || !Number.isInteger(probe.dataPlaneStatus) || !Number.isInteger(probe.expectedDataPlaneStatus) || probe.dataPlaneStatus !== probe.expectedDataPlaneStatus) {
      failures.push({
        check: 'V3',
        problem: `identity ${probe.identity} has no verified in-resource permission probe (${probe.status}${probe.error ? `: ${probe.error}` : ''})`,
        fix: 'configure a data-plane probe executed as this workload identity before treating permissions as effective'
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
  let resolvedBytes;
  try {
    resolvedBytes = await readFile(path.join(process.cwd(), '.azure', envName, 'deployment.resolved.json'));
    resolved = JSON.parse(resolvedBytes.toString('utf8'));
  } catch {
    stderr.write('validate: no deployment.resolved.json — run configure first (it runs in postprovision)\n');
    return 5;
  }

  const failures = [];
  const checks = {V1: false, V2: false, V3: false, V4: false, V5: false};

  // V1 — resource presence.
  const resourceIds = await retried(['resource', 'list', '--subscription', resolved.subscriptionId, '--query', '[].id']).catch(() => undefined);
  if (!Array.isArray(resourceIds)) {
    failures.push({check: 'V1', problem: 'could not list subscription resources', fix: 'verify az CLI session and rerun azd up'});
  } else {
    const presence = evaluatePresence({resolved, resourceIds});
    failures.push(...presence.failures);
    checks.V1 = presence.ok;
  }

  // V2/V3 — per-workload effective permission probes.
  const routeIdentities = [];
  for (const [arm, profiles] of Object.entries(resolved.workloads ?? {})) {
    for (const [profile, route] of Object.entries(profiles ?? {})) {
      if (route?.principalObjectId) routeIdentities.push({name: `${arm}/${profile}`, deployment: arm, profile,
        clientId: route.clientId, principalObjectId: route.principalObjectId, resourceId: route.resourceId ?? route.sandboxGroupId,
        networkEndpoints: {
          U5: resolved.network?.collectorPrivateIp ? `https://${resolved.network.collectorPrivateIp}:8443/` : undefined,
          U7: resolved.network?.restrictedServicePrivateIp ? `https://${resolved.network.restrictedServicePrivateIp}:9443/` : undefined
        }});
    }
  }
  const pilotIndexPath = env.PILOT_INDEX_FILE ?? values.PILOT_INDEX_FILE ?? defaultPilotIndexPath();
  const pilot = await readValidationPilotRecords({indexPath: pilotIndexPath, root: path.dirname(pilotIndexPath)});
  const probes = await probeEffectivePermissions({az: retried, identities: routeIdentities, scope: 'https://storage.azure.com/.default', fixtureEndpoint: resolved.fixtures?.blobEndpoint, pilotRecords: pilot.records});
  const pendingPilotEvidence=probes.filter(probe=>probe.status==='pilot-evidence-pending').map(probe=>probe.identity);
  failures.push(...evaluatePermissionProbes(probes));
  checks.V2 = routeIdentities.length > 0 && probes.length === routeIdentities.length &&
    probes.every(probe => probe.hasToken === true || probe.hasIdentityProof === true || probe.status === 'pilot-evidence-pending');
  checks.V3 = checks.V2 && probes.every(probe => probe.status === 'pilot-evidence-ok' ? probe.hasIdentityProof === true :
    probe.status === 'pilot-evidence-pending' ? true :
    probe.status === 'token-ok' && probe.hasToken === true && Number.isInteger(probe.dataPlaneStatus) && Number.isInteger(probe.expectedDataPlaneStatus) && probe.dataPlaneStatus === probe.expectedDataPlaneStatus);

  // V4 — independently check all three private listeners from the research
  // host. The restricted receiver must be live on its own address/port; a
  // healthy research service or collector does not prove that endpoint exists.
  const serviceListeners = [
    ['research', resolved.network?.researchServicePrivateIp, 443],
    ['collector', resolved.network?.collectorPrivateIp, 8443],
    ['restricted receiver', resolved.network?.restrictedServicePrivateIp, 9443]
  ];
  const missingListeners = serviceListeners.filter(([, ip]) => !ip);
  const researchHostName=String(resolved.network?.researchHostResourceId??'').split('/').filter(Boolean).at(-1)||'research-host';
  const listenerResults = await Promise.all(serviceListeners.map(async ([name, ip, port]) => {
    if (!ip) return {name, reachable: false};
    return {name, reachable: await probeEndpoint({az: retried, ip, port, resourceGroup: values.AZURE_RESOURCE_GROUP,vmName:researchHostName}).catch(() => false)};
  }));
  checks.V4 = missingListeners.length === 0 && listenerResults.every(listener => listener.reachable);
  for (const listener of listenerResults) {
    if (!listener.reachable) failures.push({check: 'V4', problem: `${listener.name} health endpoint is missing or not answering`, fix: 'check the research-host VM, listener IP/port, service process, and TLS certificate setup, then rerun deployment validation'});
  }

  // V5 — non-counted evidence round-trip.
  if (resolved.evidence?.containerUrl) {
    const roundTrip = await evidenceRoundTripWithRetry({az: retried, containerUrl: resolved.evidence.containerUrl})
      .catch(error => ({ok: false, error: String(error.message).slice(0, 200)}));
    checks.V5 = roundTrip?.ok === true;
    if (!checks.V5) failures.push({check: 'V5', problem: `evidence write/read/delete round-trip failed: ${roundTrip?.error ?? 'unknown'}`, fix: 'verify exact-container Blob Data Contributor for the operator and the operator /32 network rule; the validation prefix is non-counted'});
  } else failures.push({check: 'V5', problem: 'evidence container URL is missing from resolved deployment', fix: 'rerun configure and provide the evidence container URL'});

  const validationReport = createValidationReport({resolvedBytes, checks, failures, pendingPilotEvidence});
  await writeFile(path.join(process.cwd(), '.azure', envName, 'deployment-validation.json'), `${JSON.stringify(validationReport, null, 2)}\n`);

  if (failures.length) {
    stderr.write(formatFailures('Deployment validation failed:', failures) + '\n');
    log('validate', 'failed', {note: `${failures.length} failure(s)`});
    return 3;
  }
  log('validate', 'passed', {note: pendingPilotEvidence.length
    ? `V1 presence, V4 service health, V5 evidence round-trip; exact-route pilot evidence pending for ${pendingPilotEvidence.length} route(s)`
    : 'V1 presence, V2/V3 in-resource permissions, V4 service health, V5 evidence round-trip'});
  return 0;
}

/** Build a persisted validation result bound to the exact resolved deployment bytes. */
export function createValidationReport({resolvedBytes, checks = {}, failures = [], pendingPilotEvidence = [], validatedAt = new Date().toISOString()} = {}) {
  return {
    schemaVersion: 1,
    validatedAt,
    resolvedSha256: createHash('sha256').update(resolvedBytes ?? '').digest('hex'),
    status: Object.values(checks).length === 5 && ['V1', 'V2', 'V3', 'V4', 'V5'].every(key => checks[key] === true) && failures.length === 0 ? 'validated' : 'validation-failed',
    checks: Object.fromEntries(['V1', 'V2', 'V3', 'V4', 'V5'].map(key => [key, checks[key] === true])),
    evidence: {V5: {roundTripPassed: checks.V5 === true}},
    pendingPilotEvidence: [...new Set(pendingPilotEvidence)],
    failures
  };
}

/** Verify that a persisted report belongs to these resolved bytes and proves V1–V5. */
export function isValidationReportValid({report, resolvedBytes} = {}) {
  return Boolean(report && resolvedBytes && report.schemaVersion === 1 && report.status === 'validated' &&
    report.resolvedSha256 === createHash('sha256').update(resolvedBytes).digest('hex') &&
    ['V1', 'V2', 'V3', 'V4', 'V5'].every(key => report.checks?.[key] === true) &&
    report.evidence?.V5?.roundTripPassed === true && Array.isArray(report.failures) && report.failures.length === 0);
}

export async function probeEndpoint({az, ip, port = 443, resourceGroup, vmName = 'research-host'}) {
  // All listeners sit on private IPs. Probe from the research host so routing
  // stays inside the VNet; use the host-local CA bundle for TLS verification.
  if (!resourceGroup) return false;
  try {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(vmName)) return false;
    const result = await az(['vm', 'run-command', 'invoke', '-g', resourceGroup, '--name', vmName, '--command-id', 'RunShellScript', '--scripts', `curl --cacert /etc/thesis-research/tls/ca.crt --connect-timeout 5 --max-time 10 --fail --silent --show-error https://${ip}:${port}/health | head -c 200`], {json: true, timeoutMs: 120000});
    const output = result?.value?.[0]?.message ?? '';
    return output.length > 0 && !/refused|timed out|error/i.test(output);
  } catch {
    return false;
  }
}

export async function evidenceRoundTrip({az, containerUrl}) {  const name = `validation/non-counted-${Date.now()}.txt`;
  const blobUrl = `${containerUrl.replace(/\/$/, '')}/${name}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'azure-validation-'));
  const source = path.join(dir, 'payload.txt');
  const destination = path.join(dir, 'download.txt');
  await writeFile(source, 'non-counted validation round-trip', 'utf8');
  try {
    await az(['storage', 'blob', 'upload', '--blob-url', blobUrl, '--file', source, '--overwrite', '--auth-mode', 'login'], {json: false});
    await az(['storage', 'blob', 'download', '--blob-url', blobUrl, '--file', destination, '--auth-mode', 'login'], {json: false});
    const ok = (await readFile(destination, 'utf8')).includes('non-counted validation');
    await az(['storage', 'blob', 'delete', '--blob-url', blobUrl, '--auth-mode', 'login'], {json: false});
    return {ok};
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

async function evidenceRoundTripWithRetry({az,containerUrl,maxAttempts=6,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  let lastError;
  for(let attempt=1;attempt<=maxAttempts;attempt++) {
    try { return await evidenceRoundTrip({az,containerUrl}); }
    catch(error) {
      lastError=error;
      const message=String(error?.stderr??error?.message??error);
      if(attempt===maxAttempts||!/(?:403|Authorization|Forbidden|not authorized)/i.test(message)) throw error;
      await sleep(5000*attempt);
    }
  }
  throw lastError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
