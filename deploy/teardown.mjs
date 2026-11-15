#!/usr/bin/env node
/**
 * Controlled teardown. Two modes:
 *
 *   node deploy/teardown.mjs --guard   (azd predown hook) — refuse to proceed
 *                                      if the evidence container holds anything
 *                                      outside the non-counted validation/
 *                                      prefix, unless --preserve-evidence or
 *                                      --export-evidence <dir> was supplied.
 *   node deploy/teardown.mjs [--export-evidence <dir>] [--force]
 *
 * After `azd down` completes, --guard-free mode lists resources that could
 * STILL incur charges (anything outside the deployment's resource group).
 * Teardown only ever deletes the azd-managed resource group — never unmanaged
 * resources the deployment did not create.
 */
import {readAzdEnv, makeAzRunner, makeStepLogger, formatFailures} from './common.mjs';
import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function parseArgs(argv = []) {
  const options = {guard: false, force: false, exportEvidence: undefined, help: false};
  for (let i = 0; i < 0 + argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--guard') options.guard = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--export-evidence') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--export-evidence requires a directory path');
      options.exportEvidence = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** Pure decision: may teardown proceed given evidence state? */
export function evaluateTeardownGuard({blobs = [], exportEvidence, force, preserveEvidence} = {}) {
  const counted = blobs.filter(name => !String(name).startsWith('validation/'));
  if (counted.length === 0) return {allowed: true, reason: 'evidence container holds only non-counted validation blobs'};
  if (force) return {allowed: true, reason: `forced: ${counted.length} evidence blob(s) WILL BE LOST`, destructive: true};
  if (exportEvidence) return {allowed: true, reason: `${counted.length} evidence blob(s) will be exported to ${exportEvidence} first`, exports: counted.length};
  if (preserveEvidence) return {allowed: false, reason: `${counted.length} evidence blob(s) present and evidence retention is on; deletion refused`, evidencePresent: counted.length};
  return {
    allowed: false,
    reason: `${counted.length} evidence blob(s) present`,
    evidencePresent: counted.length,
    fix: 'pass --export-evidence <dir> to copy evidence out first, or --force to knowingly destroy it'
  };
}

/** Parse only an unsigned Azure Blob container URL; never send tokens elsewhere. */
export function parseEvidenceContainerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid evidence container URL'); }
  const match = /^([a-z0-9]{3,24})\.blob\.core\.windows\.net$/i.exec(url.hostname);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.port || url.search || url.hash || parts.length !== 1 || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(parts[0])) {
    throw new Error('evidence URL must identify one Azure Blob container without credentials or query');
  }
  return {account: match[1], container: parts[0]};
}

export async function listEvidenceBlobs({az, containerUrl} = {}) {
  const {account, container} = parseEvidenceContainerUrl(containerUrl);
  const blobs = await az(['storage', 'blob', 'list', '--account-name', account, '--container-name', container, '--auth-mode', 'login', '--query', '[].name']);
  if (!Array.isArray(blobs) || blobs.some(name => typeof name !== 'string')) throw new Error('Azure returned an invalid evidence listing');
  return blobs;
}

/** Resources that may still incur charges after the managed group is deleted. */
export function identifyChargedSurvivors({subscriptionResources = [], managedResourceGroup} = {}) {
  const managedName = /\/resourcegroups\/([^/]+)/i.exec(managedResourceGroup ?? '')?.[1] ?? managedResourceGroup;
  return subscriptionResources
    .filter(resource => String(resource.resourceGroup ?? /\/resourcegroups\/([^/]+)/i.exec(resource.id ?? '')?.[1] ?? '').toLowerCase() !== String(managedName ?? '').toLowerCase())
    // Keep every remaining resource in this warning: billing can arise from
    // many provider types and this inventory is not a pricing classifier.
    .map(resource => ({id: resource.id, type: resource.type, name: resource.name}));
}

export async function main({argv = process.argv.slice(2), env = process.env, az, stdout = process.stdout, stderr = process.stderr, blobLister, down} = {}) {
  const log = makeStepLogger({stream: stdout});
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 5;
  }

  const values = await readAzdEnv(env);
  const runner = az ?? makeAzRunner();
  const envName = process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default';
  const envDir = path.join(process.cwd(), '.azure', envName);
  let resolved = {};
  try {
    resolved = JSON.parse(await readFile(path.join(envDir, 'deployment.resolved.json'), 'utf8'));
  } catch {
    stderr.write('teardown: no deployment.resolved.json — deployment and evidence state are unknown; refusing to delete anything\n');
    return 5;
  }

  // Guard: check evidence before azd down deletes the storage account.
  let blobs;
  try {
    if (!resolved.evidence?.containerUrl) throw new Error('evidence container URL is missing');
    blobs = blobLister ? await blobLister(resolved.evidence.containerUrl) : await listEvidenceBlobs({az:runner, containerUrl:resolved.evidence.containerUrl});
    if (!Array.isArray(blobs)) throw new Error('evidence listing is unavailable');
  } catch (error) {
    stderr.write(`Teardown refused: could not verify evidence contents (${error.message}).\n`);
    return 3;
  }
  const decision = evaluateTeardownGuard({blobs, exportEvidence: options.exportEvidence, force: options.force, preserveEvidence: String(values.EVIDENCE_RETENTION_LOCKED ?? '') === 'true'});

  if (!decision.allowed) {
    stderr.write(formatFailures('Teardown guard refused:', [{check: 'evidence', problem: decision.reason, fix: decision.fix}]) + '\n');
    return 3;
  }

  if (decision.exports && options.exportEvidence) {
    await mkdir(options.exportEvidence, {recursive: true});
    const exported = [];
    for (const name of blobs.filter(n => !String(n).startsWith('validation/'))) {
      const filename = `${createHash('sha256').update(name).digest('hex')}.blob`;
      const target = path.join(options.exportEvidence, filename);
      const {account, container} = parseEvidenceContainerUrl(resolved.evidence.containerUrl);
      await runner(['storage', 'blob', 'download', '--account-name', account, '--container-name', container, '--auth-mode', 'login', '--name', name, '--file', target, '--overwrite', 'false'], {json: false});
      exported.push({name, filename});
    }
    await writeFile(path.join(options.exportEvidence, 'evidence-export-index.json'), `${JSON.stringify(exported, null, 2)}\n`, {flag:'wx'});
    log('teardown', 'evidence-exported', {note: `${decision.exports} blob(s) → ${options.exportEvidence}`});
  }

  if (options.guard) {
    // azd will now run its own `azd down`; guard mode only decides.
    log('teardown-guard', decision.destructive ? 'allowed-destructive' : 'allowed', {note: decision.reason});
    return 0;
  }

  // Direct mode: run azd down, then report survivors.
  log('teardown', 'running-azd-down');
  const runDown = down ?? (async () => {
    const {execCommand} = await import('./common.mjs');
    await execCommand(['azd', 'down', '--force'], {timeoutMs: 30 * 60 * 1000});
  });
  try {
    await runDown();
  } catch (error) {
    stderr.write(`azd down failed: ${String(error.stderr ?? error.message).slice(0, 400)}\n`);
    return 4;
  }

  let survivors;
  try {
    survivors = await runner(['resource', 'list', '--subscription', resolved.subscriptionId]);
    if (!Array.isArray(survivors)) throw new Error('unexpected resource listing');
  } catch (error) {
    stderr.write(`Teardown completed, but remaining Azure resources could not be verified: ${error.message}\n`);
    return 4;
  }
  const charged = identifyChargedSurvivors({subscriptionResources: survivors, managedResourceGroup: values.AZURE_RESOURCE_GROUP});
  await writeFile(path.join(envDir, 'TEARDOWN-REPORT.md'),
    `# Teardown report\n\nmanaged group: ${values.AZURE_RESOURCE_GROUP}\n${decision.reason}\n\n## Resources that may still incur charges\n` +
    (charged.length ? charged.map(r => `- \`${r.id}\` (${r.type})`).join('\n') : '- none found') + '\n');
  log('teardown', 'complete', {note: charged.length ? `${charged.length} resource(s) outside the managed group may still incur charges — see TEARDOWN-REPORT.md` : 'no chargeable survivors found'});
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
