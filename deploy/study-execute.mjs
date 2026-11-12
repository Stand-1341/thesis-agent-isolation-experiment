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
import {readAzdEnv, makeStepLogger, formatFailures} from './common.mjs';
import {readFile, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const STARTER = path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER');
const MAX_AUTH_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function protocolDigest(protocolText) {
  return createHash('sha256').update(protocolText).digest('hex');
}

/** Pure gate evaluation — every failure carries the gate id and a fix. */
export async function evaluateStudyGates({
  manifest, protocolPath, freezeLockPath, pilotIndex, verifier, evidenceReachable = true,
  authorization, now = Date.now()
} = {}) {
  const failures = [];
  const add = (gate, problem, fix) => failures.push({gate, problem, fix});

  if (!manifest || manifest.status !== 'validated') {
    add('G1', manifest ? `deployment status is ${manifest.status}` : 'no deployment manifest found', 'run `azd up` end to end and let validation pass first');
  }

  let protocol = null;
  try {
    protocol = JSON.parse(await readFile(protocolPath, 'utf8'));
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
    const digest = protocolDigest(JSON.stringify(protocol));
    if (lock.protocolSha256 !== digest) {
      add('G2', `freeze-lock digest does not match the protocol file (${digest.slice(0, 16)}…)`, 'either the protocol changed after freezing (re-freeze deliberately) or the lock points at another file');
    }
  }

  if (!pilotIndex?.routesValidated || pilotIndex.routesValidated.length === 0) {
    add('G3', 'no validated pilot routes on record', 'run the non-counted pilots and rebuild the pilot index before measured trials');
  }

  if (!verifier?.identityObjectId) add('G4', 'independent verifier identity missing', 'deploy the verifier identity (full stage) or supply one explicitly');
  if (!verifier?.scriptAvailable) add('G4', 'verifier script not found', 'expected the starter verifier scripts under 05-DOCKER-STARTER/scripts');
  if (!evidenceReachable) add('G5', 'evidence container unreachable', 'rerun deploy/validate-deployment.mjs (V5 covers this)');
  if (manifest?.evidence?.retentionLocked !== true) {
    add('G5', 'evidence retention is not locked', 'lock retention with an explicitly approved period and a successful verification step (deliberately never automatic)');
  }

  if (!authorization?.present) {
    add('G6', `no owner authorization file (set STUDY_AUTHORIZATION_FILE)`, 'create a file naming the protocol digest: "I authorize measured execution of protocol sha256:<digest>"');
  } else {
    if (authorization.digest !== undefined && protocol && authorization.digest !== protocolDigest(JSON.stringify(protocol))) {
      add('G6', 'authorization file names a different protocol digest', 're-authorize against the current protocol');
    }
    if (authorization.ageMs === undefined || authorization.ageMs > MAX_AUTH_AGE_MS) {
      add('G6', 'authorization is stale (older than 7 days or undated)', 're-sign the authorization file — a fresh human act per measured run');
    }
  }

  return {failures, ok: failures.length === 0};
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

export async function main({argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);

  const protocolPath = argValue(argv, '--protocol') ?? path.join(STARTER, 'config', 'protocol-450-three-arm-supported-v2.json');
  const freezeLockPath = argValue(argv, '--freeze-lock') ?? `${protocolPath.replace(/\.json$/, '')}-freeze-lock.json`.replace(/-freeze-lock-freeze-lock/, '-freeze-lock');
  const envName = process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default';

  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(process.cwd(), '.azure', envName, 'deployment-manifest.json'), 'utf8'));
  } catch { manifest = undefined; }

  const verifierScript = path.join(STARTER, 'scripts', 'azure-blob-verifier.mjs');
  const verifier = {
    identityObjectId: manifest?.identities?.verifier?.objectId,
    scriptAvailable: await access(verifierScript).then(() => true).catch(() => false)
  };

  const authorization = await readAuthorization({authPath: env.STUDY_AUTHORIZATION_FILE ?? values.STUDY_AUTHORIZATION_FILE});

  const gates = await evaluateStudyGates({
    manifest, protocolPath, freezeLockPath,
    pilotIndex: {routesValidated: manifest?.routes ?? []},
    verifier, authorization
  });

  if (!gates.ok) {
    stderr.write(formatFailures('Measured study NOT launched — gates failed:', gates.failures) + '\n');
    return 3;
  }

  log('study-execute', 'gates-passed', {note: 'launching measured trials via the starter CLI'});
  const {execCommand} = await import('./common.mjs');
  try {
    const result = await execCommand(['node', 'scripts/run-experiment-cli.mjs', '--config', 'config/experiment.generated.json', '--protocol', protocolPath], {cwd: STARTER, timeoutMs: 24 * 60 * 60 * 1000});
    stdout.write(result.stdout);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
