import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createAcaSandboxDataPlaneClient } from './aca-sandbox-data-plane.mjs';

const SUBSCRIPTION_ID = '01234567-89ab-cdef-0123-456789abcdef';
const TOKEN = 'test-bearer-token-must-not-escape';
const SCOPE = 'https://dynamicsessions.io/.default';
const API_VERSION = '2026-02-01-preview';

function makeResponse(status, body = {}, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalizedHeaders.get(name.toLowerCase()) ?? null },
    async json() {
      return body;
    },
  };
}

function makeClient(overrides = {}) {
  const calls = [];
  const tokenScopes = [];
  const fetchImpl = overrides.fetchImpl ?? (async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'PUT' && new URL(url).pathname.endsWith('/sandboxes')) {
      return makeResponse(202, { id: 'sandbox-123', state: 'Creating' });
    }
    if (options.method === 'GET') {
      return makeResponse(200, { id: 'sandbox-123', state: 'Running' });
    }
    return makeResponse(204);
  });
  const client = createAcaSandboxDataPlaneClient({
    region: 'westus2',
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: 'rg-test',
    sandboxGroup: 'group-a',
    getToken: async (scope) => {
      tokenScopes.push(scope);
      return TOKEN;
    },
    fetchImpl,
    sleep: async () => {},
    requestTimeoutMs: 5000,
    pollIntervalMs: 1,
    ...overrides,
    fetchImpl,
  });
  return { client, calls, tokenScopes };
}

function expectedGroupPath() {
  return `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-test/sandboxGroups/group-a`;
}

test('createSandbox uses regional endpoint, token audience, and the preview API version', async () => {
  const { client, calls, tokenScopes } = makeClient();
  await client.createSandbox({ name: 'sample' });

  assert.equal(tokenScopes.length, 2);
  assert.deepEqual(tokenScopes, [SCOPE, SCOPE]);
  assert.equal(new URL(calls[0].url).origin, 'https://management.westus2.azuredevcompute.io');
  assert.equal(new URL(calls[0].url).searchParams.get('api-version'), API_VERSION);
  assert.equal(new URL(calls[1].url).searchParams.get('api-version'), API_VERSION);
});

test('createSandbox sends the request body unchanged and polls the returned sandbox ID', async () => {
  const requestBody = {
    name: 'sample',
    egressPolicy: { mode: 'Allow', unknownPolicyField: ['preserve', 3] },
    identitySettings: { identityType: 'UserAssigned', extra: true },
    telemetryConfig: { enabled: false, vendorSetting: 'keep-me' },
    unrecognizedFutureField: { nested: 'value' },
  };
  const { client, calls } = makeClient();
  const result = await client.createSandbox(requestBody);

  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(new URL(calls[0].url).pathname, `${expectedGroupPath()}/sandboxes`);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), requestBody);
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(new URL(calls[1].url).pathname, `${expectedGroupPath()}/sandboxes/sandbox-123`);
  assert.deepEqual(result, {
    sandboxId: 'sandbox-123',
    sandbox: { id: 'sandbox-123', state: 'Running' },
  });
});

test('createSandbox polls until state matches Running without case sensitivity', async () => {
  let getCount = 0;
  const { client, calls } = makeClient({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (options.method === 'PUT') return makeResponse(202, { id: 'sandbox-123' });
      getCount += 1;
      return makeResponse(200, { id: 'sandbox-123', state: getCount === 1 ? 'Provisioning' : 'rUnNiNg' });
    },
  });

  const result = await client.createSandbox({});
  assert.equal(getCount, 2);
  assert.equal(result.sandbox.state, 'rUnNiNg');
});

test('createSandbox times out when the sandbox never reaches Running', async () => {
  let getCount = 0;
  const { client } = makeClient({
    pollIntervalMs: 1,
    sleep: () => delay(25),
    fetchImpl: async (_url, options) => {
      if (options.method === 'PUT') return makeResponse(202, { id: 'sandbox-123' });
      getCount += 1;
      return makeResponse(200, { id: 'sandbox-123', state: 'Provisioning' });
    },
  });

  await assert.rejects(
    client.createSandbox({}, { timeoutMs: 10 }),
    (error) => /timed out/i.test(error.message),
  );
  assert.equal(getCount, 1);
});

test('writeFile encodes the file query and uploads string content as bytes', async () => {
  const { client, calls } = makeClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return makeResponse(204);
  } });
  await client.writeFile('sandbox-123', '/tmp/a file & b.txt', 'snowman ☃');

  const call = calls[0];
  const url = new URL(call.url);
  assert.equal(call.options.method, 'PUT');
  assert.equal(url.pathname, `${expectedGroupPath()}/sandboxes/sandbox-123/files`);
  assert.equal(url.searchParams.get('path'), '/tmp/a file & b.txt');
  assert.equal(url.searchParams.get('createDirs'), 'true');
  assert.equal(url.searchParams.get('api-version'), API_VERSION);
  assert.equal(call.options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(Buffer.from(call.options.body).toString('utf8'), 'snowman ☃');
});

test('writeFile preserves Uint8Array bytes', async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const { client, calls } = makeClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return makeResponse(204);
  } });
  await client.writeFile('sandbox-123', '/tmp/raw.bin', bytes);

  assert.deepEqual([...new Uint8Array(calls[0].options.body)], [...bytes]);
});

test('executeShellCommand posts JSON and returns the parsed execution result', async () => {
  const execResult = { exitCode: 7, stdout: 'partial output', stderr: 'command failed' };
  const { client, calls } = makeClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return makeResponse(200, execResult);
  } });
  const result = await client.executeShellCommand('sandbox-123', 'printf %s "$VALUE"');

  const call = calls[0];
  assert.equal(call.options.method, 'POST');
  assert.equal(new URL(call.url).pathname, `${expectedGroupPath()}/sandboxes/sandbox-123/executeShellCommand`);
  assert.equal(new URL(call.url).searchParams.get('api-version'), API_VERSION);
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.options.body), { command: 'printf %s "$VALUE"' });
  assert.deepEqual(result, execResult);
});

test('getEgressDecisions returns the response body without adding fields', async () => {
  const egressBody = { decisions: [{ destination: 'example.test', action: 'Allow' }], serviceExtension: 'opaque' };
  const { client, calls } = makeClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return makeResponse(200, egressBody);
  } });
  const result = await client.getEgressDecisions('sandbox-123');

  assert.equal(calls[0].options.method, 'GET');
  assert.equal(new URL(calls[0].url).pathname, `${expectedGroupPath()}/sandboxes/sandbox-123/egress-decisions`);
  assert.deepEqual(result, egressBody);
  assert.equal(Object.hasOwn(result, 'items'), false);
});

test('deleteSandbox waits for GET 404 before confirming deletion', async () => {
  const calls = [];
  const client = makeClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === 'DELETE') return makeResponse(202);
    return calls.filter((call) => call.options.method === 'GET').length === 1
      ? makeResponse(200, { id: 'sandbox-123', state: 'Deleting' })
      : makeResponse(404, { error: { code: 'NotFound' } });
  } }).client;

  assert.equal(await client.deleteSandbox('sandbox-123'), undefined);
  assert.deepEqual(calls.map(({ options }) => options.method), ['DELETE', 'GET', 'GET']);
  assert.ok(calls.at(-1).url.endsWith('/sandboxes/sandbox-123?api-version=2026-02-01-preview'));
});

test('deleteSandbox times out rather than claiming deletion without a 404', async () => {
  let getCount = 0;
  const { client } = makeClient({
    pollIntervalMs: 1,
    sleep: () => delay(25),
    fetchImpl: async (_url, options) => {
      if (options.method === 'DELETE') return makeResponse(202);
      getCount += 1;
      return makeResponse(200, { id: 'sandbox-123', state: 'Deleting' });
    },
  });

  await assert.rejects(
    client.deleteSandbox('sandbox-123', { timeoutMs: 10 }),
    (error) => /timed out/i.test(error.message),
  );
  assert.equal(getCount, 1);
});

test('createDiskImage scopes requests to the ACA group and polls the returned image to Ready', async () => {
  const calls = [];
  const tokenScopes = [];
  const { client } = makeClient({
    getToken: async (scope) => {
      tokenScopes.push(scope);
      return TOKEN;
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (options.method === 'POST') {
        return makeResponse(202, { id: 'image-123', status: { state: 'Building' } });
      }
      return makeResponse(200, { id: 'image-123', status: { state: 'rEaDy' } });
    },
  });

  const result = await client.createDiskImage('ghcr.io/acme/node-agent:22', { name: 'node-agent' });

  assert.deepEqual(tokenScopes, [SCOPE, SCOPE]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).origin, 'https://management.westus2.azuredevcompute.io');
  assert.equal(new URL(calls[0].url).pathname, `${expectedGroupPath()}/diskimages`);
  assert.equal(new URL(calls[0].url).searchParams.get('api-version'), API_VERSION);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    image: { base: 'ghcr.io/acme/node-agent:22' },
    labels: { name: 'node-agent' },
  });
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(new URL(calls[1].url).pathname, `${expectedGroupPath()}/diskimages/image-123`);
  assert.equal(new URL(calls[1].url).searchParams.get('api-version'), API_VERSION);
  assert.deepEqual(result, {
    diskImageId: 'image-123',
    diskImage: { id: 'image-123', status: { state: 'rEaDy' } },
  });
});

test('createDiskImage sends registry credentials and a full managed identity resource ID for private images', async () => {
  const calls = [];
  const credentials = { username: 'pull-user', token: 'private-registry-secret' };
  const managedIdentityResourceId = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/disk-pull`;
  const { client } = makeClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return options.method === 'POST'
      ? makeResponse(202, { id: 'private-image', status: { state: 'Building' } })
      : makeResponse(200, { id: 'private-image', status: { state: 'Succeeded' } });
  } });

  await client.createDiskImage('registry.example/team/agent:22', {
    name: 'private-node-agent',
    managedIdentityResourceId,
    registryCredentials: credentials,
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    image: { base: 'registry.example/team/agent:22' },
    labels: { name: 'private-node-agent' },
    registryCredentials: credentials,
    managedIdentityResourceId,
  });
});

test('createDiskImage omits absent optional fields and accepts Succeeded as terminal success', async () => {
  const calls = [];
  const { client } = makeClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return options.method === 'POST'
      ? makeResponse(202, { id: 'image-succeeded', status: { state: 'Building' } })
      : makeResponse(200, { id: 'image-succeeded', status: { state: 'sUcCeEdEd' } });
  } });

  const result = await client.createDiskImage('node:22');
  const body = JSON.parse(calls[0].options.body);

  assert.deepEqual(body, { image: { base: 'node:22' } });
  assert.equal(Object.hasOwn(body, 'managedIdentityResourceId'), false);
  assert.equal(Object.hasOwn(body, 'registryCredentials'), false);
  assert.equal(result.diskImage.status.state, 'sUcCeEdEd');
});

test('createDiskImage treats Failed as terminal without exposing server details', async () => {
  const { client } = makeClient({ fetchImpl: async (_url, options) => options.method === 'POST'
    ? makeResponse(202, { id: 'failed-image', status: { state: 'Building' } })
    : makeResponse(200, {
      id: 'failed-image',
      status: { state: 'FAILED', message: 'private-registry-secret bearer-leak' },
    }) });

  await assert.rejects(
    client.createDiskImage('registry.example/team/agent:22', {
      name: 'private-agent',
      registryCredentials: { username: 'pull-user', token: 'private-registry-secret' },
    }),
    (error) => {
      assert.match(error.message, /disk image.*failed/i);
      assert.doesNotMatch(error.message, /private-registry-secret|bearer-leak|test-bearer-token/);
      return true;
    },
  );
});

test('createDiskImage times out before the image reaches a successful state', async () => {
  let getCount = 0;
  const { client } = makeClient({
    pollIntervalMs: 1,
    sleep: () => delay(25),
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') return makeResponse(202, { id: 'slow-image', status: { state: 'Building' } });
      getCount += 1;
      return makeResponse(200, { id: 'slow-image', status: { state: 'Building' } });
    },
  });

  await assert.rejects(
    client.createDiskImage('node:22', { name: 'slow-node', timeoutMs: 10 }),
    (error) => /timed out/i.test(error.message),
  );
  assert.equal(getCount, 1);
});

test('createDiskImage rejects invalid OCI references before making a request', async () => {
  const { client, calls } = makeClient();
  for (const baseImage of [
    '',
    'node image:22',
    'https://registry.example/team/agent:22',
    'https://user:password@registry.example/team/agent:22',
    'registry.example/team/agent\n:22',
    'registry.example/team/agent:22?token=secret',
    'a'.repeat(1025),
  ]) {
    await assert.rejects(client.createDiskImage(baseImage, { name: 'node-agent' }), { name: 'TypeError' });
  }
  assert.equal(calls.length, 0);
});

test('createDiskImage rejects invalid names and managed identity resource IDs before network', async () => {
  const { client, calls } = makeClient();
  const validIdentity = `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/disk-pull`;
  await assert.rejects(client.createDiskImage('node:22', { name: 'bad/name' }), { name: 'TypeError' });
  for (const managedIdentityResourceId of [
    'disk-pull',
    `/subscriptions/not-a-guid/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/disk-pull`,
    `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-test/providers/Microsoft.Compute/identities/disk-pull`,
    `${validIdentity}?api-version=evil`,
  ]) {
    await assert.rejects(
      client.createDiskImage('registry.example/team/agent:22', { name: 'private-node', managedIdentityResourceId }),
      { name: 'TypeError' },
    );
  }
  assert.equal(calls.length, 0);
});

test('createDiskImage HTTP failures do not expose bearer tokens or registry credentials', async () => {
  const credentials = { username: 'pull-user', token: 'private-registry-secret' };
  const { client } = makeClient({ fetchImpl: async () => makeResponse(403, {
    error: { code: 'Forbidden', message: `Bearer ${TOKEN} ${credentials.username} ${credentials.token}` },
  }) });

  await assert.rejects(
    client.createDiskImage('registry.example/team/agent:22', { name: 'private-node', registryCredentials: credentials }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'Forbidden');
      assert.doesNotMatch(error.message, new RegExp(`${TOKEN}|${credentials.username}|${credentials.token}`));
      return true;
    },
  );
});

test('createDiskImage redacts registry credentials echoed as an HTTP error code', async () => {
  const secret = 'Forbidden';
  const { client } = makeClient({ fetchImpl: async () => makeResponse(403, {
    error: { code: secret },
  }) });

  await assert.rejects(
    client.createDiskImage('registry.example/team/agent:22', {
      name: 'private-node',
      registryCredentials: { username: 'pull-user', token: secret },
    }),
    (error) => {
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test('createDiskImage sanitizes transport errors that include registry credentials', async () => {
  const secret = 'private-registry-secret';
  const { client } = makeClient({ fetchImpl: async () => {
    throw new Error(`transport echoed credential ${secret} and bearer ${TOKEN}`);
  } });

  await assert.rejects(
    client.createDiskImage('registry.example/team/agent:22', {
      name: 'private-node',
      registryCredentials: { username: 'pull-user', token: secret },
    }),
    (error) => {
      assert.match(error.message, /request failed/i);
      assert.doesNotMatch(error.message, new RegExp(`${TOKEN}|${secret}`));
      return true;
    },
  );
});

test('constructor validates region, resource/group segments, and subscription GUID', () => {
  const base = {
    region: 'westus2',
    subscriptionId: SUBSCRIPTION_ID,
    resourceGroup: 'rg-test',
    sandboxGroup: 'group-a',
    getToken: async () => TOKEN,
    fetchImpl: async () => makeResponse(200, {}),
  };
  for (const invalid of [
    { region: '../westus2' },
    { resourceGroup: 'rg/../other' },
    { sandboxGroup: 'group?x=1' },
    { subscriptionId: 'not-a-guid' },
  ]) {
    assert.throws(
      () => createAcaSandboxDataPlaneClient({ ...base, ...invalid }),
      { name: 'TypeError' },
    );
  }
});

test('sandbox methods reject invalid sandbox IDs before making a request', async () => {
  const { client, calls } = makeClient();
  for (const method of [
    () => client.writeFile('../escape', '/tmp/file', 'x'),
    () => client.executeShellCommand('bad/id', 'true'),
    () => client.getEgressDecisions('bad\\id'),
    () => client.deleteSandbox('..'),
  ]) {
    await assert.rejects(method, { name: 'TypeError' });
  }
  assert.equal(calls.length, 0);
});

test('HTTP errors expose bounded status and safe code but not response text or bearer token', async () => {
  const { client } = makeClient({ fetchImpl: async () => makeResponse(403, {
    error: { code: 'Forbidden', message: `Authorization: Bearer ${TOKEN}; sensitive response text` },
  }) });
  await assert.rejects(
    client.getEgressDecisions('sandbox-123'),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'Forbidden');
      assert.match(error.message, /403.*Forbidden/);
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      assert.doesNotMatch(error.message, /sensitive response text/);
      return true;
    },
  );
});

test('transport errors are sanitized so bearer material cannot escape in exceptions', async () => {
  const { client } = makeClient({ fetchImpl: async () => {
    throw new Error(`transport echoed Authorization: Bearer ${TOKEN}`);
  } });
  await assert.rejects(
    client.getEgressDecisions('sandbox-123'),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      assert.match(error.message, /request failed/i);
      return true;
    },
  );
});

test('requests reject redirects instead of following them', async () => {
  const { client, calls } = makeClient({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return makeResponse(302, { location: 'https://attacker.invalid/' }, { Location: 'https://attacker.invalid/' });
  } });
  await assert.rejects(client.getEgressDecisions('sandbox-123'), /302/);
  assert.equal(calls[0].options.redirect, 'manual');
});
