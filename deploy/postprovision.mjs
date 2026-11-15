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
import {readAzdEnv, makeCheckpointStore, resolveStatePath, makeStepLogger, execCommand, makeAzRunner} from './common.mjs';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {main as publishImages} from './publish-images.mjs';
import {main as configure} from './configure.mjs';
import {defaultResearchHostBootstrap} from './research-host-bootstrap.mjs';
import {bootstrapSandboxImages} from './bootstrap-sandboxes.mjs';
import {publishFunctions} from './publish-functions.mjs';
import {setupResearchHost} from './research-host-setup.mjs';
import {configureP3Firewall} from './configure-p3-firewall.mjs';
import {runPostFoundationWhatIfGate} from './preflight.mjs';
import {pathToFileURL} from 'node:url';

export async function main({env = process.env, stdout = process.stdout, stderr = process.stderr, checkpoints, runProvision = defaultRunProvision, publish = publishImages, configureStep = configure, bootstrapStep = defaultResearchHostBootstrap, functionsPublishStep = publishFunctions, sandboxBootstrapStep = bootstrapSandboxImages, researchHostSetupStep = setupResearchHost, p3FirewallStep = configureP3Firewall, whatIfGate = defaultPostFoundationWhatIfGate} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const store = checkpoints ?? makeCheckpointStore({statePath: resolveStatePath({...process.env, ...values})});

  // `azd provision` invoked below fires postprovision again. The checkpoint is
  // intentionally written only after that child command returns, so it cannot
  // be used to distinguish the nested hook invocation. PROVISION_STAGE is the
  // recursion guard: the full-stage hook only reconciles generated config.
  if (values.PROVISION_STAGE === 'full') {
    log('postprovision', 'skipped', {note: 'full stage hook — reconciling only'});
    const code = await configureStep({env, stdout, stderr});
    if (code !== 0) return code;
    await store.mark('configured');
    const firewallCode=await p3FirewallStep({env,stdout,stderr});
    if(firewallCode!==0) return firewallCode;
    await store.mark('p3FirewallConfigured');
    const functionsCode=await functionsPublishStep({env,stdout,stderr});
    if(functionsCode!==0) return functionsCode;
    await store.mark('functionsPublished');
    const sandboxCode=await sandboxBootstrapStep({env,stdout,stderr});
    if(sandboxCode!==0) stderr.write('postprovision: ACA Sandbox image/runtime bootstrap failed; rerun azd up after resolving the reported issue.\n');
    else await store.mark('sandboxBootstrapped');
    if(sandboxCode!==0) return sandboxCode;
    const hostCode=await researchHostSetupStep({env,stdout,stderr});
    if(hostCode!==0) return hostCode;
    await store.mark('researchHostBootstrapped');
    return 0;
  }

  // Foundation has created the dedicated vault and lock container. Seed all
  // credentials, including the host CA key, before publishing an image or
  // launching the full stage. The helper only prints counts and names.
  try { await bootstrapStep({env:values}); }
  catch {
    stderr.write('postprovision: host Key Vault/lock bootstrap failed; the image and full stage were not started. Check CA inputs, vault access, and lock-container access, then rerun azd up.\n');
    return 4;
  }
  log('postprovision', 'host-bootstrap-complete');

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

  // Confirm the exact full-stage plan after foundation outputs and the pinned
  // image digest exist. The preview is read-only and gates the full provision.
  const fullStageEnv={...values,AGENT_IMAGE_DIGEST:digest,PROVISION_STAGE:'full'};
  try {
    const gate = await whatIfGate({env:fullStageEnv});
    if (!gate?.ok) {
      stderr.write(`postprovision: post-foundation what-if gate failed at ${gate?.stage ?? 'unknown stage'}: ${gate?.problem ?? 'preview was incomplete'}; full-stage provisioning was not started.\n`);
      return 4;
    }
  } catch (error) {
    stderr.write(`postprovision: post-foundation what-if could not validate full-stage coverage: ${String(error?.message ?? error).slice(0, 1000)}; full-stage provisioning was not started.\n`);
    return 4;
  }
  log('postprovision', 'post-foundation-what-if-passed');

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

  // The child `azd provision` invokes this hook again with PROVISION_STAGE=full.
  // That nested hook configures outputs and bootstraps Sandbox images/runtime.
  // Repeating either here would re-smoke every profile and could overwrite the
  // disk-image IDs the nested hook just persisted.
  log('postprovision', 'full-stage-reconciled-by-nested-hook');
  return 0;
}

async function defaultPostFoundationWhatIfGate({env}) {
  if (!env.AZURE_SUBSCRIPTION_ID || !env.AZURE_RESOURCE_GROUP) {
    throw new Error('AZURE_SUBSCRIPTION_ID and AZURE_RESOURCE_GROUP are required');
  }
  return runPostFoundationWhatIfGate({
    az: makeAzRunner(),
    resourceGroup: env.AZURE_RESOURCE_GROUP,
    env
  });
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
