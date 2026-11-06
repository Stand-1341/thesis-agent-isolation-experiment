/**
 * Additive frozen schedule revision for the supported three-arm Azure design
 * (azure_vm + azure_container_apps_jobs + azure_container_apps_sandboxes).
 *
 * This file owns three NEW artifacts and must never weaken an existing guard:
 *   config/protocol-360-three-arm-supported-v1.json          (protocol)
 *   config/plan-360-three-arm-supported-v1.csv               (row plan, exact bytes)
 *   config/protocol-360-three-arm-supported-v1-freeze-lock.json (declared digests)
 *
 * The revision is structurally frozen but launch-gated: no live identity,
 * deployment, pilot, quota or verifier claim may appear in it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SUPPORTED_DEPLOYMENTS} from './experiment-config.mjs';
import {classifyTrialScope} from './scenario-scope.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');   // 05-DOCKER-STARTER
const PACKAGE=resolve(ROOT,'..');                                    // Complete_Thesis_Azure_Package
const PROTOCOL_FILE='config/protocol-360-three-arm-supported-v1.json';
const MATRIX_FILE='config/plan-360-three-arm-supported-v1.csv';
const LOCK_FILE='config/protocol-360-three-arm-supported-v1-freeze-lock.json';

const ARMS=['azure_vm','azure_container_apps_jobs','azure_container_apps_sandboxes'];
const PROFILES=['P1','P2','P3'];
const SCHEDULED=['U1','U2','U3','U4','U5','U7','L1','L2'];
const EXCLUDED=['U6','U8'];
const BLOCKS=5;
const ROWS_PER_BLOCK=ARMS.length*PROFILES.length*SCHEDULED.length;  // 72
const EXPECTED_TRIALS=BLOCKS*ROWS_PER_BLOCK;                        // 360
const TYPE={U1:'unauthorized',U2:'unauthorized',U3:'unauthorized',U4:'unauthorized',
  U5:'unauthorized',U7:'unauthorized',L1:'legitimate',L2:'legitimate'};

const EXPECTED_RQ1='How do different cloud architectures affect the ability of a compromised AI agent to access unauthorized resources';
const EXPECTED_RQ2='How effectively traditional virtual machines, serverless environments, and microVM environments contain the same AI agent behavior';
const EXPECTED_RQ3='What is the most secure permissions config in order to secure AI agents in these different environments?';

const MATRIX_450_SHA='39bb833e0a3af2c7bcbd9c7460119cbac97c324cf07bda4ebcc3b10cfd532298';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function loadArtifacts(){
  const protocolBytes=readFileSync(resolve(ROOT,PROTOCOL_FILE));
  const matrixBytes=readFileSync(resolve(ROOT,MATRIX_FILE));
  const lockBytes=readFileSync(resolve(ROOT,LOCK_FILE));
  return {protocolBytes,matrixBytes,lockBytes,
    protocol:JSON.parse(protocolBytes.toString('utf8')),
    lock:JSON.parse(lockBytes.toString('utf8'))};
}

function parseMatrix(bytes){
  const text=bytes.toString('utf8');
  assert.ok(text.endsWith('\r\n'),'matrix must end with CRLF');
  assert.equal(text.split('\r\n').length-1,1+EXPECTED_TRIALS,'header + 360 CRLF lines');
  const lines=text.split('\r\n');
  assert.equal(lines[0],
    'planned_run_id,block,order_in_block,deployment,permission_profile,scenario_id,scenario_type,status,result,verified_evidence_ref');
  const rows=lines.slice(1,-1).map(line=>{
    const fields=line.split(',');
    assert.equal(fields.length,10,`row must have 10 fields: ${line}`);
    return {planned_run_id:fields[0],block:Number(fields[1]),order_in_block:Number(fields[2]),
      deployment:fields[3],permission_profile:fields[4],scenario_id:fields[5],
      scenario_type:fields[6],status:fields[7],result:fields[8],verified_evidence_ref:fields[9]};
  });
  return rows;
}

function verifyFrozen({protocolBytes,matrixBytes,lock}){
  const protocolDigest=sha256(protocolBytes),matrixDigest=sha256(matrixBytes);
  if(lock.protocolSha256!==protocolDigest)
    throw new Error(`freeze lock protocol digest mismatch: declared ${lock.protocolSha256}, actual ${protocolDigest}`);
  if(lock.matrixSha256!==matrixDigest)
    throw new Error(`freeze lock matrix digest mismatch: declared ${lock.matrixSha256}, actual ${matrixDigest}`);
  return {protocolDigest,matrixDigest};
}

test('protocol selects exactly the supported three arms and stays launch-gated',()=>{
  const {protocol}=loadArtifacts();
  assert.deepEqual(protocol.deployments,ARMS,'arms are exactly VM, ACA Jobs, ACA Sandboxes');
  assert.deepEqual(protocol.profiles,PROFILES);
  for(const arm of ARMS){
    assert.ok(SUPPORTED_DEPLOYMENTS.includes(arm),`${arm} must be a config-layer deployment name`);
    assert.equal(protocol.deploymentKinds[arm],
      arm==='azure_vm'?'http':arm==='azure_container_apps_jobs'?'aca_job':'aca_sandbox');
  }
  assert.equal(protocol.measuredExecutionEnabled,false);
  assert.equal(protocol.status,'frozen_structural_launch_gated');
  const readiness=protocol.readiness;
  assert.equal(readiness.deploymentValidation,'not_validated');
  assert.equal(readiness.isolationValidation,'not_validated');
  assert.equal(readiness.independentVerifierValidation,'not_validated');
  assert.equal(readiness.liveIdentityInventory,'unavailable');
  assert.equal(readiness.noOpNetworkBaseline,'not_run');
  assert.equal(readiness.measuredExecutionEnabled,false);
});

test('research questions stay verbatim from the thesis, anchored two ways',()=>{
  const {protocol}=loadArtifacts();
  const doc=readFileSync(resolve(ROOT,'docs/AZURE-SUPPORTED-THREE-ARM-ARCHITECTURE.md'),'utf8');
  const extract=n=>{
    const match=doc.match(new RegExp(`- \\*\\*RQ${n}:\\*\\* \u201c([^\u201d]+)\u201d`));
    assert.ok(match,`architecture doc must quote RQ${n}`);
    return match[1];
  };
  assert.equal(protocol.researchQuestions.RQ1,EXPECTED_RQ1);
  assert.equal(protocol.researchQuestions.RQ2,EXPECTED_RQ2);
  assert.equal(protocol.researchQuestions.RQ3,EXPECTED_RQ3);
  assert.equal(protocol.researchQuestions.RQ1,extract(1),'RQ1 must match the architecture record');
  assert.equal(protocol.researchQuestions.RQ2,extract(2),'RQ2 must match the architecture record');
  assert.equal(protocol.researchQuestions.RQ3,extract(3),'RQ3 must match the architecture record');
});

test('matrix is the complete 3x3x8x5 factorial with a documented deterministic order',()=>{
  const {matrixBytes,protocol}=loadArtifacts();
  const rows=parseMatrix(matrixBytes);
  assert.equal(rows.length,EXPECTED_TRIALS);
  assert.deepEqual(protocol.scenarios.scheduled,SCHEDULED);
  const expectedSequence=ARMS.flatMap(deployment=>PROFILES.flatMap(profile=>
    SCHEDULED.map(scenario=>({deployment,profile,scenario}))));
  for(let block=1;block<=BLOCKS;block++){
    const slice=rows.filter(row=>row.block===block);
    assert.equal(slice.length,ROWS_PER_BLOCK,`block ${block} size`);
    slice.sort((a,b)=>a.order_in_block-b.order_in_block);
    for(let index=0;index<ROWS_PER_BLOCK;index++){
      const row=slice[index];
      assert.equal(row.order_in_block,index+1);
      assert.equal(row.deployment,expectedSequence[index].deployment);
      assert.equal(row.permission_profile,expectedSequence[index].profile);
      assert.equal(row.scenario_id,expectedSequence[index].scenario);
    }
  }
  // every cell exactly five times, once per block (five valid repetitions)
  const cells=new Map();
  for(const row of rows){
    const key=`${row.deployment}:${row.permission_profile}:${row.scenario_id}`;
    const entry=cells.get(key)??new Set();
    entry.add(row.block);
    cells.set(key,entry);
  }
  assert.equal(cells.size,ARMS.length*PROFILES.length*SCHEDULED.length);
  for(const [key,blocks] of cells)
    assert.equal(blocks.size,BLOCKS,`cell ${key} must run once in each of five blocks`);
  assert.equal(protocol.repetitionsPerCell,BLOCKS);
  assert.equal(protocol.blocks,BLOCKS);
});

test('planned attempt counts are computed, not manufactured toward 450',()=>{
  const {matrixBytes,protocol}=loadArtifacts();
  const rows=parseMatrix(matrixBytes);
  assert.equal(protocol.expectedTrials,EXPECTED_TRIALS);
  assert.equal(rows.filter(row=>row.scenario_type==='unauthorized').length,270);
  assert.equal(rows.filter(row=>row.scenario_type==='legitimate').length,90);
  assert.deepEqual(protocol.plannedAttemptCounts,{unauthorized:270,legitimate:90});
  for(const arm of ARMS)
    assert.equal(rows.filter(row=>row.deployment===arm).length,120,`${arm} row total`);
  for(const profile of PROFILES)
    assert.equal(rows.filter(row=>row.permission_profile===profile).length,120,`${profile} row total`);
  for(const scenario of SCHEDULED)
    assert.equal(rows.filter(row=>row.scenario_id===scenario).length,45,`${scenario} row total`);
  for(const row of rows){
    assert.equal(row.scenario_type,TYPE[row.scenario_id]);
    assert.equal(row.status,'NOT RUN');
    assert.equal(row.result,'');
    assert.equal(row.verified_evidence_ref,'');
  }
  const reference=protocol.fullFactorialReference;
  assert.equal(reference.fullFactorialCells,450);
  assert.equal(reference.scheduledRows,360);
  assert.equal(reference.notApplicableCellInstances,90);
});

test('U6/U8 are excluded as recorded not-applicable cells, never silently dropped',()=>{
  const {matrixBytes,protocol}=loadArtifacts();
  const rows=parseMatrix(matrixBytes);
  assert.equal(rows.some(row=>EXCLUDED.includes(row.scenario_id)),false,'no U6/U8 rows scheduled');
  const excluded=protocol.matrix.notApplicableCells;
  assert.deepEqual(excluded.scenarios,EXCLUDED);
  assert.deepEqual(excluded.armsAffected,ARMS);
  assert.equal(excluded.designCells,ARMS.length*PROFILES.length*EXCLUDED.length);   // 18
  assert.equal(excluded.cellInstancesAtFiveRepetitions,excluded.designCells*BLOCKS); // 90
  assert.equal(excluded.reason,'scenario_requires_sessions');
  // the exclusion agrees with the runtime scope checker rather than contradicting it
  for(const arm of ARMS) for(const scenario of EXCLUDED)
    assert.equal(classifyTrialScope({deployment:arm,permission_profile:'P2',scenario_id:scenario}).status,
      'not_applicable',`${arm} ${scenario}`);
  // U6/U8 mean run-scoped Blob application namespaces, not VM filesystem or provider session memory
  const framing=protocol.u6U8Operationalization;
  assert.deepEqual(framing.blobContainerNamespaces,['session-a','session-b','prior-session']);
  assert.deepEqual(framing.notAClaimAbout,['vm_filesystem_state','provider_native_cross_tenant_session_memory']);
  assert.equal(framing.admissionGate,'per-arm sessionCapabilities declaration after azure_blob_container_namespaces fixture validation on that arm');
});

test('every scheduled row agrees with the runtime scope checker',()=>{
  const {matrixBytes,protocol}=loadArtifacts();
  const rows=parseMatrix(matrixBytes);
  let gated=0;
  for(const row of rows){
    const scope=classifyTrialScope({deployment:row.deployment,
      permission_profile:row.permission_profile,scenario_id:row.scenario_id});
    if(row.permission_profile==='P3'&&['U5','U7'].includes(row.scenario_id)){
      gated++;
      assert.equal(scope.status,'unsupported',`${row.planned_run_id}`);
      assert.equal(scope.reason,'independent_network_denial_evidence_unavailable');
    } else {
      assert.equal(scope.status,'measurable',`${row.planned_run_id}`);
    }
  }
  assert.equal(gated,ARMS.length*2*BLOCKS,'30 P3 U5/U7 rows are scheduled but evidence-gated');
  assert.equal(protocol.gatedRows.p3NetworkDenialRows,30);
});

test('P3 network evidence sources are per-arm and never conflated',()=>{
  const {protocol}=loadArtifacts();
  const p3=protocol.p3NetworkEvidence;
  for(const arm of ARMS){
    assert.equal(p3[arm].pilotValidated,false,`${arm} P3 pilot must not be claimed`);
    assert.ok(Array.isArray(p3[arm].evidenceSources)&&p3[arm].evidenceSources.length>0);
  }
  // Sandbox egress decisions are their own evidence kind, never a firewall or flow log
  assert.deepEqual(p3.azure_container_apps_sandboxes.evidenceSources,['sandbox_network_egress_decisions']);
  assert.equal(p3.azure_container_apps_sandboxes.evidenceSources.some(source=>
    source.includes('firewall')||source.includes('flow')),false);
  // ACA Jobs use firewall records and are on the VNet flow-log incompatibility list
  assert.deepEqual(p3.azure_container_apps_jobs.evidenceSources,['azure_diagnostics_firewall']);
  // The VM arm may use flow logs or its firewall diagnostics; it is a distinct record source per arm
  assert.deepEqual(p3.azure_vm.evidenceSources,['vnet_flow_log','azure_diagnostics_firewall']);
});

test('route keys are the nine deployment:profile identifiers the config layer expects',()=>{
  const {protocol}=loadArtifacts();
  assert.deepEqual(protocol.routeKeys,ARMS.flatMap(arm=>PROFILES.map(profile=>`${arm}:${profile}`)));
  for(const key of protocol.routeKeys){
    const [deployment,profile]=key.split(':');
    assert.ok(SUPPORTED_DEPLOYMENTS.includes(deployment),`unknown deployment in ${key}`);
    assert.ok(PROFILES.includes(profile),`unknown profile in ${key}`);
  }
});

test('run IDs are fresh, unique, self-consistent, and absent from every prior matrix',()=>{
  const {matrixBytes}=loadArtifacts();
  const rows=parseMatrix(matrixBytes);
  const ids=new Set(rows.map(row=>row.planned_run_id));
  assert.equal(ids.size,EXPECTED_TRIALS,'no duplicate IDs inside the plan');
  for(const row of rows){
    const expected=`tas360-b${String(row.block).padStart(2,'0')}-${String(row.order_in_block).padStart(2,'0')}-${row.deployment}-${row.permission_profile}-${row.scenario_id}`;
    assert.equal(row.planned_run_id,expected,'ID must encode block, order, arm, profile, scenario');
    assert.match(row.planned_run_id,/^tas360-b0[1-5]-[0-7][0-9]-/);
  }
  for(const file of readdirSync(PACKAGE).filter(name=>/^03-.*\.csv$/.test(name))){
    const text=readFileSync(resolve(PACKAGE,file),'utf8');
    for(const id of ids)
      assert.ok(!text.includes(id),`${id} already appears in ${file}; IDs must be fresh`);
  }
});

test('freeze lock and protocol declare the exact bytes on disk',()=>{
  const {protocolBytes,matrixBytes,protocol,lock}=loadArtifacts();
  const digests=verifyFrozen({protocolBytes,matrixBytes,lock});
  assert.equal(protocol.matrix.file,MATRIX_FILE);
  assert.equal(lock.protocolFile,PROTOCOL_FILE);
  assert.equal(lock.matrixFile,MATRIX_FILE);
  assert.equal(protocol.matrix.sha256,digests.matrixDigest);
  assert.equal(protocolBytes.includes('\r'),false,'protocol JSON stays LF');
  assert.equal(lock.measuredExecutionEnabled,false);
  assert.equal(lock.status,'frozen_structural_launch_gated');
});

test('a one-byte edit to either frozen artifact is rejected by the declared digest',()=>{
  const {protocolBytes,matrixBytes,lock}=loadArtifacts();
  const tamperedMatrix=Buffer.from(matrixBytes);
  tamperedMatrix[0]^=1;
  assert.throws(()=>verifyFrozen({protocolBytes,matrixBytes:tamperedMatrix,lock}),/matrix digest mismatch/);
  const tamperedProtocol=Buffer.from(protocolBytes);
  tamperedProtocol[Math.floor(tamperedProtocol.length/2)]^=1;
  assert.throws(()=>verifyFrozen({protocolBytes:tamperedProtocol,matrixBytes,lock}),/protocol digest mismatch/);
  // a single semantic character change (U1 -> U2 in the first data row) must also change the digest
  const semantic=Buffer.from(matrixBytes);
  const text=semantic.toString('utf8');
  const headerEnd=text.indexOf('\r\n');
  const firstRowEnd=text.indexOf('\r\n',headerEnd+1);
  const index=text.indexOf(',U1,',headerEnd+1);
  assert.ok(index>headerEnd&&index<firstRowEnd,'first data row must contain ,U1,');
  semantic[index+2]='2';
  assert.notEqual(sha256(semantic),lock.matrixSha256);
});

test('the new freeze lock is separate from every existing freeze lock',()=>{
  const {lock}=loadArtifacts();
  const rev5=JSON.parse(readFileSync(resolve(ROOT,'config/protocol-400-rev5-vm-functions-idfix-freeze-lock.json'),'utf8'));
  const rev4=JSON.parse(readFileSync(resolve(ROOT,'config/protocol-400-rev4-vm-functions-freeze-lock.json'),'utf8'));
  for(const prior of [rev4,rev5]){
    assert.notEqual(lock.matrixSha256,prior.matrixSha256);
    assert.notEqual(lock.protocolSha256,prior.protocolSha256);
    assert.notEqual(lock.protocolFile,prior.protocolFile);
  }
});

test('pre-existing frozen artifacts remain byte-identical',()=>{
  const {protocol:planning450}= {protocol:JSON.parse(
    readFileSync(resolve(ROOT,'config/protocol-450-three-architecture-planning.json'),'utf8'))};
  assert.equal(sha256(readFileSync(resolve(PACKAGE,'03-PLANNED-TRIAL-MATRIX-450.csv'))),MATRIX_450_SHA);
  assert.equal(planning450.matrixSha256,MATRIX_450_SHA,'450 planning protocol still declares the same digest');
  assert.equal(planning450.status,'planning_not_validated');
  const rev5=JSON.parse(readFileSync(resolve(ROOT,'config/protocol-400-rev5-vm-functions-idfix-freeze-lock.json'),'utf8'));
  assert.equal(sha256(readFileSync(resolve(ROOT,rev5.protocolFile))),rev5.protocolSha256);
  assert.equal(sha256(readFileSync(resolve(PACKAGE,rev5.matrixFile))),rev5.matrixSha256);
});

test('launch gates are enumerated honestly and none is claimed passed',()=>{
  const {protocol}=loadArtifacts();
  const gates=protocol.launchGates.map(gate=>`${gate.gate} ${gate.status}`).join(' ');
  for(const keyword of ['live_identity','per_arm_non_counted_pilot','no_op_network_baseline','quota_and_capacity','verifier_and_scope_wiring','owner_measured_freeze'])
    assert.ok(gates.includes(keyword),`launch gate ${keyword} must be present`);
  assert.equal(protocol.launchGates.every(gate=>gate.status==='open'),true,'no gate may be claimed closed by an offline artifact');
});
