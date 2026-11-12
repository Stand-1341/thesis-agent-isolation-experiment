import test from 'node:test';
import assert from 'node:assert/strict';
import {isTransientAzureFailure, withRetry, makeCheckpointStore, makeAzRunner, formatFailures} from './common.mjs';
import {evaluatePreflight, cidrsOverlap, REQUIRED_PROVIDERS} from './preflight.mjs';
import {hashBuildContext, resolveImageDigest} from './publish-images.mjs';
import {resolveConfiguration, renderExperimentConfig} from './configure.mjs';
import {evaluatePresence, evaluatePermissionProbes} from './validate-deployment.mjs';
import {evaluateTeardownGuard, identifyChargedSurvivors, parseArgs} from './teardown.mjs';
import {protocolDigest, evaluateStudyGates, readAuthorization} from './study-execute.mjs';
import {buildManifest, renderReport, DESIGN_BLOCKERS} from './readiness-report.mjs';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const PASS_FACTS = {
  subscription: {id: '00000000-0000-0000-0000-000000000000', state: 'Enabled'},
  rolePermissions: [{actions: ['*']}],
  providers: Object.fromEntries(REQUIRED_PROVIDERS.map(p => [p, 'Registered'])),
  regionAvailable: true,
  quota: {vmFamilyLimit: 50, vmFamilyUsed: 4, vmNeeded: 4},
  skuRestricted: [],
  existingVnetPrefixes: ['10.20.0.0/16'],
  budgetPresent: true,
  skipBudget: false
};

test('common: transient Azure failure detection', () => {
  assert.equal(isTransientAzureFailure({exitCode: 1, stderr: 'RequestTimeout: try again'}), true);
  assert.equal(isTransientAzureFailure({exitCode: 1, stderr: 'ValidationError: bad template'}), false);
  assert.equal(isTransientAzureFailure({exitCode: 0}), false);
});

test('common: withRetry retries transient then succeeds', async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    if (calls < 3) { const e = new Error('429 throttl'); e.exitCode = 1; throw e; }
    return 'ok';
  };
  const retried = withRetry(run, {attempts: 4, baseDelayMs: 1, sleep: async () => {}, jitter: () => 0});
  assert.equal(await retried('x'), 'ok');
  assert.equal(calls, 3);
});

test('common: withRetry does not retry non-transient', async () => {
  let calls = 0;
  const run = async () => { calls += 1; const e = new Error('ValidationError'); e.exitCode = 1; throw e; };
  const retried = withRetry(run, {attempts: 4, baseDelayMs: 1, sleep: async () => {}, jitter: () => 0});
  await assert.rejects(retried('x'));
  assert.equal(calls, 1);
});

test('common: checkpoint store marks, reads and clears', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ck-'));
  const store = makeCheckpointStore({statePath: path.join(dir, 'state.json'), now: () => '2026-11-12T00:00:00Z'});
  assert.equal(await store.has('step1'), false);
  await store.mark('step1', {digest: 'sha256:abc'});
  assert.equal(await store.has('step1'), true);
  const state = await store.load();
  assert.equal(state.checkpoints.step1.digest, 'sha256:abc');
  await store.clear('step1');
  assert.equal(await store.has('step1'), false);
  await rm(dir, {recursive: true, force: true});
});

test('preflight: cidrsOverlap basic cases', () => {
  assert.equal(cidrsOverlap('10.48.0.0/16', '10.48.9.0/24'), true);
  assert.equal(cidrsOverlap('10.48.0.0/16', '10.49.0.0/16'), false);
  assert.equal(cidrsOverlap('0.0.0.0/0', '192.168.0.0/24'), true);
});

test('preflight: healthy subscription passes', () => {
  const result = evaluatePreflight(PASS_FACTS);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

test('preflight: unregistered provider fails with fix', () => {
  const facts = {...PASS_FACTS, providers: {...PASS_FACTS.providers, 'Microsoft.App': 'NotRegistered'}};
  const {failures} = evaluatePreflight(facts);
  assert.equal(failures.length, 1);
  assert.match(failures[0].fix, /az provider register --namespace Microsoft.App/);
});

test('preflight: missing role assignment permission fails', () => {
  const facts = {...PASS_FACTS, rolePermissions: [{actions: ['Microsoft.Resources/deployments/write']}]};
  const {failures} = evaluatePreflight(facts);
  assert.ok(failures.some(f => f.check === 'rbac' && f.problem.includes('roleAssignments/write')));
});

test('preflight: quota headroom shortfall fails', () => {
  const facts = {...PASS_FACTS, quota: {vmFamilyLimit: 6, vmFamilyUsed: 4, vmNeeded: 4}};
  const {failures} = evaluatePreflight(facts);
  assert.ok(failures.some(f => f.check === 'quota'));
});

test('preflight: address-space overlap with existing vnet fails', () => {
  const facts = {...PASS_FACTS, existingVnetPrefixes: ['10.48.100.0/24']};
  const {failures} = evaluatePreflight(facts);
  assert.ok(failures.some(f => f.check === 'address-space' && f.problem.includes('10.48.100.0/24')));
});

test('preflight: SKU restriction fails', () => {
  const facts = {...PASS_FACTS, skuRestricted: ['Standard_F1as_v7']};
  const {failures} = evaluatePreflight(facts);
  assert.ok(failures.some(f => f.check === 'sku'));
});

test('preflight: missing budget fails unless skipped', () => {
  const facts = {...PASS_FACTS, budgetPresent: false};
  assert.ok(evaluatePreflight(facts).failures.some(f => f.check === 'budget'));
  assert.equal(evaluatePreflight({...facts, skipBudget: true}).failures.length, 0);
});

test('preflight: disabled subscription fails auth gate', () => {
  const facts = {...PASS_FACTS, subscription: {...PASS_FACTS.subscription, state: 'Disabled'}};
  assert.ok(evaluatePreflight(facts).failures.some(f => f.check === 'auth'));
});

test('publish-images: build context hash is stable and content-sensitive', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ctx-'));
  const a = await hashBuildContext({dir});
  const b = await hashBuildContext({dir});
  assert.equal(a, b);
  await writeFile(path.join(dir, 'package.json'), '{"changed":true}');
  const c = await hashBuildContext({dir});
  assert.notEqual(a, c);
  await rm(dir, {recursive: true, force: true});
});

test('publish-images: resolveImageDigest validates digest shape', async () => {
  const good = 'sha256:' + 'a'.repeat(64);
  const az = async args => {
    if (args[1] === 'repository' && args[2] === 'show') return good;
    throw new Error('unexpected call');
  };
  assert.equal(await resolveImageDigest({az, registry: 'r'}), good);
  const badAz = async () => 'latest';
  await assert.rejects(resolveImageDigest({az: badAz, registry: 'r'}), /non-digest/);
});

const GOOD_OUTPUTS = {
  registryServer: 'thesisacr',
  controllerIdentityClientId: '11111111-1111-1111-1111-111111111111',
  controllerIdentityObjectId: '22222222-2222-2222-2222-222222222222',
  verifierIdentityObjectId: '33333333-3333-3333-3333-333333333333',
  secretReaderIdentityObjectId: '44444444-4444-4444-4444-444444444444',
  fixtureOwnerIdentityObjectId: '55555555-5555-5555-5555-555555555555',
  sandboxControlIdentityClientId: '66666666-6666-6666-6666-666666666666',
  imagePullIdentityResourceId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.ManagedIdentity/userAssignedIdentities/imgpull',
  virtualNetworkId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/virtualNetworks/vnet',
  researchServicePrivateIp: '10.48.9.4',
  collectorPrivateIp: '10.48.9.5',
  evidenceAccountId: '/subscriptions/x/evidence',
  evidenceContainerUrl: 'https://evidence.blob.core.windows.net/evd',
  fixtureAccountId: '/subscriptions/x/fixture',
  fixtureBlobEndpoint: 'https://fixture.blob.core.windows.net/fx',
  logWorkspaceId: '/subscriptions/x/logs',
  jobsEnvironmentId: 'env1',
  jobsP3EnvironmentId: 'env2',
  experimentConfigRoutes: {
    azure_vm: {
      P1: {principalObjectId: 'a', resourceId: '/subscriptions/x/vmP1'},
      P2: {principalObjectId: 'b', resourceId: '/subscriptions/x/vmP2'},
      P3: {principalObjectId: 'c', resourceId: '/subscriptions/x/vmP3'}
    },
    aca_jobs: {
      P1: {principalObjectId: 'd', clientId: 'd1', resourceId: '/subscriptions/x/jobP1'},
      P2: {principalObjectId: 'e', clientId: 'e1', resourceId: '/subscriptions/x/jobP2'},
      P3: null
    },
    aca_sandboxes: {
      P1: {principalObjectId: 'f', clientId: 'f1', sandboxGroupId: '/subscriptions/x/sbP1'},
      P2: {principalObjectId: 'g', clientId: 'g1', sandboxGroupId: '/subscriptions/x/sbP2'},
      P3: {principalObjectId: 'h', clientId: 'h1', sandboxGroupId: '/subscriptions/x/sbP3'}
    }
  }
};

test('configure: healthy outputs resolve without problems', () => {
  const {problems, resolved} = resolveConfiguration({outputs: GOOD_OUTPUTS, env: {AZURE_SUBSCRIPTION_ID: 'sub'}});
  assert.deepEqual(problems, []);
  assert.equal(resolved.identities.controller.clientId, '11111111-1111-1111-1111-111111111111');
});

test('configure: missing infra output reports the exact key', () => {
  const outputs = {...GOOD_OUTPUTS, verifierIdentityObjectId: ''};
  const {problems} = resolveConfiguration({outputs, env: {AZURE_SUBSCRIPTION_ID: 'sub'}});
  assert.ok(problems.some(p => p.includes('verifierIdentityObjectId')));
});

test('configure: route with no principal is reported', () => {
  const outputs = structuredClone(GOOD_OUTPUTS);
  outputs.experimentConfigRoutes.aca_jobs.P2.principalObjectId = '';
  const {problems} = resolveConfiguration({outputs, env: {AZURE_SUBSCRIPTION_ID: 'sub'}});
  assert.ok(problems.some(p => p.includes('aca_jobs/P2')));
});

test('configure: experiment config renders deployed/undeployed routes and flags missing image', () => {
  const {resolved} = resolveConfiguration({outputs: GOOD_OUTPUTS, env: {AZURE_SUBSCRIPTION_ID: 'sub'}});
  const rendered = renderExperimentConfig({resolved, env: {}});
  assert.equal(rendered.config.routes.aca_jobs.P3.deployed, false);
  assert.equal(rendered.config.routes.azure_vm.P1.deployed, true);
  assert.ok(rendered.problems.some(p => p.includes('AGENT_IMAGE_DIGEST')));
  const resolvedWithImage = resolveConfiguration({outputs: GOOD_OUTPUTS, env: {AZURE_SUBSCRIPTION_ID: 'sub', AGENT_IMAGE_DIGEST: 'sha256:' + 'f'.repeat(64)}}).resolved;
  const withImage = renderExperimentConfig({resolved: resolvedWithImage, env: {}});
  assert.deepEqual(withImage.problems, []);
  assert.equal(withImage.config.routes.aca_jobs.P3.deployed, false);
});

test('validate: presence check flags missing resources', () => {
  const resolved = {workloads: GOOD_OUTPUTS.experimentConfigRoutes};
  const resourceIds = ['/subscriptions/x/vmP1', '/subscriptions/x/vmP2'];
  const {failures} = evaluatePresence({resolved, resourceIds});
  // vmP3, jobP1, jobP2 are expected but absent (sandbox routes carry sandboxGroupId, not resourceId)
  assert.equal(failures.length, 3);
  assert.ok(failures.every(f => f.check === 'V1'));
});

test('validate: token-failed identity becomes an effective-permission failure', () => {
  const probes = [
    {identity: 'aca_jobs/P1', status: 'token-ok', hasToken: true},
    {identity: 'aca_jobs/P2', status: 'token-failed', error: 'AADSTS50053'}
  ];
  const failures = evaluatePermissionProbes(probes);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].check, 'V3');
  assert.match(failures[0].fix, /not effective/);
});

test('validate: token-ok without token also fails', () => {
  const failures = evaluatePermissionProbes([{identity: 'x', status: 'token-ok', hasToken: false}]);
  assert.equal(failures.length, 1);
});

test('teardown: guard allows when only validation blobs exist', () => {
  const decision = evaluateTeardownGuard({blobs: ['validation/non-counted-1.txt']});
  assert.equal(decision.allowed, true);
});

test('teardown: guard refuses when counted evidence present', () => {
  const decision = evaluateTeardownGuard({blobs: ['trials/2026/row-1.json']});
  assert.equal(decision.allowed, false);
  assert.match(decision.fix, /--export-evidence|--force/);
});

test('teardown: export option allows and counts exports', () => {
  const decision = evaluateTeardownGuard({blobs: ['trials/a.json', 'validation/x'], exportEvidence: '/tmp/ev'});
  assert.equal(decision.allowed, true);
  assert.equal(decision.exports, 1);
});

test('teardown: force is explicitly marked destructive', () => {
  const decision = evaluateTeardownGuard({blobs: ['trials/a.json'], force: true});
  assert.equal(decision.allowed, true);
  assert.equal(decision.destructive, true);
});

test('teardown: charged survivors exclude the managed group', () => {
  const survivors = identifyChargedSurvivors({
    subscriptionResources: [
      {id: '/subscriptions/x/resourceGroups/rg-managed/providers/Microsoft.Storage/storageAccounts/inside', type: 'Microsoft.Storage/storageAccounts'},
      {id: '/subscriptions/x/resourceGroups/rg-other/providers/Microsoft.Storage/storageAccounts/outside', type: 'Microsoft.Storage/storageAccounts'},
      {id: '/subscriptions/x/resourceGroups/rg-other/providers/Microsoft.Web/sites/irrelevant', type: 'Microsoft.Web/sites'}
    ],
    managedResourceGroup: '/subscriptions/x/resourceGroups/rg-managed'
  });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].id, /outside/);
});

test('teardown: argument parsing rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--nuke']), /unknown argument/);
  assert.equal(parseArgs(['--guard', '--export-evidence', '/tmp/x']).exportEvidence, '/tmp/x');
  assert.throws(() => parseArgs(['--guard', '--export-evidence']), /requires a directory/);
});

test('study-execute: fresh matching authorization passes G6', async () => {
  const protocol = {name: 'p450', rows: 450};
  const text = JSON.stringify(protocol);
  const digest = protocolDigest(text);
  const lock = {protocolSha256: digest};
  const dir = await mkdtemp(path.join(tmpdir(), 'auth-'));
  const authFile = path.join(dir, 'AUTH.txt');
  await writeFile(authFile, `I authorize measured execution of protocol sha256:${digest}\n`);
  const auth = await readAuthorization({authPath: authFile, now: Date.now()});
  const gates = await evaluateStudyGates({
    manifest: {status: 'validated', evidence: {retentionLocked: true}, routes: ['azure_vm/P1']},
    protocolText: text,
    protocolPath: 'protocol.json',
    freezeLockPath: 'lock.json',
    pilotIndex: {routesValidated: ['azure_vm/P1']},
    verifier: {identityObjectId: 'v', scriptAvailable: true},
    authorization: auth
  });
  // G2 needs files on disk; supply them
  assert.ok(gates.failures.every(f => f.gate !== 'G6'));
  await rm(dir, {recursive: true, force: true});
});

test('study-execute: stale authorization fails G6', async () => {
  const auth = {present: true, digest: 'x', ageMs: 30 * 24 * 60 * 60 * 1000};
  const gates = await evaluateStudyGates({manifest: {status: 'validated', evidence: {retentionLocked: true}}, pilotIndex: {routesValidated: ['r']}, verifier: {identityObjectId: 'v', scriptAvailable: true}, authorization: auth});
  assert.ok(gates.failures.some(f => f.gate === 'G6' && /stale/.test(f.problem)));
});

test('study-execute: unlocked retention fails G5', async () => {
  const gates = await evaluateStudyGates({manifest: {status: 'validated', evidence: {retentionLocked: false}}, pilotIndex: {routesValidated: ['r']}, verifier: {identityObjectId: 'v', scriptAvailable: true}, authorization: {present: true, digest: undefined, ageMs: 1000}});
  assert.ok(gates.failures.some(f => f.gate === 'G5' && /retention/.test(f.problem)));
});

test('study-execute: unvalidated deployment fails G1 and blocks everything', async () => {
  const gates = await evaluateStudyGates({manifest: {status: 'validation-failed'}, pilotIndex: {routesValidated: []}, verifier: {}, authorization: {present: false}});
  assert.ok(gates.failures.some(f => f.gate === 'G1'));
  assert.equal(gates.ok, false);
});

test('readiness-report: manifest marks measured study blocked by design blockers', () => {
  const resolved = {workloads: GOOD_OUTPUTS.experimentConfigRoutes, subscriptionId: 'sub', location: 'centralus', registry: {agentImage: 'x@sha256:' + '0'.repeat(64)}};
  const manifest = buildManifest({resolved, checkpointState: {checkpoints: {publishImages: {}}}, env: {}, validationPassed: true, designBlockers: DESIGN_BLOCKERS});
  assert.equal(manifest.status, 'validated');
  assert.equal(manifest.measuredStudyReady, false);
  assert.equal(manifest.routes.length, 8);
  const report = renderReport(manifest);
  assert.match(report, /p3-network-denial-telemetry/);
  assert.match(report, /study:execute/);
});

test('readiness-report: clean design state flips measuredStudyReady', () => {
  const resolved = {workloads: GOOD_OUTPUTS.experimentConfigRoutes, subscriptionId: 'sub', location: 'centralus', registry: {agentImage: 'x'}};
  const manifest = buildManifest({resolved, checkpointState: {}, env: {}, validationPassed: true, designBlockers: []});
  assert.equal(manifest.measuredStudyReady, true);
});

test('common: formatFailures renders check/problem/fix blocks', () => {
  const text = formatFailures('title', [{check: 'a', problem: 'p', fix: 'f'}]);
  assert.match(text, /✗ a: p/);
  assert.match(text, /fix: f/);
});

test('resolve-inputs: ssh public key found from candidate path', async () => {
  const {resolveSshPublicKey} = await import('./resolve-inputs.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'ssh-'));
  const keyPath = path.join(dir, 'id_ed25519.pub');
  await writeFile(keyPath, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample\n');
  const result = await resolveSshPublicKey({config: {vm: {sshPublicKeyPath: keyPath}}, envDir: dir, env: {}, read: readFile});
  assert.equal(result.value.startsWith('ssh-ed25519 '), true);
  await rm(dir, {recursive: true, force: true});
});

test('resolve-inputs: config trustedControllerIp wins over network lookup', async () => {
  const {resolveEgressIp} = await import('./resolve-inputs.mjs');
  const result = await resolveEgressIp({config: {trustedControllerIp: '1.2.3.4/32'}, fetchImpl: async () => { throw new Error('should not be called'); }});
  assert.deepEqual(result, {value: '1.2.3.4/32', source: 'config'});
});

test('resolve-inputs: egress IP validated before use', async () => {
  const {resolveEgressIp} = await import('./resolve-inputs.mjs');
  const garbage = await resolveEgressIp({config: {}, fetchImpl: async () => ({text: async () => 'not-an-ip'})});
  assert.equal(garbage, undefined);
  const good = await resolveEgressIp({config: {}, fetchImpl: async () => ({text: async () => '203.0.113.7\n'})});
  assert.deepEqual(good, {value: '203.0.113.7/32', source: 'https://api.ipify.org'});
});

test('resolve-inputs: loadDeploymentConfig tolerates missing file', async () => {
  const {loadDeploymentConfig} = await import('./resolve-inputs.mjs');
  assert.deepEqual(await loadDeploymentConfig({read: async () => { throw new Error('enoent'); }}), {});
});

test('postprovision: orchestration calls publish → env set → provision → configure in order', async () => {
  const {main} = await import('./postprovision.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'pp-'));
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    const store = makeCheckpointStore({statePath: path.join(dir, '.azure', 'test', 'deployment-state.json')});
    await store.mark('publishImages', {digest: 'sha256:' + '1'.repeat(64), registry: 'thesisacr', sourceKey: 'k'});
    const calls = [];
    const code = await main({
      env: {AZURE_ENV_NAME: 'test', PROVISION_STAGE: 'foundation'},
      stdout: {write: () => {}}, stderr: {write: () => {}},
      checkpoints: store,
      runProvision: async () => { calls.push('provision'); return {exitCode: 0}; },
      publish: async () => { calls.push('publish'); return 0; },
      configureStep: async () => { calls.push('configure'); return 0; }
    });
    assert.equal(code, 0);
    assert.deepEqual(calls, ['publish', 'provision', 'configure']);
    // full-stage checkpoint recorded → rerun skips reprovision and only reconfigures
    const rerunCalls = [];
    const rerun = await main({
      env: {AZURE_ENV_NAME: 'test', PROVISION_STAGE: 'full'},
      stdout: {write: () => {}}, stderr: {write: () => {}},
      checkpoints: store,
      runProvision: async () => { rerunCalls.push('provision'); return {exitCode: 0}; },
      publish: async () => { rerunCalls.push('publish'); return 0; },
      configureStep: async () => { rerunCalls.push('configure'); return 0; }
    });
    assert.equal(rerun, 0);
    assert.deepEqual(rerunCalls, ['configure']);
    // env fallback wrote the pinned digest + stage without azd present
    const envFile = await readFile(path.join(dir, '.azure', 'test', '.env'), 'utf8');
    assert.match(envFile, /PROVISION_STAGE=full/);
    assert.match(envFile, /AGENT_IMAGE_DIGEST=sha256:/);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, {recursive: true, force: true});
  }
});
