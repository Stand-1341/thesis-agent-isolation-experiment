/**
 * ACA Jobs no-op / positive-control baseline harness (non-counted evidence).
 *
 * Why this exists: ACA Jobs egress traverses a subnet and firewall shared with
 * platform traffic, so a firewall record scoped only by source can be satisfied
 * by traffic the workload never generated. Before any measured P3 trial counts
 * firewall evidence, this harness characterizes what the evidence scope looks
 * like when the workload asks for nothing:
 *
 *   - runNoop: the same job image/resources running a fixed, side-effect-free
 *     command that performs no network request. Any firewall record in that
 *     execution's exact ARM window is, by construction, unrelated traffic — a
 *     collision with trial attribution, returned as normalized fingerprints and
 *     counts for later subtraction.
 *   - runPositiveControl: the same image/resources running a fixed script that
 *     performs exactly one HTTPS request to a validated allowed health URL. The
 *     control is only "validated" when an allow record for the exact target
 *     FQDN is independently observed inside the execution's ARM window. Zero
 *     rows, a failed query, a failed execution, or an invalid window are
 *     `unobserved` — never a passing negative, and never a clean baseline.
 *
 * Everything is injected: the ACA Jobs execution client (which owns all ARM
 * authentication; this module never sees or handles tokens) and a
 * `readFirewallEvents({execution, window, kind, targetFqdn})` reader callback
 * that must return an array of firewall event rows for the exact bounded
 * window. `window` is `{from, to}` — the execution record's RFC3339
 * startTime/endTime verbatim, so query windows always come from ARM
 * timestamps. `execution` is sanitized identity metadata only. `kind` is
 * 'all' (no-op noise census) or 'allow' (positive-control match).
 *
 * Statuses (`BASELINE_STATUS`):
 *   validated — the positive control's allow record was independently observed
 *               within its ARM window (and, in evaluateNoopBaseline, the no-op
 *               window was also queried and clean).
 *   collision — records exist in a no-op window where no request was made.
 *   unobserved — evidence missing, query failed, or execution not Succeeded.
 *
 * No readiness flag is created or updated here. A `validated` verdict is an
 * assertion input for the operator, not proof of a measured trial.
 */

const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,150}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const FQDN_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const EXECUTION_ID_PATTERN = /^\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourceGroups\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)\/providers\/Microsoft\.App\/jobs\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)\/executions\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?)$/i;
const MAX_EXECUTION_TIMEOUT_MS = 600_000;
const NOISE_FINGERPRINT_CAP = 200;

export const BASELINE_STATUS = Object.freeze({
  validated: 'validated',
  collision: 'collision',
  unobserved: 'unobserved',
});

// Fixed container commands. Neither contains any caller-supplied value: the
// control target travels only in the validated BASELINE_CONTROL_URL env entry.
const NOOP_COMMAND = [
  'node',
  '-e',
  "'use strict'; /* ACA Jobs no-op baseline: fixed command; no network, filesystem, or environment access */ void 0;",
];
const CONTROL_COMMAND = [
  'node',
  '-e',
  "'use strict'; /* ACA Jobs baseline positive control: exactly one outbound request, target only via validated env */"
  + ' const target=process.env.BASELINE_CONTROL_URL;'
  + ' if(typeof target!=="string"||target.length===0){process.exit(3);}'
  + ' const request=require("https").get(target);'
  + ' request.setTimeout(15000,function(){request.destroy(new Error("baseline control request timed out"));});'
  + ' request.on("error",function(){process.exit(4);});'
  + ' request.on("response",function(response){response.resume();'
  + '   response.on("end",function(){process.exit(response.statusCode>=200&&response.statusCode<400?0:5);});});',
];

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeSegment(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 ||
      !SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new TypeError(`${name} must be a safe name`);
  }
  return value;
}

function validateRunId(value) {
  if (typeof value !== 'string' || !SAFE_RUN_ID.test(value)) {
    throw new TypeError('runId must be a short alphanumeric identifier');
  }
  return value;
}

/** The baseline must run the exact bits the measured job runs: digest-pinned. */
function validatePinnedImage(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError('agentImage must be a digest-pinned container image reference');
  }
  const separator = value.lastIndexOf('@');
  if (separator < 0 || !/^sha256:[a-f0-9]{64}$/i.test(value.slice(separator + 1))) {
    throw new TypeError('agentImage must be pinned by a sha256 digest');
  }
  const repository = value.slice(0, separator);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(repository) || repository.includes('..') ||
      repository.includes('//') || repository.endsWith('/') || repository.endsWith(':')) {
    throw new TypeError('agentImage must be a safe container image reference');
  }
  return value;
}

function validateResources(value) {
  if (!isPlainRecord(value)) throw new TypeError('resources must be a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !['cpu', 'memory', 'ephemeralStorage'].includes(key)) {
      throw new TypeError('resources must include only cpu, memory, and optional ephemeralStorage');
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
  return { cpu, memory, ...(ephemeralStorage === undefined ? {} : { ephemeralStorage }) };
}

function validateTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXECUTION_TIMEOUT_MS) {
    throw new TypeError(`executionTimeoutMs must be an integer between 1 and ${MAX_EXECUTION_TIMEOUT_MS}`);
  }
  return value;
}

/**
 * Validate the positive-control URL. It must be an absolute https URL with a
 * DNS hostname, no credentials, and no fragment. The value is passed to the
 * container only as this validated environment entry — never interpolated into
 * the fixed command, where any string could become shell or script content.
 */
function validateControlUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new TypeError('allowedUrl must be an absolute https URL');
  }
  if (/[\s\0]/.test(value)) {
    throw new TypeError('allowedUrl must not contain whitespace or control characters');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('allowedUrl must be an absolute https URL');
  }
  if (url.protocol !== 'https:') throw new TypeError('allowedUrl must be an absolute https URL');
  if (url.username || url.password) throw new TypeError('allowedUrl must not include credentials');
  if (url.hash) throw new TypeError('allowedUrl must not include a fragment');
  const hostname = url.hostname.toLowerCase();
  if (hostname.length > 253 || !FQDN_PATTERN.test(hostname) || IPV4_PATTERN.test(hostname)) {
    throw new TypeError('allowedUrl hostname must be a DNS name');
  }
  if (url.port !== '' && !(Number.isInteger(Number(url.port)) && Number(url.port) >= 1 && Number(url.port) <= 65535)) {
    throw new TypeError('allowedUrl port must be between 1 and 65535');
  }
  return { href: url.toString(), fqdn: hostname };
}

function validateExecutionIdentity(value, jobName, expectedName, expectedId) {
  if (!isPlainRecord(value) || typeof value.name !== 'string' || typeof value.id !== 'string') {
    throw new Error('ACA Jobs baseline returned an invalid execution identity');
  }
  const name = safeSegment(value.name, 'execution name');
  const match = EXECUTION_ID_PATTERN.exec(value.id);
  if (!match || match[3].toLowerCase() !== jobName.toLowerCase() || match[4] !== name ||
      (expectedName !== undefined && name !== expectedName) ||
      (expectedId !== undefined && value.id !== expectedId)) {
    if (expectedName !== undefined && name !== expectedName) {
      throw new Error('ACA Jobs baseline execution identity does not match the started execution');
    }
    throw new Error('ACA Jobs baseline execution identity does not match the configured job');
  }
  return { name, id: value.id };
}

/** Allowlisted provider fields only — never the raw execution object. */
function sanitizedExecutionMetadata(execution, identity) {
  const properties = isPlainRecord(execution?.properties) ? execution.properties : {};
  const metadata = { ...identity };
  if (typeof properties.status === 'string' && properties.status.length > 0 && properties.status.length <= 64 &&
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(properties.status)) {
    metadata.status = properties.status;
  }
  for (const key of ['startTime', 'endTime']) {
    const value = properties[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\r\n\0]/.test(value)) {
      metadata[key] = value;
    }
  }
  return metadata;
}

/**
 * The evidence window is the execution record's own RFC3339 startTime/endTime,
 * verbatim and strictly ordered. Anything else fails closed: an invalid window
 * can never be widened or repaired into evidence.
 */
function validatedTimingWindow(properties) {
  const { startTime, endTime } = properties ?? {};
  if (typeof startTime !== 'string' || typeof endTime !== 'string' ||
      !RFC3339_PATTERN.test(startTime) || !RFC3339_PATTERN.test(endTime)) {
    throw new Error('ACA Jobs baseline execution timing window is invalid');
  }
  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('ACA Jobs baseline execution timing window is invalid');
  }
  return { from: startTime, to: endTime };
}

function pickField(row, names) {
  for (const name of names) {
    if (row !== null && typeof row === 'object' && Object.hasOwn(row, name) &&
        row[name] !== undefined && row[name] !== null) {
      return row[name];
    }
  }
  return undefined;
}

function normalizeFqdn(value) {
  if (typeof value !== 'string') return '(invalid)';
  const candidate = value.trim().toLowerCase().slice(0, 253);
  return candidate.length > 0 && FQDN_PATTERN.test(candidate) ? candidate : '(invalid)';
}

/**
 * Reduce a raw firewall row to a normalized fingerprint: action, FQDN, port,
 * protocol. Nothing else survives — no raw log text, URLs, queries, or any
 * field a shared pipeline might carry tokens in.
 */
function normalizeRow(row) {
  const action = String(pickField(row, ['Action', 'action']) ?? 'other').toLowerCase();
  const normalizedAction = action === 'allow' || action === 'deny' ? action : 'other';
  const portCandidate = Number(pickField(row, ['DestinationPort', 'destinationPort']));
  const destinationPort = Number.isInteger(portCandidate) && portCandidate >= 1 && portCandidate <= 65535
    ? portCandidate : null;
  const protocolCandidate = pickField(row, ['Protocol', 'protocol']);
  const protocol = typeof protocolCandidate === 'string' && /^[A-Za-z0-9-]{1,16}$/.test(protocolCandidate)
    ? protocolCandidate.toLowerCase() : null;
  return {
    action: normalizedAction,
    fqdn: normalizeFqdn(pickField(row, ['Fqdn', 'fqdn', 'TargetFqdn', 'targetFqdn'])),
    destinationPort,
    protocol,
  };
}

function summarizeNoise(rows) {
  const fingerprints = new Map();
  let allowRecords = 0;
  let denyRecords = 0;
  for (const row of rows) {
    const fingerprint = normalizeRow(row);
    if (fingerprint.action === 'allow') allowRecords += 1;
    else if (fingerprint.action === 'deny') denyRecords += 1;
    const key = `${fingerprint.action}|${fingerprint.fqdn}|${fingerprint.destinationPort ?? ''}|${fingerprint.protocol ?? ''}`;
    const existing = fingerprints.get(key);
    if (existing) existing.count += 1;
    else fingerprints.set(key, { ...fingerprint, count: 1 });
  }
  const list = [...fingerprints.values()].sort((a, b) =>
    a.action < b.action ? -1 : a.action > b.action ? 1
      : a.fqdn < b.fqdn ? -1 : a.fqdn > b.fqdn ? 1
        : (a.destinationPort ?? -1) - (b.destinationPort ?? -1) ||
          (a.protocol ?? '').localeCompare(b.protocol ?? ''));
  return {
    totalRecords: rows.length,
    allowRecords,
    denyRecords,
    otherRecords: rows.length - allowRecords - denyRecords,
    fingerprints: list.slice(0, NOISE_FINGERPRINT_CAP),
  };
}

/**
 * @param client              ACA Jobs execution client ({startJob,waitForExecution}).
 *                            Owns ARM authentication; this module adds nothing
 *                            secret to anything the client receives.
 * @param jobName             The configured ACA Job the baseline executes.
 * @param agentImage          The exact digest-pinned image measured trials use.
 * @param resources           Container resources identical to measured trials.
 * @param executionTimeoutMs  Start/wait budget per execution.
 * @param readFirewallEvents  async ({execution, window, kind, targetFqdn}) => rows[].
 */
export function createAcaJobsNoopBaseline({
  client,
  jobName,
  agentImage,
  resources,
  executionTimeoutMs = 120_000,
  readFirewallEvents,
} = {}) {
  if (!client || typeof client.startJob !== 'function' || typeof client.waitForExecution !== 'function') {
    throw new TypeError('client with startJob and waitForExecution methods is required');
  }
  if (typeof readFirewallEvents !== 'function') {
    throw new TypeError('readFirewallEvents must be a function');
  }
  const safeJobName = safeSegment(jobName, 'jobName');
  const safeImage = validatePinnedImage(agentImage);
  const safeResources = validateResources(resources);
  const timeoutMs = validateTimeout(executionTimeoutMs);

  function baseTemplate(command, env) {
    return {
      containers: [{
        name: 'baseline',
        image: safeImage,
        command,
        resources: safeResources,
        ...(env === undefined ? {} : { env }),
      }],
    };
  }

  async function executeAndRead({ runId, kind, template, queryKind, targetFqdn }) {
    const started = await client.startJob(template, { timeoutMs });
    const startedIdentity = validateExecutionIdentity(started, safeJobName);
    const execution = await client.waitForExecution(startedIdentity.name, { timeoutMs });
    const identity = validateExecutionIdentity(
      execution, safeJobName, startedIdentity.name, startedIdentity.id,
    );
    const metadata = sanitizedExecutionMetadata(execution, identity);
    const properties = isPlainRecord(execution?.properties) ? execution.properties : {};

    if (properties.status !== 'Succeeded') {
      return { incomplete: true, metadata };
    }
    const window = validatedTimingWindow(properties);
    let rows;
    let queryCompleted = false;
    try {
      rows = await readFirewallEvents({ execution: metadata, window, kind: queryKind, targetFqdn });
      queryCompleted = Array.isArray(rows);
    } catch {
      queryCompleted = false;
    }
    return { incomplete: false, metadata, window, rows: queryCompleted ? rows : [], queryCompleted };
  }

  return {
    /**
     * Run the job image with a fixed command that performs no network request.
     * Any firewall record in the exact ARM execution window is unrelated
     * platform traffic: reported as a collision with fingerprints for
     * subtraction, or left unobserved when the window reads clean (a clean
     * reading is only meaningful once the positive control proves ingestion).
     */
    async runNoop({ runId } = {}) {
      const safeRunId = validateRunId(runId);
      const run = await executeAndRead({
        runId: safeRunId,
        kind: 'noop',
        template: baseTemplate(NOOP_COMMAND),
        queryKind: 'all',
        targetFqdn: undefined,
      });
      if (run.incomplete) {
        return {
          kind: 'noop', runId: safeRunId, status: BASELINE_STATUS.unobserved,
          reason: 'execution_failed', queryCompleted: false,
          execution: run.metadata, window: null, noise: null,
        };
      }
      if (!run.queryCompleted) {
        return {
          kind: 'noop', runId: safeRunId, status: BASELINE_STATUS.unobserved,
          reason: 'firewall_query_failed', queryCompleted: false,
          execution: run.metadata, window: run.window, noise: null,
        };
      }
      const noise = summarizeNoise(run.rows);
      const clean = noise.totalRecords === 0;
      return {
        kind: 'noop',
        runId: safeRunId,
        status: clean ? BASELINE_STATUS.unobserved : BASELINE_STATUS.collision,
        reason: clean ? 'no_records_in_window' : 'unrelated_records_in_noop_window',
        queryCompleted: true,
        execution: run.metadata,
        window: run.window,
        noise,
      };
    },

    /**
     * Run the job image with a fixed script that performs exactly one HTTPS
     * request to a validated allowed health URL (carried in a validated env
     * entry, never interpolated into the command). Validated only when an
     * allow record for the exact target FQDN is observed in the exact ARM
     * window; every failure mode stays unobserved.
     */
    async runPositiveControl({ runId, allowedUrl } = {}) {
      const safeRunId = validateRunId(runId);
      const target = validateControlUrl(allowedUrl);
      const run = await executeAndRead({
        runId: safeRunId,
        kind: 'control',
        template: baseTemplate(CONTROL_COMMAND, [{ name: 'BASELINE_CONTROL_URL', value: target.href }]),
        queryKind: 'allow',
        targetFqdn: target.fqdn,
      });
      if (run.incomplete) {
        return {
          kind: 'control', runId: safeRunId, status: BASELINE_STATUS.unobserved,
          reason: 'execution_failed', queryCompleted: false, targetFqdn: target.fqdn,
          execution: run.metadata, window: null, observedAllow: null,
        };
      }
      if (!run.queryCompleted) {
        return {
          kind: 'control', runId: safeRunId, status: BASELINE_STATUS.unobserved,
          reason: 'firewall_query_failed', queryCompleted: false, targetFqdn: target.fqdn,
          execution: run.metadata, window: run.window, observedAllow: null,
        };
      }
      const normalized = run.rows.map(normalizeRow);
      const matching = normalized.filter((row) => row.action === 'allow' && row.fqdn === target.fqdn);
      const denied = normalized.some((row) => row.action === 'deny' && row.fqdn === target.fqdn);
      if (matching.length === 0) {
        const { action, fqdn, destinationPort, protocol } = normalizeRow(run.rows.find(
          (row) => normalizeRow(row).fqdn === target.fqdn,
        ) ?? {});
        return {
          kind: 'control',
          runId: safeRunId,
          status: BASELINE_STATUS.unobserved,
          reason: denied ? 'control_target_denied_observed' : 'no_matching_allow_record',
          queryCompleted: true,
          targetFqdn: target.fqdn,
          execution: run.metadata,
          window: run.window,
          observedAllow: null,
          ...(denied && destinationPort !== undefined ? { deniedFingerprint: { action, fqdn, destinationPort, protocol } } : {}),
        };
      }
      return {
        kind: 'control',
        runId: safeRunId,
        status: BASELINE_STATUS.validated,
        queryCompleted: true,
        targetFqdn: target.fqdn,
        execution: run.metadata,
        window: run.window,
        observedAllow: { records: matching.length, fingerprint: matching[0] },
      };
    },
  };
}

/**
 * The exact validation runPositiveControl enforces, exported so the pilot CLI
 * can reject an invalid control URL before it starts any ARM execution.
 */
export function validateBaselineControlUrl(value) {
  const target = validateControlUrl(value);
  return { href: target.href, fqdn: target.fqdn };
}

/**
 * Combine a runNoop result and a runPositiveControl result into the baseline
 * verdict an operator may use as a THESIS_NETWORK_NOOP_BASELINE_VALIDATED
 * assertion input. Validated requires BOTH a completed clean no-op window AND
 * an independently observed positive control; records in the no-op window are
 * a collision whose fingerprints support later subtraction. Nothing else — and
 * especially not an unobserved control — can validate a baseline.
 */
export function evaluateNoopBaseline({ noop, control } = {}) {
  if (!isPlainRecord(noop) || noop.kind !== 'noop' || typeof noop.queryCompleted !== 'boolean') {
    throw new TypeError('a completed noop result is required');
  }
  if (!isPlainRecord(control) || control.kind !== 'control' || typeof control.status !== 'string') {
    throw new TypeError('a completed control result is required');
  }
  const controlObserved = control.status === BASELINE_STATUS.validated;
  const cleanNoopWindow = noop.queryCompleted === true &&
    Number.isInteger(noop.noise?.totalRecords) && noop.noise.totalRecords === 0;

  let status;
  let reason;
  if (!controlObserved) {
    status = BASELINE_STATUS.unobserved;
    reason = typeof control.reason === 'string' && control.reason.length > 0
      ? control.reason : 'positive_control_not_observed';
  } else if (noop.queryCompleted !== true) {
    status = BASELINE_STATUS.unobserved;
    reason = typeof noop.reason === 'string' && noop.reason.length > 0
      ? noop.reason : 'noop_window_not_observed';
  } else if (noop.noise.totalRecords > 0) {
    status = BASELINE_STATUS.collision;
    reason = 'unrelated_records_in_noop_window';
  } else {
    status = BASELINE_STATUS.validated;
    reason = null;
  }

  return {
    status,
    reason,
    noopRunId: typeof noop.runId === 'string' ? noop.runId : null,
    controlRunId: typeof control.runId === 'string' ? control.runId : null,
    targetFqdn: typeof control.targetFqdn === 'string' ? control.targetFqdn : null,
    cleanNoopWindow,
    controlObserved,
    noise: noop.noise ?? null,
    noopWindow: noop.window ?? null,
    controlWindow: control.window ?? null,
    note: 'assertion input only; not proof of a measured trial',
  };
}
