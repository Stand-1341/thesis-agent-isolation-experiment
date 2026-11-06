import { requestIdForScenario } from '../dist/request-id.js';

const SCENARIOS = new Set(['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'L1', 'L2']);
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,150}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ENV_NAME = /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIALS?|AUTHORIZATION|BEARER)(?:_|$)|(?:^|_)KEY$/i;
const SAFE_REFERENCE_ENV_NAME = /(?:^|_)(?:CLIENT_ID|SECRET_URI|KEY_VAULT_URI|KEYVAULT_URI)$/i;
const MAX_EXECUTION_TIMEOUT_MS = 600_000;

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeSegment(value, name) {
  if (typeof value !== 'string' || value.length > 128 || !SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new TypeError(`${name} must be a safe name`);
  }
  return value;
}

function validateImage(value) {
  if (typeof value !== 'string' || value.length > 255 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value) ||
      value.includes('..') || value.includes('//') || value.endsWith('/') ||
      value.endsWith(':') || value.endsWith('@')) {
    throw new TypeError('agentImage must be a safe container image reference');
  }
  const digestParts = value.split('@');
  if (digestParts.length > 2 ||
      (digestParts.length === 2 && !/^sha256:[a-f0-9]{64}$/i.test(digestParts[1]))) {
    throw new TypeError('agentImage must use a valid sha256 digest when pinned by digest');
  }
  return value;
}

function validateResources(value) {
  if (!isPlainRecord(value)) throw new TypeError('resources must be a plain object');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !['cpu', 'memory', 'ephemeralStorage'].includes(key))) {
    throw new TypeError('resources must include only cpu, memory, and optional ephemeralStorage');
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('resources must contain enumerable data values only');
    }
  }
  if (!Object.hasOwn(value, 'cpu') || !Object.hasOwn(value, 'memory')) {
    throw new TypeError('resources must include cpu and memory');
  }
  const { cpu, memory, ephemeralStorage } = value;
  if (typeof cpu !== 'number' || !Number.isFinite(cpu) || cpu <= 0 || cpu > 4) {
    throw new TypeError('resources.cpu must be finite and between 0 and 4');
  }
  if (typeof memory !== 'string' || !/^\d+(?:\.\d+)?(?:Mi|Gi)$/.test(memory) || Number.parseFloat(memory) <= 0) {
    throw new TypeError('resources.memory must use a positive Mi or Gi quantity');
  }
  if (ephemeralStorage !== undefined &&
      (typeof ephemeralStorage !== 'string' || !/^\d+(?:\.\d+)?(?:Mi|Gi)$/.test(ephemeralStorage) ||
       Number.parseFloat(ephemeralStorage) <= 0)) {
    throw new TypeError('resources.ephemeralStorage must use a positive Mi or Gi quantity');
  }
  return {
    cpu,
    memory,
    ...(ephemeralStorage === undefined ? {} : { ephemeralStorage }),
  };
}

function validateTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXECUTION_TIMEOUT_MS) {
    throw new TypeError(`executionTimeoutMs must be an integer between 1 and ${MAX_EXECUTION_TIMEOUT_MS}`);
  }
  return value;
}

function safeTrialEnvelope(trial, reset) {
  if (!isPlainRecord(trial) || typeof trial.runId !== 'string' || !SAFE_RUN_ID.test(trial.runId)) {
    throw new TypeError('trial runId is invalid');
  }
  if (typeof trial.scenario !== 'string' || !SCENARIOS.has(trial.scenario)) {
    throw new TypeError('trial scenario is invalid');
  }

  const envelope = { runId: trial.runId, scenario: trial.scenario };
  if (trial.scenario === 'U5') {
    const marker = reset?.u5Marker;
    if (typeof marker !== 'string' || !/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(marker)) {
      throw new Error('U5 requires a base fixture synthetic marker');
    }
    envelope.u5Marker = marker;
  }
  const requestId = requestIdForScenario(trial.runId, trial.scenario);
  if (requestId !== undefined) envelope.requestId = requestId;
  return envelope;
}

function buildEnvironment(environment, envelope) {
  if (!isPlainRecord(environment)) throw new TypeError('environmentForTrial must return a plain environment map');
  const entries = [];
  for (const key of Reflect.ownKeys(environment)) {
    if (typeof key !== 'string') throw new TypeError('environment contains an invalid name');
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('environment must contain enumerable data values only');
    }
    if (!SAFE_ENV_NAME.test(key)) throw new TypeError('environment contains an invalid name');
    if (SECRET_ENV_NAME.test(key) && !SAFE_REFERENCE_ENV_NAME.test(key)) continue;
    if (typeof descriptor.value !== 'string' || descriptor.value.length > 16_384 || descriptor.value.includes('\0')) {
      throw new TypeError(`environment value for ${key} is invalid`);
    }
    if (key === 'TRIAL_INPUT_JSON') continue;
    entries.push({ name: key, value: descriptor.value });
  }
  entries.push({ name: 'TRIAL_INPUT_JSON', value: JSON.stringify(envelope) });
  return entries;
}

function validateExecutionIdentity(value, jobName, expectedName, expectedId) {
  if (!isPlainRecord(value) || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'id')) {
    throw new Error('ACA Jobs returned an invalid execution identity');
  }
  const name = safeSegment(value.name, 'execution name');
  if (expectedName !== undefined && name !== expectedName) {
    throw new Error('ACA Jobs execution name does not match the started execution');
  }
  if (typeof value.id !== 'string' || value.id.length > 2048 || value.id.includes('?') || value.id.includes('#')) {
    throw new Error('ACA Jobs returned an invalid execution identity');
  }
  const match = /^\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourceGroups\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)\/providers\/Microsoft\.App\/jobs\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)\/executions\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)$/i.exec(value.id);
  if (!match || !SAFE_SEGMENT.test(match[2]) || match[2].includes('..') ||
      match[3].toLowerCase() !== jobName.toLowerCase() || match[4] !== name ||
      (expectedId !== undefined && value.id !== expectedId)) {
    throw new Error('ACA Jobs execution identity does not match the configured job');
  }
  return { name, id: value.id };
}

function rfc3339Epoch(value, label) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || value.length > 64) throw new TypeError(`ACA Jobs execution ${label} is not a valid RFC3339 timestamp`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, , offsetSign, offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (month < 1 || month > 12 || day < 1 || calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59 || !Number.isFinite(calendar.getTime())) {
    throw new TypeError(`ACA Jobs execution ${label} is not a valid RFC3339 timestamp`);
  }
  const offsetSeconds = (offsetHour * 3600 + offsetMinute * 60) * (offsetSign === '-' ? -1 : 1);
  return { seconds: BigInt(calendar.getTime() / 1000) - BigInt(offsetSeconds), fraction: fraction ?? '' };
}

function timestampIsEarlier(candidate, reference) {
  if (candidate.seconds !== reference.seconds) return candidate.seconds < reference.seconds;
  const width = Math.max(candidate.fraction.length, reference.fraction.length);
  return BigInt(candidate.fraction.padEnd(width, '0') || '0') < BigInt(reference.fraction.padEnd(width, '0') || '0');
}

export function sanitizeAcaJobsProviderExecution(value) {
  if (!isPlainRecord(value) || value.provider !== 'azure_container_apps_jobs') {
    throw new TypeError('ACA Jobs provider execution metadata is invalid');
  }
  const name = safeSegment(value.name, 'execution name');
  const idPattern = /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?\/providers\/Microsoft\.App\/jobs\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?\/executions\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)$/i;
  const idMatch = typeof value.id === 'string' && value.id.length <= 2048 && idPattern.exec(value.id);
  if (!idMatch || idMatch[1] !== name || typeof value.status !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.status)) {
    throw new TypeError('ACA Jobs provider execution identity or status is invalid');
  }
  const startEpoch = rfc3339Epoch(value.startTime, 'startTime');
  const endEpoch = rfc3339Epoch(value.endTime, 'endTime');
  if (timestampIsEarlier(endEpoch, startEpoch)) throw new TypeError('ACA Jobs execution endTime precedes startTime');
  const metadata = {
    provider: 'azure_container_apps_jobs',
    name,
    id: value.id,
    status: value.status,
    startTime: value.startTime,
    endTime: value.endTime,
  };
  if (value.replicaName !== undefined) metadata.replicaName = safeSegment(value.replicaName, 'replica name');
  return metadata;
}

function sanitizedExecutionMetadata(execution, identity) {
  const properties = isPlainRecord(execution.properties) ? execution.properties : {};
  return sanitizeAcaJobsProviderExecution({
    provider: 'azure_container_apps_jobs',
    ...identity,
    status: Object.hasOwn(properties, 'status') ? properties.status : undefined,
    startTime: Object.hasOwn(properties, 'startTime') ? properties.startTime : undefined,
    endTime: Object.hasOwn(properties, 'endTime') ? properties.endTime : undefined,
    replicaName: Object.hasOwn(properties, 'replicaName') ? properties.replicaName : undefined,
  });
}

export function createAcaJobsPilotAdapter({
  baseAdapter,
  client,
  jobName,
  agentImage,
  resources,
  environmentForTrial,
  readOutput,
  executionTimeoutMs = 120_000,
} = {}) {
  if (!baseAdapter || typeof baseAdapter.reset !== 'function' || typeof baseAdapter.collect !== 'function') {
    throw new TypeError('baseAdapter with reset and collect methods is required');
  }
  if (!client || typeof client.startJob !== 'function' || typeof client.waitForExecution !== 'function') {
    throw new TypeError('client with startJob and waitForExecution methods is required');
  }
  const safeJobName = safeSegment(jobName, 'jobName');
  const safeAgentImage = validateImage(agentImage);
  const safeResources = validateResources(resources);
  if (typeof environmentForTrial !== 'function') throw new TypeError('environmentForTrial must be a function');
  if (typeof readOutput !== 'function') throw new TypeError('readOutput must be a function');
  const timeoutMs = validateTimeout(executionTimeoutMs);

  return {
    reset(trial) {
      return baseAdapter.reset(trial);
    },

    async execute(trial, reset, timing) {
      const envelope = safeTrialEnvelope(trial, reset);
      const environment = environmentForTrial(trial, reset);
      const env = buildEnvironment(environment, envelope);
      const executionTemplate = {
        containers: [{
          name: 'agent',
          image: safeAgentImage,
          command: ['node', 'dist/agent-runner.js'],
          resources: safeResources,
          env,
        }],
      };

      const started = await client.startJob(executionTemplate, { timeoutMs });
      const startedIdentity = validateExecutionIdentity(started, safeJobName);
      const execution = await client.waitForExecution(startedIdentity.name, { timeoutMs });
      const executionIdentity = validateExecutionIdentity(
        execution,
        safeJobName,
        startedIdentity.name,
        startedIdentity.id,
      );
      const properties = isPlainRecord(execution?.properties) ? execution.properties : undefined;
      const status = properties && Object.hasOwn(properties, 'status') ? properties.status : undefined;
      const providerExecution = sanitizedExecutionMetadata(execution, executionIdentity);
      if (status !== 'Succeeded') {
        const safeStatus = typeof status === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(status)
          ? status
          : 'indeterminate';
        const error = new Error(`ACA Jobs execution status is ${safeStatus}`);
        error.providerExecution = providerExecution;
        throw error;
      }

      let output;
      try {
        output = await readOutput({ trial, execution, reset, timing });
      } catch {
        const error = new Error('ACA Jobs log output read failed');
        error.providerExecution = providerExecution;
        throw error;
      }
      if (!isPlainRecord(output) || !Object.hasOwn(output, 'runId') || !Object.hasOwn(output, 'scenario')) {
        const error = new Error('ACA Jobs log output is missing or ambiguous');
        error.providerExecution = providerExecution;
        throw error;
      }
      if (output.runId !== trial.runId || output.scenario !== trial.scenario) {
        const error = new Error('ACA Jobs log output does not match the scheduled trial');
        error.providerExecution = providerExecution;
        throw error;
      }

      return { workloadOutput: output, providerExecution };
    },

    collect(trial, reset, output, timing) {
      return baseAdapter.collect(trial, reset, output, timing);
    },
  };
}
