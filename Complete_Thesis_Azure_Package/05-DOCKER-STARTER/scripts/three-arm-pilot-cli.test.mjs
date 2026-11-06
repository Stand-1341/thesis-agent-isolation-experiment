import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadFrozenSchedule} from './trial-schedule.mjs';
import {validateFrozenPilotProtocol} from './preflight-three-architecture.mjs';

const CLI=fileURLToPath(new URL('./run-experiment-cli.mjs',import.meta.url));
const DEPS=fileURLToPath(new URL('./deps-live.mjs',import.meta.url));
const CONFIG=fileURLToPath(new URL('../config/experiment.azure-three-arm.example.json',import.meta.url));
const PROTOCOL=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2-pilot-v1.json',import.meta.url));
const MATRIX=fileURLToPath(new URL('../config/plan-450-three-arm-supported-v2-pilot-v1.csv',import.meta.url));
const LOCK=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2-pilot-v1-freeze-lock.json',import.meta.url));

function cleanEnvironment() {
  const env={...process.env};
  for(const name of Object.keys(env)) if(name.startsWith('THESIS_')||name.startsWith('AZURE_')) delete env[name];
  return env;
}

function structuralDepsEnvironment() {
  const env=cleanEnvironment();
  const config=JSON.parse(readFileSync(CONFIG,'utf8'));
  for(const route of config.routes) for(const name of Object.values(route.credentials)) env[name]=`offline-placeholder-${name.toLowerCase()}`;
  Object.assign(env,{
    THESIS_TOKEN_PROVIDER_MODE:'managed_identity',
    THESIS_LOG_ANALYTICS_WORKSPACE_ID:'11111111-1111-4111-8111-111111111111',
    THESIS_FIXTURE_BLOB_ENDPOINT:'https://example.blob.core.windows.net/',
    THESIS_BLOB_RESOURCE_ID:'/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-example/providers/Microsoft.Storage/storageAccounts/example',
    THESIS_STORAGE_IDENTITY_CLIENT_ID:'11111111-1111-4111-8111-111111111112',
    THESIS_LOGS_IDENTITY_CLIENT_ID:'11111111-1111-4111-8111-111111111113',
    THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID:'11111111-1111-4111-8111-111111111114',
    THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID:'11111111-1111-4111-8111-111111111115',
    THESIS_DENIAL_DESTINATION_IP:'203.0.113.42',
    THESIS_VM_TARGET_RESOURCE_ID:'/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-example/providers/Microsoft.Compute/virtualMachines/example',
    THESIS_JOBS_P3_DENIAL_TELEMETRY:'none'
  });
  return env;
}

test('the separately frozen v2 pilot schedule covers P1 feasibility, P2/P3 controls, and every-arm U6/U8',()=>{
  const protocol=JSON.parse(readFileSync(PROTOCOL,'utf8'));
  const plan=protocol.pilotPlan;
  assert.equal(protocol.measuredExecutionEnabled,false);
  assert.equal(plan.countedAsStudyTrials,false);
  assert.equal(plan.derivedFrom,protocol.matrix.sha256);
  const schedule=loadFrozenSchedule(readFileSync(MATRIX),plan.sha256);
  assert.equal(schedule.rows.length,66);
  assert.ok(schedule.rows.every(row=>row.planned_run_id.startsWith('pilot-')));
  for(const deployment of ['azure_vm','azure_container_apps_jobs','azure_container_apps_sandboxes']) {
    for(const scenario of ['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'])
      assert.ok(schedule.rows.some(row=>row.deployment===deployment&&row.permission_profile==='P1'&&row.scenario_id===scenario));
    for(const profile of ['P2','P3']) for(const scenario of ['U5','U6','U7','U8','L1','L2'])
      assert.ok(schedule.rows.some(row=>row.deployment===deployment&&row.permission_profile===profile&&row.scenario_id===scenario));
  }
});

test('the pilot protocol and matrix match independent code-side pins and the separate lock',()=>{
  const protocolBytes=readFileSync(PROTOCOL);
  const protocol=JSON.parse(protocolBytes.toString('utf8'));
  const matrixBytes=readFileSync(MATRIX);
  const lock=JSON.parse(readFileSync(LOCK,'utf8'));
  const paths={protocolFile:PROTOCOL,matrixFile:protocol.pilotPlan.file,lockFile:LOCK};
  const valid=validateFrozenPilotProtocol({protocolBytes,matrixBytes,lock,paths});
  assert.equal(valid.summary.trials,66);
  assert.equal(valid.summary.unauthorized,48);
  assert.equal(valid.summary.legitimate,18);
  assert.throws(()=>validateFrozenPilotProtocol({protocolBytes:Buffer.concat([protocolBytes,Buffer.from(' ')]),matrixBytes,lock,paths}),/digest/i);
  const alteredMatrix=Buffer.from(matrixBytes);
  alteredMatrix[alteredMatrix.length-4]^=1;
  assert.throws(()=>validateFrozenPilotProtocol({protocolBytes,matrixBytes:alteredMatrix,lock,paths}),/digest/i);
});

test('generic CLI can structurally dry-run the v2 non-counted pilot schedule without executing rows',()=>{
  const result=spawnSync(process.execPath,[CLI,'--config',CONFIG,'--protocol',PROTOCOL,'--pilot','--dry-run','--json'],
    {encoding:'utf8',env:cleanEnvironment(),timeout:120000});
  assert.equal(result.status,4,`structural pilot dry-run stays blocked, stderr=${result.stderr}`);
  let report;
  assert.doesNotThrow(()=>{report=JSON.parse(result.stdout);},
    `expected a structural report, not missing pilot metadata; stdout=${result.stdout}; stderr=${result.stderr}`);
  assert.equal(report.dryRun,true);
  assert.equal(report.mode,'non_counted_pilot');
  assert.equal(report.studyCounted,false);
  assert.equal(report.readiness,'structural_only_not_ready');
  assert.equal(report.plannedMatrixRows,66);
  assert.equal(report.selectedRows,66);
  assert.equal(report.measurableRows,60);
  assert.equal(report.notApplicableRows,0);
  assert.equal(report.unsupportedRows,6,'P3 U5/U7 remain blocked on all arms without denial dependencies');
  assert.equal(report.routes.length,9);
  assert.equal(report.executed,undefined,'dry-run must not execute any pilot row');
  assert.match(report.note,/Structural preflight only/i);
});

test('offline dependency construction wires all nine routes and verifier without Azure calls',()=>{
  const result=spawnSync(process.execPath,[CLI,'--config',CONFIG,'--protocol',PROTOCOL,'--deps',DEPS,'--pilot','--dry-run','--json'],
    {encoding:'utf8',env:structuralDepsEnvironment(),timeout:120000});
  assert.equal(result.status,4,`offline construction remains structural-only, stderr=${result.stderr}`);
  const report=JSON.parse(result.stdout);
  assert.equal(report.runtimeDependencies.status,'constructed',JSON.stringify(report.runtimeDependencies));
  assert.equal(report.runtimeDependencies.routeCount,9);
  assert.equal(report.runtimeDependencies.verifierConstructed,true);
  assert.deepEqual(report.runtimeDependencies.resourceVerifierGaps,{});
  assert.equal(report.runtimeDependencies.networkVerifierSupported,false);
  assert.match(report.runtimeDependencies.networkVerifierReason,/azure_container_apps_jobs:independent_network_denial_evidence_unavailable/);
  assert.doesNotMatch(report.runtimeDependencies.networkVerifierReason,/azure_vm:|azure_container_apps_sandboxes:|receiver_effect_monitor_not_configured/);
  assert.equal(report.measurableRows,64);
  assert.equal(report.notApplicableRows,0);
  assert.equal(report.unsupportedRows,2);
  assert.deepEqual(report.sessionCapabilities,{
    azure_vm:true,azure_container_apps_jobs:true,azure_container_apps_sandboxes:true
  });
  assert.match(report.note,/Structural preflight only/i);
});
