import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  preflightThreeArchitecture,
  validateSelectedProtocol,
  freezeLockPathFor,
  NETWORK_DENIAL_CAPABILITY,
  SUPERSEDED_DEPLOYMENTS,
  THREE_ARM_ROUTES
} from './preflight-three-architecture.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const legacyProtocol=JSON.parse(readFileSync(resolve(root,'config/protocol-450-three-architecture-planning.json')));
const legacyPlanBytes=readFileSync(resolve(root,'../03-PLANNED-TRIAL-MATRIX-450.csv'));
const candidateProtocolBytes=readFileSync(resolve(root,'config/protocol-450-three-arm-supported-v2.json'));
const candidateMatrixBytes=readFileSync(resolve(root,'config/plan-450-three-arm-supported-v2.csv'));
const candidateFreezeLock=JSON.parse(readFileSync(resolve(root,'config/protocol-450-three-arm-supported-v2-freeze-lock.json')));
const v1ProtocolBytes=readFileSync(resolve(root,'config/protocol-360-three-arm-supported-v1.json'));
const v1MatrixBytes=readFileSync(resolve(root,'config/plan-360-three-arm-supported-v1.csv'));
const v1FreezeLock=JSON.parse(readFileSync(resolve(root,'config/protocol-360-three-arm-supported-v1-freeze-lock.json')));
const exampleConfig=JSON.parse(readFileSync(resolve(root,'config/experiment.azure-three-arm.example.json')));
const liveConfig=JSON.parse(readFileSync(resolve(root,'config/experiment.azure-live.json')));

const candidatePaths={protocolFile:'config/protocol-450-three-arm-supported-v2.json',
  matrixFile:'config/plan-450-three-arm-supported-v2.csv',
  lockFile:'config/protocol-450-three-arm-supported-v2-freeze-lock.json'};

/** Deterministic, structure-only fixtures: GUIDs, names and URIs, never secrets. */
const guid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const uai=n=>`/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-preflight/providers/Microsoft.ManagedIdentity/userassignedidentities/ua-${n}`;
const pinnedImage='registry.example.invalid/thesis-agent@sha256:'+'a'.repeat(64);
const sharedUrls={resourceUrl:'https://resource.example.invalid',collectorUrl:'https://collector.example.invalid',
  restrictedUrl:'https://restricted.example.invalid',sessionDataStore:'azure_blob_external_namespace'};

function threeArmConfig() {
  let next=0;
  const route=(deployment,profile,credentials)=>{next+=1;
    return {deployment,profile,principalObjectId:guid(next),
      workloadClientId:guid(100+next),secretReaderClientId:guid(200+next),
      workloadIdentityResourceId:uai(100+next),secretReaderIdentityResourceId:uai(200+next),
      workloadTokenSecretUri:`https://kv-preflight.vault.azure.net/secrets/token-${next}`,credentials};};
  const httpCreds={controller:`THESIS_VM_CONTROLLER_KEY`,resourceAdmin:'THESIS_RESOURCE_ADMIN_KEY',collectorAdmin:'THESIS_COLLECTOR_ADMIN_KEY'};
  const jobCreds={resourceAdmin:'THESIS_RESOURCE_ADMIN_KEY',collectorAdmin:'THESIS_COLLECTOR_ADMIN_KEY'};
  const byProfile=(prefix,profiles)=>Object.fromEntries(profiles.map(profile=>[profile,`${prefix}-${profile.toLowerCase()}`]));
  return {
    evidenceDirectory:'results/evidence',auditWindowSeconds:3600,
    deployments:{
      azure_vm:{kind:'http',agentUrl:'https://vm-agent.example.invalid',...sharedUrls},
      azure_container_apps_jobs:{kind:'aca_job',subscriptionId:'22222222-2222-4222-8222-222222222222',
        resourceGroup:'rg-preflight',workloadProfileName:'Consumption',jobNames:byProfile('job',['P1','P2','P3']),
        agentImage:pinnedImage,imagePullIdentityResourceId:uai(900),resources:{cpu:0.5,memory:'1Gi'},
        apiVersion:'2026-07-01',executionTimeoutMs:120000,logWaitMs:600000,...sharedUrls},
      azure_container_apps_sandboxes:{kind:'aca_sandbox',subscriptionId:'22222222-2222-4222-8222-222222222222',
        resourceGroup:'rg-preflight',region:'eastus',sandboxGroups:byProfile('group',['P1','P2','P3']),
        diskImageIds:byProfile('disk',['P1','P2','P3']),agentImage:pinnedImage,imagePullIdentityResourceId:uai(901),
        resources:{cpu:'1vCPU',memory:'1Gi',disk:'1Gi'},apiVersion:'2026-02-01-preview',timeoutMs:300000,...sharedUrls}
    },
    routes:[
      route('azure_vm','P1',httpCreds),route('azure_vm','P2',httpCreds),route('azure_vm','P3',httpCreds),
      route('azure_container_apps_jobs','P1',jobCreds),route('azure_container_apps_jobs','P2',jobCreds),route('azure_container_apps_jobs','P3',jobCreds),
      route('azure_container_apps_sandboxes','P1',jobCreds),route('azure_container_apps_sandboxes','P2',jobCreds),route('azure_container_apps_sandboxes','P3',jobCreds)
    ]
  };
}

function preflightFixtures(overrides={}) {
  return {legacyPlanBytes,legacyProtocol,
    candidateProtocolBytes,candidateMatrixBytes,freezeLock:candidateFreezeLock,
    config:exampleConfig,paths:candidatePaths,...overrides};
}

const expectedGates=['per_arm_non_counted_pilots','u6_u8_session_fixture_validation',
  'target_scoped_positive_control_and_noop_baseline','receiver_effect_rule',
  'verifier_and_scope_wiring','measured_mode_operator_assertions',
  'live_identity_and_quota_unknown','owner_measured_freeze'];

test('legacy 450 planning plan is preserved and inspected with its own legacy protocol',()=>{
  const report=preflightThreeArchitecture(preflightFixtures());
  const frozen=report.frozenLegacyPlan;
  assert.equal(frozen.status,'planning_not_validated');
  assert.equal(frozen.measuredExecutionEnabled,false);
  assert.equal(frozen.rows,450);
  assert.equal(frozen.blocks,5);
  assert.ok(frozen.architecture.includes('superseded'));
  assert.ok(frozen.disposition.includes('do not mutate'));
  assert.equal(frozen.inspectedWith.protocol,'config/protocol-450-three-architecture-planning.json');
  assert.equal(frozen.inspectedWith.matrix,'03-PLANNED-TRIAL-MATRIX-450.csv');
  // the inspected digest is the legacy protocol's own declared digest, unchanged on disk
  assert.equal(frozen.sha256,legacyProtocol.matrixSha256);
  // tampering with the legacy protocol's planning-only status still refuses
  assert.throws(()=>preflightThreeArchitecture(preflightFixtures(
    {legacyProtocol:{...legacyProtocol,measuredExecutionEnabled:true}})),/planning only/);
});

test('candidate v2 protocol is selected, lock-pinned and shape-validated',()=>{
  const report=preflightThreeArchitecture(preflightFixtures());
  const selected=report.selectedProtocol;
  assert.equal(selected.revision,'three-arm-supported-450-v2');
  assert.equal(selected.status,'frozen_structural_launch_gated');
  assert.deepEqual(selected.deployments,['azure_vm','azure_container_apps_jobs','azure_container_apps_sandboxes']);
  assert.equal(selected.measuredExecutionEnabled,false);
  assert.equal(selected.freezeLock.file,candidatePaths.lockFile);
  assert.equal(selected.freezeLock.protocolSha256Verified,true);
  assert.equal(selected.freezeLock.matrixSha256Verified,true);
  assert.equal(selected.matrix.trials,450);
  assert.equal(selected.matrix.blocks,5);
  assert.equal(selected.matrix.rowsPerBlock,90);
  assert.equal(selected.matrix.unauthorized,360);
  assert.equal(selected.matrix.legitimate,90);
  assert.ok(selected.validation.includes('not live validation'));
  // structural verification is reported separately from live gates
  assert.equal(report.structuralVerification.freezeLockDigestsVerified,true);
  assert.equal(report.structuralVerification.candidateShapeVerified,true);
  assert.equal(report.structuralVerification.legacyPlanPlanningOnly,true);
  assert.equal(report.structuralVerification.offlineEvidenceOnly,true);
});

test('digest refusal: any byte change to the frozen candidate pair is rejected',()=>{
  const tamperedMatrix=Buffer.from(candidateMatrixBytes);
  tamperedMatrix[0]^=1;
  assert.throws(()=>validateSelectedProtocol({protocolBytes:candidateProtocolBytes,
    matrixBytes:tamperedMatrix,lock:candidateFreezeLock,paths:candidatePaths}),/matrix digest/);
  const tamperedProtocol=Buffer.from(candidateProtocolBytes);
  tamperedProtocol[Math.floor(tamperedProtocol.length/2)]^=1;
  assert.throws(()=>validateSelectedProtocol({protocolBytes:tamperedProtocol,
    matrixBytes:candidateMatrixBytes,lock:candidateFreezeLock,paths:candidatePaths}),/protocol digest/);
  assert.throws(()=>preflightThreeArchitecture(preflightFixtures({candidateMatrixBytes:tamperedMatrix})),/matrix digest/);
});

test('candidate cannot authenticate a re-pinned but altered protocol/matrix pair',()=>{
  const alteredMatrixText=candidateMatrixBytes.toString('utf8')
    .replace('tas450-b01-01-azure_vm-P1-U1','tas450-b01-01-azure_vm-P1-U1x');
  const alteredMatrixBytes=Buffer.from(alteredMatrixText);
  assert.notEqual(alteredMatrixBytes.length,candidateMatrixBytes.length);
  const alteredProtocol=JSON.parse(candidateProtocolBytes.toString('utf8'));
  alteredProtocol.matrix.sha256=createHash('sha256').update(alteredMatrixBytes).digest('hex');
  const alteredProtocolBytes=Buffer.from(JSON.stringify(alteredProtocol));
  const alteredLock={...candidateFreezeLock,
    protocolSha256:createHash('sha256').update(alteredProtocolBytes).digest('hex'),
    matrixSha256:createHash('sha256').update(alteredMatrixBytes).digest('hex')};
  assert.throws(()=>validateSelectedProtocol({protocolBytes:alteredProtocolBytes,
    matrixBytes:alteredMatrixBytes,lock:alteredLock,paths:candidatePaths}),/approved candidate/);
});

test('a self-consistent pair that enables measured execution is still refused',()=>{
  // Rewrite the protocol with measuredExecutionEnabled:true, then re-pin BOTH
  // digests in a matching lock: digest checks alone must not be enough.
  const enabled=JSON.parse(candidateProtocolBytes.toString('utf8'));
  enabled.measuredExecutionEnabled=true;
  const enabledBytes=Buffer.from(JSON.stringify(enabled));
  const consistentLock={...candidateFreezeLock,
    protocolSha256:createHash('sha256').update(enabledBytes).digest('hex'),
    measuredExecutionEnabled:true};
  assert.throws(()=>validateSelectedProtocol({protocolBytes:enabledBytes,
    matrixBytes:candidateMatrixBytes,lock:consistentLock,paths:candidatePaths}),/measured execution/);
  // lock and protocol must also agree with each other when only one flips
  assert.throws(()=>validateSelectedProtocol({protocolBytes:candidateProtocolBytes,
    matrixBytes:candidateMatrixBytes,lock:{...candidateFreezeLock,measuredExecutionEnabled:true}}),/measured execution/);
});

test('a freeze lock naming different files cannot authenticate a candidate',()=>{
  // v2 protocol paired with the v1 lock: wrong pairing must be named, not just fail a digest
  assert.throws(()=>validateSelectedProtocol({protocolBytes:candidateProtocolBytes,
    matrixBytes:candidateMatrixBytes,lock:v1FreezeLock,paths:candidatePaths}),/freeze lock/);
  // protocol and lock disagreeing about the declared matrix digest is a hard failure
  assert.throws(()=>validateSelectedProtocol({protocolBytes:candidateProtocolBytes,
    matrixBytes:candidateMatrixBytes,lock:{...candidateFreezeLock,matrixSha256:'0'.repeat(64)},paths:candidatePaths}),/matrix digest/);
  // a candidate that does not select the three arms is not a three-arm candidate
  const wrongArms=JSON.parse(candidateProtocolBytes.toString('utf8'));
  wrongArms.deployments=['azure_vm','azure_functions_flex','azure_custom_sessions_hyperv'];
  assert.throws(()=>validateSelectedProtocol({protocolBytes:Buffer.from(JSON.stringify(wrongArms)),
    matrixBytes:candidateMatrixBytes,lock:candidateFreezeLock,paths:candidatePaths}),/three supported deployments/);
  // a candidate whose matrix disagrees with its declared shape is rejected
  const truncated=Buffer.concat([Buffer.from(candidateMatrixBytes.subarray(0,candidateMatrixBytes.lastIndexOf('\r\n',candidateMatrixBytes.length-2)+1))]);
  assert.notEqual(truncated.length,candidateMatrixBytes.length);
  const smallLock={...candidateFreezeLock,
    matrixSha256:createHash('sha256').update(truncated).digest('hex')};
  assert.throws(()=>validateSelectedProtocol({protocolBytes:candidateProtocolBytes,
    matrixBytes:truncated,lock:smallLock,paths:candidatePaths}),/shape/);
});

test('U6/U8 scheduled rows are gated, not N/A, when the config declares the session store',()=>{
  const report=preflightThreeArchitecture(preflightFixtures());
  const scope=report.scheduleScope;
  assert.equal(scope.rows,450);
  assert.equal(scope.notApplicable,0);
  assert.equal(scope.unsupported,10);
  assert.equal(scope.measurable,440);
  assert.deepEqual(scope.notApplicableByScenario,{});
  assert.deepEqual(scope.sessionCapabilityByArm,{azure_vm:true,azure_container_apps_jobs:true,azure_container_apps_sandboxes:true});
  assert.equal(scope.gatedRows.u6U8SessionFixture.rows,90);
  assert.ok(scope.gatedRows.u6U8SessionFixture.status.includes('fixture-validation pilot'));
  assert.equal(scope.gatedRows.p3NetworkDenial.rows,30);
  // the schedule-scope note must not relabel gated rows as not applicable
  assert.ok(!scope.note.includes('U6/U8 not applicable'));
});

test('without the session-store declaration U6/U8 are not applicable as a config gap',()=>{
  const config=threeArmConfig();
  for(const deployment of Object.values(config.deployments)) delete deployment.sessionDataStore;
  const report=preflightThreeArchitecture(preflightFixtures({config}));
  const scope=report.scheduleScope;
  assert.equal(scope.notApplicable,90);
  assert.deepEqual(scope.notApplicableByScenario,{U6:45,U8:45});
  assert.equal(scope.measurable,350);
  assert.deepEqual(scope.sessionCapabilityByArm,{});
  assert.ok(report.blockers.some(blocker=>blocker.includes('azure_blob_external_namespace')));
});

test('Jobs P3 stays capability-blocked; VM and Sandbox denial capabilities stay distinct',()=>{
  assert.equal(NETWORK_DENIAL_CAPABILITY.azure_container_apps_jobs.established,false);
  assert.equal(NETWORK_DENIAL_CAPABILITY.azure_container_apps_jobs.codePresent,true,
    'the Jobs reader is local code even though its target-specific capability is not configured');
  assert.equal(NETWORK_DENIAL_CAPABILITY.azure_container_apps_jobs.pilotValidated,false);
  assert.equal(NETWORK_DENIAL_CAPABILITY.azure_vm.established,true);
  assert.equal(NETWORK_DENIAL_CAPABILITY.azure_container_apps_sandboxes.established,true);
  const evidence=Object.values(NETWORK_DENIAL_CAPABILITY).map(item=>item.evidence);
  assert.equal(new Set(evidence).size,3,'each arm states its own distinct evidence');
  const report=preflightThreeArchitecture(preflightFixtures());
  assert.deepEqual(report.scheduleScope.unsupportedByRoute,
    {'azure_container_apps_jobs:P3:independent_network_denial_evidence_unavailable':10});
  assert.ok(report.blockers.some(blocker=>blocker.includes('azure_container_apps_jobs:P3')));
});

test('hard refusal while gates are open: the report can never enable launch',()=>{
  const report=preflightThreeArchitecture(preflightFixtures());
  assert.equal(report.ready,false);
  assert.equal(report.launchEnabled,false);
  assert.deepEqual(report.pendingGates.map(gate=>gate.gate),expectedGates);
  const kinds=report.pendingGates.map(gate=>gate.kind).sort();
  assert.deepEqual(kinds,['owner_assertion','owner_assertion','pilot_required','pilot_required',
    'pilot_required','pilot_required','pilot_required','subscription_unknown']);
  // Offline wiring evidence cannot close the remaining live pilot gates; stale blanket blockers stay absent.
  assert.ok(!report.pendingGates.some(gate=>gate.gate==='three_arm_protocol_revision'));
  assert.ok(!report.pendingGates.some(gate=>gate.gate==='runtime_wiring_new_arms'));
  assert.ok(!JSON.stringify(report.pendingGates).match(/No protocol file selects|no integrated ACA Jobs\/Sandbox run adapter/i));
  assert.match(report.pendingGates.find(gate=>gate.gate==='verifier_and_scope_wiring').detail,/offline dependency-construction dry run builds all nine selected routes/);
  assert.equal(report.structuralVerification.localAdapterCodePresent,true);
  assert.equal(report.structuralVerification.genericRunnerConsumesCandidate,true);
  assert.equal(report.structuralVerification.measuredPathDependencyConstructionVerified,true);
  assert.equal(report.structuralVerification.receiverEffectMonitorWiredInCoverage,true);
  assert.equal(report.networkDenialCapability.azure_container_apps_jobs.codePresent,true);
  for(const blocker of ['Gate pending (pilot_required)','Gate pending (owner_assertion)',
    'Gate pending (subscription_unknown)','cannot establish live Azure resources'])
    assert.ok(report.blockers.some(item=>item.includes(blocker)),`missing blocker class: ${blocker}`);
  assert.ok(report.pendingGates.some(gate=>gate.detail.includes('THESIS_NETWORK_NOOP_BASELINE_VALIDATED')));
  assert.equal(report.structuralVerification.offlineEvidenceOnly,true);
});

test('superseded-architecture and duplicate routes remain config blockers',()=>{
  const base=threeArmConfig();
  const config={...base,routes:[...base.routes,
    base.routes[0],
    {deployment:'azure_functions_flex',profile:'P1',agentUrl:'https://flex.example.invalid/api',
      principalObjectId:guid(50),credentials:{controller:'THESIS_FN_CONTROLLER_KEY',resourceAdmin:'THESIS_RESOURCE_ADMIN_KEY',collectorAdmin:'THESIS_COLLECTOR_ADMIN_KEY'}}]};
  const report=preflightThreeArchitecture(preflightFixtures({config}));
  assert.deepEqual(report.configAssessment.duplicateRoutes,['azure_vm:P1']);
  assert.deepEqual(report.configAssessment.oldArchitectureRoutes,['azure_functions_flex:P1']);
  assert.ok(SUPERSEDED_DEPLOYMENTS.includes('azure_functions_flex'));
  assert.equal(report.launchEnabled,false);
  assert.ok(report.blockers.some(blocker=>blocker.includes('duplicate routes')));
  // an old-architecture live config is assessed, never silently accepted
  const legacyReport=preflightThreeArchitecture(preflightFixtures({config:liveConfig}));
  assert.deepEqual(legacyReport.configAssessment.missingRoutes,THREE_ARM_ROUTES.filter(key=>key.startsWith('azure_container_apps_')));
  assert.equal(legacyReport.configAssessment.configValidation.status,'invalid_or_unsupported');
});

test('the superseded 360-v1 revision still validates structurally as a candidate',()=>{
  const validated=validateSelectedProtocol({protocolBytes:v1ProtocolBytes,matrixBytes:v1MatrixBytes,
    lock:v1FreezeLock,paths:{protocolFile:'config/protocol-360-three-arm-supported-v1.json',
      matrixFile:'config/plan-360-three-arm-supported-v1.csv',
      lockFile:'config/protocol-360-three-arm-supported-v1-freeze-lock.json'}});
  assert.equal(validated.summary.trials,360);
  assert.equal(validated.summary.rowsPerBlock,72);
  assert.equal(validated.summary.unauthorized,270);
  assert.equal(validated.summary.legitimate,90);
  const report=preflightThreeArchitecture({legacyPlanBytes,legacyProtocol,
    candidateProtocolBytes:v1ProtocolBytes,candidateMatrixBytes:v1MatrixBytes,freezeLock:v1FreezeLock,
    config:exampleConfig,paths:{protocolFile:'config/protocol-360-three-arm-supported-v1.json',
      matrixFile:'config/plan-360-three-arm-supported-v1.csv',
      lockFile:'config/protocol-360-three-arm-supported-v1-freeze-lock.json'}});
  assert.equal(report.scheduleScope.rows,360);
  assert.equal(report.scheduleScope.notApplicable,0,'v1 withdraws U6/U8 from the schedule itself; no N/A rows exist');
  assert.equal(report.scheduleScope.unsupported,10);
  assert.equal(report.selectedProtocol.matrix.trials,360);
});

test('freezeLockPathFor derives the conventional lock path beside the protocol',()=>{
  assert.equal(freezeLockPathFor('config/protocol-450-three-arm-supported-v2.json'),
    'config/protocol-450-three-arm-supported-v2-freeze-lock.json');
  assert.equal(basename(freezeLockPathFor('/tmp/x/protocol-450-three-arm-supported-v2.json')),
    'protocol-450-three-arm-supported-v2-freeze-lock.json');
});

test('real CLI: a valid candidate exits 4 with the JSON readiness report',()=>{
  const run=spawnSync(process.execPath,
    ['scripts/preflight-three-architecture.mjs','--config','config/experiment.azure-three-arm.example.json',
     '--protocol','config/protocol-450-three-arm-supported-v2.json'],
    {cwd:root,encoding:'utf8'});
  assert.equal(run.status,4,`stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  const report=JSON.parse(run.stdout);
  assert.equal(report.schema,'three_architecture_preflight_v3');
  assert.equal(report.launchEnabled,false);
  assert.equal(report.ready,false);
  assert.equal(report.selectedProtocol.revision,'three-arm-supported-450-v2');
  assert.equal(report.selectedProtocol.freezeLock.protocolSha256Verified,true);
  assert.equal(report.scheduleScope.rows,450);
  assert.equal(report.scheduleScope.notApplicable,0);
  assert.equal(report.scheduleScope.unsupported,10);
  assert.equal(report.scheduleScope.measurable,440);
  assert.equal(report.frozenLegacyPlan.rows,450);
  assert.deepEqual(report.pendingGates.map(gate=>gate.gate),expectedGates);
  assert.ok(!run.stdout.includes('CONTROLLER_KEY')&&!run.stdout.includes('vault.azure.net/secrets'));
});

test('real CLI: a tampered candidate exits 3 and a missing lock is a hard failure',()=>{
  const dir=mkdtempSync(join(tmpdir(),'preflight-candidate-'));
  try {
    const protocolPath=join(dir,'protocol-450-three-arm-supported-v2.json');
    const tampered=candidateProtocolBytes.toString('utf8').replace('"revision": "three-arm-supported-450-v2"','"revision": "three-arm-supported-450-v2 "');
    writeFileSync(protocolPath,tampered);
    writeFileSync(freezeLockPathFor(protocolPath),JSON.stringify(candidateFreezeLock));
    const digestRun=spawnSync(process.execPath,
      ['scripts/preflight-three-architecture.mjs','--config','config/experiment.azure-three-arm.example.json',
       '--protocol',protocolPath],
      {cwd:root,encoding:'utf8'});
    assert.equal(digestRun.status,3);
    assert.match(digestRun.stderr,/Preflight failed:.*protocol digest/);
    // protocol copy present but its freeze lock absent
    const loneDir=mkdtempSync(join(tmpdir(),'preflight-lone-'));
    try {
      writeFileSync(join(loneDir,'protocol-450-three-arm-supported-v2.json'),candidateProtocolBytes);
      const lockRun=spawnSync(process.execPath,
        ['scripts/preflight-three-architecture.mjs','--config','config/experiment.azure-three-arm.example.json',
         '--protocol',join(loneDir,'protocol-450-three-arm-supported-v2.json')],
        {cwd:root,encoding:'utf8'});
      assert.equal(lockRun.status,3);
      assert.match(lockRun.stderr,/Preflight failed:/);
    } finally { rmSync(loneDir,{recursive:true,force:true}); }
    // usage: --protocol is now required, the candidate is the selected protocol
    const usageRun=spawnSync(process.execPath,
      ['scripts/preflight-three-architecture.mjs','--config','config/experiment.azure-three-arm.example.json'],
      {cwd:root,encoding:'utf8'});
    assert.equal(usageRun.status,3);
    assert.match(usageRun.stderr,/usage:/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
