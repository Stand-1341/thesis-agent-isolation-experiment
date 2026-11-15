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
import {readAzdEnv, makeAzRunner, withRetry, makeStepLogger, makeCheckpointStore, resolveStatePath, execCommand} from './common.mjs';
import {createHash} from 'node:crypto';
import {readFile, writeFile, readdir, mkdir, copyFile, cp, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {X509Certificate} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const STARTER = path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER');
const DIGEST = /^sha256:[0-9a-f]{64}$/;

async function removeBuildContext(context) {
  let lastError;
  for(let attempt=0;attempt<10;attempt++) {
    try { await rm(context,{recursive:true,force:true}); return; }
    catch(error) {
      lastError=error;
      if(!['EBUSY','EPERM','ENOTEMPTY'].includes(error?.code)||attempt===9) break;
      await delay(1000*(attempt+1));
    }
  }
  throw lastError;
}

/** Hash the build context files so a rerun with unchanged source skips the build. */
function validatePublicResearchCa(bytes) {
  let certificate;
  try { certificate = new X509Certificate(bytes); }
  catch { throw new Error('THESIS_RESEARCH_CA_CERT must point to a valid public CA certificate'); }
  if (!certificate.ca || !Number.isFinite(Date.parse(certificate.validFrom)) || Date.parse(certificate.validFrom) > Date.now() || !Number.isFinite(Date.parse(certificate.validTo)) || Date.parse(certificate.validTo) <= Date.now() + 30 * 24 * 60 * 60 * 1000)
    throw new Error('THESIS_RESEARCH_CA_CERT must be an unexpired CA certificate with at least 30 days validity');
  return certificate;
}

export async function hashBuildContext({dir = STARTER, caCertificatePath = path.join(STARTER, 'certs/thesis-pilot-ca.pem'), read = readFile, list = readdir} = {}) {
  const hash = createHash('sha256');
  // Hash precisely the inputs copied by Dockerfile.node, including the
  // lockfile, bundled CA and compiled code. Missing inputs must not produce a
  // reusable cache key for an image that cannot be built.
  const files = ['Dockerfile.node', '.dockerignore', 'package.json', 'package-lock.json'];
  async function collect(relative) {
    for (const item of await list(path.join(dir, relative), {withFileTypes:true})) {
      const name = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) throw new Error(`image build input is a symlink: ${name}`);
      if (item.isDirectory()) await collect(name);
      else if (item.isFile()) files.push(name);
      else throw new Error(`unsupported image build input: ${name}`);
    }
  }
  await collect('dist');
  for (const file of files.sort()) {
    const contents = await read(path.join(dir, ...file.split('/')));
    hash.update(`${file}\0${contents.length}\0`).update(contents);
  }
  const caBytes = await read(caCertificatePath);
  validatePublicResearchCa(caBytes);
  hash.update(`certs/thesis-pilot-ca.pem\0${caBytes.length}\0`).update(caBytes);
  return `sha256:${hash.digest('hex')}`;
}

/** Build a clean local ACR context with the caller's preprovisioned public CA. */
export async function prepareImageBuildContext({dir = STARTER, caCertificatePath, createTemp = mkdtemp, copy = copyFile, copyTree = cp} = {}) {
  if (typeof caCertificatePath !== 'string' || !caCertificatePath)
    throw new Error('THESIS_RESEARCH_CA_CERT is required before image publication; the workload image must trust the host CA issued later');
  const caBytes = await readFile(caCertificatePath);
  validatePublicResearchCa(caBytes);
  const context = await createTemp(path.join(tmpdir(), 'thesis-agent-image-'));
  try {
    for (const name of ['Dockerfile.node', '.dockerignore', 'package.json', 'package-lock.json'])
      await copy(path.join(dir, name), path.join(context, name));
    await copyTree(path.join(dir, 'dist'), path.join(context, 'dist'), {recursive: true, dereference: false, errorOnExist: true});
    const certDir = path.join(context, 'certs');
    await mkdir(certDir, {recursive: true});
    await copy(caCertificatePath, path.join(certDir, 'thesis-pilot-ca.pem'));
    return context;
  } catch (error) {
    await rm(context, {recursive: true, force: true});
    throw error;
  }
}

/** Extract the image digest after a push. */
export async function resolveImageDigest({az, registry, subscriptionId, repository = 'thesis/agent', tag = 'latest'}) {
  const digest = await az(['acr', 'repository', 'show', '--name', registry, '--image', `${repository}:${tag}`, '--query', 'digest', ...(subscriptionId ? ['--subscription', subscriptionId] : [])]);
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new Error(`registry returned a non-digest value for ${repository}:${tag}: ${String(digest).slice(0, 100)}`);
  }
  return digest;
}

async function buildAndPushImage({az,registry,subscriptionId,context,timeoutMs=30*60*1000}={}) {
  let dockerReady=false;
  try {
    await execCommand(['docker','info','--format','{{.ServerVersion}}'],{timeoutMs:15000});
    dockerReady=true;
  } catch {}
  if(!dockerReady) {
    await az(['acr','build','--subscription',subscriptionId,'--registry',registry,'--image','thesis/agent:latest',
      '--file','Dockerfile.node',context],{json:false,timeoutMs});
    return 'remote';
  }
  const loginServer=await az(['acr','show','--subscription',subscriptionId,'--name',registry,'--query','loginServer']);
  if(typeof loginServer!=='string'||!loginServer.includes('.')) throw new Error('Azure Container Registry did not return a valid login server');
  const image=`${loginServer}/thesis/agent:latest`;
  await az(['acr','login','--subscription',subscriptionId,'--name',registry],{json:false,timeoutMs:120000});
  await execCommand(['docker','build','--file','Dockerfile.node','--tag',image,context],{cwd:context,timeoutMs});
  await execCommand(['docker','push',image],{cwd:context,timeoutMs});
  return 'local';
}

export async function main({env = process.env, az, checkpoints, stdout = process.stdout, stderr = process.stderr} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const runner = az ?? makeAzRunner();
  const retried = withRetry(runner);
  const store = checkpoints ?? makeCheckpointStore({statePath: resolveStatePath({...process.env, ...values})});
  const registry = values.AGENT_REGISTRY_NAME ?? `${values.AZURE_NAME_PREFIX ?? 'thesis'}acr`;
  if (!values.AZURE_SUBSCRIPTION_ID) throw new Error('AZURE_SUBSCRIPTION_ID is required to publish the image');
  const caCertificatePath = values.THESIS_RESEARCH_CA_CERT;
  if (!caCertificatePath) throw new Error('THESIS_RESEARCH_CA_CERT must name the preprovisioned public research CA before foundation image publication');
  const sourceKey = await hashBuildContext({caCertificatePath});

  // Reuse: same source hash already built and digest still present in the registry.
  const state = await store.load();
  const prior = state.checkpoints?.publishImages;
  if (prior?.sourceKey === sourceKey && prior?.registry === registry) {
    const stillThere = await retried(['acr', 'repository', 'show', '--subscription', values.AZURE_SUBSCRIPTION_ID, '--name', registry, '--image', `thesis/agent@${prior.digest}`, '--query', 'digest']).then(() => true).catch(() => false);
    if (stillThere) {
      log('publish-images', 'reused', {note: `digest ${prior.digest.slice(0, 19)}… already built from identical source`});
      stdout.write(`${prior.digest}\n`);
      return 0;
    }
  }

  log('publish-images', 'building', {note: `az acr build Dockerfile.node → ${registry}.azurecr.io/thesis/agent:latest`});
  const context = await prepareImageBuildContext({caCertificatePath});
  let buildError;
  try {
    await buildAndPushImage({az:retried,registry,subscriptionId:values.AZURE_SUBSCRIPTION_ID,context});
  } catch(error) { buildError=error; throw error; }
  finally {
    try { await removeBuildContext(context); }
    catch(error) { if(!buildError) throw error; }
  }

  const digest = await resolveImageDigest({az: retried, registry, subscriptionId: values.AZURE_SUBSCRIPTION_ID});
  await store.mark('publishImages', {registry, digest, sourceKey});
  log('publish-images', 'published', {note: `pinned digest ${digest}`});
  stdout.write(`${digest}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
