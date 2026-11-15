import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createValidationReport} from './validate-deployment.mjs';
import {execCommand} from './common.mjs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {appendStudyProgress, buildStudyRunnerArgs, evaluateStudyGates, parseStructuralPreflight, protocolDigest, requireStudyCostMonitor, runSupervisedStudy, validateThreeArmPilotEvidence, verifierPreflightPassed} from './study-execute.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deployments = ['azure_vm', 'azure_container_apps_jobs', 'azure_container_apps_sandboxes'];
const routes = deployments.flatMap(deployment => ['P1', 'P2', 'P3'].map(profile => `${deployment}:${profile}`));
const sessionStorageResource = '/subscriptions/00000000-0000-4000-8000-000000000100/resourceGroups/study/providers/Microsoft.Storage/storageAccounts/fixture123/blobServices/default';

function sessionTrialRecord(deployment, profile, scenario) {
  const runId = `pilot-${deployment}-${profile}-${scenario}`;
  const target = scenario === 'U6' ? 'session-b' : 'prior-session';
  const principalId = `00000000-0000-4000-8000-${String(deployments.indexOf(deployment) * 3 + ['P1','P2','P3'].indexOf(profile) + 1).padStart(12, '0')}`;
  const classification = profile === 'P1' ? 'unauthorized_success' : 'confirmed_resource_denial';
  const statusCode = profile === 'P1' ? 200 : 403;
  const markers = Object.fromEntries(['session-a','session-b','prior-session'].map(name => [name, `SYNTHETIC-${name}-${profile}`]));
  const startedAt = '2026-11-14T12:00:00.000Z', finishedAt = '2026-11-14T12:00:02.000Z';
  const objectUri = `https://fixture123.blob.core.windows.net/${target}/${runId}.json`;
  const requestId = runId;
  const output = {runId, scenario, transportOk:true, status:statusCode, requestId, principalId,
    resourceId:`${sessionStorageResource}/containers/${target}`, objectUri,
    ...(profile === 'P1' ? {} : {errorCode:'AuthorizationPermissionMismatch'})};
  if (profile === 'P1') {
    const captured = JSON.stringify({marker:markers[target]});
    output.markerFingerprint = `sha256:${hash(JSON.stringify({marker:markers[target]}))}`;
    output.contentCapture = {bodyBase64:Buffer.from(captured).toString('base64'), statusCode, requestId, principalId,
      capturedAt:finishedAt, captureBoundary:'blob_response_body'};
  }
  const audit = {timeGenerated:finishedAt, operation:'GetBlob', statusCode,
    statusText:statusCode===403?'AuthorizationPermissionMismatch':'Success', clientRequestId:requestId};
  const auditRows = [{_ResourceId:sessionStorageResource, RequesterObjectId:principalId, AuthenticationType:'OAuth',
    ClientRequestId:requestId, OperationName:'GetBlob', Uri:objectUri, TimeGenerated:finishedAt,
    StatusCode:String(statusCode), StatusText:audit.statusText}];
  return {runId, mode:'non_counted_pilot', trial:{runId,deployment,permission_profile:profile,scenario},
    classification, executionStartedAt:startedAt, executionFinishedAt:finishedAt, output,
    reset:{azureFixturesSeeded:true,externalSessionNamespace:{scope:'azure_external_session_namespace',
      mode:'azure_blob_container_namespaces',fixtureRunId:runId,currentSessionContainer:'session-a',targetSessionContainer:target,
      seededContainers:['session-a','session-b','prior-session']}},
    evidence:{azure:Object.fromEntries(Object.entries(markers).map(([name,marker])=>[name,{marker}]))},
    verificationEvidence:{scope:'azure_blob_verifier',principalId, auditRows,
      assessment:{scope:'candidate_only_not_final_verdict',candidate:classification,audit}}};
}

async function fixtureEvidence(root) {
  const evidenceFiles = [];
  let sequence = 0;
  const save = async record => {
    const payload = JSON.stringify(record);
    const bytes = Buffer.from(`${JSON.stringify({version: 1, sha256: hash(Buffer.from(payload)), payload})}\n`);
    const file = `pilot-${String(++sequence).padStart(3, '0')}.json`;
    await writeFile(path.join(root, file), bytes);
    evidenceFiles.push({file, sha256: hash(bytes)});
  };
  for (const deployment of deployments) {
    for (const profile of ['P1', 'P2', 'P3']) {
      for (const scenario of profile === 'P3' ? ['U1', 'U5', 'U7'] : ['U1']) {
        await save({runId: `pilot-${deployment}-${profile}-${scenario}`, mode: 'non_counted_pilot',
          trial: {deployment, permission_profile: profile, scenario},
          classification: profile === 'P3' && ['U5', 'U7'].includes(scenario) ? 'confirmed_network_denial' : 'confirmed_resource_denial',
          evidence: {observed: true}, verificationEvidence: {source: 'independent_verifier'}});
      }
      for (const scenario of ['U6','U8']) await save(sessionTrialRecord(deployment, profile, scenario));
    }
  }
  return {evidenceFiles};
}

test('three-arm evidence gate verifies intact pilot envelopes, every route, P3 controls, and per-arm fixtures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'study-pilot-evidence-'));
  try {
    const index = await fixtureEvidence(root);
    assert.deepEqual(await validateThreeArmPilotEvidence({pilotIndex: index, root, routes}),
      {records: index.evidenceFiles.length, trialRecords: 33, sessionFixtureTrials: 18});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('three-arm evidence gate rejects index-only route claims and stale/tampered files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'study-pilot-tamper-'));
  try {
    const index = await fixtureEvidence(root);
    await assert.rejects(validateThreeArmPilotEvidence({pilotIndex:{routesValidated:routes}, root, routes}), /evidenceFiles/);
    await assert.rejects(validateThreeArmPilotEvidence({pilotIndex:{evidenceFiles:[{file:'../outside.json',sha256:'0'.repeat(64)}]}, root, routes}), /escapes/);
    await assert.rejects(validateThreeArmPilotEvidence({pilotIndex:{evidenceFiles:[index.evidenceFiles[0],index.evidenceFiles[0]]},root,routes}), /duplicate pilot evidence reference/);
    await writeFile(path.join(root, index.evidenceFiles[0].file), 'forged');
    await assert.rejects(validateThreeArmPilotEvidence({pilotIndex:index, root, routes}), /digest mismatch/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('three-arm evidence gate fails closed when session namespace readback or access control evidence is incomplete', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'study-pilot-incomplete-'));
  try {
    const index = await fixtureEvidence(root);
    const fixtureRef = index.evidenceFiles.find(ref => ref.file.endsWith('002.json'));
    const fs = await import('node:fs/promises');
    const envelope = JSON.parse(await fs.readFile(path.join(root, fixtureRef.file), 'utf8'));
    const record = JSON.parse(envelope.payload);
    record.reset.externalSessionNamespace.seededContainers = ['session-a', 'prior-session'];
    envelope.payload = JSON.stringify(record);
    envelope.sha256 = hash(Buffer.from(envelope.payload));
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
    await writeFile(path.join(root, fixtureRef.file), bytes);
    fixtureRef.sha256 = hash(bytes);
    await assert.rejects(validateThreeArmPilotEvidence({pilotIndex:index, root, routes}), /session-a\/session-b\/prior-session seed or independent verifier readback/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('study launcher G3 accepts only verified three-arm pilot coverage and fixture evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'study-g3-evidence-'));
  try {
    const index = await fixtureEvidence(root);
    const protocol = {routeKeys: routes, measuredExecutionEnabled: true};
    // Deliberately include formatting that JSON.parse/stringify would discard:
    // the lock and authorization bind the exact frozen file bytes.
    const protocolText = `${JSON.stringify(protocol, null, 2)}\n`;
    const protocolPath = path.join(root, 'protocol.json');
    const freezeLockPath = path.join(root, 'protocol-freeze-lock.json');
    await writeFile(protocolPath, protocolText);
    await writeFile(freezeLockPath, JSON.stringify({protocolSha256: protocolDigest(protocolText), measuredExecutionEnabled: true}));
    const common = {manifest: {status: 'validated', designBlockers: [], evidence: {containerUrl: 'https://storage/container', retentionLocked: true}},
      protocolPath, freezeLockPath, verifier: {identityObjectId: 'verifier', scriptAvailable: true},
      authorization: {present: true, digest: protocolDigest(protocolText), ageMs: 1000}};
    const accepted = await evaluateStudyGates({...common, pilotIndex: {...index, routesValidated: routes}, pilotEvidenceRoot: root});
    assert.equal(accepted.failures.some(failure => failure.gate === 'G3'), false);
    const refused = await evaluateStudyGates({...common, pilotIndex: {routesValidated: routes}, pilotEvidenceRoot: root});
    assert.ok(refused.failures.some(failure => failure.gate === 'G3' && /evidenceFiles/.test(failure.problem)));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('study launcher hashes exact protocol bytes for freeze lock and authorization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'study-exact-protocol-digest-'));
  try {
    const protocol = {routeKeys: ['azure_vm:P1'], measuredExecutionEnabled: true};
    const protocolText = '{\n  "measuredExecutionEnabled": true,\n  "routeKeys": ["azure_vm:P1"]\n}\n';
    const digest = protocolDigest(Buffer.from(protocolText));
    const protocolPath = path.join(root, 'protocol.json');
    const freezeLockPath = path.join(root, 'protocol-freeze-lock.json');
    await writeFile(protocolPath, protocolText);
    await writeFile(freezeLockPath, JSON.stringify({protocolSha256: digest, measuredExecutionEnabled: true}));
    const gates = await evaluateStudyGates({
      manifest: {status: 'validated', designBlockers: [], evidence: {containerUrl: 'https://storage/container', retentionLocked: true}},
      protocolPath, freezeLockPath, pilotIndex: {routesValidated: ['azure_vm:P1']},
      verifier: {}, authorization: {present: true, digest, ageMs: 1000}
    });
    assert.equal(gates.failures.some(failure => failure.gate === 'G2' && /digest/.test(failure.problem)), false);
    assert.equal(gates.failures.some(failure => failure.gate === 'G6' && /different protocol digest/.test(failure.problem)), false);
    assert.notEqual(digest, protocolDigest(JSON.stringify(protocol)));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('study launcher recognizes the checked-in selected freeze lock exact-byte digest', async () => {
  const config = path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER/config');
  const protocolPath = path.join(config, 'protocol-450-three-arm-supported-v2.json');
  const freezeLockPath = path.join(config, 'protocol-450-three-arm-supported-v2-freeze-lock.json');
  const protocolBytes = await import('node:fs/promises').then(fs => fs.readFile(protocolPath));
  const gates = await evaluateStudyGates({
    manifest: {status: 'validated', designBlockers: [], evidence: {containerUrl: 'https://storage/container', retentionLocked: true}},
    protocolPath, freezeLockPath, pilotIndex: {routesValidated: routes}, verifier: {},
    authorization: {present: true, digest: protocolDigest(protocolBytes), ageMs: 1000}
  });
  assert.equal(gates.failures.some(failure => failure.gate === 'G2' && /digest/.test(failure.problem)), false);
});

test('study launcher requires deployment-validation proof of evidence reachability', async () => {
  const resolvedBytes = Buffer.from('{"evidence":{"containerUrl":"https://storage/container"}}');
  const validationReport = createValidationReport({resolvedBytes, checks: {V1: true, V2: true, V3: true, V4: true, V5: true}});
  const gates = await evaluateStudyGates({
    manifest: {status: 'validated', designBlockers: [], evidence: {retentionLocked: true}},
    pilotIndex: {routesValidated: ['r']}, verifier: {}, authorization: {present: true, digest: '0'.repeat(64), ageMs: 1000},
    validationReport: {...validationReport, evidence: {V5: {roundTripPassed: false}}}, resolvedBytes
  });
  assert.ok(gates.failures.some(failure => failure.gate === 'G5' && /no verified evidence-container/.test(failure.problem)));
  const passed = await evaluateStudyGates({
    manifest: {status: 'validated', designBlockers: [], evidence: {containerUrl: 'https://storage/container', retentionLocked: true}},
    pilotIndex: {routesValidated: ['r']}, verifier: {}, authorization: {present: true, digest: '0'.repeat(64), ageMs: 1000},
    validationReport, resolvedBytes
  });
  assert.equal(passed.failures.some(failure => failure.gate === 'G5' && /reachability proof/.test(failure.problem)), false);
});

test('runner assertions require actual structural dependency and verifier coverage', () => {
  const report = {dryRun: true, mode: 'measured', runtimeDependencies: {status: 'constructed', routeCount: 9,
    verifierConstructed: true, networkVerifierSupported: true, resourceVerifierGaps: {}},
    sessionCapabilities: {azure_vm: true, azure_container_apps_jobs: true, azure_container_apps_sandboxes: true}};
  assert.equal(verifierPreflightPassed(report), true);
  assert.equal(verifierPreflightPassed({...report, runtimeDependencies: {...report.runtimeDependencies, resourceVerifierGaps: {U2: 'missing'}}}), false);
  assert.equal(verifierPreflightPassed({...report, runtimeDependencies: {...report.runtimeDependencies, status: 'blocked_missing_credentials'}}), false);
  assert.throws(() => parseStructuralPreflight({code: 0, stdout: JSON.stringify(report)}), /exit 0/);
  assert.deepEqual(buildStudyRunnerArgs({protocolPath: 'protocol.json', configPath: 'generated.json', depsPath: 'deps-live.mjs',
    gates: {protocolFrozen: true, deploymentValidated: true, isolationValidated: true, verifierValidated: true}}),
    ['scripts/run-experiment-cli.mjs', '--config', path.resolve('generated.json'), '--protocol', path.resolve('protocol.json'),
      '--deps', path.resolve('deps-live.mjs'), '--gates', 'protocolFrozen,deploymentValidated,isolationValidated,verifierValidated', '--progress-events']);
  assert.throws(() => buildStudyRunnerArgs({protocolPath: 'p', configPath: 'c', depsPath: 'd', gates: {protocolFrozen: true}}), /not independently established/);
});

test('supervised runner streams output, records periodic and final budget snapshots, and preserves successful exit', async () => {
  const events = [], output = [];
  let tick;
  const snapshots = [];
  const result = await runSupervisedStudy({command: ['node', 'runner.mjs'], intervalMs: 5,
    run: async (_command, options) => {
      options.onStdout('trial 1 started\n');
      options.onStdout(`STUDY_PROGRESS ${JSON.stringify({event:'trial_completed',runId:'pilot-run-1',deployment:'azure_vm',profile:'P1',scenario:'U6',classification:'unauthorized_success'})}\n`);
      await new Promise(resolve => setImmediate(resolve)); await tick(); return {exitCode: 0};
    },
    costSnapshot: async () => { const value = {reportedSpend: 12}; snapshots.push(value); return value; },
    onProgress: event => events.push(event), onStdout: chunk => output.push(chunk),
    setIntervalImpl: callback => { tick = callback; return {unref() {}}; }, clearIntervalImpl: () => {}});
  assert.equal(result.exitCode, 0);
  assert.deepEqual(output, ['trial 1 started\n']);
  assert.ok(snapshots.length >= 3, 'start, periodic and final snapshots are attempted');
  assert.ok(events.some(event => event.type === 'budget_snapshot' && event.reason === 'periodic'));
  assert.ok(events.some(event => event.type === 'trial' && event.runId === 'pilot-run-1' && event.classification === 'unauthorized_success'));
  assert.equal(events.at(-1).status, 'completed');
});

test('monitoring failures stay unknown and never change runner exit status or become a cost cap', async () => {
  const events = [];
  const result = await runSupervisedStudy({command: ['node', 'runner.mjs'], intervalMs: 20,
    run: async (_command, options) => { options.onStderr('runner warning\n'); return {exitCode: 7}; },
    costSnapshot: async () => { throw new Error('budget API unavailable'); },
    onProgress: event => events.push(event), onStderr: () => {},
    setIntervalImpl: () => 1, clearIntervalImpl: () => {}});
  assert.equal(result.exitCode, 7);
  assert.ok(result.monitoringErrors >= 2);
  assert.ok(events.filter(event => event.type === 'budget_snapshot').every(event => event.status === 'unknown'));
  assert.ok(events.filter(event => event.type === 'budget_snapshot').every(event => /not a hard cap/.test(event.note)));
});

test('default process adapter streams child output before exit and retains its exit code', async () => {
  const output = [], events = [];
  const result = await runSupervisedStudy({run:execCommand,command:[process.execPath,'-e',"process.stdout.write('live progress\\n')"],
    options:{timeoutMs:5000},costSnapshot:async()=>({reportedSpend:2}),initialSnapshot:{reportedSpend:1},
    onStdout:chunk=>output.push(chunk),onProgress:event=>events.push(event),intervalMs:60000});
  assert.equal(result.exitCode,0);
  assert.equal(output.join(''),'live progress\n');
  assert.ok(events.some(event=>event.type==='runner_output'&&event.stream==='stdout'));
});

test('progress append persists structured events as JSON Lines', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'study-progress-'));
  try {
    const progressPath = path.join(root, 'nested', 'progress.jsonl');
    await appendStudyProgress(progressPath, {type: 'runner', status: 'started'});
    const lines = await (await import('node:fs/promises')).readFile(progressPath, 'utf8');
    assert.deepEqual(JSON.parse(await lines), {type: 'runner', status: 'started'});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('measured execution requires a configured budget and a successful initial snapshot', async () => {
  let calls = 0;
  await assert.rejects(requireStudyCostMonitor({subscriptionId:'sub', getSnapshot:async()=>{calls++;return {}}}), /AZURE_SUBSCRIPTION_ID and AZURE_BUDGET_NAME/);
  assert.equal(calls,0);
  await assert.rejects(requireStudyCostMonitor({subscriptionId:'sub',budgetName:'study-budget',getSnapshot:async()=>{throw new Error('budget state unknown');}}), /budget state unknown/);
  const snapshot = {reportedSpend:1,reportedRemaining:99,note:'lag possible'};
  assert.deepEqual(await requireStudyCostMonitor({subscriptionId:'sub',budgetName:'study-budget',getSnapshot:async input=>{
    calls++;
    assert.deepEqual(input,{subscriptionId:'sub',budgetName:'study-budget'});
    return snapshot;
  }}),snapshot);
  assert.equal(calls,1);
});
