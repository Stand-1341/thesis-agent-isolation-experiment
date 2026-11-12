#!/usr/bin/env node
/**
 * Input resolution — the "no manual configuration" half of preprovision.
 *
 * Before the first `azd provision`, three values would otherwise require
 * hand-editing: the SSH public key, the trusted controller IP, and the pinned
 * VM image version. This script resolves each from the machine or from Azure
 * and records it in the azd environment. Idempotent: existing values are never
 * overwritten (resolve-once semantics; force with --refresh).
 *
 * Sources, in priority order:
 *   sshPublicKey       existing env value → config/deployment.json
 *                      vm.sshPublicKeyPath (~/.ssh/id_ed25519.pub) → generate a
 *                      dedicated key pair under .azure/<env>/ (never overwrite)
 *   trustedControllerIp existing env value → config/deployment.json
 *                      trustedControllerIp → this machine's egress IP (a /32)
 *   vmImageVersion      existing env value → latest pinned version of the
 *                      Ubuntu Arm64 offer the template expects
 */
import {readAzdEnv, makeStepLogger, execCommand} from './common.mjs';
import {readFile, writeFile, mkdir, access, chmod} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const UBUNTU_ARM64_URN = 'Canonical:ubuntu-24_04-lts-arm64:server-arm64';

export async function loadDeploymentConfig({read = readFile} = {}) {
  try {
    return JSON.parse(await read('config/deployment.json', 'utf8'));
  } catch {
    return {};
  }
}

export async function resolveSshPublicKey({config, envDir, env, refresh = false, read = readFile, exec = execCommand} = {}) {
  const publicKeyPath = path.join(envDir, 'deployment-ssh.pub');
  const configKey = config?.vm?.sshPublicKeyPath?.replace(/^~/, process.env.HOME ?? '~');
  const candidates = [configKey, path.join(process.env.HOME ?? '', '.ssh', 'id_ed25519.pub'), path.join(process.env.HOME ?? '', '.ssh', 'id_rsa.pub')].filter(Boolean);

  for (const candidate of candidates) {
    const text = await read(candidate, 'utf8').catch(() => undefined);
    if (text) {
      const line = text.split('\n').find(l => /^ssh-(ed25519|rsa) /.test(l.trim()));
      if (line) return {value: line.trim(), source: candidate};
    }
  }

  // No existing usable key: generate a dedicated one for this environment.
  try {
    await access(publicKeyPath);
    if (!refresh) return {value: (await read(publicKeyPath, 'utf8')).trim(), source: publicKeyPath};
  } catch { /* not present — generate */ }
  await exec(['ssh-keygen', '-t', 'ed25519', '-N', '', '-C', 'thesis-deployment', '-f', publicKeyPath.replace(/\.pub$/, ''), '-q']);
  await chmod(publicKeyPath.replace(/\.pub$/, ''), 0o600).catch(() => {});
  return {value: (await read(publicKeyPath, 'utf8')).trim(), source: publicKeyPath};
}

export async function resolveEgressIp({config, fetchImpl = fetch} = {}) {
  if (config?.trustedControllerIp) return {value: config.trustedControllerIp, source: 'config'};
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const response = await fetchImpl(url, {signal: AbortSignal.timeout(8000)});
      const text = (await response.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return {value: `${text}/32`, source: url};
    } catch { /* try next */ }
  }
  return undefined;
}

export async function resolveVmImageVersion({exec = execCommand} = {}) {
  try {
    const output = await execCommand(['az', 'vm', 'image', 'list', '--all', '--output', 'json', '--query', `[?urn=='${UBUNTU_ARM64_URN}'].version | [0]`], {timeoutMs: 120000});
    const version = JSON.parse(output.stdout);
    if (typeof version === 'string' && version) return {value: version, source: 'az vm image list'};
  } catch { /* az unavailable or offline — leave unset, render-parameters will demand it */ }
  return undefined;
}

export async function main({env = process.env, stdout = process.stdout, stderr = process.stderr, refresh = false} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const envName = process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default';
  const envDir = path.join(process.cwd(), '.azure', envName);
  await mkdir(envDir, {recursive: true});
  const config = await loadDeploymentConfig();

  const resolved = {};
  if (!values.SSH_PUBLIC_KEY || refresh) {
    const key = await resolveSshPublicKey({config, envDir, env: values, refresh});
    if (key) resolved.SSH_PUBLIC_KEY = key.value;
  }
  if (!values.TRUSTED_CONTROLLER_IP || refresh) {
    const ip = await resolveEgressIp({config});
    if (ip) resolved.TRUSTED_CONTROLLER_IP = ip.value;
  }
  if (!values.VM_IMAGE_VERSION || refresh) {
    const version = await resolveVmImageVersion();
    if (version) resolved.VM_IMAGE_VERSION = version.value;
  }
  if (config?.namePrefix && !values.AZURE_NAME_PREFIX) resolved.AZURE_NAME_PREFIX = config.namePrefix;
  if (config?.region && !values.AZURE_LOCATION) resolved.AZURE_LOCATION = config.region;
  if (config?.evidence?.retentionDays !== undefined && !values.EVIDENCE_RETENTION_DAYS) resolved.EVIDENCE_RETENTION_DAYS = String(config.evidence.retentionDays);

  if (Object.keys(resolved).length === 0) {
    log('resolve-inputs', 'noop', {note: 'all inputs already resolved'});
    return 0;
  }
  for (const [key, value] of Object.entries(resolved)) {
    await execCommand(['azd', 'env', 'set', key, value], {timeoutMs: 60000}).catch(async error => {
      // azd not on PATH during unit/manual runs: persist to .env directly.
      stderr.write(`(azd env set unavailable — writing ${key} to ${envDir}/.env directly)\n`);
      const envFile = path.join(envDir, '.env');
      const existing = await readFile(envFile, 'utf8').catch(() => '');
      const updated = existing.split('\n').filter(line => line && !line.startsWith(`${key}=`));
      updated.push(`${key}=${value}`);
      await writeFile(envFile, `${updated.join('\n')}\n`);
    });
  }
  log('resolve-inputs', 'resolved', {note: Object.keys(resolved).join(', ')});
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main({refresh: process.argv.includes('--refresh')});
}
