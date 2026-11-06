import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASELINE_STATUS,
  createAcaJobsNoopBaseline,
  evaluateNoopBaseline,
} from './aca-jobs-noop-baseline.mjs';

const SUBSCRIPTION_ID = '01234567-89ab-cdef-0123-456789abcdef';
const JOB_NAME = 'job-test';
const EXECUTION_NAME = 'job-test-baseline-001';
const EXECUTION_ID = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-test/providers/Microsoft.App/jobs/${JOB_NAME}/executions/${EXECUTION_NAME}`;
const OTHER_JOB_EXECUTION_ID = EXECUTION_ID.replace(`jobs/${JOB_NAME}`, 'jobs/other-job');
const PINNED_IMAGE = `registry.example.com/thesis/agent@sha256:${'a'.repeat(64)}`;
const RESOURCES = { cpu: 0.5, memory: '1Gi' };
const TIMEOUT_MS = 90_000;
const START = '2026-11-05T12:00:00Z';
const END = '2026-11-05T12:01:00Z';
const ALLOWED_URL = 'https://Health.Example.com/status';
const NORMALIZED_URL = 'https://health.example.com/status';
const TARGET_FQDN = 'health.example.com';
const CANARY = 'raw-log-secret-token';

function makeClient(overrides = {}) {
  const calls = [];
  const started = overrides.started ?? { name: EXECUTION_NAME, id: EXECUTION_ID };
  const waited = overrides.waited ?? {
    name: EXECUTION_NAME,
    id: EXECUTION_ID,
    properties: { status: 'Succeeded', startTime: START, endTime: END },
  };
  const client = {
    async startJob(template, options) {
      calls.push({ op: 'startJob', template, options });
      if (overrides.startError) throw overrides.startError;
      return started;
    },
    async waitForExecution(name, options) {
      calls.push({ op: 'waitForExecution', name, options });
      if (overrides.waitError) throw overrides.waitError;
      return waited;
    },
  };
  return { client, calls };
}

function makeReader(overrides = {}) {
  const calls = [];
  const readFirewallEvents = async (query) => {
    calls.push(query);
    if (overrides.error) throw overrides.error;
    const rows = typeof overrides.rows === 'function' ? overrides.rows(query) : overrides.rows;
    return rows;
  };
  return { readFirewallEvents, calls };
}

function makeHarness(overrides = {}) {
  const clientBundle = overrides.clientBundle ?? makeClient(overrides.client);
  const readerBundle = overrides.readerBundle ?? makeReader(overrides.reader);
  const harness = createAcaJobsNoopBaseline({
    client: clientBundle.client,
    jobName: JOB_NAME,
    agentImage: PINNED_IMAGE,
    resources: RESOURCES,
    executionTimeoutMs: TIMEOUT_MS,
    readFirewallEvents: readerBundle.readFirewallEvents,
  });
  return { harness, client: clientBundle, reader: readerBundle };
}

const NOISY_ROWS = [
  { TimeGenerated: '2026-11-05T12:00:20Z', SourceIp: '10.0.0.5', Fqdn: 'Telemetry.Example.com',
    TargetUrl: `https://telemetry.example.com/v1?sig=${CANARY}`, DestinationPort: 443,
    Protocol: 'Https', Action: 'Allow', msg_s: `raw ${CANARY}` },
  { TimeGenerated: '2026-11-05T12:00:40Z', fqdn: 'telemetry.example.com', destinationPort: 443,
    protocol: 'https', action: 'deny' },
  { Action: 'Allow', Fqdn: 'management.azure.com', DestinationPort: 443, Protocol: 'https' },
  { Action: 'Deny', Fqdn: 'management.azure.com', DestinationPort: 443, Protocol: 'https' },
  { Action: 'inspect', DestinationPort: '443' },
];

const NOISY_FINGERPRINTS = [
  { action: 'allow', fqdn: 'management.azure.com', destinationPort: 443, protocol: 'https', count: 1 },
  { action: 'allow', fqdn: 'telemetry.example.com', destinationPort: 443, protocol: 'https', count: 1 },
  { action: 'deny', fqdn: 'management.azure.com', destinationPort: 443, protocol: 'https', count: 1 },
  { action: 'deny', fqdn: 'telemetry.example.com', destinationPort: 443, protocol: 'https', count: 1 },
  { action: 'other', fqdn: '(invalid)', destinationPort: 443, protocol: null, count: 1 },
];

const SANITIZED_EXECUTION = {
  name: EXECUTION_NAME,
  id: EXECUTION_ID,
  status: 'Succeeded',
  startTime: START,
  endTime: END,
};

// ---------------------------------------------------------------- factory ---

test('factory rejects unsafe configuration without touching the client', () => {
  const { client } = makeClient();
  const { readFirewallEvents } = makeReader();
  const base = {
    client,
    jobName: JOB_NAME,
    agentImage: PINNED_IMAGE,
    resources: RESOURCES,
    executionTimeoutMs: TIMEOUT_MS,
    readFirewallEvents,
  };
  for (const invalid of [
    { client: undefined },
    { client: { startJob: async () => {} } },
    { jobName: '../other' },
    { jobName: 'job?x' },
    { agentImage: 'registry.example.com/agent:latest' },
    { agentImage: 'registry.example.com/agent@sha256:abc' },
    { agentImage: 'registry.example.com/agent@md5:' + 'a'.repeat(32) },
    { agentImage: '../agent@sha256:' + 'a'.repeat(64) },
    { resources: { cpu: 0.5 } },
    { resources: { cpu: 10, memory: '1Gi' } },
    { resources: { cpu: 0.5, memory: '1TB' } },
    { resources: { cpu: 0.5, memory: '1Gi', extra: true } },
    { executionTimeoutMs: 0 },
    { executionTimeoutMs: 600_001 },
    { executionTimeoutMs: 1_000.5 },
    { readFirewallEvents: undefined },
    { readFirewallEvents: 'not-a-function' },
  ]) {
    assert.throws(() => createAcaJobsNoopBaseline({ ...base, ...invalid }), { name: 'TypeError' });
  }
});

// ------------------------------------------------------------------- no-op ---

test('runNoop starts a fixed side-effect-free template: top-level containers, pinned image, resources, no env', async () => {
  const { harness, client } = makeHarness();

  await harness.runNoop({ runId: 'baseline-noop-1' });

  assert.equal(client.calls.length, 2);
  const start = client.calls[0];
  assert.equal(start.op, 'startJob');
  assert.deepEqual(start.options, { timeoutMs: TIMEOUT_MS });
  const template = start.template;
  assert.deepEqual(Object.keys(template), ['containers']);
  assert.equal(template.containers.length, 1);
  const container = template.containers[0];
  assert.deepEqual(Object.keys(container).sort(), ['command', 'image', 'name', 'resources']);
  assert.equal(container.image, PINNED_IMAGE);
  assert.deepEqual(container.resources, RESOURCES);
  assert.equal(container.command[0], 'node');
  assert.equal(container.command[1], '-e');
  assert.equal(typeof container.command[2], 'string');
  assert.doesNotMatch(container.command[2], /https?:|require\s*\(|fetch|socket|dns|child_process/i);
  assert.deepEqual(client.calls[1], { op: 'waitForExecution', name: EXECUTION_NAME, options: { timeoutMs: TIMEOUT_MS } });
});

test('runNoop template is identical across run ids: the no-op cannot depend on the run', async () => {
  const { harness, client } = makeHarness();

  await harness.runNoop({ runId: 'baseline-a' });
  await harness.runNoop({ runId: 'baseline-b' });

  assert.deepEqual(client.calls[0].template, client.calls[2].template);
});

test('runNoop queries the reader with the exact ARM window, kind all, and sanitized execution metadata', async () => {
  const { harness, reader } = makeHarness({ reader: { rows: [] } });

  await harness.runNoop({ runId: 'baseline-noop-1' });

  assert.equal(reader.calls.length, 1);
  assert.deepEqual(reader.calls[0], {
    execution: SANITIZED_EXECUTION,
    window: { from: START, to: END },
    kind: 'all',
    targetFqdn: undefined,
  });
});

test('runNoop clean window is unobserved pending the positive control, never a clean baseline by itself', async () => {
  const { harness } = makeHarness({ reader: { rows: [] } });

  const result = await harness.runNoop({ runId: 'baseline-noop-1' });

  assert.deepEqual(result, {
    kind: 'noop',
    runId: 'baseline-noop-1',
    status: BASELINE_STATUS.unobserved,
    reason: 'no_records_in_window',
    queryCompleted: true,
    execution: SANITIZED_EXECUTION,
    window: { from: START, to: END },
    noise: { totalRecords: 0, allowRecords: 0, denyRecords: 0, otherRecords: 0, fingerprints: [] },
  });
});

test('runNoop noisy window is a collision with normalized fingerprints and counts for subtraction', async () => {
  const { harness } = makeHarness({ reader: { rows: NOISY_ROWS } });

  const result = await harness.runNoop({ runId: 'baseline-noop-1' });

  assert.equal(result.status, BASELINE_STATUS.collision);
  assert.equal(result.reason, 'unrelated_records_in_noop_window');
  assert.equal(result.queryCompleted, true);
  assert.deepEqual(result.noise, {
    totalRecords: 5,
    allowRecords: 2,
    denyRecords: 2,
    otherRecords: 1,
    fingerprints: NOISY_FINGERPRINTS,
  });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(CANARY));
  assert.ok(!serialized.includes('TargetUrl'));
  assert.ok(!serialized.includes('msg_s'));
  assert.ok(!serialized.includes('sig='));
});

test('runNoop reader failure is unobserved without leaking reader error text', async () => {
  const { harness } = makeHarness({
    reader: { error: new Error(`kql failure leaked ${CANARY} and bearer material`) },
  });

  const result = await harness.runNoop({ runId: 'baseline-noop-1' });

  assert.equal(result.status, BASELINE_STATUS.unobserved);
  assert.equal(result.reason, 'firewall_query_failed');
  assert.equal(result.queryCompleted, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(CANARY));
  assert.ok(!serialized.includes('kql failure'));
});

test('runNoop treats a non-array reader result as a failed query, not as an empty window', async () => {
  for (const rows of [null, undefined, { rows: [] }]) {
    const { harness } = makeHarness({ reader: { rows } });
    const result = await harness.runNoop({ runId: 'baseline-noop-1' });
    assert.equal(result.status, BASELINE_STATUS.unobserved);
    assert.equal(result.reason, 'firewall_query_failed');
    assert.equal(result.queryCompleted, false);
  }
});

// -------------------------------------------------------- positive control ---

test('runPositiveControl passes the validated URL only as an env value, never inside the command', async () => {
  const { harness, client } = makeHarness({
    reader: { rows: [{ Action: 'Allow', Fqdn: TARGET_FQDN, DestinationPort: 443, Protocol: 'Https' }] },
  });

  const first = await harness.runPositiveControl({ runId: 'control-1', allowedUrl: ALLOWED_URL });
  const second = await harness.runPositiveControl({
    runId: 'control-2',
    allowedUrl: 'https://other.example.net/health',
  });

  const templateA = client.calls[0].template;
  const templateB = client.calls[2].template;
  const containerA = templateA.containers[0];
  assert.deepEqual(Object.keys(templateA), ['containers']);
  assert.deepEqual(containerA.command, templateB.containers[0].command);
  assert.ok(!JSON.stringify(containerA.command).includes('example'));
  assert.deepEqual(containerA.env, [{ name: 'BASELINE_CONTROL_URL', value: NORMALIZED_URL }]);
  assert.deepEqual(templateB.containers[0].env, [{ name: 'BASELINE_CONTROL_URL', value: 'https://other.example.net/health' }]);
  assert.equal(containerA.image, PINNED_IMAGE);
  assert.deepEqual(containerA.resources, RESOURCES);
  assert.equal(first.targetFqdn, TARGET_FQDN);
});

test('runPositiveControl reports validated only when a matching allow record is observed in the ARM window', async () => {
  const { harness, reader } = makeHarness({
    reader: { rows: [{ Action: 'Allow', Fqdn: 'Health.Example.com', DestinationPort: 443, Protocol: 'Https' }] },
  });

  const result = await harness.runPositiveControl({ runId: 'control-1', allowedUrl: ALLOWED_URL });

  assert.equal(reader.calls.length, 1);
  assert.deepEqual(reader.calls[0], {
    execution: SANITIZED_EXECUTION,
    window: { from: START, to: END },
    kind: 'allow',
    targetFqdn: TARGET_FQDN,
  });
  assert.deepEqual(result, {
    kind: 'control',
    runId: 'control-1',
    status: BASELINE_STATUS.validated,
    targetFqdn: TARGET_FQDN,
    queryCompleted: true,
    execution: SANITIZED_EXECUTION,
    window: { from: START, to: END },
    observedAllow: {
      records: 1,
      fingerprint: { action: 'allow', fqdn: TARGET_FQDN, destinationPort: 443, protocol: 'https' },
    },
  });
});

test('runPositiveControl stays unobserved when zero rows come back: absence is never a passing negative', async () => {
  const { harness } = makeHarness({ reader: { rows: [] } });

  const result = await harness.runPositiveControl({ runId: 'control-1', allowedUrl: ALLOWED_URL });

  assert.equal(result.status, BASELINE_STATUS.unobserved);
  assert.equal(result.reason, 'no_matching_allow_record');
  assert.equal(result.observedAllow, null);
  assert.equal(result.queryCompleted, true);
});

test('runPositiveControl observing a deny for the control target is unobserved with a distinct reason', async () => {
  const { harness } = makeHarness({
    reader: { rows: [{ Action: 'Deny', Fqdn: TARGET_FQDN, DestinationPort: 443, Protocol: 'Https' }] },
  });

  const result = await harness.runPositiveControl({ runId: 'control-1', allowedUrl: ALLOWED_URL });

  assert.equal(result.status, BASELINE_STATUS.unobserved);
  assert.equal(result.reason, 'control_target_denied_observed');
});

test('runPositiveControl counts only allow rows matching the exact target FQDN as the observed control', async () => {
  const { harness } = makeHarness({
    reader: {
      rows: [
        { Action: 'Allow', Fqdn: 'other.example.net', DestinationPort: 443, Protocol: 'https' },
        { Action: 'Deny', Fqdn: TARGET_FQDN, DestinationPort: 443, Protocol: 'https' },
        { Action: 'Allow', Fqdn: 'Health.Example.com', DestinationPort: 443, Protocol: 'https' },
        { Action: 'Allow', Fqdn: TARGET_FQDN, DestinationPort: 443, Protocol: 'https' },
      ],
    },
  });

  const result = await harness.runPositiveControl({ runId: 'control-1', allowedUrl: ALLOWED_URL });

  assert.equal(result.status, BASELINE_STATUS.validated);
  assert.equal(result.observedAllow.records, 2);
  assert.deepEqual(result.observedAllow.fingerprint, {
    action: 'allow', fqdn: TARGET_FQDN, destinationPort: 443, protocol: 'https',
  });
});

test('runPositiveControl reader failure is unobserved and sanitized', async () => {
  const { harness } = makeHarness({ reader: { error: new Error(`workspace query died ${CANARY}`) } });

  const result = await harness.runPositiveControl({ runId: 'control-1', allowedUrl: ALLOWED_URL });

  assert.equal(result.status, BASELINE_STATUS.unobserved);
  assert.equal(result.reason, 'firewall_query_failed');
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('unsafe control URLs are rejected before any execution starts', async () => {
  for (const bad of [
    'http://health.example.com/status',
    'https://user:pass@health.example.com/status',
    'https://192.0.2.10/status',
    'https://health.example.com/x y',
    'https://health.example.com/status#fragment',
    'ftp://health.example.com/status',
    'javascript:alert(1)',
    'not a url',
    '',
    42,
    null,
    undefined,
  ]) {
    const { harness, client, reader } = makeHarness();
    await assert.rejects(
      harness.runPositiveControl({ runId: 'control-1', allowedUrl: bad }),
      (error) => error.name === 'TypeError' || /allowedUrl/i.test(error.message),
    );
    assert.equal(client.calls.length, 0, `client must not be called for ${JSON.stringify(bad)}`);
    assert.equal(reader.calls.length, 0);
  }
});

test('a control URL with an explicit port and path is accepted and normalized', async () => {
  const { harness } = makeHarness({ reader: { rows: [] } });

  const result = await harness.runPositiveControl({ runId: 'control-1', allowedUrl: 'https://Health.Example.com:8443/ping' });

  assert.equal(result.targetFqdn, TARGET_FQDN);
  assert.equal(result.status, BASELINE_STATUS.unobserved);
  assert.equal(result.reason, 'no_matching_allow_record');
});

// -------------------------------------------------------- execution record ---

test('a failed execution is unobserved and the reader is never queried', async () => {
  const { harness, reader } = makeHarness({
    client: {
      waited: { name: EXECUTION_NAME, id: EXECUTION_ID, properties: { status: 'Failed' } },
    },
  });

  const noop = await harness.runNoop({ runId: 'baseline-noop-1' });
  assert.equal(noop.status, BASELINE_STATUS.unobserved);
  assert.equal(noop.reason, 'execution_failed');
  assert.equal(noop.queryCompleted, false);
  assert.equal(noop.window, null);
  assert.equal(noop.execution.status, 'Failed');
  assert.equal(reader.calls.length, 0);

  const control = await harness.runPositiveControl({ runId: 'control-1', allowedUrl: ALLOWED_URL });
  assert.equal(control.status, BASELINE_STATUS.unobserved);
  assert.equal(control.reason, 'execution_failed');
  assert.equal(reader.calls.length, 0);
});

test('malformed or unordered ARM timing windows fail closed as errors', async () => {
  for (const properties of [
    { status: 'Succeeded', startTime: START },
    { status: 'Succeeded', endTime: END },
    { status: 'Succeeded', startTime: 'not-a-timestamp', endTime: END },
    { status: 'Succeeded', startTime: 'Nov 5, 2026 12:00:00 UTC', endTime: END },
    { status: 'Succeeded', startTime: START, endTime: START },
    { status: 'Succeeded', startTime: END, endTime: START },
  ]) {
    const { harness, reader } = makeHarness({ client: { waited: { name: EXECUTION_NAME, id: EXECUTION_ID, properties } } });
    await assert.rejects(harness.runNoop({ runId: 'baseline-noop-1' }), /timing window is invalid/i);
    await assert.rejects(
      harness.runPositiveControl({ runId: 'control-1', allowedUrl: ALLOWED_URL }),
      /timing window is invalid/i,
    );
    assert.equal(reader.calls.length, 0);
  }
});

test('execution identities outside the configured job or differing from the started run are rejected', async () => {
  const otherJob = makeHarness({ client: { started: { name: EXECUTION_NAME, id: OTHER_JOB_EXECUTION_ID } } });
  await assert.rejects(otherJob.harness.runNoop({ runId: 'baseline-noop-1' }), /configured job/i);

  const renamed = makeHarness({
    client: {
      waited: { name: 'different-execution', id: EXECUTION_ID.replace(EXECUTION_NAME, 'different-execution'),
        properties: { status: 'Succeeded', startTime: START, endTime: END } },
    },
  });
  await assert.rejects(renamed.harness.runNoop({ runId: 'baseline-noop-1' }), /started execution/i);
});

// ------------------------------------------------------------- evaluate ------

test('evaluateNoopBaseline: clean noop plus observed control is validated', async () => {
  const clean = await makeHarness({ reader: { rows: [] } }).harness.runNoop({ runId: 'noop-run' });
  const control = await makeHarness({
    reader: { rows: [{ Action: 'Allow', Fqdn: TARGET_FQDN, DestinationPort: 443, Protocol: 'Https' }] },
  }).harness.runPositiveControl({ runId: 'control-run', allowedUrl: ALLOWED_URL });

  const verdict = evaluateNoopBaseline({ noop: clean, control });

  assert.equal(verdict.status, BASELINE_STATUS.validated);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.cleanNoopWindow, true);
  assert.equal(verdict.controlObserved, true);
  assert.equal(verdict.noopRunId, 'noop-run');
  assert.equal(verdict.controlRunId, 'control-run');
  assert.equal(verdict.targetFqdn, TARGET_FQDN);
  assert.equal(verdict.noise.totalRecords, 0);
  assert.match(verdict.note, /assertion input/i);
});

test('evaluateNoopBaseline: records in the noop window are a collision even with an observed control', async () => {
  const noisy = await makeHarness({ reader: { rows: NOISY_ROWS } }).harness.runNoop({ runId: 'noop-run' });
  const control = await makeHarness({
    reader: { rows: [{ Action: 'Allow', Fqdn: TARGET_FQDN, DestinationPort: 443, Protocol: 'Https' }] },
  }).harness.runPositiveControl({ runId: 'control-run', allowedUrl: ALLOWED_URL });

  const verdict = evaluateNoopBaseline({ noop: noisy, control });

  assert.equal(verdict.status, BASELINE_STATUS.collision);
  assert.equal(verdict.reason, 'unrelated_records_in_noop_window');
  assert.equal(verdict.controlObserved, true);
  assert.equal(verdict.cleanNoopWindow, false);
  assert.deepEqual(verdict.noise.fingerprints, NOISY_FINGERPRINTS);
});

test('evaluateNoopBaseline: an unobserved control keeps the whole baseline unobserved regardless of the noop', async () => {
  const clean = await makeHarness({ reader: { rows: [] } }).harness.runNoop({ runId: 'noop-run' });
  const noisy = await makeHarness({ reader: { rows: NOISY_ROWS } }).harness.runNoop({ runId: 'noop-run' });
  const absent = await makeHarness({ reader: { rows: [] } }).harness
    .runPositiveControl({ runId: 'control-run', allowedUrl: ALLOWED_URL });
  const failed = await makeHarness({
    client: { waited: { name: EXECUTION_NAME, id: EXECUTION_ID, properties: { status: 'Failed' } } },
  }).harness.runPositiveControl({ runId: 'control-run', allowedUrl: ALLOWED_URL });

  for (const controlResult of [absent, failed]) {
    for (const noopResult of [clean, noisy]) {
      const verdict = evaluateNoopBaseline({ noop: noopResult, control: controlResult });
      assert.equal(verdict.status, BASELINE_STATUS.unobserved);
      assert.equal(verdict.controlObserved, false);
      assert.equal(typeof verdict.reason, 'string');
    }
  }
});

test('evaluateNoopBaseline: an incomplete noop query keeps the baseline unobserved even with an observed control', async () => {
  const control = await makeHarness({
    reader: { rows: [{ Action: 'Allow', Fqdn: TARGET_FQDN, DestinationPort: 443, Protocol: 'Https' }] },
  }).harness.runPositiveControl({ runId: 'control-run', allowedUrl: ALLOWED_URL });
  const queryFailed = await makeHarness({ reader: { error: new Error('boom') } }).harness
    .runNoop({ runId: 'noop-run' });

  const verdict = evaluateNoopBaseline({ noop: queryFailed, control });

  assert.equal(verdict.status, BASELINE_STATUS.unobserved);
  assert.equal(verdict.reason, 'firewall_query_failed');
});

test('evaluateNoopBaseline rejects results of the wrong kind', () => {
  const control = { kind: 'control', status: 'validated', queryCompleted: true, targetFqdn: TARGET_FQDN };
  for (const bad of [undefined, null, { kind: 'control' }, { kind: 'other', queryCompleted: true }]) {
    assert.throws(() => evaluateNoopBaseline({ noop: bad, control }), { name: 'TypeError' });
  }
  const noop = { kind: 'noop', queryCompleted: true, noise: { totalRecords: 0 } };
  for (const bad of [undefined, null, { kind: 'noop' }, { kind: 'other' }]) {
    assert.throws(() => evaluateNoopBaseline({ noop, control: bad }), { name: 'TypeError' });
  }
});

// ------------------------------------------------------------- hygiene -------

test('no secret material ever reaches the client, the reader, or the results', async () => {
  const { harness, client, reader } = makeHarness({
    reader: {
      rows: [
        { Action: 'Allow', Fqdn: TARGET_FQDN, Authorization: `Bearer ${CANARY}`,
          TargetUrl: `https://health.example.com/x?code=${CANARY}`, DestinationPort: 443, Protocol: 'https' },
        { Action: 'Deny', Fqdn: 'platform.example.com', msg_s: `leaked ${CANARY}` },
      ],
    },
  });

  const noop = await harness.runNoop({ runId: 'baseline-noop-1' });
  const control = await harness.runPositiveControl({ runId: 'control-1', allowedUrl: ALLOWED_URL });

  for (const call of client.calls) {
    const serialized = JSON.stringify(call);
    assert.ok(!/token|secret|password|bearer|authorization/i.test(serialized.replace(/BASELINE_CONTROL_URL/g, '')),
      `client call leaked secret-shaped material: ${serialized}`);
  }
  for (const query of reader.calls) {
    assert.deepEqual(Object.keys(query).sort(), ['execution', 'kind', 'targetFqdn', 'window']);
    assert.deepEqual(Object.keys(query.execution).sort(), ['endTime', 'id', 'name', 'startTime', 'status']);
    assert.ok(!JSON.stringify(query).includes(CANARY));
  }
  for (const result of [noop, control]) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(CANARY));
    assert.ok(!/Bearer|Authorization|msg_s|TargetUrl/.test(serialized));
  }
});
