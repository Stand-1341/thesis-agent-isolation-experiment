import assert from 'node:assert/strict';
import test from 'node:test';
import { requestIdForScenario } from '../dist/request-id.js';
import { createAcaSandboxPilotAdapter } from './aca-sandbox-pilot-adapter.mjs';

const runId = 'pilot_run_001';
const trial = { runId, scenario: 'U5' };
const diskImageId = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.App/sandboxGroups/group-a/diskImages/node-agent';
const resources = { cpu: '1000m', memory: '2048Mi' };
const identitySettings = [
  { identity: 'system', lifecycle: 'main' },
  { identity: 'image-pull-identity', lifecycle: 'none' },
];
const egressPolicy = { mode: 'deny_all', rules: [{ action: 'allow', host: 'collector.example.test' }] };
const safeEnvironment = {
  THESIS_WORKLOAD_TOKEN_SECRET_URI: 'https://vault.example.test/secrets/mock-workload-token',
  THESIS_SECRET_READER_CLIENT_ID: '00000000-0000-4000-8000-000000000002',
  RESEARCH_URL: 'https://resource.example.test',
};
const lifecycle = { autoSuspendPolicy: { enabled: true, interval: 300, mode: 'Memory' } };

function makeHarness({ base = {}, client = {}, builders = {}, execCommand, timeoutMs } = {}) {
  const calls = { order: [], baseReset: [], baseCollect: [], baseCleanup: [], createSandbox: [], execute: [], egress: [], delete: [] };
  const baseAdapter = {
    async reset(value) {
      calls.baseReset.push(value);
      return { fixtureReset: true, u5Marker: 'SYNTHETIC-fixture-marker', ...base.resetResult };
    },
    async collect(...args) {
      calls.baseCollect.push(args);
      return { fixtureEvidence: true, ...base.collectResult };
    },
    async cleanup(...args) {
      calls.order.push('baseCleanup');
      calls.baseCleanup.push(args);
      if (base.cleanupError) throw new Error(`base leaked ${base.cleanupError}`);
      return base.cleanupResult ?? { cleaned: true };
    },
    ...base.methods,
  };
  const sandboxClient = {
    async createSandbox(body, options) {
      calls.createSandbox.push({ body, options });
      if (client.createError) throw new Error(`create leaked ${client.createError}`);
      return client.createResult ?? { sandboxId: 'sandbox-123', sandbox: { id: 'sandbox-123', state: 'Running' } };
    },
    async executeShellCommand(id, command) {
      calls.execute.push({ id, command });
      if (client.executeError) throw new Error(`execute leaked ${client.executeError}`);
      return client.executeResult ?? {
        exitCode: 0,
        stdout: `${JSON.stringify({ runId: trial.runId, scenario: trial.scenario, transportOk: true, status: 200 })}\n`,
        stderr: '',
      };
    },
    async getEgressDecisions(id) {
      calls.egress.push(id);
      if (client.egressError) throw new Error(`egress leaked ${client.egressError}`);
      return Object.hasOwn(client, 'egressResult') ? client.egressResult : { networkEgress: { allowed: [], denied: [] } };
    },
    async deleteSandbox(id, options) {
      calls.order.push('delete');
      calls.delete.push({ id, options });
      if (client.deleteError) throw new Error(`delete leaked ${client.deleteError}`);
      return undefined;
    },
  };
  const adapter = createAcaSandboxPilotAdapter({
    baseAdapter,
    client: sandboxClient,
    sandboxGroup: 'group-a',
    diskImageId,
    resources,
    environmentForTrial: builders.environmentForTrial ?? (() => safeEnvironment),
    identitySettingsForTrial: builders.identitySettingsForTrial ?? (() => identitySettings),
    egressPolicyForTrial: builders.egressPolicyForTrial ?? (() => egressPolicy),
    ...(execCommand === undefined ? {} : { execCommand }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { adapter, calls };
}

test('reset creates exactly one configured sandbox and never injects secret values', async () => {
  const { adapter, calls } = makeHarness();
  const reset = await adapter.reset(trial);

  assert.deepEqual(calls.baseReset, [trial]);
  assert.equal(calls.createSandbox.length, 1);
  const { body, options } = calls.createSandbox[0];
  assert.equal(body.sourcesRef.diskImage.id, diskImageId);
  assert.deepEqual(body.resources, resources);
  assert.deepEqual(body.lifecycle, lifecycle);
  assert.deepEqual(body.identitySettings, identitySettings);
  assert.deepEqual(body.egressPolicy, egressPolicy);
  assert.deepEqual(body.environment, {
    ...safeEnvironment,
    TRIAL_INPUT_JSON: JSON.stringify({ runId, scenario: 'U5', u5Marker: 'SYNTHETIC-fixture-marker', requestId: requestIdForScenario(runId, 'U5') }),
  });
  assert.deepEqual(options, { timeoutMs: 30_000 });
  assert.equal(reset.fixtureReset, true);
  assert.equal(reset.sandboxId, 'sandbox-123');
  assert.deepEqual(reset.sandboxPolicy, {
    sandboxGroup: 'group-a', diskImageId, resources, lifecycle, identitySettings, egressPolicy,
  });
  const serializedBody = JSON.stringify(body);
  for (const forbidden of ['mockWorkloadToken', 'azureAccessToken', 'WORKLOAD_TOKEN:', 'secret-value-not-configured']) {
    assert.equal(serializedBody.includes(forbidden), false, `unexpected credential material: ${forbidden}`);
  }
});

test('reset uses only the restricted envelope and stable request IDs for correlated scenarios', async () => {
  for (const scenario of ['U1', 'U5', 'U6', 'U8']) {
    const { adapter, calls } = makeHarness();
    const currentTrial = { runId, scenario };
    const reset = await adapter.reset(currentTrial);
    const envelope = JSON.parse(calls.createSandbox[0].body.environment.TRIAL_INPUT_JSON);
    assert.deepEqual(Object.keys(envelope).sort(), scenario === 'U5'
      ? ['requestId', 'runId', 'scenario', 'u5Marker']
      : ['requestId', 'runId', 'scenario']);
    assert.equal(envelope.requestId, requestIdForScenario(runId, scenario));
    assert.equal(reset.sandboxId, 'sandbox-123');
  }
});

test('reset requires a synthetic base marker for U5 and fails before sandbox creation', async () => {
  const { adapter, calls } = makeHarness({ base: { resetResult: { u5Marker: 'real-secret-marker' } } });
  await assert.rejects(adapter.reset(trial), /synthetic marker/i);
  assert.equal(calls.createSandbox.length, 0);
});

test('reset rejects raw credential environment variables without exposing their values', async () => {
  const { adapter, calls } = makeHarness({ builders: {
    environmentForTrial: () => ({ WORKLOAD_TOKEN: 'raw-workload-token-value' }),
  } });
  await assert.rejects(adapter.reset(trial), (error) => {
    assert.match(error.message, /configuration is invalid/i);
    assert.doesNotMatch(error.message, /raw-workload-token-value/);
    return true;
  });
  assert.equal(calls.createSandbox.length, 0);
});

test('reset rejects identity policy that exposes the image-pull identity to the sandbox', async () => {
  const { adapter, calls } = makeHarness({ builders: {
    identitySettingsForTrial: () => [
      { identity: 'workload-identity', lifecycle: 'none' },
      { identity: 'image-pull-identity', lifecycle: 'main' },
    ],
  } });
  await assert.rejects(adapter.reset(trial), /configuration is invalid/i);
  assert.equal(calls.createSandbox.length, 0);
});

test('constructor rejects missing dependencies, invalid image, command, timeout, and builders', () => {
  const good = {
    baseAdapter: { reset: async () => ({}), collect: async () => ({}) },
    client: { createSandbox() {}, executeShellCommand() {}, getEgressDecisions() {}, deleteSandbox() {} },
    sandboxGroup: 'group-a', diskImageId, resources,
    environmentForTrial() { return {}; }, identitySettingsForTrial() { return []; }, egressPolicyForTrial() { return {}; },
  };
  assert.throws(() => createAcaSandboxPilotAdapter({ ...good, client: undefined }), /configuration/i);
  assert.throws(() => createAcaSandboxPilotAdapter({ ...good, diskImageId: '' }), /disk image/i);
  assert.throws(() => createAcaSandboxPilotAdapter({ ...good, diskImageId: 'https://image.example.test/?token=secret' }), /disk image/i);
  assert.throws(() => createAcaSandboxPilotAdapter({ ...good, execCommand: '' }), /command/i);
  assert.throws(() => createAcaSandboxPilotAdapter({ ...good, timeoutMs: 0 }), /timeout/i);
  assert.throws(() => createAcaSandboxPilotAdapter({ ...good, environmentForTrial: null }), /builder/i);
});

test('execute runs the fixed command and accepts exactly one matching JSON result line', async () => {
  const { adapter, calls } = makeHarness();
  const reset = await adapter.reset(trial);
  const output = { runId, scenario: 'U5', transportOk: true, status: 200 };
  calls.execute.length = 0;
  const result = await adapter.execute(trial, reset);

  assert.deepEqual(calls.execute, [{ id: 'sandbox-123', command: 'cd /app && node dist/agent-runner.js' }]);
  assert.deepEqual(result, output);
});

test('execute accepts an explicitly configured fixed command without interpolating trial data', async () => {
  const { adapter, calls } = makeHarness({ execCommand: 'node /opt/agent/runner.js --once' });
  const reset = await adapter.reset(trial);
  await adapter.execute(trial, reset);
  assert.equal(calls.execute[0].command, 'node /opt/agent/runner.js --once');
  assert.equal(calls.execute[0].command.includes(runId), false);
});

test('execute rejects nonzero exit and malformed, ambiguous, or mismatched stdout without exposing process text', async () => {
  const cases = [
    { result: { exitCode: 9, stdout: '{"runId":"pilot_run_001","scenario":"U5"}', stderr: 'Bearer super-secret' }, pattern: /nonzero|failed/i },
    { result: { exitCode: 0, stdout: 'not-json', stderr: '' }, pattern: /stdout|json|result/i },
    { result: { exitCode: 0, stdout: '{"runId":"pilot_run_001","scenario":"U5"}\n{"runId":"pilot_run_001","scenario":"U5"}', stderr: '' }, pattern: /stdout|json|result/i },
    { result: { exitCode: 0, stdout: `${JSON.stringify({ runId: 'another-run', scenario: 'U5' })}\n`, stderr: '' }, pattern: /identity|mismatch/i },
    { result: { exitCode: 0, stdout: `${JSON.stringify({ runId, scenario: 'U4' })}\n`, stderr: '' }, pattern: /identity|mismatch/i },
  ];
  for (const { result, pattern } of cases) {
    const { adapter } = makeHarness({ client: { executeResult: result } });
    const reset = await adapter.reset(trial);
    await assert.rejects(adapter.execute(trial, reset), (error) => {
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /super-secret|Bearer/);
      return true;
    });
  }
});

test('collect delegates with the exact trial/reset and preserves exact-sandbox egress decisions', async () => {
  const telemetry = {
    networkEgress: {
      allowed: [{ host: 'collector.example.test', method: 'POST', path: '/collect', action: 'Allow' }],
      denied: [{ host: 'restricted.example.test', method: 'GET', path: '/restricted', action: 'Deny' }],
    },
    providerExtension: { retained: true },
  };
  const { adapter, calls } = makeHarness({ client: { egressResult: telemetry } });
  const reset = await adapter.reset(trial);
  const output = { runId, scenario: 'U5' };
  const timing = { startedAt: 'start' };
  const evidence = await adapter.collect(trial, reset, output, timing);

  assert.deepEqual(calls.baseCollect, [[trial, reset, output, timing]]);
  assert.deepEqual(calls.egress, ['sandbox-123']);
  assert.deepEqual(evidence.sandboxEgressDecisions, telemetry);
});

test('collect omits missing or malformed telemetry rather than asserting a decision', async () => {
  for (const telemetry of [undefined, null, {},
    { networkEgress: { allowed: [], denied: 'not-an-array' } },
    { networkEgress: { allowed: [null], denied: [] } }]) {
    const { adapter } = makeHarness({
      client: { egressResult: telemetry },
      base: { collectResult: { sandboxEgressDecisions: { networkEgress: { allowed: [], denied: [{ action: 'Deny' }] } } } },
    });
    const reset = await adapter.reset(trial);
    const evidence = await adapter.collect(trial, reset, {}, {});
    assert.equal(Object.hasOwn(evidence, 'sandboxEgressDecisions'), false);
  }
});

test('collect refuses to fetch egress telemetry for a different trial/reset pairing', async () => {
  const { adapter, calls } = makeHarness();
  const reset = await adapter.reset(trial);
  await assert.rejects(adapter.collect({ runId, scenario: 'U1' }, reset, {}, {}), /trial.*reset|mismatch/i);
  assert.equal(calls.egress.length, 0);
});

test('cleanup reports deletion only after client confirmation and then runs base cleanup', async () => {
  const { adapter, calls } = makeHarness();
  assert.equal(adapter.cleanupOnFailure, true);
  const reset = await adapter.reset(trial);
  const result = await adapter.cleanup(trial, reset);

  assert.deepEqual(calls.delete, [{ id: 'sandbox-123', options: { timeoutMs: 30_000 } }]);
  assert.deepEqual(calls.baseCleanup, [[trial, reset]]);
  assert.deepEqual(calls.order, ['delete', 'baseCleanup']);
  assert.deepEqual(result, { sandboxDeleted: true, baseCleanup: { cleaned: true } });
});

test('cleanup does not claim deletion on provider failure but still attempts base cleanup', async () => {
  const { adapter, calls } = makeHarness({ client: { deleteError: 'do-not-leak-this' } });
  const reset = await adapter.reset(trial);
  await assert.rejects(adapter.cleanup(trial, reset), (error) => {
    assert.match(error.message, /cleanup failed/i);
    assert.doesNotMatch(error.message, /do-not-leak-this/);
    return true;
  });
  assert.equal(calls.delete.length, 1);
  assert.equal(calls.baseCleanup.length, 1);
});

test('cleanup aggregates deletion and base-cleanup failures without exposing provider messages', async () => {
  const { adapter, calls } = makeHarness({
    client: { deleteError: 'provider-secret' },
    base: { cleanupError: 'base-secret' },
  });
  const reset = await adapter.reset(trial);
  await assert.rejects(adapter.cleanup(trial, reset), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.doesNotMatch(`${error.message} ${error.errors.map((entry) => entry.message).join(' ')}`, /provider-secret|base-secret/);
    return true;
  });
  assert.equal(calls.baseCleanup.length, 1);
});
