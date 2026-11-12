#!/usr/bin/env node
/**
 * azd postprovision hook — bridges the two provisioning stages.
 *
 * azd provision (stage 'foundation', from PROVISION_STAGE unset/default) has
 * just created the registry, identities, network and storage. This hook:
 *
 *   1. publishes the agent image and records its immutable digest
 *   2. records the digest + PROVISION_STAGE=full in the azd environment
 *   3. re-runs `azd provision` — the full stage deploys VM arm, ACA Jobs and
 *      sandbox configuration pinned to that digest
 *   4. runs auto-configuration (deploy/configure.mjs)
 *
 * Interrupt-safe: every step is checkpointed. Rerunning `azd up` after an
 * interruption resumes at the first incomplete step instead of repeating work.
 */
import {readAzdEnv, makeCheckpointStore, resolveStatePath, makeStepLogger, execCommand} from './common.mjs';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {main as publishImages} from './publish-images.mjs';
import {main as configure} from './configure.mjs';
import {pathToFileURL} from 'node:url';

export async function main({env = process.env, stdout = process.stdout, stderr = process.stderr, checkpoints, runProvision = defaultRunProvision, publish = publishImages, configureStep = configure} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const store = checkpoints ?? makeCheckpointStore({statePath: resolveStatePath({...process.env, ...values})});

  if (values.PROVISION_STAGE === 'full' && await store.has('fullStageProvisioned')) {
    log('postprovision', 'skipped', {note: 'full stage already provisioned (checkpoint present) — reconciling only'});
    const code = await configureStep({env, stdout, stderr});
    return code;
  }

  // 1. Image publish (internally idempotent on source-hash).
  const publishCode = await publish({env, stdout, stderr});
  if (publishCode !== 0) return publishCode;
  const state = await store.load();
  const digest = state.checkpoints?.publishImages?.digest;
  if (!digest) {
    stderr.write('postprovision: publish-images did not record a digest\n');
    return 4;
  }
  log('postprovision', 'image-published', {note: digest});

  // 2. Pin digest + switch stage in the azd environment.
  await runAzdEnvSet({AZURE_IMAGE_DIGEST_REF: digest, AGENT_IMAGE_DIGEST: digest, PROVISION_STAGE: 'full'}, values.AZURE_ENV_NAME ?? 'default');
  log('postprovision', 'env-updated', {note: 'PROVISION_STAGE=full, digest pinned'});

  // 3. Second provisioning pass (full stage).
  const provisionResult = await runProvision();
  if (provisionResult.exitCode !== 0) {
    stderr.write(`postprovision: full-stage provision failed (exit ${provisionResult.exitCode}). Rerun azd up to resume.\n`);
    return provisionResult.exitCode;
  }
  await store.mark('fullStageProvisioned', {digest});
  log('postprovision', 'full-stage-provisioned');

  // 4. Auto-configuration from ARM outputs.
  const configureCode = await configureStep({env, stdout, stderr});
  if (configureCode !== 0) return configureCode;
  log('postprovision', 'configured');
  return 0;
}

async function runAzdEnvSet(values, envName = process.env.AZURE_ENV_NAME ?? 'default') {
  for (const [key, value] of Object.entries(values)) {
    try {
      await execCommand(['azd', 'env', 'set', key, value], {timeoutMs: 60000});
    } catch {
      // azd not reachable (or hook ran outside azd): persist directly to the
      // environment .env azd reads, preserving any existing keys.
      const envFile = path.join(process.cwd(), '.azure', envName, '.env');
      await mkdir(path.dirname(envFile), {recursive: true});
      const existing = await readFile(envFile, 'utf8').catch(() => '');
      const updated = existing.split('\n').filter(line => line && !line.startsWith(`${key}=`));
      updated.push(`${key}=${value}`);
      await writeFile(envFile, `${updated.join('\n')}\n`);
    }
  }
}

async function defaultRunProvision() {
  try {
    await execCommand(['azd', 'provision'], {timeoutMs: 60 * 60 * 1000});
    return {exitCode: 0};
  } catch (error) {
    return {exitCode: error.code ?? 1, stderr: String(error.stderr ?? '').slice(0, 2000)};
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
