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
import {readAzdEnv, makeStepLogger, makeCheckpointStore, resolveStatePath, makeAzRunner} from './common.mjs';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isValidationReportValid, readValidationPilotRecords, matchPilotPermissionEvidence, defaultPilotIndexPath} from './validate-deployment.mjs';
import {readEvidenceRetentionStatus} from './evidence-retention.mjs';
import {validateThreeArmPilotEvidence} from './study-execute.mjs';

/**
 * Research-design blockers surfaced in the report — deployment cannot resolve
 * these; they gate the measured study, not `azd up`.
 */
export const DESIGN_BLOCKERS = [
  {
    id: 'p3-network-denial-telemetry',
    detail: 'Ten Functions Flex P3 trials remain unsupported: independently attributable network-denial telemetry is unproven.',
    required: 'cloud pilot demonstrating per-trial denial attribution, or a protocol revision freezing a reduced scope'
  },
  {
    id: 'u6-u8-fixture-validation',
    detail: 'Ninety U6/U8 trials need fixture validation.',
    required: 'validated fixtures recorded in the pilot index'
  }
];

/** Clear design blockers only when the runner's intact evidence satisfies the full three-arm contract. */
export async function validateReadinessPilotEvidence({indexPath, resolved} = {}) {
  try {
    const selected=indexPath ?? defaultPilotIndexPath();
    const pilotIndex=JSON.parse(await readFile(selected,'utf8'));
    const routes=Object.entries(resolved?.workloads??{}).flatMap(([arm,profiles])=>
      Object.entries(profiles??{}).filter(([,route])=>route?.principalObjectId).map(([profile])=>`${arm}:${profile}`));
    if(!routes.length || routes.some(route=>!(pilotIndex.routesValidated??[]).some(validated=>String(validated).replace('/' , ':')===route)))
      throw new Error('pilot index does not validate every resolved route');
    await validateThreeArmPilotEvidence({pilotIndex,root:path.dirname(selected),routes,
      deployments:[...new Set(routes.map(route=>route.split(':')[0]))]});
    const loaded=await readValidationPilotRecords({indexPath:selected,root:path.dirname(selected)});
    if(loaded.error) throw new Error(loaded.error);
    const fixtureEndpoint=resolved?.fixtures?.blobEndpoint;
    for(const [arm,profiles] of Object.entries(resolved?.workloads??{})) for(const [profile,route] of Object.entries(profiles??{})) {
      if(!route?.principalObjectId) continue;
      const networkEndpoints={
        U5:resolved.network?.collectorPrivateIp?`https://${resolved.network.collectorPrivateIp}:8443/`:undefined,
        U7:resolved.network?.restrictedServicePrivateIp?`https://${resolved.network.restrictedServicePrivateIp}:9443/`:undefined
      };
      const proof=matchPilotPermissionEvidence({identity:{deployment:arm,profile,principalObjectId:route.principalObjectId,
        clientId:route.clientId,resourceId:route.resourceId??route.sandboxGroupId,networkEndpoints},records:loaded.records,fixtureEndpoint});
      if(!proof.ok) throw new Error(`${arm}/${profile}: ${proof.error}`);
    }
    return {ok:true};
  } catch(error) {
    return {ok:false,error:String(error?.message??error).slice(0,240)};
  }
}

export function buildManifest({resolved, resolvedBytes, validationReport, checkpointState, env, retentionStatus, designBlockers = DESIGN_BLOCKERS, runtimeState = {}} = {}) {
  const validationPassed = isValidationReportValid({report: validationReport, resolvedBytes});
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
    validation: validationPassed ? {
      status: validationReport.status,
      validatedAt: validationReport.validatedAt,
      resolvedSha256: validationReport.resolvedSha256,
      checks: validationReport.checks,
      evidence: validationReport.evidence,
      pendingPilotEvidence: validationReport.pendingPilotEvidence ?? []
    } : {status: validationReport?.status ?? 'missing'},
    runtime: {
      functionsPublication: runtimeState.functions ?? {status: 'missing'},
      sandboxBootstrap: runtimeState.sandboxes ?? {status: 'missing'},
      researchHost: runtimeState.researchHost ?? {status: 'missing'}
    },
    measuredStudyReady: validationPassed && retentionStatus?.locked === true && designBlockers.length === 0,
    image: resolved?.registry?.agentImage,
    routes: deployedRoutes,
    identities: resolved?.identities,
    evidence: {
      account: resolved?.evidence?.accountId,
      containerUrl: resolved?.evidence?.containerUrl,
      retentionDays: Number(env.EVIDENCE_RETENTION_DAYS ?? 7),
      retentionLocked: retentionStatus?.locked === true,
      retentionPolicy: retentionStatus ?? {state:'unknown',locked:false,reason:'no read-only ARM policy check was performed'},
      note: retentionStatus?.locked === true
        ? `read-only ARM check confirms a locked ${retentionStatus.periodDays}-day container policy`
        : `read-only ARM check did not confirm a locked container policy (${retentionStatus?.state ?? 'unknown'}); measured execution remains blocked`
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
    `- retention: configured ${manifest.evidence.retentionDays} days; observed policy **${manifest.evidence.retentionPolicy.state}**${manifest.evidence.retentionPolicy.periodDays ? ` for ${manifest.evidence.retentionPolicy.periodDays} days` : ''} (${manifest.evidence.note})`,
    '',
    '## Measured study readiness',
    manifest.measuredStudyReady
      ? '- deployment validated and no open design blockers.'
      : `- measured execution is blocked until every readiness gate passes:`,
    ...(!manifest.evidence.retentionLocked ? [`  - **evidence-retention** — ${manifest.evidence.retentionPolicy.reason ?? 'container policy is not confirmed locked'}`] : []),
    ...manifest.designBlockers.map(b => `  - **${b.id}** — ${b.detail} (requires: ${b.required})`),
    ...((manifest.validation.pendingPilotEvidence ?? []).length ? [`  - **pilot-evidence** — pending for: ${manifest.validation.pendingPilotEvidence.join(', ')}`] : []),
    '',
    '## Runtime',
    `- Functions package: **${manifest.runtime.functionsPublication.status}**`,
    `- Sandbox disk images: **${manifest.runtime.sandboxBootstrap.status}**`,
    `- Research host: **${manifest.runtime.researchHost.status}**`,
    '',
    `Measured execution remains a separate, gated operation: \`${manifest.nextCommand}\``,
    ''
  ];
  return lines.join('\n');
}

async function readJsonIf(filePath) {
  try { return JSON.parse(await readFile(filePath,'utf8')); }
  catch { return undefined; }
}

export function summarizeFunctionsState(state) {
  if(!state||typeof state.packages!=='object') return {status:'missing'};
  const packages=Object.values(state.packages).filter(item=>item&&typeof item==='object');
  if(!packages.length) return {status:'missing'};
  const latest=packages.at(-1),routes=Object.values(latest.routes??{}).filter(route=>route?.verifiedAt);
  return {status:routes.length?'ready':'pending',packageSha256:latest.packageSha256,
    verifiedRoutes:routes.length,publishedAt:latest.routes?Object.values(latest.routes).map(route=>route.publishedAt).filter(Boolean).sort().at(-1):undefined};
}

export function summarizeSandboxState(state) {
  if(!state||typeof state.images!=='object') return {status:'missing'};
  const images=Object.values(state.images).filter(item=>item&&typeof item==='object');
  if(!images.length) return {status:'missing'};
  const ready=images.filter(item=>item.status==='ready'&&item.diskImageId);
  return {status:ready.length===images.length?'ready':'pending',readyImages:ready.length,totalImages:images.length,
    readyAt:ready.map(item=>item.readyAt).filter(Boolean).sort().at(-1)};
}

export function summarizeResearchHostState(state) {
  return state?.verifiedAt&&state?.hostResourceId
    ? {status:'ready',verifiedAt:state.verifiedAt,packageSha256:state.packageSha256}
    : {status:'pending'};
}

export async function main({env = process.env, stdout = process.stdout, stderr = process.stderr} = {}) {  const log = makeStepLogger({stream: stdout});
  const values = await readAzdEnv(env);
  const envName = process.env.AZURE_ENV_NAME ?? values.AZURE_ENV_NAME ?? 'default';
  const envDir = path.join(process.cwd(), '.azure', envName);

  let resolved, resolvedBytes, validationReport, checkpointState = {checkpoints: {}};
  try {
    resolvedBytes = await readFile(path.join(envDir, 'deployment.resolved.json'));
    resolved = JSON.parse(resolvedBytes.toString('utf8'));
  } catch {
    stderr.write('readiness-report: deployment.resolved.json missing — configure step did not run\n');
    return 5;
  }
  try { validationReport = JSON.parse(await readFile(path.join(envDir, 'deployment-validation.json'), 'utf8')); }
  catch { validationReport = undefined; }
  const store = makeCheckpointStore({statePath: resolveStatePath({...process.env, ...values})});
  checkpointState = await store.load();

  const retentionStatus=await readEvidenceRetentionStatus({az:makeAzRunner(),accountId:resolved.evidence?.accountId,
    containerUrl:resolved.evidence?.containerUrl,subscriptionId:resolved.subscriptionId ?? values.AZURE_SUBSCRIPTION_ID,
    requiredDays:Number(values.EVIDENCE_RETENTION_DAYS ?? 7)});
  const pilotIndexPath=process.env.PILOT_INDEX_FILE ?? values.PILOT_INDEX_FILE ?? defaultPilotIndexPath();
  const pilotReadiness=await validateReadinessPilotEvidence({indexPath:pilotIndexPath,resolved});
  const runtimeState={
    functions:summarizeFunctionsState(await readJsonIf(path.join(envDir,'functions-publish.json'))),
    sandboxes:summarizeSandboxState(await readJsonIf(path.join(envDir,'sandbox-bootstrap.json'))),
    researchHost:summarizeResearchHostState(await readJsonIf(path.join(envDir,'research-host-setup.json')))
  };
  const manifest = buildManifest({resolved, resolvedBytes, validationReport, checkpointState, env: values, retentionStatus,
    designBlockers:pilotReadiness.ok?[]:DESIGN_BLOCKERS,runtimeState});
  await writeFile(path.join(envDir, 'deployment-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(envDir, 'DEPLOYMENT-REPORT.md'), renderReport(manifest));
  log('readiness-report', 'emitted', {note: `${path.join(envDir, 'deployment-manifest.json')} — status ${manifest.status}`});
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
