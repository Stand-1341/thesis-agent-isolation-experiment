#!/usr/bin/env node
/**
 * `npm run study:execute` — the measured-study launcher.
 *
 * Deliberately separate from `azd up` so a routine deployment can never launch
 * hundreds of billable trials. Every gate must pass BEFORE any trial starts:
 *
 *   G1 validated deployment  — a deployment-manifest.json with status=validated
 *   G2 frozen protocol      — protocol file + matching freeze-lock present
 *   G3 pilot coverage       — pilot index shows the required routes validated
 *   G4 independent verifier — verifier identity + verifier script available
 *   G5 evidence custody     — evidence container reachable, retention decided
 *   G6 owner authorization  — STUDY_AUTHORIZATION_FILE points at a signed file
 *                             naming this protocol digest (re-commit each run)
 *
 * Gate G6 is an explicit fresh human act: the authorization file must contain
 * the protocol's SHA-256 digest AND have been modified within the last 7 days,
 * so an old signature cannot authorize a revised protocol.
 */
import {readAzdEnv, makeStepLogger, formatFailures, execCommand} from './common.mjs';
import {readFile, realpath, appendFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isValidationReportValid, defaultPilotIndexPath} from './validate-deployment.mjs';
import {getCostSnapshot} from './cost-monitor.mjs';
import {assessBlobTrial} from '../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/scripts/blob-trial-assessment.mjs';

const STARTER = path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER');
const MAX_AUTH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_COST_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Supervise a long-running runner while preserving its exit status. Budget
 * snapshots are observations only: failures stay unknown and never stop or
 * authorize the measured process.
 */
export async function runSupervisedStudy({run, command, options = {}, costSnapshot, intervalMs = DEFAULT_COST_SNAPSHOT_INTERVAL_MS,
  onProgress = () => {}, onStdout = () => {}, onStderr = () => {}, now = () => new Date().toISOString(),
  initialSnapshot, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval} = {}) {
  if (typeof run !== 'function' || !Array.isArray(command)) throw new Error('runner command and process adapter are required');
  if (typeof costSnapshot !== 'function') throw new Error('cost snapshot adapter is required');
  if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new Error('cost snapshot interval must be positive');
  let monitoringErrors = 0;
  let snapshotActive = false;
  let lastSnapshotTask = Promise.resolve();
  let activeSnapshotTask = Promise.resolve();
  let progressQueue = Promise.resolve();
  let stdoutChunks = 0;
  let stderrChunks = 0;
  let stdoutPending = '';
  const handleStdout = chunk => {
    stdoutChunks += 1;
    const value = String(chunk);
    stdoutPending += value;
    while (stdoutPending.includes('\n')) {
      const newline = stdoutPending.indexOf('\n');
      const line = stdoutPending.slice(0, newline).replace(/\r$/, '');
      stdoutPending = stdoutPending.slice(newline + 1);
      if (line.startsWith('STUDY_PROGRESS ')) {
        let event;
        try { event = JSON.parse(line.slice('STUDY_PROGRESS '.length)); } catch { event = undefined; }
        if (isSafeTrialProgress(event)) void emit({type: 'trial', status: 'completed',
          runId: event.runId, deployment: event.deployment, profile: event.profile,
          scenario: event.scenario, classification: event.classification});
        else { try { onStdout(`${line}\n`); } catch { monitoringErrors += 1; } }
      } else { try { onStdout(`${line}\n`); } catch { monitoringErrors += 1; } }
    }
    if (stdoutPending.length > 8192) {
      try { onStdout(stdoutPending); } catch { monitoringErrors += 1; }
      stdoutPending = '';
    }
    void emit({type: 'runner_output', stream: 'stdout', bytes: Buffer.byteLength(value)});
  };
  const emit = event => {
    const entry = {at: now(), ...event};
    progressQueue = progressQueue.then(() => onProgress(entry)).catch(() => { monitoringErrors += 1; });
    return progressQueue;
  };
  const snapshot = async reason => {
    if (snapshotActive) {
      await emit({type: 'budget_snapshot', status: 'skipped', reason, detail: 'previous snapshot is still pending'});
      return;
    }
    snapshotActive = true;
    try {
      const value = await costSnapshot();
      await emit({type: 'budget_snapshot', status: 'available', reason, snapshot: value,
        note: 'Azure budget data can lag actual spend and does not cap charges.'});
    } catch (error) {
      monitoringErrors += 1;
      await emit({type: 'budget_snapshot', status: 'unknown', reason,
        detail: String(error?.message ?? 'snapshot unavailable').slice(0, 240),
        note: 'Unknown or delayed spend is not zero and is not a hard cap.'});
    } finally { snapshotActive = false; }
  };
  const scheduleSnapshot = reason => {
    const alreadyActive = snapshotActive;
    const task = snapshot(reason);
    if (!alreadyActive) activeSnapshotTask = task;
    return task;
  };

  await emit({type: 'runner', status: 'started'});
  if (initialSnapshot) await emit({type: 'budget_snapshot', status: 'available', reason: 'start', snapshot: initialSnapshot,
    note: 'Azure budget data can lag actual spend and does not cap charges.'});
  else lastSnapshotTask = scheduleSnapshot('start');
  const timer = setIntervalImpl(() => { lastSnapshotTask = scheduleSnapshot('periodic'); return lastSnapshotTask; }, intervalMs);
  timer?.unref?.();
  let result;
  let failure;
  try {
    result = await run(command, {...options,
      onStdout: handleStdout,
      onStderr: chunk => { stderrChunks += 1; try { onStderr(chunk); } catch { monitoringErrors += 1; } void emit({type: 'runner_output', stream: 'stderr', bytes: Buffer.byteLength(chunk)}); }
    });
  } catch (error) { failure = error; }
  finally {
    clearIntervalImpl(timer);
    if (stdoutPending) {
      const line = stdoutPending.replace(/\r$/, '');
      if (line.startsWith('STUDY_PROGRESS ')) {
        let event;
        try { event = JSON.parse(line.slice('STUDY_PROGRESS '.length)); } catch { event = undefined; }
        if (isSafeTrialProgress(event)) await emit({type: 'trial', status: 'completed', runId: event.runId,
          deployment: event.deployment, profile: event.profile, scenario: event.scenario, classification: event.classification});
        else try { onStdout(`${line}\n`); } catch { monitoringErrors += 1; }
      } else try { onStdout(stdoutPending); } catch { monitoringErrors += 1; }
      stdoutPending = '';
    }
    await Promise.all([lastSnapshotTask, activeSnapshotTask]);
    await scheduleSnapshot('final');
  }
  const exitCode = failure ? (Number.isInteger(failure.exitCode) ? failure.exitCode : Number.isInteger(failure.code) ? failure.code : 1) :
    (Number.isInteger(result?.exitCode) ? result.exitCode : 0);
  await emit({type: 'runner', status: exitCode === 0 ? 'completed' : 'failed', exitCode, stdoutChunks, stderrChunks,
    error: failure ? String(failure?.message ?? 'runner failed').slice(0, 240) : undefined});
  await progressQueue;
  return {exitCode, result, error: failure, monitoringErrors, stdoutChunks, stderrChunks};
}

const PROGRESS_CLASSIFICATIONS = new Set(['unauthorized_success', 'confirmed_resource_denial', 'confirmed_network_denial',
  'legitimate_completion', 'legitimate_failed', 'agent_no_attempt', 'indeterminate', 'not_applicable']);
function isSafeTrialProgress(event) {
  return event?.event === 'trial_completed' && /^[A-Za-z0-9_-]{1,150}$/.test(event.runId ?? '') &&
    /^azure_[a-z0-9_]{1,80}$/.test(event.deployment ?? '') && ['P1', 'P2', 'P3'].includes(event.profile) &&
    /^(?:U[1-8]|L[12])$/.test(event.scenario ?? '') && PROGRESS_CLASSIFICATIONS.has(event.classification);
}

export async function appendStudyProgress(progressPath, entry) {
  await mkdir(path.dirname(progressPath), {recursive: true});
  await appendFile(progressPath, `${JSON.stringify(entry)}\n`, {encoding: 'utf8'});
}

export async function requireStudyCostMonitor({subscriptionId, budgetName, getSnapshot = getCostSnapshot} = {}) {
  if (typeof subscriptionId !== 'string' || !subscriptionId.trim() || typeof budgetName !== 'string' || !budgetName.trim())
    throw new Error('AZURE_SUBSCRIPTION_ID and AZURE_BUDGET_NAME are required before measured execution');
  return getSnapshot({subscriptionId: subscriptionId.trim(), budgetName: budgetName.trim()});
}

export function protocolDigest(protocolText) {
  return createHash('sha256').update(protocolText).digest('hex');
}

/** Pure gate evaluation — every failure carries the gate id and a fix. */
export async function evaluateStudyGates({
  manifest, protocolPath, freezeLockPath, pilotIndex, verifier, validationReport, resolvedBytes,
  pilotEvidenceRoot, authorization, now = Date.now()
} = {}) {
  const failures = [];
  const add = (gate, problem, fix) => failures.push({gate, problem, fix});

  if (!manifest || manifest.status !== 'validated') {
    add('G1', manifest ? `deployment status is ${manifest.status}` : 'no deployment manifest found', 'run `azd up` end to end and let validation pass first');
  }

  let protocol = null;
  let protocolBytes = null;
  try {
    protocolBytes = await readFile(protocolPath);
    protocol = JSON.parse(protocolBytes.toString('utf8'));
  } catch {
    add('G2', `cannot read protocol at ${protocolPath}`, 'supply --protocol <path> or freeze a protocol first');
  }
  let lock = null;
  try {
    lock = JSON.parse(await readFile(freezeLockPath, 'utf8'));
  } catch {
    add('G2', `cannot read freeze-lock at ${freezeLockPath}`, 'a frozen protocol requires its lock file');
  }
  if (protocol && lock) {
    // The freeze lock covers the exact bytes on disk. Re-serializing parsed JSON
    // changes whitespace/key ordering and can falsely reject a valid freeze.
    const digest = protocolDigest(protocolBytes);
    if (lock.protocolSha256 !== digest) {
      add('G2', `freeze-lock digest does not match the protocol file (${digest.slice(0, 16)}…)`, 'either the protocol changed after freezing (re-freeze deliberately) or the lock points at another file');
    }
    const protocolEnabled = protocol.measuredExecutionEnabled === true ||
      protocol.readiness?.measuredExecutionEnabled === true || protocol.runner?.measuredExecutionEnabled === true;
    if (!protocolEnabled || lock.measuredExecutionEnabled !== true) {
      add('G2', 'protocol and freeze-lock do not both explicitly enable measured execution', 'complete review and freeze a protocol that explicitly enables measured execution in both the protocol and its lock');
    }
  }

  const requiredRoutes = protocol?.routeKeys ?? protocol?.routes;
  const requiredRouteSet = Array.isArray(requiredRoutes) ? requiredRoutes.map(normalizeRouteKey) : [];
  const validatedRouteSet = Array.isArray(pilotIndex?.routesValidated)
    ? new Set(pilotIndex.routesValidated.map(normalizeRouteKey)) : new Set();
  if (!requiredRouteSet.length) {
    add('G3', 'protocol does not declare required route coverage', 'freeze a protocol with an explicit routeKeys list');
  } else {
    const missingRoutes = requiredRouteSet.filter(route => !validatedRouteSet.has(route));
    if (missingRoutes.length) {
      add('G3', `pilot index is missing validated route coverage: ${missingRoutes.join(', ')}`, 'run and document non-counted pilots for every protocol route before measured trials');
    }
  }

  // Three-arm readiness must be backed by the runner's integrity-protected
  // non-counted evidence envelopes. A hand-edited routesValidated list is only
  // a claim, so it cannot close per-arm route, P3 denial, or session fixture gates.
  if (requiredRouteSet.some(route => route.startsWith('azure_container_apps_'))) {
    try {
      await validateThreeArmPilotEvidence({pilotIndex, root: pilotEvidenceRoot, routes: requiredRouteSet,
        deployments: [...new Set(requiredRouteSet.map(route=>route.split(':')[0]))]});
    } catch (error) {
      add('G3', `pilot evidence validation failed: ${error.message}`, 'run non-counted per-arm pilots and provide their intact evidence envelopes plus a matching pilot index');
    }
  }

  if (!Array.isArray(manifest?.designBlockers) || manifest.designBlockers.length > 0) {
    const count = Array.isArray(manifest?.designBlockers) ? manifest.designBlockers.length : 'unknown';
    add('G3', `unresolved or unreported research-design blockers (${count})`, 'resolve every listed blocker or explicitly revise the frozen protocol and readiness manifest to the approved study scope');
  }

  if (!verifierPreflightPassed(verifier, requiredRouteSet.length, [...new Set(requiredRouteSet.map(route=>route.split(':')[0]))]))
    add('G4', 'live dependency construction and verifier coverage preflight did not pass for every selected route', 'resolve credentials and configure the real dependency module until its structural dry-run constructs every route and the verifier without coverage gaps');
  // Independently require the persisted V1–V5 report, bound to the current
  // resolved deployment bytes. Manifest status and a URL alone prove nothing.
  const evidenceReachable = manifest?.status === 'validated' &&
    typeof manifest?.evidence?.containerUrl === 'string' && manifest.evidence.containerUrl.length > 0 &&
    isValidationReportValid({report: validationReport, resolvedBytes});
  if (!evidenceReachable) add('G5', 'no verified evidence-container reachability proof from deployment validation', 'rerun deploy/validate-deployment.mjs (V5 covers this) and emit a validated deployment manifest');
  if (manifest?.evidence?.retentionLocked !== true) {
    add('G5', 'evidence retention is not locked', 'lock retention with an explicitly approved period and a successful verification step (deliberately never automatic)');
  }

  if (!authorization?.present) {
    add('G6', `no owner authorization file (set STUDY_AUTHORIZATION_FILE)`, 'create a file naming the protocol digest: "I authorize measured execution of protocol sha256:<digest>"');
  } else {
    if (!authorization.digest) {
      add('G6', 'authorization file does not contain a protocol SHA-256 digest', 're-authorize with the current protocol digest: sha256:<64 lowercase hex characters>');
    } else if (protocolBytes && authorization.digest !== protocolDigest(protocolBytes)) {
      add('G6', 'authorization file names a different protocol digest', 're-authorize against the current protocol');
    }
    if (authorization.ageMs === undefined || authorization.ageMs > MAX_AUTH_AGE_MS) {
      add('G6', 'authorization is stale (older than 7 days or undated)', 're-sign the authorization file — a fresh human act per measured run');
    }
  }

  return {failures, ok: failures.length === 0};
}

export function buildStudyRunnerArgs({protocolPath, configPath, depsPath, gates}) {
  const names = ['protocolFrozen', 'deploymentValidated', 'isolationValidated', 'verifierValidated'];
  if (!names.every(name => gates?.[name] === true)) throw new Error('measured runner gates are not independently established');
  return ['scripts/run-experiment-cli.mjs', '--config', path.resolve(configPath), '--protocol', path.resolve(protocolPath),
    '--deps', path.resolve(depsPath), '--gates', names.join(','), '--progress-events'];
}

export function parseStructuralPreflight({code, stdout, stderr = ''} = {}) {
  let report;
  try { report = JSON.parse(stdout); }
  catch { throw new Error(`runner structural preflight returned invalid JSON${stderr ? `: ${stderr.trim().slice(0, 240)}` : ''}`); }
  if (code !== 4 || report?.dryRun !== true || report?.readiness !== 'structural_only_not_ready')
    throw new Error(`runner structural preflight did not complete as a blocked dry-run (exit ${code})`);
  return report;
}

export function verifierPreflightPassed(report, expectedRoutes = 9, requiredDeployments = ['azure_vm', 'azure_container_apps_jobs', 'azure_container_apps_sandboxes']) {
  const deps = report?.runtimeDependencies;
  const sessionCapabilities = report?.sessionCapabilities ?? {};
  return report?.dryRun === true && report?.mode === 'measured' && deps?.status === 'constructed' &&
    deps.routeCount === expectedRoutes && deps.verifierConstructed === true &&
    deps.networkVerifierSupported === true && Object.keys(deps.resourceVerifierGaps ?? {}).length === 0 &&
    requiredDeployments.every(deployment => sessionCapabilities[deployment] === true);
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const DEFAULT_THREE_ARM_DEPLOYMENTS = ['azure_vm', 'azure_functions_flex', 'azure_container_apps_sandboxes'];

/** Validate independently stored runner envelopes referenced by the pilot index. */
export async function validateThreeArmPilotEvidence({pilotIndex, root, routes, deployments} = {}) {
  deployments = deployments ?? [...new Set((routes ?? []).map(route => String(route).split(':')[0]).filter(Boolean))];
  if (!pilotIndex || !Array.isArray(pilotIndex.evidenceFiles) || !pilotIndex.evidenceFiles.length)
    throw new Error('pilot index has no evidenceFiles list');
  if (!root) throw new Error('pilot evidence root is not configured');
  const realRoot = await realpath(root);
  const records = [];
  const referencedFiles = new Set();
  for (const ref of pilotIndex.evidenceFiles) {
    if (!ref || typeof ref.file !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? ''))
      throw new Error('each evidence reference needs a relative file and SHA-256 digest');
    if (referencedFiles.has(ref.file)) throw new Error(`duplicate pilot evidence reference: ${ref.file}`);
    referencedFiles.add(ref.file);
    const candidate = path.resolve(realRoot, ref.file);
    const candidateRelative = path.relative(realRoot, candidate);
    if (!candidateRelative || candidateRelative === '..' || candidateRelative.startsWith(`..${path.sep}`) || path.isAbsolute(candidateRelative))
      throw new Error('evidence reference escapes the configured evidence root');
    const absolute = await realpath(candidate);
    const relative = path.relative(realRoot, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('evidence reference escapes the configured evidence root');
    const bytes = await readFile(absolute);
    if (sha256(bytes) !== ref.sha256) throw new Error(`evidence digest mismatch for ${ref.file}`);
    let envelope, record;
    try {
      envelope = JSON.parse(bytes.toString('utf8'));
      if (envelope.version !== 1 || typeof envelope.payload !== 'string' || sha256(Buffer.from(envelope.payload, 'utf8')) !== envelope.sha256)
        throw new Error('integrity');
      record = JSON.parse(envelope.payload);
    } catch {
      throw new Error(`invalid runner evidence envelope: ${ref.file}`);
    }
    records.push(record);
  }

  const trials = records.filter(record => record?.mode === 'non_counted_pilot' && record?.trial &&
    typeof record.runId === 'string' && record.runId.startsWith('pilot-'));
  const hasEvidence = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
  const routeOf = trial => `${trial.deployment}:${trial.permission_profile ?? trial.profile}`;
  for (const route of routes ?? []) {
    if (!trials.some(record => routeOf(record.trial) === route && record.trial.scenario && record.classification &&
        record.classification !== 'indeterminate' && hasEvidence(record.evidence) && hasEvidence(record.verificationEvidence)))
      throw new Error(`no completed non-counted trial evidence for ${route}`);
  }

  for (const deployment of deployments) {
    for (const scenario of ['U5', 'U7']) {
      const found = trials.some(record => record.trial.deployment === deployment &&
        (record.trial.permission_profile ?? record.trial.profile) === 'P3' && record.trial.scenario === scenario &&
        record.classification === 'confirmed_network_denial' && hasEvidence(record.verificationEvidence));
      if (!found) throw new Error(`missing P3 ${scenario} confirmed network-denial pilot for ${deployment}`);
    }
  }

  const sessionTrials = records.filter(record => trials.includes(record) && deployments.includes(record.trial.deployment) &&
    ['U6', 'U8'].includes(record.trial.scenario));
  for (const deployment of deployments) {
    for (const profile of ['P1', 'P2', 'P3']) for (const scenario of ['U6', 'U8']) {
      const matches = sessionTrials.filter(record => record.trial.deployment === deployment &&
        (record.trial.permission_profile ?? record.trial.profile) === profile && record.trial.scenario === scenario);
      if (matches.length !== 1) throw new Error(`expected exactly one non-counted ${scenario} session fixture trial for ${deployment}:${profile}`);
      const record = matches[0], target = scenario === 'U6' ? 'session-b' : 'prior-session';
      const namespace = record.reset?.externalSessionNamespace;
      const azure = record.evidence?.azure;
      const output = record.output;
      const verified = record.verificationEvidence;
      const auditRows = verified?.auditRows;
      const containerResource = /^(.*)\/containers\/(?:session-b|prior-session)$/i.exec(output?.resourceId ?? '')?.[1];
      const executionStart = Date.parse(record.executionStartedAt), executionEnd = Date.parse(record.executionFinishedAt);
      if (record.reset?.azureFixturesSeeded !== true || namespace?.scope !== 'azure_external_session_namespace' ||
          namespace.mode !== 'azure_blob_container_namespaces' || namespace.fixtureRunId !== record.runId ||
          namespace.currentSessionContainer !== 'session-a' || namespace.targetSessionContainer !== target ||
          !['session-a', 'session-b', 'prior-session'].every(name => namespace.seededContainers?.includes(name) &&
            typeof azure?.[name]?.marker === 'string' && azure[name].marker.startsWith('SYNTHETIC-')))
        throw new Error(`missing session-a/session-b/prior-session seed or independent verifier readback for ${deployment}:${profile}:${scenario}`);
      const expected = profile === 'P1' ? 'unauthorized_success' : 'confirmed_resource_denial';
      const expectedStatus = profile === 'P1' ? 200 : 403;
      let recomputed;
      try {
        const endpoint = new URL(output.objectUri);
        recomputed = assessBlobTrial({trial: record.trial, output, azureState: azure, azureProbeState: record.evidence?.azureProbe,
          auditRows, resourceId: containerResource, principalId: output.principalId,
          blobEndpoint: `${endpoint.origin}/`, startMs: Math.max(0, executionStart - 10000), endMs: executionEnd + 10000});
      } catch { recomputed = undefined; }
      const assessment = verified?.assessment;
      if (record.classification !== expected || verified?.scope !== 'azure_blob_verifier' ||
          verified.principalId?.toLowerCase() !== output?.principalId?.toLowerCase() ||
          !containerResource || !Number.isFinite(executionStart) || !Number.isFinite(executionEnd) || executionEnd < executionStart ||
          !Array.isArray(auditRows) || !output?.transportOk || output?.status !== expectedStatus ||
          assessment?.scope !== 'candidate_only_not_final_verdict' || assessment?.candidate !== expected ||
          recomputed?.candidate !== expected || recomputed?.audit?.statusCode !== expectedStatus ||
          (profile !== 'P1' && ((output?.storageErrorCode ?? output?.errorCode) !== 'AuthorizationPermissionMismatch' ||
            recomputed.audit.statusText !== 'AuthorizationPermissionMismatch')))
        throw new Error(`session namespace access control was not independently verified for ${deployment}:${profile}:${scenario}`);
    }
  }
  if (sessionTrials.length !== deployments.length * 3 * 2)
    throw new Error('pilot evidence contains unexpected or duplicate three-arm U6/U8 records');
  return {records: records.length, trialRecords: trials.length, sessionFixtureTrials: sessionTrials.length};
}

function normalizeRouteKey(route) {
  return typeof route === 'string' ? route.replace('/', ':') : '';
}

export async function readAuthorization({authPath, protocolText, now = Date.now(), stat} = {}) {
  if (!authPath) return {present: false};
  let text;
  try {
    text = await readFile(authPath, 'utf8');
    const stats = stat ?? (await import('node:fs')).promises.stat;
    const info = await stats(authPath);
    return {present: true, digest: extractDigest(text), ageMs: now - info.mtimeMs};
  } catch {
    return {present: false};
  }
}

function extractDigest(text) {
  const match = /sha256:([0-9a-f]{64})/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

export async function main({argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr, run = execCommand} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);

  const protocolPath = argValue(argv, '--protocol') ?? path.join(STARTER, 'config', 'protocol-450-flex-sandbox-supported-v3.json');
  const freezeLockPath = argValue(argv, '--freeze-lock') ?? `${protocolPath.replace(/\.json$/, '')}-freeze-lock.json`.replace(/-freeze-lock-freeze-lock/, '-freeze-lock');
  const configPath = path.resolve(argValue(argv, '--config') ?? path.join(STARTER, 'config', 'experiment.generated.json'));
  const depsPath = path.join(STARTER, 'scripts', 'deps-live.mjs');
  const envName = process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default';
  const selectedDeployments = await readConfiguredDeployments(configPath);

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(process.cwd(), '.azure', envName, 'deployment-manifest.json'), 'utf8'));
  } catch { manifest = undefined; }

  let resolvedBytes, validationReport;
  try {
    resolvedBytes = await readFile(path.join(process.cwd(), '.azure', envName, 'deployment.resolved.json'));
    validationReport = JSON.parse(await readFile(path.join(process.cwd(), '.azure', envName, 'deployment-validation.json'), 'utf8'));
  } catch { /* G5 fails closed when the validation proof is missing. */ }

  const authorization = await readAuthorization({authPath: env.STUDY_AUTHORIZATION_FILE ?? values.STUDY_AUTHORIZATION_FILE});

  const pilotIndexPath = env.PILOT_INDEX_FILE ?? values.PILOT_INDEX_FILE ?? defaultPilotIndexPath();
  let pilotIndex;
  try {
    pilotIndex = JSON.parse(await readFile(pilotIndexPath, 'utf8'));
  } catch {
    pilotIndex = undefined;
  }

  let verifier;
  try {
    const args = ['node', 'scripts/run-experiment-cli.mjs', '--config', configPath, '--protocol', path.resolve(protocolPath),
      '--deps', depsPath, '--dry-run', '--json'];
    let result;
    try {
      result = await run(args, {cwd: STARTER, env: {...values, ...env}, timeoutMs: 120000});
      verifier = parseStructuralPreflight({code: result.exitCode ?? 0, stdout: result.stdout, stderr: result.stderr});
    } catch (error) {
      verifier = parseStructuralPreflight({code: Number(error.code), stdout: error.stdout, stderr: error.stderr ?? error.message});
    }
  } catch (error) {
    verifier = {preflightError: error.message};
  }

  const gates = await evaluateStudyGates({
    manifest, protocolPath, freezeLockPath,
    pilotIndex, pilotEvidenceRoot: path.dirname(pilotIndexPath),
    verifier, validationReport, resolvedBytes, authorization
  });

  if (!gates.ok) {
    stderr.write(formatFailures('Measured study NOT launched — gates failed:', gates.failures) + '\n');
    return 3;
  }

  const subscriptionId = env.AZURE_SUBSCRIPTION_ID ?? values.AZURE_SUBSCRIPTION_ID;
  const budgetName = env.AZURE_BUDGET_NAME ?? values.AZURE_BUDGET_NAME;
  let initialBudgetSnapshot;
  try {
    initialBudgetSnapshot = await requireStudyCostMonitor({subscriptionId, budgetName});
  } catch (error) {
    stderr.write(`Measured study NOT launched — budget monitoring is unavailable: ${String(error?.message ?? 'unknown budget state').slice(0, 300)}\n`);
    return 3;
  }
  const progressPath = path.join(process.cwd(), '.azure', envName, 'study-execution-progress.jsonl');
  try { await appendStudyProgress(progressPath, {at: new Date().toISOString(), type: 'monitor', status: 'ready', initialSnapshot: initialBudgetSnapshot}); }
  catch (error) {
    stderr.write(`Measured study NOT launched — progress monitoring cannot be persisted: ${String(error?.message ?? 'progress store unavailable').slice(0, 300)}\n`);
    return 3;
  }

  log('study-execute', 'gates-passed', {note: 'launching measured trials via the starter CLI'});
  try {
    const launchGates = {
      protocolFrozen: !gates.failures.some(failure => failure.gate === 'G2'),
      deploymentValidated: !gates.failures.some(failure => failure.gate === 'G1') && verifierPreflightPassed(verifier, selectedDeployments.routes, selectedDeployments.deployments),
      isolationValidated: !gates.failures.some(failure => failure.gate === 'G3'),
      verifierValidated: verifierPreflightPassed(verifier, selectedDeployments.routes, selectedDeployments.deployments)
    };
    const args = buildStudyRunnerArgs({protocolPath, configPath, depsPath, gates: launchGates});
    const monitored = await runSupervisedStudy({
      run, command: ['node', ...args], options: {cwd: STARTER, env: {...values, ...env}, timeoutMs: 24 * 60 * 60 * 1000},
      costSnapshot: () => getCostSnapshot({subscriptionId: env.AZURE_SUBSCRIPTION_ID ?? values.AZURE_SUBSCRIPTION_ID,
        budgetName: env.AZURE_BUDGET_NAME ?? values.AZURE_BUDGET_NAME}),
      initialSnapshot: initialBudgetSnapshot,
      onProgress: async entry => {
        await appendStudyProgress(progressPath, entry);
        if (entry.type === 'trial') stdout.write(`[trial] ${entry.runId} ${entry.deployment}/${entry.profile} ${entry.scenario}: ${entry.classification}\n`);
      },
      onStdout: chunk => stdout.write(chunk),
      onStderr: chunk => stderr.write(chunk)
    });
    if (monitored.stdoutChunks === 0) stdout.write(monitored.result?.stdout ?? monitored.error?.stdout ?? '');
    if (monitored.stderrChunks === 0) stderr.write(monitored.result?.stderr ?? monitored.error?.stderr ?? '');
    if (monitored.monitoringErrors) stderr.write(`Study monitoring had ${monitored.monitoringErrors} recording error(s); see ${progressPath} for available progress and cost snapshots.\n`);
    if (monitored.exitCode !== 0) {
      stderr.write(`measured run failed with exit code ${monitored.exitCode}: ${String(monitored.error?.message ?? '').slice(0, 400)}\n`);
      return 4;
    }
    return 0;
  } catch (error) {
    stderr.write(`measured run failed: ${String(error.stderr ?? error.message).slice(0, 500)}\n`);
    return 4;
  }
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function readConfiguredDeployments(configPath) {
  try {
    const config=JSON.parse(await readFile(configPath,'utf8'));
    const deployments=Object.keys(config?.deployments??{}).filter(name=>/^azure_[a-z0-9_]+$/.test(name));
    const routes=Array.isArray(config?.routes)?config.routes.length:0;
    if(deployments.length&&routes) return {deployments,routes};
  } catch {}
  return {deployments:DEFAULT_THREE_ARM_DEPLOYMENTS,routes:9};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
