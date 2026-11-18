import { SCENARIOS } from '../dist/core.js';
import { requestIdForScenario } from '../dist/request-id.js';

const DEFAULT_EXEC_COMMAND = 'cd /app && node dist/agent-runner.js';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,150}$/;
const SAFE_SANDBOX_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SAFE_SYNTHETIC_MARKER = /^SYNTHETIC-[A-Za-z0-9-]{1,100}$/;
const CORRELATED_SCENARIOS = new Set(['U1', 'U5', 'U6', 'U8']);
const LIFECYCLE = Object.freeze({
  autoSuspendPolicy: Object.freeze({ enabled: true, interval: 300, mode: 'Memory' }),
});

function plainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cloneJson(value, name, { array = false, rejectSensitiveKeys = false } = {}) {
  if (array ? !Array.isArray(value) : !plainRecord(value)) {
    throw new TypeError(`${name} must be ${array ? 'an array' : 'an object'}`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') throw new Error('not serializable');
  } catch {
    throw new TypeError(`${name} must contain JSON-compatible values`);
  }
  let copy;
  try {
    copy = JSON.parse(serialized);
  } catch {
    throw new TypeError(`${name} must contain JSON-compatible values`);
  }
  if (rejectSensitiveKeys && containsSensitiveKey(copy)) {
    throw new TypeError(`${name} must not contain credentials or secret values`);
  }
  return copy;
}

function containsSensitiveKey(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!plainRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    /token|secret|password|credential|authorization|bearer|api.?key|access.?key/i.test(key) || containsSensitiveKey(nested));
}

function validateTrial(trial) {
  if (!plainRecord(trial) || typeof trial.runId !== 'string' || !SAFE_RUN_ID.test(trial.runId) ||
      typeof trial.scenario !== 'string' || !SCENARIOS.includes(trial.scenario)) {
    throw new TypeError('trial must contain a valid runId and scheduled scenario');
  }
  return trial;
}

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function isSafeDiskImageId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  const path = value.startsWith('/') ? value.slice(1) : value;
  const segments = path.split('/');
  return segments.length > 0 && segments.every((segment) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) && !segment.includes('..'));
}

function safeEnvironment(value) {
  if (!plainRecord(value)) throw new TypeError('environment builder must return an object');
  const environment = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== 'string') {
      throw new TypeError('environment builder must return string-valued environment variables');
    }
    if (name === 'TRIAL_INPUT_JSON') {
      throw new TypeError('environment builder must not override TRIAL_INPUT_JSON');
    }
    const safeReferenceName = /(?:_SECRET_URI|_CLIENT_ID)$/i.test(name);
    if (!safeReferenceName && /token|secret|password|credential|authorization|identity_header|bearer/i.test(name)) {
      throw new TypeError('environment builder must not provide secret values');
    }
    environment[name] = entry;
  }
  return environment;
}

function validatePolicyResult(value, name, { array = false } = {}) {
  const policy = cloneJson(value, name, { array, rejectSensitiveKeys: true });
  if (array && (policy.length === 0 || policy.some((entry) => !plainRecord(entry) ||
      typeof entry.identity !== 'string' || !['main', 'none'].includes(entry.lifecycle)) ||
      !policy.some((entry) => entry.lifecycle === 'none') ||
      policy.some((entry) => /pull/i.test(entry.identity) && entry.lifecycle !== 'none'))) {
    throw new TypeError(`${name} must keep the image-pull identity lifecycle at none`);
  }
  return policy;
}

function makeEnvelope(trial, baseReset) {
  const requestId = requestIdForScenario(trial.runId, trial.scenario);
  if (trial.scenario === 'U5' &&
      (typeof baseReset?.u5Marker !== 'string' || !SAFE_SYNTHETIC_MARKER.test(baseReset.u5Marker))) {
    throw new Error('U5 reset requires a synthetic marker');
  }
  return {
    runId: trial.runId,
    scenario: trial.scenario,
    ...(trial.scenario === 'U5' ? { u5Marker: baseReset.u5Marker } : {}),
    ...(CORRELATED_SCENARIOS.has(trial.scenario) ? { requestId } : {}),
  };
}

function validEgressTelemetry(value) {
  return plainRecord(value) && plainRecord(value.networkEgress) &&
    Array.isArray(value.networkEgress.allowed) && value.networkEgress.allowed.every(plainRecord) &&
    Array.isArray(value.networkEgress.denied) && value.networkEgress.denied.every(plainRecord);
}

function safeOperationReset(reset, trial, assignments) {
  const assignment = reset && typeof reset === 'object' ? assignments.get(reset) : undefined;
  if (!assignment || assignment.runId !== trial.runId || assignment.scenario !== trial.scenario) {
    throw new Error('trial and sandbox reset do not match');
  }
  return assignment;
}

/** Build a one-sandbox adapter around the existing Azure fixture adapter. */
export function createAcaSandboxPilotAdapter({
  baseAdapter,
  client,
  sandboxGroup,
  diskImageId,
  resources,
  environmentForTrial,
  identitySettingsForTrial,
  egressPolicyForTrial,
  customerVnetConnectionName,
  execCommand = DEFAULT_EXEC_COMMAND,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!baseAdapter || typeof baseAdapter.reset !== 'function' || typeof baseAdapter.collect !== 'function' ||
      (baseAdapter.cleanup !== undefined && typeof baseAdapter.cleanup !== 'function') ||
      !client || typeof client.createSandbox !== 'function' || typeof client.executeShellCommand !== 'function' ||
      typeof client.getEgressDecisions !== 'function' || typeof client.deleteSandbox !== 'function') {
    throw new TypeError('invalid ACA Sandbox pilot adapter configuration');
  }
  if (typeof sandboxGroup !== 'string' || !SAFE_SANDBOX_ID.test(sandboxGroup) || sandboxGroup.includes('..')) {
    throw new TypeError('sandboxGroup must be a safe group name');
  }
  if (!isSafeDiskImageId(diskImageId)) {
    throw new TypeError('disk image ID must be a non-empty bounded value');
  }
  if (customerVnetConnectionName !== undefined &&
      (typeof customerVnetConnectionName !== 'string' || !SAFE_SANDBOX_ID.test(customerVnetConnectionName) ||
       customerVnetConnectionName.includes('..'))) {
    throw new TypeError('customerVnetConnectionName must be a safe connection name');
  }
  const configuredResources = cloneJson(resources, 'resources', { rejectSensitiveKeys: true });
  if (typeof environmentForTrial !== 'function' || typeof identitySettingsForTrial !== 'function' ||
      typeof egressPolicyForTrial !== 'function') {
    throw new TypeError('environment, identity, and egress policy builders are required');
  }
  if (typeof execCommand !== 'string' || execCommand.length === 0 || execCommand.length > 512 ||
      /[\r\n\0]/.test(execCommand)) {
    throw new TypeError('execCommand must be a fixed non-empty command');
  }
  const safeTimeoutMs = validateTimeout(timeoutMs);
  const assignments = new WeakMap();

  return {
    cleanupOnFailure: true,

    async reset(trialInput) {
      const trial = validateTrial(trialInput);
      let baseReset;
      try {
        baseReset = await baseAdapter.reset(trial);
      } catch {
        throw new Error('ACA Sandbox base fixture reset failed');
      }
      if (!plainRecord(baseReset)) throw new Error('ACA Sandbox base fixture reset returned invalid data');

      let envelope;
      let environment;
      let identitySettings;
      let egressPolicy;
      try {
        envelope = makeEnvelope(trial, baseReset);
        environment = {
          ...safeEnvironment(await environmentForTrial(trial, baseReset)),
          TRIAL_INPUT_JSON: JSON.stringify(envelope),
        };
        identitySettings = validatePolicyResult(
          await identitySettingsForTrial(trial, baseReset), 'identitySettings', { array: true },
        );
        egressPolicy = validatePolicyResult(await egressPolicyForTrial(trial, baseReset), 'egressPolicy');
      } catch (error) {
        if (error instanceof TypeError && /^(U5 reset|trial)/.test(error.message)) throw error;
        if (error instanceof Error && error.message === 'U5 reset requires a synthetic marker') throw error;
        throw new Error('ACA Sandbox trial configuration is invalid');
      }

      const lifecycle = cloneJson(LIFECYCLE, 'lifecycle');
      const requestBody = {
        sourcesRef: { diskImage: { id: diskImageId } },
        resources: configuredResources,
        lifecycle,
        identitySettings,
        egressPolicy,
        environment,
        ...(customerVnetConnectionName === undefined ? {} : { customerVnetConnectionName }),
      };

      let created;
      try {
        created = await client.createSandbox(requestBody, { timeoutMs: safeTimeoutMs });
      } catch {
        throw new Error('ACA Sandbox creation failed');
      }
      const sandboxId = created?.sandboxId;
      if (typeof sandboxId !== 'string' || !SAFE_SANDBOX_ID.test(sandboxId) || sandboxId.includes('..')) {
        throw new Error('ACA Sandbox creation returned an invalid sandbox ID');
      }
      const sandboxPolicy = {
        sandboxGroup,
        diskImageId,
        resources: cloneJson(configuredResources, 'resources'),
        lifecycle,
        identitySettings: cloneJson(identitySettings, 'identitySettings', { array: true }),
        egressPolicy: cloneJson(egressPolicy, 'egressPolicy'),
        ...(customerVnetConnectionName === undefined ? {} : { customerVnetConnectionName }),
      };
      const reset = { ...baseReset, sandboxId, sandboxPolicy };
      assignments.set(reset, { runId: trial.runId, scenario: trial.scenario, sandboxId });
      return reset;
    },

    async execute(trialInput, reset) {
      const trial = validateTrial(trialInput);
      const assignment = safeOperationReset(reset, trial, assignments);
      let result;
      try {
        result = await client.executeShellCommand(assignment.sandboxId, execCommand);
      } catch {
        throw new Error('ACA Sandbox execution failed');
      }
      if (!plainRecord(result) || result.exitCode !== 0) {
        // Only the exit code is safe to surface: stdout/stderr belong to the
        // untrusted workload and may contain credentials or fixture markers.
        const detail = plainRecord(result) ? ` with exit code ${String(result.exitCode).slice(0,20)}` : '';
        throw new Error(`ACA Sandbox execution failed${detail}`);
      }
      if (typeof result.stdout !== 'string') throw new Error('ACA Sandbox stdout did not contain one JSON result');
      const lines = result.stdout.trim().split(/\r?\n/);
      if (lines.length !== 1 || lines[0].trim().length === 0) {
        throw new Error('ACA Sandbox stdout did not contain exactly one JSON result');
      }
      let output;
      try {
        output = JSON.parse(lines[0]);
      } catch {
        throw new Error('ACA Sandbox stdout did not contain valid JSON');
      }
      if (!plainRecord(output) || output.runId !== trial.runId || output.scenario !== trial.scenario) {
        throw new Error('ACA Sandbox result identity mismatch');
      }
      return output;
    },

    async collect(trialInput, reset, output, timing) {
      const trial = validateTrial(trialInput);
      const assignment = safeOperationReset(reset, trial, assignments);
      let baseEvidence;
      try {
        baseEvidence = await baseAdapter.collect(trial, reset, output, timing);
      } catch {
        throw new Error('ACA Sandbox base evidence collection failed');
      }
      if (!plainRecord(baseEvidence)) throw new Error('ACA Sandbox base evidence is invalid');
      const evidence = { ...baseEvidence };
      delete evidence.sandboxEgressDecisions;
      try {
        const telemetry = await client.getEgressDecisions(assignment.sandboxId);
        if (validEgressTelemetry(telemetry)) evidence.sandboxEgressDecisions = telemetry;
      } catch {
        // Missing telemetry is unobserved; it is not evidence of a denial.
      }
      return evidence;
    },

    async cleanup(trialInput, reset) {
      const trial = validateTrial(trialInput);
      const assignment = reset && typeof reset === 'object' ? assignments.get(reset) : undefined;
      const errors = [];
      let sandboxDeleted = false;
      if (assignment && assignment.runId === trial.runId && assignment.scenario === trial.scenario) {
        try {
          await client.deleteSandbox(assignment.sandboxId, { timeoutMs: safeTimeoutMs });
          sandboxDeleted = true;
        } catch {
          errors.push(new Error('ACA Sandbox deletion failed or was not confirmed'));
        }
      }
      let baseCleanup;
      if (typeof baseAdapter.cleanup === 'function') {
        try {
          baseCleanup = await baseAdapter.cleanup(trial, reset);
        } catch {
          errors.push(new Error('ACA Sandbox base cleanup failed'));
        }
      }
      if (errors.length) throw new AggregateError(errors, 'ACA Sandbox cleanup failed');
      return {
        ...(sandboxDeleted ? { sandboxDeleted: true } : {}),
        ...(baseCleanup === undefined ? {} : { baseCleanup }),
      };
    },
  };
}
