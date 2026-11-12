/**
 * Shared plumbing for deploy/*.mjs: Azure CLI execution with retry, checkpoint
 * state that makes reruns resume instead of duplicating work, azd environment
 * access, and structured logging.
 *
 * Everything takes injected dependencies (run/shell/clock/fs) so the modules
 * built on it are unit-testable without Azure — same convention as the
 * experiment scripts in 05-DOCKER-STARTER/scripts.
 */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';

/** Transient Azure failures worth retrying. */
export function isTransientAzureFailure({exitCode, stderr, message} = {}) {
  const text = `${stderr ?? ''} ${message ?? ''}`;
  if (exitCode === 0) return false;
  return /\b(429|RequestTimeout|TimeoutError|InternalServerError|ConflictError|RetryableError|ephemeral|transient|throttl)\b/i.test(text);
}

/**
 * Wrap a command runner with bounded exponential backoff for transient Azure
 * failures. Non-transient failures rethrow immediately.
 */
export function withRetry(run, {attempts = 4, baseDelayMs = 3000, sleep = defaultSleep, jitter = defaultJitter} = {}) {
  return async (command, options = {}) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await run(command, options);
      } catch (error) {
        lastError = error;
        if (attempt === attempts || !isTransientAzureFailure(error)) throw error;
        await sleep(baseDelayMs * 2 ** (attempt - 1) + jitter());
      }
    }
    throw lastError;
  };
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const defaultJitter = () => Math.floor(Math.random() * 500);

/** Execute via child_process. Returns {exitCode, stdout, stderr}; throws on nonzero. */
export async function execCommand(command, {cwd, env, timeoutMs = 15 * 60 * 1000} = {}) {
  const {execFile} = await import('node:child_process');
  const [file, ...args] = command;
  return new Promise((resolve, reject) => {
    execFile(file, args, {cwd, env: {...process.env, ...env}, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024},
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve({stdout: String(stdout), stderr: String(stderr)});
        }
      });
  });
}

/** az CLI invocation that parses JSON output; throws with stderr on failure. */
export function makeAzRunner({exec = execCommand} = {}) {
  return async function az(args, {json = true, cwd, timeoutMs} = {}) {
    const full = ['az', ...args, ...(json ? ['--output', 'json'] : [])];
    const result = await exec(full, {cwd, timeoutMs});
    const text = result.stdout.trim();
    if (!json || !text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`az ${args[0]} returned non-JSON output: ${text.slice(0, 400)}`);
    }
  };
}

/**
 * Deployment checkpoint state. Lives inside the azd environment directory
 * (.azure/<env>/deployment-state.json) so `azd env select` switches state with
 * the environment it belongs to. Idempotency primitive for the whole pipeline:
 * a step either has a checkpoint (skip on rerun) or does not (run it).
 */
export function makeCheckpointStore({statePath, now = () => new Date().toISOString(), read = readFile, write = writeFile, mkdirImpl = mkdir} = {}) {
  return {
    statePath,
    async load() {
      try {
        return JSON.parse(await read(statePath, 'utf8'));
      } catch {
        return {checkpoints: {}, steps: []};
      }
    },
    async mark(step, detail = {}) {
      const state = await this.load();
      state.checkpoints[step] = {completedAt: now(), ...detail};
      state.steps.push({step, at: now()});
      await mkdirImpl(path.dirname(statePath), {recursive: true});
      await write(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      return state;
    },
    async has(step) {
      const state = await this.load();
      return Boolean(state.checkpoints?.[step]);
    },
    async clear(step) {
      const state = await this.load();
      delete state.checkpoints?.[step];
      await write(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    }
  };
}

/** Resolve the azd environment directory (.azure/<AZURE_ENV_NAME>) for state. */
export function resolveStatePath(env = process.env) {
  const name = env.AZURE_ENV_NAME;
  if (!name) throw new Error('AZURE_ENV_NAME is not set — run inside `azd up`/`azd provision` or set it manually');
  return path.join(process.cwd(), '.azure', name, 'deployment-state.json');
}

/** Read azd environment values (priority: process env, then .azure/<env>/.env). */
export async function readAzdEnv(env = process.env) {
  const values = {};
  if (env.AZURE_ENV_NAME) {
    const envFile = path.join(process.cwd(), '.azure', env.AZURE_ENV_NAME, '.env');
    if (existsSync(envFile)) {
      for (const line of (await readFile(envFile, 'utf8')).split('\n')) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  return {...values, ...pickDefined(env)};
}

function pickDefined(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

/** azd infra outputs as a flat {name: value} map (from `azd infra outputs --json`). */
export async function readInfraOutputs({azd = defaultAzdOutputs} = {}) {
  return azd();
}

async function defaultAzdOutputs() {
  const result = await execCommand(['azd', 'infra', 'outputs', '--json'], {timeoutMs: 120000});
  return JSON.parse(result.stdout);
}

/** Structured step logger: one line to stdout, one JSON line to the deploy log. */
export function makeStepLogger({stream = process.stdout, logPath, now = () => new Date().toISOString()} = {}) {
  const entries = [];
  return function log(step, status, detail = {}) {
    const entry = {at: now(), step, status, ...detail};
    entries.push(entry);
    stream.write(`[${step}] ${status}${detail.note ? ` — ${detail.note}` : ''}\n`);
    if (logPath) {
      mkdir(path.dirname(logPath), {recursive: true}).then(() =>
        writeFile(logPath, `${JSON.stringify(entry)}\n`, {encoding: 'utf8', flag: 'a'})
      ).catch(() => {});
    }
    return entry;
  };
}

/** Fail fast with a machine-readable block: title, one bullet per problem, fixes. */
export function formatFailures(title, failures) {
  const lines = [title, ''];
  for (const failure of failures) {
    lines.push(`  ✗ ${failure.check}: ${failure.problem}`);
    if (failure.fix) lines.push(`    fix: ${failure.fix}`);
  }
  return lines.join('\n');
}

export function assertRequiredEnv(values, required) {
  const missing = required.filter(key => !values[key]);
  if (missing.length) {
    throw new Error(`missing required azd environment values: ${missing.join(', ')} (set with: azd env set <NAME> <VALUE>)`);
  }
}
