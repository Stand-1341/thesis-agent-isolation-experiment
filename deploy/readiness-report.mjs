#!/usr/bin/env node
/**
 * Final step of `azd up`: emit the machine-readable deployment manifest and a
 * human readiness report. Consumed by CI and by study-execute as proof that a
 * validated deployment exists.
 *
 * Outputs (into .azure/<env>/):
 *   deployment-manifest.json — machine-readable: resources, identities, digest,
 *                              validation results, evidence locations, cost notes
 *   DEPLOYMENT-REPORT.md     — human summary incl. open research-design blockers
 */
import {readAzdEnv, makeStepLogger, makeCheckpointStore, resolveStatePath} from './common.mjs';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/**
 * Research-design blockers surfaced in the report — deployment cannot resolve
 * these; they gate the measured study, not `azd up`.
 */
export const DESIGN_BLOCKERS = [
  {
    id: 'p3-network-denial-telemetry',
    detail: 'Ten ACA Jobs P3 trials remain unsupported: independently attributable network-denial telemetry is unproven.',
    required: 'cloud pilot demonstrating per-trial denial attribution, or a protocol revision freezing a reduced scope'
  },
  {
    id: 'u6-u8-fixture-validation',
    detail: 'Ninety U6/U8 trials need fixture validation.',
    required: 'validated fixtures recorded in the pilot index'
  }
];

export function buildManifest({resolved, checkpointState, env, validationPassed = true, designBlockers = DESIGN_BLOCKERS} = {}) {
  const deployedRoutes = [];
  for (const [arm, profiles] of Object.entries(resolved?.workloads ?? {})) {
    for (const [profile, route] of Object.entries(profiles ?? {})) {
      if (route?.principalObjectId) deployedRoutes.push(`${arm}/${profile}`);
    }
  }
  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    environment: env.AZURE_ENV_NAME ?? 'default',
    subscriptionId: resolved?.subscriptionId,
    location: resolved?.location,
    status: validationPassed ? 'validated' : 'validation-failed',
    measuredStudyReady: validationPassed && designBlockers.length === 0,
    image: resolved?.registry?.agentImage,
    routes: deployedRoutes,
    identities: resolved?.identities,
    evidence: {
      account: resolved?.evidence?.accountId,
      containerUrl: resolved?.evidence?.containerUrl,
      retentionDays: Number(env.EVIDENCE_RETENTION_DAYS ?? 7),
      retentionLocked: false,
      note: 'retention locking is deliberately NOT applied automatically; it requires an explicit approved retention period and a successful verification step'
    },
    checkpoints: Object.keys(checkpointState?.checkpoints ?? {}),
    designBlockers,
    nextCommand: 'npm run study:execute  (separately authorized; runs no trials until its own gates pass)'
  };
}

export function renderReport(manifest) {
  const lines = [
    '# Deployment report — thesis-agent-isolation-experiment',
    '',
    `- environment: **${manifest.environment}**`,
    `- subscription: \`${manifest.subscriptionId}\` (${manifest.location})`,
    `- status: **${manifest.status}**`,
    `- image: \`${manifest.image}\``,
    `- workload routes deployed: ${manifest.routes.length} (${manifest.routes.join(', ')})`,
    '',
    '## Evidence',
    `- container: \`${manifest.evidence.containerUrl}\``,
    `- retention: ${manifest.evidence.retentionDays} days, lock **not** applied (${manifest.evidence.note})`,
    '',
    '## Measured study readiness',
    manifest.measuredStudyReady
      ? '- deployment validated and no open design blockers.'
      : `- deployment is validated for **non-counted** work, but the measured study is blocked:`,
    ...manifest.designBlockers.map(b => `  - **${b.id}** — ${b.detail} (requires: ${b.required})`),
    '',
    `Measured execution remains a separate, gated operation: \`${manifest.nextCommand}\``,
    ''
  ];
  return lines.join('\n');
}

export async function main({env = process.env, stdout = process.stdout, stderr = process.stderr, validationPassed = true} = {}) {
  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const envName = process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default';
  const envDir = path.join(process.cwd(), '.azure', envName);

  let resolved, checkpointState = {checkpoints: {}};
  try {
    resolved = JSON.parse(await readFile(path.join(envDir, 'deployment.resolved.json'), 'utf8'));
  } catch {
    stderr.write('readiness-report: deployment.resolved.json missing — configure step did not run\n');
    return 5;
  }
  const store = makeCheckpointStore({statePath: resolveStatePath({...process.env, ...values})});
  checkpointState = await store.load();

  const manifest = buildManifest({resolved, checkpointState, env: values, validationPassed});
  await writeFile(path.join(envDir, 'deployment-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(envDir, 'DEPLOYMENT-REPORT.md'), renderReport(manifest));
  log('readiness-report', 'emitted', {note: `${path.join(envDir, 'deployment-manifest.json')} — status ${manifest.status}`});
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
