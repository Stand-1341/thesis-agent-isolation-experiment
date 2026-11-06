import assert from 'node:assert/strict';
import test from 'node:test';

import { requestIdForScenario } from '../dist/request-id.js';
import { createAcaJobsPilotAdapter } from './aca-jobs-pilot-adapter.mjs';

const JOB_NAME = 'thesis-agent-job';
const IMAGE = 'example.azurecr.io/thesis/agent:pilot-1';
const RUN_ID = 'aca-pilot-run-01';
const EXECUTION_NAME = 'thesis-agent-job-run-001';
const EXECUTION_ID = `/subscriptions/01234567-89ab-cdef-0123-456789abcdef/resourceGroups/rg-pilot/providers/Microsoft.App/jobs/${JOB_NAME}/executions/${EXECUTION_NAME}`;
const RESOURCES = { cpu: 1, memory: '2Gi' };
const TIMING = { startedAt: 123, deadline: 456 };

function execution(status = 'Succeeded', extra = {}) {
  return {
    name: EXECUTION_NAME,
    id: EXECUTION_ID,
    properties: {
      status,
      startTime: '2026-11-05T12:00:00Z',
      endTime: '2026-11-05T12:00:03Z',
      replicaName: 'thesis-agent-job-run-001-replica-abc',
      responseBody: { token: 'must-not-escape' },
      ...extra,
    },
    rawBody: { authorization: 'Bearer must-not-escape' },
  };
}

function makeHarness({
  trial = { runId: RUN_ID, scenario: 'U1' },
  reset = { u5Marker: 'SYNTHETIC-protected-marker' },
  environment = { RESEARCH_URL: 'https://resource.example', AZURE_CLIENT_ID: 'client-id' },
  output = { runId: trial.runId, scenario: trial.scenario, transportOk: true },
  status = 'Succeeded',
  readOutput,
  executionResult = execution(status),
} = {}) {
  const calls = { reset: [], collect: [], starts: [], waits: [], logs: [] };
  const baseAdapter = {
    async reset(...args) { calls.reset.push(args); return reset; },
    async collect(...args) { calls.collect.push(args); return { evidence: 'collected' }; },
  };
  const client = {
    async startJob(...args) {
      calls.starts.push(args);
      return { name: EXECUTION_NAME, id: EXECUTION_ID };
    },
    async waitForExecution(...args) {
      calls.waits.push(args);
      return executionResult;
    },
  };
  const adapter = createAcaJobsPilotAdapter({
    baseAdapter,
    client,
    jobName: JOB_NAME,
    agentImage: IMAGE,
    resources: RESOURCES,
    environmentForTrial: (...args) => {
      calls.environmentArgs = args;
      return environment;
    },
    readOutput: async (args) => {
      calls.logs.push(args);
      return readOutput ? readOutput(args) : output;
    },
    executionTimeoutMs: 9_000,
  });
  return { adapter, calls, baseAdapter, client, trial, reset, output };
}

test('constructor requires dependencies and rejects unsafe job/image/resource settings', () => {
  const valid = {
    baseAdapter: { reset() {}, collect() {} },
    client: { startJob() {}, waitForExecution() {} },
    jobName: JOB_NAME,
    agentImage: IMAGE,
    resources: RESOURCES,
    environmentForTrial() { return {}; },
    readOutput() {},
  };
  assert.throws(() => createAcaJobsPilotAdapter(), /baseAdapter|configuration|required/i);
  for (const invalid of [
    { jobName: '../other' },
    { jobName: 'job/name' },
    { agentImage: 'https://user:password@example.invalid/image:tag' },
    { agentImage: 'registry.example//image:tag' },
    { resources: { cpu: 0, memory: '2Gi' } },
    { resources: { cpu: 1, memory: '../secret' } },
    { executionTimeoutMs: 0 },
  ]) {
    assert.throws(() => createAcaJobsPilotAdapter({ ...valid, ...invalid }));
  }
  assert.throws(() => createAcaJobsPilotAdapter({ ...valid, readOutput: undefined }), /readOutput/i);
});

test('reset delegates the original trial and returns the base fixture state unchanged', async () => {
  const harness = makeHarness();

  const reset = await harness.adapter.reset(harness.trial);

  assert.strictEqual(reset, harness.reset);
  assert.deepEqual(harness.calls.reset, [[harness.trial]]);
});

test('execution posts one top-level complete ACA override and uses the injected log reader', async () => {
  const harness = makeHarness({
    environment: {
      RESEARCH_URL: 'https://resource.example',
      COLLECTOR_URL: 'https://collector.example',
      AZURE_CLIENT_ID: 'client-id',
      AZURE_KEY_VAULT_URI: 'https://vault.example.vault.azure.net/',
      THESIS_WORKLOAD_TOKEN_SECRET_URI: 'https://vault.example.vault.azure.net/secrets/workload-token',
      THESIS_SECRET_READER_CLIENT_ID: 'secret-reader-client-id',
      WORKLOAD_TOKEN: 'must-not-be-forwarded',
      API_SECRET: 'must-not-be-forwarded-either',
      TRIAL_INPUT_JSON: 'caller-value-must-be-replaced',
    },
  });

  const result = await harness.adapter.execute(harness.trial, harness.reset, TIMING);

  assert.deepEqual(Object.keys(harness.calls.starts[0][0]), ['containers']);
  assert.equal(Object.hasOwn(harness.calls.starts[0][0], 'template'), false);
  assert.deepEqual(harness.calls.starts[0][0].containers, [{
    name: 'agent',
    image: IMAGE,
    command: ['node', 'dist/agent-runner.js'],
    resources: RESOURCES,
    env: [
      { name: 'RESEARCH_URL', value: 'https://resource.example' },
      { name: 'COLLECTOR_URL', value: 'https://collector.example' },
      { name: 'AZURE_CLIENT_ID', value: 'client-id' },
      { name: 'AZURE_KEY_VAULT_URI', value: 'https://vault.example.vault.azure.net/' },
      { name: 'THESIS_WORKLOAD_TOKEN_SECRET_URI', value: 'https://vault.example.vault.azure.net/secrets/workload-token' },
      { name: 'THESIS_SECRET_READER_CLIENT_ID', value: 'secret-reader-client-id' },
      { name: 'TRIAL_INPUT_JSON', value: JSON.stringify({
        runId: RUN_ID,
        scenario: 'U1',
        requestId: requestIdForScenario(RUN_ID, 'U1'),
      }) },
    ],
  }]);
  assert.deepEqual(harness.calls.waits, [[EXECUTION_NAME, { timeoutMs: 9_000 }]]);
  assert.deepEqual(harness.calls.starts[0][1], { timeoutMs: 9_000 });
  assert.deepEqual(harness.calls.logs, [{ trial: harness.trial, execution: execution(), reset: harness.reset, timing: TIMING }]);
  assert.deepEqual(harness.calls.environmentArgs, [harness.trial, harness.reset]);
  assert.deepEqual(result.workloadOutput, harness.output);
  assert.equal(JSON.stringify(harness.calls.starts).includes('must-not-be-forwarded'), false);
});

test('request IDs for U1, U5, U6, and U8 are deterministic in the narrow trial envelope', async () => {
  const harness = makeHarness({ readOutput: async ({ trial }) => ({
    runId: trial.runId,
    scenario: trial.scenario,
    transportOk: true,
  }) });
  for (const scenario of ['U1', 'U5', 'U6', 'U8']) {
    const trial = { runId: RUN_ID, scenario };
    await harness.adapter.execute(trial, harness.reset, TIMING);
    const encoded = harness.calls.starts.at(-1)[0].containers[0].env.find(({ name }) => name === 'TRIAL_INPUT_JSON').value;
    assert.deepEqual(JSON.parse(encoded), {
      runId: RUN_ID,
      scenario,
      ...(scenario === 'U5' ? { u5Marker: harness.reset.u5Marker } : {}),
      requestId: requestIdForScenario(RUN_ID, scenario),
    });
  }
  assert.equal(harness.calls.starts.length, 4);
});

test('U5 fails before starting a job when the base fixture lacks a synthetic marker', async () => {
  const harness = makeHarness({ reset: { u5Marker: 'real-secret' }, trial: { runId: RUN_ID, scenario: 'U5' } });

  await assert.rejects(harness.adapter.execute(harness.trial, harness.reset, TIMING), /U5.*synthetic marker/i);
  assert.equal(harness.calls.starts.length, 0);
});

test('trial identifiers and scenarios are validated before environment construction or job start', async () => {
  const harness = makeHarness();
  for (const trial of [
    { runId: '../bad', scenario: 'U1' },
    { runId: RUN_ID, scenario: 'not-a-scenario' },
  ]) {
    await assert.rejects(harness.adapter.execute(trial, harness.reset, TIMING), /runId|scenario/i);
  }
  assert.equal(harness.calls.starts.length, 0);
  assert.equal(harness.calls.environmentArgs, undefined);
});

test('failed ACA execution status fails closed without consulting the log reader', async () => {
  const harness = makeHarness({ status: 'Failed' });

  await assert.rejects(harness.adapter.execute(harness.trial, harness.reset, TIMING), error => {
    assert.match(error.message,/execution.*Failed|Failed.*execution/i);
    assert.equal(error.providerExecution.provider,'azure_container_apps_jobs');
    assert.equal(error.providerExecution.startTime,'2026-11-05T12:00:00Z');
    assert.equal(error.providerExecution.endTime,'2026-11-05T12:00:03Z');
    return true;
  });
  assert.equal(harness.calls.logs.length, 0);
});

test('missing or ambiguous injected log output fails closed', async () => {
  const missing = makeHarness({ readOutput: async () => undefined });
  await assert.rejects(missing.adapter.execute(missing.trial, missing.reset, TIMING), /output|log/i);
  for (const output of [null, [], [{ runId: RUN_ID, scenario: 'U1' }]]) {
    const harness = makeHarness({ output });
    await assert.rejects(harness.adapter.execute(harness.trial, harness.reset, TIMING), /output|log/i);
  }
});

test('log output for a different run or scenario is rejected', async () => {
  for (const output of [
    { runId: 'another-run', scenario: 'U1' },
    { runId: RUN_ID, scenario: 'U5' },
  ]) {
    const harness = makeHarness({ output });
    await assert.rejects(harness.adapter.execute(harness.trial, harness.reset, TIMING), /output.*match|mismatch/i);
  }
});

test('returns the explicit workload/provider envelope with allowlisted ARM execution metadata', async () => {
  const rawExecution = execution('Succeeded', {
    authorization: 'Bearer execution-secret',
    endTime: '2026-11-05T12:00:03Z',
  });
  const harness = makeHarness({ executionResult: rawExecution });

  const result = await harness.adapter.execute(harness.trial, harness.reset, TIMING);

  assert.deepEqual(result, {
    workloadOutput: harness.output,
    providerExecution: {
      provider: 'azure_container_apps_jobs',
      name: EXECUTION_NAME,
      id: EXECUTION_ID,
      status: 'Succeeded',
      startTime: '2026-11-05T12:00:00Z',
      endTime: '2026-11-05T12:00:03Z',
      replicaName: 'thesis-agent-job-run-001-replica-abc',
    },
  });
  assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
  assert.equal(JSON.stringify(result).includes('execution-secret'), false);
});

test('rejects missing, malformed, or reversed authoritative ARM execution timestamps',async()=>{
  const invalidCases=[
    {startTime:undefined},
    {endTime:undefined},
    {startTime:'2026-02-30T12:00:00Z'},
    {startTime:'not-an-rfc3339-time'},
    {endTime:'2026-11-05T11:59:59Z'},
    {startTime:'2026-11-05T12:00:00.1239Z',endTime:'2026-11-05T12:00:00.1231Z'},
  ];
  for(const extra of invalidCases) {
    const result=execution('Succeeded',extra);
    if(extra.endTime==='2026-11-05T11:59:59Z') result.properties.startTime='2026-11-05T12:00:00Z';
    const harness=makeHarness({executionResult:result});
    await assert.rejects(harness.adapter.execute(harness.trial,harness.reset,TIMING),/timestamp|time/i);
    assert.equal(harness.calls.logs.length,0);
  }
});

test('execution response must belong to the started execution', async () => {
  const harness = makeHarness({ executionResult: { ...execution(), name: 'different-execution' } });

  await assert.rejects(harness.adapter.execute(harness.trial, harness.reset, TIMING), /execution.*match|mismatch/i);
  assert.equal(harness.calls.logs.length, 0);
});

test('malformed environment output is rejected rather than serialized into the override', async () => {
  for (const environment of [null, ['not', 'a', 'map'], { BAD_NAME: 42 }]) {
    const harness = makeHarness({ environment });
    await assert.rejects(harness.adapter.execute(harness.trial, harness.reset, TIMING), /environment|env/i);
  }
  const harness = makeHarness({ environment: { 'BAD=NAME': 'value' } });
  await assert.rejects(harness.adapter.execute(harness.trial, harness.reset, TIMING), /environment|env/i);
});

test('collect delegates all arguments and there is no per-trial resource cleanup', async () => {
  const harness = makeHarness();
  const output = { runId: RUN_ID, scenario: 'U1' };

  const evidence = await harness.adapter.collect(harness.trial, harness.reset, output, TIMING);

  assert.deepEqual(evidence, { evidence: 'collected' });
  assert.deepEqual(harness.calls.collect, [[harness.trial, harness.reset, output, TIMING]]);
  assert.equal(Object.hasOwn(harness.adapter, 'cleanup'), false);
});
