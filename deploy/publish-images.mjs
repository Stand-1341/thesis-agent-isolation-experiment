#!/usr/bin/env node
/**
 * Build and push the agent workload image to the deployment's registry, then
 * record its IMMUTABLE DIGEST. Digest, not tag — a tag drifts silently between
 * the deployment and a later measured run.
 *
 * Uses `az acr build` (server-side build; no local Docker required) against
 * Complete_Thesis_Azure_Package/05-DOCKER-STARTER/Dockerfile.node.
 *
 * Idempotent: if the exact source tree digest was already built and recorded
 * in checkpoint state, the recorded digest is reused without rebuilding.
 */
import {readAzdEnv, makeAzRunner, withRetry, makeStepLogger, makeCheckpointStore, resolveStatePath} from './common.mjs';
import {createHash} from 'node:crypto';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const STARTER = path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER');
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Hash the build context files so a rerun with unchanged source skips the build. */
export async function hashBuildContext({dir = STARTER, entries = ['Dockerfile.node', 'package.json', 'tsconfig.json', 'compose.yaml'], read = readFile, list = readdir} = {}) {
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(entry).update(':').update(await read(path.join(dir, entry), 'utf8').catch(() => ''));
  const srcFiles = (await list(path.join(dir, 'src')).catch(() => [])).filter(f => f.endsWith('.ts')).sort();
  for (const file of srcFiles) hash.update(`src/${file}`).update(':').update(await read(path.join(dir, 'src', file), 'utf8').catch(() => ''));
  return `sha256:${hash.digest('hex').slice(0, 32)}-src`;
}

/** Extract the image digest after a push. */
export async function resolveImageDigest({az, registry, repository = 'thesis/agent', tag = 'latest'}) {
  const digest = await az(['acr', 'repository', 'show', '--name', registry, '--image', `${repository}:${tag}`, '--query', 'digest']);
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new Error(`registry returned a non-digest value for ${repository}:${tag}: ${String(digest).slice(0, 100)}`);
  }
  return digest;
}

export async function main({env = process.env, az, checkpoints, stdout = process.stdout, stderr = process.stderr} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const runner = az ?? makeAzRunner();
  const retried = withRetry(runner);
  const store = checkpoints ?? makeCheckpointStore({statePath: resolveStatePath({...process.env, ...values})});
  const registry = values.AGENT_REGISTRY_NAME ?? `${values.AZURE_NAME_PREFIX ?? 'thesis'}acr`;
  const sourceKey = await hashBuildContext();

  // Reuse: same source hash already built and digest still present in the registry.
  const state = await store.load();
  const prior = state.checkpoints?.publishImages;
  if (prior?.sourceKey === sourceKey && prior?.registry === registry) {
    const stillThere = await retried(['acr', 'repository', 'show', '--name', registry, '--image', `thesis/agent@${prior.digest}`, '--query', 'digest']).then(() => true).catch(() => false);
    if (stillThere) {
      log('publish-images', 'reused', {note: `digest ${prior.digest.slice(0, 19)}… already built from identical source`});
      stdout.write(`${prior.digest}\n`);
      return 0;
    }
  }

  log('publish-images', 'building', {note: `az acr build Dockerfile.node → ${registry}.azurecr.io/thesis/agent:latest`});
  await retried(['acr', 'build', '--registry', registry, '--image', 'thesis/agent:latest', '--file', 'Dockerfile.node', STARTER], {json: false, timeoutMs: 30 * 60 * 1000});

  const digest = await resolveImageDigest({az: retried, registry});
  await store.mark('publishImages', {registry, digest, sourceKey});
  log('publish-images', 'published', {note: `pinned digest ${digest}`});
  stdout.write(`${digest}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
