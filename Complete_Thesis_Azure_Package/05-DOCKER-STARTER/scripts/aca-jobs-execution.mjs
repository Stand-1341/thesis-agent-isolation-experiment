const ARM_ENDPOINT = 'https://management.azure.com';
const ARM_SCOPE = 'https://management.azure.com/.default';
const DEFAULT_API_VERSION = '2026-07-01';
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_POLL_ATTEMPTS = 120;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const ACTIVE_STATUSES = new Set(['Running', 'Processing']);
const TERMINAL_STATUSES = new Set(['Succeeded', 'Stopped', 'Degraded', 'Failed']);

function validateSegment(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 ||
      !SEGMENT_PATTERN.test(value) || value.includes('..')) {
    throw new TypeError(`${name} must be a safe URL path segment`);
  }
  return value;
}

function validateDuration(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite positive number`);
  }
  return value;
}

function timeoutError(operation) {
  return new Error(`ACA Jobs ${operation} timed out`);
}

function httpError(status) {
  const boundedStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  const error = new Error(`ACA Jobs HTTP ${boundedStatus}`);
  error.status = boundedStatus;
  return error;
}

function validateExecutionResult(body, expectedName, jobPath, operation = 'start') {
  const name = body?.name;
  const id = body?.id;
  try {
    validateSegment(name, 'executionName');
  } catch {
    throw new Error(`ACA Jobs ${operation} returned an invalid execution response`);
  }
  if (typeof id !== 'string' || id.length > 2048 || id.includes('?') || id.includes('#')) {
    throw new Error(`ACA Jobs ${operation} returned an invalid execution response`);
  }

  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/jobs\/([^/]+)\/executions\/([^/]+)$/i.exec(id);
  if (!match ||
      match[1].toLowerCase() !== jobPath.subscriptionId.toLowerCase() ||
      match[2].toLowerCase() !== jobPath.resourceGroup.toLowerCase() ||
      match[3].toLowerCase() !== jobPath.jobName.toLowerCase() ||
      match[4].toLowerCase() !== name.toLowerCase() ||
      (expectedName !== undefined && expectedName.toLowerCase() !== name.toLowerCase())) {
    throw new Error(`ACA Jobs ${operation} returned an invalid execution response`);
  }
  try {
    for (const segment of match.slice(1)) validateSegment(segment, 'executionId');
  } catch {
    throw new Error(`ACA Jobs ${operation} returned an invalid execution response`);
  }
  return { name, id };
}

function trustedLocation(value, { subscriptionId, jobPath, apiVersion }) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) {
    throw new Error('ACA Jobs start returned an untrusted Location');
  }
  let url;
  try {
    url = new URL(value, ARM_ENDPOINT);
  } catch {
    throw new Error('ACA Jobs start returned an untrusted Location');
  }
  if (url.origin !== ARM_ENDPOINT || url.protocol !== 'https:' || url.username || url.password ||
      url.port || url.hash) {
    throw new Error('ACA Jobs start returned an untrusted Location');
  }

  const path = url.pathname;
  const configuredStartPath = `${jobPath.path}/start`.toLowerCase();
  let belongsToJob = path.toLowerCase() === configuredStartPath;
  if (path.toLowerCase().startsWith(`${configuredStartPath}/`)) {
    const suffix = path.slice(configuredStartPath.length + 1).split('/');
    belongsToJob = suffix.length > 0 && suffix.every((part) => SEGMENT_PATTERN.test(part));
  }
  const operationPath = new RegExp(
    `^/subscriptions/${subscriptionId}/providers/Microsoft\\.App/locations/[A-Za-z0-9][A-Za-z0-9._-]{0,126}/(?:operationStatuses|operationResults)/[A-Za-z0-9][A-Za-z0-9._-]{0,126}$`,
    'i',
  );
  if (!belongsToJob && !operationPath.test(path)) {
    throw new Error('ACA Jobs start returned an untrusted Location');
  }

  const queryEntries = [...url.searchParams.entries()];
  if (queryEntries.some(([key]) => key.toLowerCase() !== 'api-version') ||
      url.searchParams.getAll('api-version').length > 1 ||
      (url.searchParams.has('api-version') && url.searchParams.get('api-version') !== apiVersion)) {
    throw new Error('ACA Jobs start returned an untrusted Location');
  }
  url.searchParams.set('api-version', apiVersion);
  return url.toString();
}

function retryDelay(response, nowValue, fallbackMs) {
  const raw = response.headers?.get?.('retry-after');
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallbackMs;
  const value = String(raw).trim();
  let milliseconds;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    milliseconds = Number(value) * 1000;
  } else {
    const parsedDate = Date.parse(value);
    if (!Number.isFinite(parsedDate)) return fallbackMs;
    milliseconds = parsedDate - nowValue;
  }
  if (!Number.isFinite(milliseconds)) return fallbackMs;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, milliseconds));
}

export function createAcaJobsExecutionClient({
  subscriptionId,
  resourceGroup,
  jobName,
  getToken,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  apiVersion = DEFAULT_API_VERSION,
  requestTimeoutMs = 30_000,
  pollIntervalMs = 1_000,
} = {}) {
  if (typeof subscriptionId !== 'string' || !GUID_PATTERN.test(subscriptionId)) {
    throw new TypeError('subscriptionId must be a GUID');
  }
  const safeResourceGroup = validateSegment(resourceGroup, 'resourceGroup');
  const safeJobName = validateSegment(jobName, 'jobName');
  if (typeof getToken !== 'function') throw new TypeError('getToken must be a function');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof apiVersion !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(apiVersion)) {
    throw new TypeError('apiVersion must be a safe non-empty version string');
  }
  validateDuration(requestTimeoutMs, 'requestTimeoutMs');
  validateDuration(pollIntervalMs, 'pollIntervalMs');

  const jobPath = {
    subscriptionId,
    resourceGroup: safeResourceGroup,
    jobName: safeJobName,
    path: `/subscriptions/${encodeURIComponent(subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(safeResourceGroup)}` +
      `/providers/Microsoft.App/jobs/${encodeURIComponent(safeJobName)}`,
  };

  async function request(method, url, { body, deadline, operation }) {
    const remainingMs = deadline === undefined ? requestTimeoutMs : deadline - now();
    if (remainingMs <= 0) throw timeoutError(operation);
    const timeoutMs = Math.max(1, Math.floor(Math.min(requestTimeoutMs, remainingMs)));
    const controller = new AbortController();
    let timer;
    const requestTimeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError(operation));
      }, timeoutMs);
    });

    const requestWork = (async () => {
      let token;
      try {
        token = await getToken(ARM_SCOPE);
      } catch {
        throw new Error('ACA Jobs authentication failed');
      }
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error('ACA Jobs authentication failed');
      }
      if (controller.signal.aborted) throw timeoutError(operation);

      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw timeoutError(operation);
        throw new Error('ACA Jobs request failed');
      }

      if (response.status < 200 || response.status >= 300) throw httpError(response.status);
      if (response.status === 202) return { status: response.status, body: undefined, response };
      if (response.status !== 200) throw httpError(response.status);

      let responseBody;
      try {
        responseBody = await response.json();
      } catch {
        throw new Error('ACA Jobs response was not valid JSON');
      }
      return { status: response.status, body: responseBody, response };
    })();

    try {
      return await Promise.race([requestWork, requestTimeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollSleep(delayMs, deadline, operation) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw timeoutError(operation);
    const waitMs = Math.min(Math.max(0, delayMs), remainingMs);
    let timer;
    const deadlineReached = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(operation)), Math.max(1, Math.ceil(remainingMs)));
    });
    try {
      await Promise.race([
        Promise.resolve().then(() => sleep(waitMs)),
        deadlineReached,
      ]);
    } catch (error) {
      if (error?.message === `ACA Jobs ${operation} timed out`) throw error;
      throw new Error(`ACA Jobs ${operation} wait failed`);
    } finally {
      clearTimeout(timer);
    }
    if (waitMs >= remainingMs || deadline - now() <= 0) throw timeoutError(operation);
  }

  function makeApiUrl(path) {
    const url = new URL(`${ARM_ENDPOINT}${path}`);
    url.searchParams.set('api-version', apiVersion);
    return url.toString();
  }

  function validateExecutionName(name) {
    return validateSegment(name, 'executionName');
  }

  async function getExecutionInternal(executionName, deadline, operation = 'getExecution') {
    const safeName = validateExecutionName(executionName);
    const url = makeApiUrl(`${jobPath.path}/executions/${encodeURIComponent(safeName)}`);
    const result = await request('GET', url, { deadline, operation });
    return result.body;
  }

  async function startJob(executionTemplate, { timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS } = {}) {
    validateDuration(timeoutMs, 'timeoutMs');
    if (!executionTemplate || typeof executionTemplate !== 'object' || Array.isArray(executionTemplate) ||
        !Array.isArray(executionTemplate.containers) ||
        (executionTemplate.initContainers !== undefined && !Array.isArray(executionTemplate.initContainers))) {
      throw new TypeError('executionTemplate must be a JobExecutionTemplate object with containers');
    }
    let body;
    try {
      body = JSON.stringify(executionTemplate);
    } catch {
      throw new TypeError('executionTemplate must be JSON serializable');
    }
    if (typeof body !== 'string') throw new TypeError('executionTemplate must be JSON serializable');

    const deadline = now() + timeoutMs;
    const startUrl = makeApiUrl(`${jobPath.path}/start`);
    const initial = await request('POST', startUrl, { body, deadline, operation: 'startJob' });
    if (initial.status === 200) return validateExecutionResult(initial.body, undefined, jobPath);
    if (initial.status !== 202) throw httpError(initial.status);

    const location = trustedLocation(initial.response.headers?.get?.('location'), {
      subscriptionId,
      jobPath,
      apiVersion,
    });
    let lastResponse = initial.response;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      const delayMs = retryDelay(lastResponse, now(), pollIntervalMs);
      await pollSleep(delayMs, deadline, 'startJob');
      const polled = await request('GET', location, { deadline, operation: 'startJob' });
      if (polled.status === 200) return validateExecutionResult(polled.body, undefined, jobPath);
      if (polled.status !== 202) throw httpError(polled.status);
      lastResponse = polled.response;
    }
    throw new Error('ACA Jobs start polling exceeded the poll limit');
  }

  async function getExecution(executionName) {
    return getExecutionInternal(executionName);
  }

  async function waitForExecution(executionName, { timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS } = {}) {
    const safeName = validateExecutionName(executionName);
    validateDuration(timeoutMs, 'timeoutMs');
    const deadline = now() + timeoutMs;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      if (deadline - now() <= 0) throw timeoutError('waitForExecution');
      const execution = await getExecutionInternal(safeName, deadline, 'waitForExecution');
      validateExecutionResult(execution, safeName, jobPath, 'execution');
      const status = execution?.properties?.status;
      if (status === 'Succeeded' || TERMINAL_STATUSES.has(status)) return execution;
      if (!ACTIVE_STATUSES.has(status)) {
        throw new Error('ACA Jobs indeterminate execution status');
      }
      await pollSleep(pollIntervalMs, deadline, 'waitForExecution');
    }
    throw new Error('ACA Jobs execution polling exceeded the poll limit');
  }

  return { startJob, getExecution, waitForExecution };
}
