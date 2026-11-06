#!/usr/bin/env node
/**
 * Cheapest path to one real, observable ACA Sandboxes execution.
 *
 * This exists because the full three-arm composition is not required to answer the
 * only question that blocks everything else: does the sandbox data plane work, and
 * does it produce attributable evidence? One sandbox group, one sandbox, one command,
 * one egress-decision read, one delete.
 *
 * It creates real, billable Azure resources. It therefore refuses to run without an
 * explicit `--execute` flag, and it refuses to run without an identity.
 *
 * Exit codes:
 *   0  full observation chain confirmed (created, executed, deleted, evidence read)
 *   2  partial: the chain completed but at least one link is unobserved
 *   3  the sandbox was created but a later step failed
 *   4  identity or transport unavailable
 *   5  usage error
 */

import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createAcaSandboxDataPlaneClient} from './aca-sandbox-data-plane.mjs';
import {createAzureRestTokenProvider} from './azure-inventory.mjs';

/**
 * Audience the shared sandbox client requests. Recorded in the observation because the
 * client's audience is the Dynamic Sessions one and the Sandboxes data plane is a
 * separate GA surface — an audience mismatch would surface as a 401, and having the
 * value in the record makes that diagnosable instead of mysterious.
 */
export const SANDBOX_DATA_PLANE_SCOPE = 'https://dynamicsessions.io/.default';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Telemetry categories the sandbox platform can export. */
export const TELEMETRY_CATEGORIES = Object.freeze([
  'ContainerStdoutStderr', 'ContainerOtel', 'Metrics', 'NetworkEgressDecisions'
]);

const USAGE = [
  'Create one sandbox, run one command, read egress evidence, delete it.',
  '',
  'Usage: node scripts/sandbox-first-light.mjs --execute --resource-group <name> \\',
  '         --sandbox-group <name> [--region <region>] [--public-image <name>] \\',
  '         [--body <file.json>] [--probe-url <https-url>] [--out <file.json>]',
  '',
  'Environment: AZURE_SUBSCRIPTION_ID (required), AZURE_REGION (or --region),',
  '             AZURE_DEVICE_CODE_AUTH=1 to sign in as yourself.',
  '',
  '--execute is mandatory. Without it this command only validates inputs and exits 5.',
  'This creates billable resources. Nothing is deleted except the sandbox it creates.'
].join('\n');

export function parseArgs(argv = []) {
  const options = {
    execute: false, help: false, subscriptionId: undefined, region: undefined,
    resourceGroup: undefined, sandboxGroup: undefined, publicImage: 'ubuntu',
    bodyPath: undefined, probeUrl: undefined, outPath: undefined
  };
  const single = {subscription: 'subscriptionId', region: 'region', 'resource-group': 'resourceGroup',
    'sandbox-group': 'sandboxGroup', 'public-image': 'publicImage', body: 'bodyPath',
    'probe-url': 'probeUrl', out: 'outPath'};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--execute') { options.execute = true; continue; }
    if (!arg.startsWith('--')) throw new Error('positional arguments are not accepted');
    const name = arg.slice(2);
    const key = single[name];
    if (!key) throw new Error(`unknown argument: ${/^[A-Za-z0-9-]+$/.test(name) ? arg : 'positional argument'}`);
    const value = argv[++i];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (options[key] !== undefined && key !== 'publicImage') throw new Error(`${arg} may only be supplied once`);
    options[key] = value;
  }
  if (options.help) return options;
  if (options.resourceGroup !== undefined && !NAME.test(options.resourceGroup))
    throw new Error('--resource-group must be a valid resource group name');
  if (options.sandboxGroup !== undefined && !NAME.test(options.sandboxGroup))
    throw new Error('--sandbox-group must be a valid sandbox group name');
  if (options.region !== undefined && !REGION.test(options.region))
    throw new Error('--region must be a lowercase Azure region name');
  if (options.publicImage !== undefined && !NAME.test(options.publicImage))
    throw new Error('--public-image must be a valid image name');
  if (options.probeUrl !== undefined) {
    let url;
    try { url = new URL(options.probeUrl); } catch { throw new Error('--probe-url must be a URL'); }
    if (url.protocol !== 'https:') throw new Error('--probe-url must use https');
  }
  return options;
}

/**
 * Build the sandbox creation body.
 *
 * The repository's established shape is `sourcesRef.diskImage.id` for a custom image.
 * A public prebuilt image is the cheaper path, but the exact REST field for one is not
 * something this code can confirm offline, so `--body` always wins and what was sent is
 * recorded in the observation.
 */
export function buildSandboxBody({publicImage = 'ubuntu'} = {}) {
  return {sourcesRef: {publicImage: {name: publicImage}}};
}

function redact(value) {
  if (typeof value !== 'string') return undefined;
  let text = value;
  // Never let bearer material or long opaque tokens reach the record.
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [REDACTED]');
  text = text.replace(/\beyJ[A-Za-z0-9._-]{20,}/g, '[REDACTED-JWT]');
  text = text.replace(/\b[A-Za-z0-9]{40,}\b/g, '[REDACTED-OPAQUE]');
  return text;
}

/**
 * Describe what was actually observed across the assurance dimensions that matter for
 * a containment claim. Absence of evidence is never recorded as a passing observation.
 */
export function summarizeObservation({execution, egress, lifecycle, telemetryConfigDeclared}) {
  const dimensions = {};
  dimensions.fidelity = {
    status: execution && execution.completed ? 'observed' : 'unobserved',
    detail: execution && execution.completed
      ? 'A command executed in the sandbox and returned a result.'
      : 'No command result was returned; nothing about sandbox behaviour is established.'
  };
  dimensions.controllability = {
    status: lifecycle && lifecycle.created && lifecycle.deletedConfirmed ? 'observed' : 'partial',
    detail: lifecycle && lifecycle.created && lifecycle.deletedConfirmed
      ? 'Sandbox creation and confirmed deletion were both observed.'
      : 'Lifecycle control is only partly observed; the sandbox may still exist.'
  };
  const decisionCount = egress && Number.isInteger(egress.decisionCount) ? egress.decisionCount : 0;
  if (!telemetryConfigDeclared) {
    dimensions.observability = {
      status: 'unobserved',
      detail: 'No telemetryConfig was supplied, so the platform exported nothing. ' +
        'A zero decision count here is a missing sensor, not clean egress.'
    };
  } else if (decisionCount > 0) {
    dimensions.observability = {
      status: 'observed',
      detail: `Telemetry export was declared and ${decisionCount} egress decision record(s) were read back.`
    };
  } else {
    dimensions.observability = {
      status: 'unobserved',
      detail: 'Telemetry export was declared but no egress decision records came back. ' +
        'No outbound request may have occurred, or export may not have propagated. ' +
        'This is not evidence that egress was clean.'
    };
  }
  dimensions.containment = {
    status: 'unobserved',
    detail: 'A single first-light run exercises no unauthorized scenario and proves no containment.'
  };
  dimensions.reproducibility = {
    status: lifecycle && lifecycle.created ? 'partial' : 'unobserved',
    detail: 'One run only. Reproducibility needs the same inputs replayed and independently compared.'
  };
  dimensions.governance = {
    status: 'unobserved',
    detail: 'No retention, ownership or approval artifact accompanies this run.'
  };
  const statuses = Object.values(dimensions).map(d => d.status);
  // Note: a first-light run can never be `observed` overall. Containment and governance
  // require a scenario and an approval artifact that this command does not produce. The
  // chain-completion flag is what decides the exit code; this field describes coverage.
  const overall = statuses.every(s => s === 'observed') ? 'observed'
    : statuses.every(s => s === 'unobserved') ? 'unobserved' : 'partial';
  return {overall, dimensions};
}

/**
 * Run the first-light chain. All side effects happen through injected dependencies so the
 * whole sequence can be tested without Azure.
 */
export async function runFirstLight({
  subscriptionId, region, resourceGroup, sandboxGroup,
  sandboxBody, probeUrl, client, now = () => new Date(), execTimeoutMs = 60_000
} = {}) {
  if (!GUID.test(subscriptionId ?? '')) throw new TypeError('subscriptionId must be a GUID');
  if (!client) throw new TypeError('client is required');

  const startedAt = now().toISOString();
  const record = {
    schema: 'sandbox_first_light_v1',
    startedAt,
    target: {subscriptionId, region, resourceGroup, sandboxGroup},
    sandboxBodySent: sandboxBody,
    probeUrl: probeUrl ?? null,
    dataPlaneAudience: SANDBOX_DATA_PLANE_SCOPE,
    telemetryConfigDeclared: Boolean(sandboxBody?.telemetryConfig),
    lifecycle: {created: false, reachedRunning: false, deletedConfirmed: false},
    execution: null,
    egress: {decisionCount: 0, attributable: false},
    chain: {created: false, executed: false, egressRead: false, deleted: false, confirmed: false},
    failure: null
  };

  let sandboxId;
  try {
    const created = await client.createSandbox(sandboxBody, {timeoutMs: execTimeoutMs});
    sandboxId = created.sandboxId;
    record.lifecycle.created = true;
    record.lifecycle.reachedRunning = true;
    record.lifecycle.sandboxIdOmitted = true;
    record.chain.created = true;
  } catch (error) {
    record.failure = {stage: 'create', message: redact(error?.message) ?? 'create failed'};
    record.observation = summarizeObservation(record);
    return {record, exitCode: 4};
  }

  try {
    const command = probeUrl
      ? `curl -sS -m 10 -o /dev/null -w '%{http_code}' ${JSON.stringify(probeUrl)}`
      : 'echo first-light';
    const result = await client.executeShellCommand(sandboxId, command);
    record.execution = {
      completed: true,
      command,
      exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
      stdout: redact(typeof result?.stdout === 'string' ? result.stdout.slice(0, 2048) : ''),
      stderr: redact(typeof result?.stderr === 'string' ? result.stderr.slice(0, 2048) : '')
    };
    record.chain.executed = true;
  } catch (error) {
    record.failure = {stage: 'execute', message: redact(error?.message) ?? 'execute failed'};
    record.execution = {completed: false};
  }

  try {
    const decisions = await client.getEgressDecisions(sandboxId);
    const list = Array.isArray(decisions) ? decisions
      : Array.isArray(decisions?.value) ? decisions.value : null;
    record.egress = {
      decisionCount: list ? list.length : 0,
      attributable: Boolean(list && list.length > 0),
      // Records are summarized by decision verdict only; no destinations are retained.
      verdicts: list
        ? list.map(d => (typeof d?.decision === 'string' ? d.decision : 'unknown'))
          .slice(0, 50)
        : null
    };
    if (!Array.isArray(decisions) && !Array.isArray(decisions?.value)) {
      record.egress.unparsedShape = true;
    }
    record.chain.egressRead = Array.isArray(decisions) || Array.isArray(decisions?.value);
  } catch (error) {
    record.failure = record.failure ?? {stage: 'egress', message: redact(error?.message) ?? 'egress read failed'};
    record.egress = {decisionCount: 0, attributable: false, readFailed: true};
  }

  try {
    await client.deleteSandbox(sandboxId, {timeoutMs: execTimeoutMs});
    record.lifecycle.deletedConfirmed = true;
    record.chain.deleted = true;
  } catch (error) {
    record.failure = record.failure ?? {stage: 'delete', message: redact(error?.message) ?? 'delete failed'};
  }

  record.finishedAt = now().toISOString();
  record.chain.confirmed = record.chain.created && record.chain.executed &&
    record.chain.egressRead && record.chain.deleted;
  record.observation = summarizeObservation(record);

  // 0 means the whole observation chain ran and produced attributable evidence. Anything
  // less is partial on purpose: a chain that completed without a single egress record is
  // a working sandbox with an unproven sensor, not a result.
  const exitCode = record.failure ? 3
    : record.chain.confirmed && record.egress.attributable ? 0
      : 2;
  return {record, exitCode};
}

export async function main({
  argv = process.argv.slice(2), env = process.env, getToken, fetchImpl,
  stdout = process.stdout, stderr = process.stderr, now = () => new Date()
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 5;
  }
  if (options.help) { stdout.write(`${USAGE}\n`); return 0; }

  const subscriptionId = options.subscriptionId ?? env.AZURE_SUBSCRIPTION_ID;
  const region = options.region ?? env.AZURE_REGION;

  if (!options.execute) {
    stderr.write('Refusing to run: --execute is required. This command creates billable Azure resources.\n' +
      `${USAGE}\n`);
    return 5;
  }
  const missing = [];
  if (!subscriptionId) missing.push('AZURE_SUBSCRIPTION_ID');
  if (!region) missing.push('AZURE_REGION or --region');
  if (!options.resourceGroup) missing.push('--resource-group');
  if (!options.sandboxGroup) missing.push('--sandbox-group');
  if (missing.length) {
    stderr.write(`Refusing to run: missing ${missing.join(', ')}\n${USAGE}\n`);
    return 5;
  }
  if (!GUID.test(subscriptionId)) { stderr.write('Refusing to run: subscription must be a GUID\n'); return 5; }

  let tokenProvider = getToken;
  if (!tokenProvider) {
    try {
      tokenProvider = await createAzureRestTokenProvider({env});
    } catch (error) {
      stdout.write(`${JSON.stringify({schema: 'sandbox_first_light_v1', status: 'identity_unavailable',
        reason: redact(error?.message) ?? 'credential construction failed'})}\n`);
      return 4;
    }
  }

  let sandboxBody;
  if (options.bodyPath) {
    try {
      sandboxBody = JSON.parse(await readFile(options.bodyPath, 'utf8'));
    } catch (error) {
      stderr.write(`Refusing to run: cannot read --body ${options.bodyPath}\n`);
      return 5;
    }
  } else {
    sandboxBody = buildSandboxBody({publicImage: options.publicImage});
  }

  const client = createAcaSandboxDataPlaneClient({
    region, subscriptionId, resourceGroup: options.resourceGroup,
    sandboxGroup: options.sandboxGroup,
    getToken: async scope => tokenProvider(scope ?? SANDBOX_DATA_PLANE_SCOPE),
    ...(fetchImpl ? {fetchImpl} : {})
  });

  const {record, exitCode} = await runFirstLight({
    subscriptionId, region, resourceGroup: options.resourceGroup,
    sandboxGroup: options.sandboxGroup, sandboxBody, probeUrl: options.probeUrl, client, now
  });

  const json = `${JSON.stringify(record)}\n`;
  stdout.write(json);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
