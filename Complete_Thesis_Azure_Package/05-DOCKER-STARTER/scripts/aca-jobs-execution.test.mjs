import assert from 'node:assert/strict';
import test from 'node:test';

import { createAcaJobsExecutionClient } from './aca-jobs-execution.mjs';

const SUBSCRIPTION_ID = '01234567-89ab-cdef-0123-456789abcdef';
const TOKEN = 'test-bearer-token-must-not-escape';
const SCOPE = 'https://management.azure.com/.default';
const API_VERSION = '2026-07-01';
const BASE_PATH = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-test/providers/Microsoft.App/jobs/job-test`;
const EXECUTION_NAME = 'job-test-run-001';
const EXECUTION_ID = `${BASE_PATH}/executions/${EXECUTION_NAME}`;
const TEMPLATE = {
  containers: [{ name: 'worker', image: 'example.invalid/worker:stable', resources: { cpu: 0.5, memory: '1Gi' } }],
  initContainers: [{ name: 'prepare', image: 'example.invalid/prepare:stable' }],
  futureProperty: { preserve: true },
};

function makeResponse(status, body = {}, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    status,
    headers: { get: (name) => normalizedHeaders.get(name.toLowerCase()) ?? null },
    async json() { return body; },
  };
}

function makeClient(overrides = {}) {
  const calls = [];
  const tokenScopes = [];
  const tokenProvider = overrides.getToken ?? (async () => TOKEN);
  const transport = overrides.fetchImpl ?? (async () => makeResponse(500, { error: { code: 'Unexpected' } }));
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return transport(url, options);
  };
  const client = createAcaJobsExecutionClient({
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: 'rg-test',
    jobName: 'job-test',
    getToken: async (scope) => {
      tokenScopes.push(scope);
      return tokenProvider(scope);
    },
    fetchImpl,
    sleep: overrides.sleep ?? (async () => {}),
    now: overrides.now ?? (() => 1_000),
    apiVersion: API_VERSION,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 5_000,
    pollIntervalMs: overrides.pollIntervalMs ?? 100,
  });
  return { client, calls, tokenScopes };
}

function executionBody(status = 'Succeeded', extra = {}) {
  return {
    name: EXECUTION_NAME,
    id: EXECUTION_ID,
    properties: { status, startTime: '2026-11-05T12:00:00Z', ...extra },
  };
}

test('constructor rejects a non-GUID subscription and unsafe resource path segments', () => {
  const base = {
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: 'rg-test',
    jobName: 'job-test',
    getToken: async () => TOKEN,
    fetchImpl: async () => makeResponse(200, {}),
  };
  for (const invalid of [
    { subscriptionId: 'not-a-guid' },
    { subscriptionId: '01234567-89ab-cdef-0123-456789abcde/' },
    { resourceGroup: '../other' },
    { resourceGroup: 'rg?x=secret' },
    { jobName: 'job/name' },
    { jobName: '..' },
  ]) {
    assert.throws(() => createAcaJobsExecutionClient({ ...base, ...invalid }), { name: 'TypeError' });
  }
});

test('startJob posts the exact top-level execution template to ARM using the ARM token scope', async () => {
  const { client, calls, tokenScopes } = makeClient({
    fetchImpl: async () => makeResponse(200, { name: EXECUTION_NAME, id: EXECUTION_ID }),
  });

  const started = await client.startJob(TEMPLATE);

  assert.deepEqual(tokenScopes, [SCOPE]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://management.azure.com${BASE_PATH}/start?api-version=${API_VERSION}`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[0].options.body), TEMPLATE);
  assert.deepEqual(started, { name: EXECUTION_NAME, id: EXECUTION_ID });
});

test('startJob rejects an execution resource ID outside the configured job', async () => {
  const { client } = makeClient({
    fetchImpl: async () => makeResponse(200, {
      name: EXECUTION_NAME,
      id: `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/other/providers/Microsoft.App/jobs/job-test/executions/${EXECUTION_NAME}`,
    }),
  });

  await assert.rejects(client.startJob(TEMPLATE), /invalid execution response/i);
});

test('startJob requires the returned name to match the execution resource ID', async () => {
  const { client } = makeClient({
    fetchImpl: async () => makeResponse(200, {
      name: 'different-run',
      id: EXECUTION_ID,
    }),
  });

  await assert.rejects(client.startJob(TEMPLATE), /invalid execution response/i);
});

test('startJob polls the trusted ARM Location and caps a large Retry-After delay', async () => {
  const calls = [];
  const sleeps = [];
  let now = 1_000;
  const location = `https://management.azure.com${BASE_PATH}/start/operations/op-1?api-version=${API_VERSION}`;
  const { client } = makeClient({
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (options.method === 'POST') return makeResponse(202, {}, { Location: location, 'Retry-After': '999' });
      return makeResponse(200, { name: EXECUTION_NAME, id: EXECUTION_ID });
    },
  });

  const started = await client.startJob(TEMPLATE, { timeoutMs: 30_000 });

  assert.deepEqual(started, { name: EXECUTION_NAME, id: EXECUTION_ID });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, location);
  assert.equal(calls[1].options.method, 'GET');
  assert.deepEqual(sleeps, [10_000]);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${TOKEN}`);
});

test('startJob bounds Retry-After waiting by the overall timeout', async () => {
  let now = 0;
  let polls = 0;
  const sleeps = [];
  const location = `https://management.azure.com${BASE_PATH}/start/operations/op-2?api-version=${API_VERSION}`;
  const { client } = makeClient({
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') return makeResponse(202, {}, { Location: location, 'Retry-After': '90' });
      polls += 1;
      return makeResponse(202, {}, { 'Retry-After': '90' });
    },
  });

  await assert.rejects(client.startJob(TEMPLATE, { timeoutMs: 1_500 }), /timed out/i);
  assert.equal(polls, 0);
  assert.deepEqual(sleeps, [1_500]);
});

test('startJob rejects a 202 response with an untrusted Location origin', async () => {
  const { client, calls } = makeClient({
    fetchImpl: async () => makeResponse(202, {}, {
      Location: 'https://attacker.invalid/steal?api-version=2026-07-01',
    }),
  });

  await assert.rejects(client.startJob(TEMPLATE), /untrusted.*location/i);
  assert.equal(calls.length, 1);
});

test('startJob rejects a same-origin Location outside the configured ARM operation paths', async () => {
  const { client, calls } = makeClient({
    fetchImpl: async () => makeResponse(202, {}, {
      Location: `https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/other/providers/Microsoft.App/jobs/other/start?api-version=${API_VERSION}`,
    }),
  });

  await assert.rejects(client.startJob(TEMPLATE), /untrusted.*location/i);
  assert.equal(calls.length, 1);
});

test('startJob fails closed when a 202 completion lacks a valid execution name and ID', async () => {
  const location = `https://management.azure.com${BASE_PATH}/start/operations/op-3?api-version=${API_VERSION}`;
  const { client } = makeClient({
    fetchImpl: async (_url, options) => options.method === 'POST'
      ? makeResponse(202, {}, { Location: location })
      : makeResponse(200, { status: 'Succeeded' }),
  });

  await assert.rejects(client.startJob(TEMPLATE), /invalid execution response/i);
});

test('getExecution uses the documented execution resource endpoint and returns the provider object', async () => {
  const providerBody = executionBody('Running', { customField: { kept: true } });
  const { client, calls } = makeClient({ fetchImpl: async () => makeResponse(200, providerBody) });

  const result = await client.getExecution(EXECUTION_NAME);

  assert.equal(calls[0].url, `https://management.azure.com${EXECUTION_ID}?api-version=${API_VERSION}`);
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(result, providerBody);
  assert.equal(Object.hasOwn(result, 'items'), false);
});

test('getExecution rejects an unsafe execution name before making a request', async () => {
  const { client, calls } = makeClient();

  await assert.rejects(client.getExecution('../other'), { name: 'TypeError' });
  assert.equal(calls.length, 0);
});

test('waitForExecution polls until Succeeded and returns the raw provider object', async () => {
  let now = 0;
  let gets = 0;
  const sleeps = [];
  const { client } = makeClient({
    now: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    fetchImpl: async (_url, options) => {
      gets += 1;
      return makeResponse(200, gets === 1
        ? executionBody('Running')
        : executionBody('Succeeded', { endTime: '2026-11-05T12:01:00Z', extension: 'kept' }));
    },
  });

  const result = await client.waitForExecution(EXECUTION_NAME, { timeoutMs: 1_000 });

  assert.equal(gets, 2);
  assert.deepEqual(sleeps, [100]);
  assert.deepEqual(result, executionBody('Succeeded', {
    endTime: '2026-11-05T12:01:00Z', extension: 'kept',
  }));
});

test('waitForExecution returns a terminal failure object without rewriting provider fields', async () => {
  const failed = executionBody('Failed', { endTime: '2026-11-05T12:01:00Z', custom: 'provider-value' });
  const { client } = makeClient({ fetchImpl: async () => makeResponse(200, failed) });

  assert.deepEqual(await client.waitForExecution(EXECUTION_NAME), failed);
});

test('waitForExecution rejects Unknown and malformed statuses as indeterminate', async () => {
  for (const body of [executionBody('Unknown'), { name: EXECUTION_NAME, id: EXECUTION_ID, properties: {} }]) {
    const { client } = makeClient({ fetchImpl: async () => makeResponse(200, body) });
    await assert.rejects(client.waitForExecution(EXECUTION_NAME), /indeterminate execution status/i);
  }
});

test('waitForExecution times out while the execution remains Processing', async () => {
  let now = 0;
  let gets = 0;
  const { client } = makeClient({
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    fetchImpl: async () => { gets += 1; return makeResponse(200, executionBody('Processing')); },
  });

  await assert.rejects(client.waitForExecution(EXECUTION_NAME, { timeoutMs: 250 }), /timed out/i);
  assert.equal(gets, 3);
});

test('HTTP failures expose only status and do not leak response text, caller values, or token', async () => {
  const { client } = makeClient({ fetchImpl: async () => makeResponse(403, {
    error: {
      code: 'Forbidden',
      message: `caller-secret response detail Authorization: Bearer ${TOKEN}`,
    },
  }) });

  await assert.rejects(client.getExecution(EXECUTION_NAME), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    assert.doesNotMatch(error.message, /caller-secret|response detail|Forbidden/);
    assert.doesNotMatch(error.message, /api-version=2026-07-01/);
    return true;
  });
});

test('transport errors are sanitized so bearer material cannot escape in exceptions', async () => {
  const { client } = makeClient({ fetchImpl: async () => {
    throw new Error(`transport echoed bearer ${TOKEN} and caller-secret`);
  } });

  await assert.rejects(client.getExecution(EXECUTION_NAME), (error) => {
    assert.match(error.message, /request failed/i);
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    assert.doesNotMatch(error.message, /caller-secret/);
    return true;
  });
});

test('redirect responses are rejected rather than followed', async () => {
  const { client, calls } = makeClient({ fetchImpl: async () => makeResponse(302, {}, {
    Location: 'https://attacker.invalid/',
  }) });

  await assert.rejects(client.getExecution(EXECUTION_NAME), /HTTP 302/);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('request timeout rejects even when the injected fetch ignores its AbortSignal', async () => {
  const { client } = makeClient({
    requestTimeoutMs: 15,
    fetchImpl: async () => new Promise(() => {}),
  });

  await assert.rejects(client.getExecution(EXECUTION_NAME), /timed out/i);
});

test('202 polling terminates after a finite number of attempts even with a frozen clock', async () => {
  let polls = 0;
  const location = `https://management.azure.com${BASE_PATH}/start/operations/op-4?api-version=${API_VERSION}`;
  const { client } = makeClient({
    sleep: async () => {},
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') return makeResponse(202, {}, { Location: location });
      polls += 1;
      return makeResponse(202);
    },
  });

  await assert.rejects(client.startJob(TEMPLATE, { timeoutMs: 60_000 }), /poll limit/i);
  assert.ok(polls <= 120);
});
