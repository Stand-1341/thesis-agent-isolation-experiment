/**
 * Verified against the official Azure Container Apps Sandbox SDK for Python
 * (`azure-containerapps-sandbox` 0.1.0b4, `_helpers.py`).
 *
 * The audience is the Dynamic Sessions one even though the API surface is the Sandboxes
 * data plane at `management.{region}.azuredevcompute.io`. That looks wrong and is not:
 * the vendor SDK hardcodes the same three values, so they are a contract, not a bug.
 * `scripts/sandbox-data-plane-contract.test.mjs` fails if any of them drift.
 */
const DATA_PLANE_SCOPE = 'https://dynamicsessions.io/.default';
const DEFAULT_API_VERSION = '2026-02-01-preview';
const DATA_PLANE_BASE = 'https://management.azuredevcompute.io';
export const DATA_PLANE_CONTRACT = Object.freeze({
  scope: DATA_PLANE_SCOPE,
  apiVersion: DEFAULT_API_VERSION,
  base: DATA_PLANE_BASE,
  verifiedAgainst: 'azure-containerapps-sandbox 0.1.0b4'
});
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const REGION_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

function validateSegment(value, name, pattern = SEGMENT_PATTERN) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 ||
      !pattern.test(value) || value.includes('..')) {
    throw new TypeError(`${name} must be a safe URL path segment`);
  }
  return value;
}

function validateDuration(value, name, { allowZero = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${name} must be a finite ${allowZero ? 'non-negative' : 'positive'} number`);
  }
  return value;
}

const OCI_REFERENCE_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[A-Fa-f0-9]{64})?$/;
const MAX_OCI_REFERENCE_LENGTH = 512;

function validateOciReference(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_OCI_REFERENCE_LENGTH ||
      !OCI_REFERENCE_PATTERN.test(value)) {
    throw new TypeError('baseImage must be a bounded OCI image reference without URL credentials');
  }
  return value;
}

function validateManagedIdentityResourceId(value) {
  if (typeof value !== 'string') {
    throw new TypeError('managedIdentityResourceId must be a full user-assigned identity resource ID');
  }
  const parts = value.split('/');
  if (parts.length !== 9 || parts[0] !== '' ||
      parts[1].toLowerCase() !== 'subscriptions' || !GUID_PATTERN.test(parts[2]) ||
      parts[3].toLowerCase() !== 'resourcegroups' ||
      parts[5].toLowerCase() !== 'providers' ||
      parts[6].toLowerCase() !== 'microsoft.managedidentity' ||
      parts[7].toLowerCase() !== 'userassignedidentities') {
    throw new TypeError('managedIdentityResourceId must be a full user-assigned identity resource ID');
  }
  validateSegment(parts[4], 'managed identity resource group');
  validateSegment(parts[8], 'managed identity name');
  return value;
}

function validateRegistryCredentials(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('registryCredentials must contain username and token strings');
  }
  let username;
  let token;
  try {
    username = value.username;
    token = value.token;
  } catch {
    throw new TypeError('registryCredentials must contain username and token strings');
  }
  if (typeof username !== 'string' || typeof token !== 'string') {
    throw new TypeError('registryCredentials must contain username and token strings');
  }
  return { username, token };
}

function timeoutError(operation) {
  return new Error(`ACA Sandbox ${operation} timed out before confirmation`);
}

function safeHttpError(status, code) {
  const safeCode = typeof code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(code)
    ? code
    : 'Unknown';
  const error = new Error(`ACA Sandbox HTTP ${status} (${safeCode})`);
  error.status = status;
  error.code = safeCode;
  return error;
}

async function responseCode(response) {
  try {
    const body = await response.json();
    return body?.error?.code ?? body?.code;
  } catch {
    return undefined;
  }
}

async function responseBody(response) {
  if (response.status === 204 || response.status === 205) return undefined;
  try {
    return await response.json();
  } catch {
    throw new Error('ACA Sandbox response was not valid JSON');
  }
}

/** Create a small injected-transport client for the ACA Sandboxes data plane. */
export function createAcaSandboxDataPlaneClient({
  region,
  subscriptionId,
  resourceGroup,
  sandboxGroup,
  getToken,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  apiVersion = DEFAULT_API_VERSION,
  requestTimeoutMs = 30_000,
  pollIntervalMs = 1_000,
} = {}) {
  validateSegment(region, 'region', REGION_PATTERN);
  if (typeof subscriptionId !== 'string' || !GUID_PATTERN.test(subscriptionId)) {
    throw new TypeError('subscriptionId must be a GUID');
  }
  const safeResourceGroup = validateSegment(resourceGroup, 'resourceGroup');
  const safeSandboxGroup = validateSegment(sandboxGroup, 'sandboxGroup');
  if (typeof getToken !== 'function') throw new TypeError('getToken must be a function');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  if (typeof apiVersion !== 'string' || apiVersion.length === 0 || apiVersion.length > 128) {
    throw new TypeError('apiVersion must be a non-empty string of at most 128 characters');
  }
  validateDuration(requestTimeoutMs, 'requestTimeoutMs');
  validateDuration(pollIntervalMs, 'pollIntervalMs');

  const endpoint = `https://management.${region}.azuredevcompute.io`;
  const groupPath = `/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/resourceGroups/${encodeURIComponent(safeResourceGroup)}` +
    `/sandboxGroups/${encodeURIComponent(safeSandboxGroup)}`;

  async function request(method, path, {
    query = {},
    body,
    headers = {},
    deadline,
    operation = method.toLowerCase(),
    allowNotFound = false,
  } = {}) {
    const remainingMs = deadline === undefined ? Infinity : deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError(operation);
    const requestMs = Math.max(1, Math.floor(Math.min(requestTimeoutMs, remainingMs)));
    const url = new URL(`${endpoint}${path}`);
    const params = new URLSearchParams({ 'api-version': apiVersion });
    for (const [key, value] of Object.entries(query)) params.set(key, String(value));
    url.search = params.toString();

    let token;
    try {
      token = await getToken(DATA_PLANE_SCOPE);
    } catch {
      throw new Error('ACA Sandbox authentication failed');
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('ACA Sandbox authentication failed');
    }

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...headers,
        },
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(requestMs),
      });
    } catch {
      throw new Error('ACA Sandbox request failed (network or timeout error)');
    }

    if (allowNotFound && response.status === 404) return { status: 404, body: undefined };
    if (response.status < 200 || response.status >= 300) {
      throw safeHttpError(response.status, await responseCode(response));
    }
    return { status: response.status, body: await responseBody(response) };
  }

  async function pollDelay(deadline, operation) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError(operation);
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }

  async function createSandbox(requestBody, { timeoutMs = requestTimeoutMs } = {}) {
    validateDuration(timeoutMs, 'timeoutMs');
    const deadline = Date.now() + timeoutMs;
    const created = await request('PUT', `${groupPath}/sandboxes`, {
      body: JSON.stringify(requestBody),
      headers: { 'Content-Type': 'application/json' },
      deadline,
      operation: 'createSandbox',
    });
    const sandboxId = validateSegment(created.body?.id, 'sandboxId');

    while (true) {
      const polled = await request('GET', `${groupPath}/sandboxes/${encodeURIComponent(sandboxId)}`, {
        deadline,
        operation: 'createSandbox',
      });
      const sandbox = polled.body;
      if (typeof sandbox?.state === 'string' && sandbox.state.toLowerCase() === 'running') {
        return { sandboxId, sandbox };
      }
      await pollDelay(deadline, 'createSandbox');
    }
  }

  async function createDiskImage(baseImage, {
    name,
    managedIdentityResourceId,
    registryCredentials,
    timeoutMs = requestTimeoutMs,
  } = {}) {
    const safeBaseImage = validateOciReference(baseImage);
    validateDuration(timeoutMs, 'timeoutMs');

    const requestBody = { image: { base: safeBaseImage } };
    if (name !== undefined) requestBody.labels = { name: validateSegment(name, 'name') };
    if (registryCredentials !== undefined) {
      requestBody.registryCredentials = validateRegistryCredentials(registryCredentials);
    }
    if (managedIdentityResourceId !== undefined) {
      requestBody.managedIdentityResourceId = validateManagedIdentityResourceId(managedIdentityResourceId);
    }

    const deadline = Date.now() + timeoutMs;
    const credentialSecrets = Object.values(requestBody.registryCredentials ?? {}).filter(Boolean);
    const requestDiskImage = async (method, path, options) => {
      try {
        return await request(method, path, options);
      } catch (error) {
        if (error instanceof Error && credentialSecrets.some((secret) => error.message.includes(secret))) {
          if (Number.isInteger(error.status)) throw safeHttpError(error.status, 'Unknown');
          throw new Error('ACA Sandbox request failed (network or timeout error)');
        }
        throw error;
      }
    };
    const created = await requestDiskImage('POST', `${groupPath}/diskimages`, {
      body: JSON.stringify(requestBody),
      headers: { 'Content-Type': 'application/json' },
      deadline,
      operation: 'createDiskImage',
    });
    const diskImageId = validateSegment(created.body?.id, 'diskImageId');
    let diskImage = created.body;

    while (true) {
      const state = typeof diskImage?.status?.state === 'string'
        ? diskImage.status.state.toLowerCase()
        : '';
      if (state === 'ready' || state === 'succeeded') return { diskImageId, diskImage };
      if (state === 'failed') throw new Error('ACA Sandbox disk image build failed');

      const polled = await requestDiskImage('GET', `${groupPath}/diskimages/${encodeURIComponent(diskImageId)}`, {
        deadline,
        operation: 'createDiskImage',
      });
      diskImage = polled.body;
      const polledState = typeof diskImage?.status?.state === 'string'
        ? diskImage.status.state.toLowerCase()
        : '';
      if (polledState !== 'ready' && polledState !== 'succeeded' && polledState !== 'failed') {
        await pollDelay(deadline, 'createDiskImage');
      }
    }
  }

  async function writeFile(sandboxId, path, content) {
    const id = validateSegment(sandboxId, 'sandboxId');
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
      throw new TypeError('path must be a non-empty file path without null bytes');
    }
    let bytes;
    if (typeof content === 'string') bytes = Buffer.from(content, 'utf8');
    else if (content instanceof Uint8Array) bytes = content;
    else throw new TypeError('content must be a string or Uint8Array');

    const result = await request('PUT', `${groupPath}/sandboxes/${encodeURIComponent(id)}/files`, {
      query: { path, createDirs: 'true' },
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    return result.body;
  }

  async function executeShellCommand(sandboxId, command) {
    const id = validateSegment(sandboxId, 'sandboxId');
    if (typeof command !== 'string') throw new TypeError('command must be a string');
    const result = await request('POST', `${groupPath}/sandboxes/${encodeURIComponent(id)}/executeShellCommand`, {
      body: JSON.stringify({ command }),
      headers: { 'Content-Type': 'application/json' },
    });
    return result.body;
  }

  async function getEgressDecisions(sandboxId) {
    const id = validateSegment(sandboxId, 'sandboxId');
    const result = await request('GET', `${groupPath}/sandboxes/${encodeURIComponent(id)}/egress-decisions`);
    return result.body;
  }

  async function deleteSandbox(sandboxId, { timeoutMs = requestTimeoutMs } = {}) {
    const id = validateSegment(sandboxId, 'sandboxId');
    validateDuration(timeoutMs, 'timeoutMs');
    const deadline = Date.now() + timeoutMs;
    await request('DELETE', `${groupPath}/sandboxes/${encodeURIComponent(id)}`, {
      deadline,
      operation: 'deleteSandbox',
      allowNotFound: true,
    });

    while (true) {
      const result = await request('GET', `${groupPath}/sandboxes/${encodeURIComponent(id)}`, {
        deadline,
        operation: 'deleteSandbox',
        allowNotFound: true,
      });
      if (result.status === 404) return undefined;
      await pollDelay(deadline, 'deleteSandbox');
    }
  }

  return { createSandbox, createDiskImage, writeFile, executeShellCommand, getEgressDecisions, deleteSandbox };
}
