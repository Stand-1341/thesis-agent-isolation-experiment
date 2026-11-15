/**
 * Read-only assessment of a selected, frozen three-arm schedule. This command
 * never starts trials. It separates the immutable legacy-plan inspection from
 * the candidate protocol/matrix pair, and it always refuses measured launch:
 * offline structure cannot close owner, pilot, or subscription gates.
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {basename,dirname,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspectOriginalPlan} from './inspect-three-architecture-plan.mjs';
import {validateExperimentConfig} from './experiment-config.mjs';
import {analyzeTrialScope} from './scenario-scope.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const HEADER=['planned_run_id','block','order_in_block','deployment','permission_profile','scenario_id',
  'scenario_type','status','result','verified_evidence_ref'];
const PROFILES=['P1','P2','P3'];
const ALL_SCENARIOS=['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'];
export const THREE_ARM_DEPLOYMENTS=['azure_vm','azure_container_apps_jobs','azure_container_apps_sandboxes'];
export const SUPERSEDED_DEPLOYMENTS=['azure_functions_flex','azure_custom_sessions_hyperv','azure_container_instances'];
export const THREE_ARM_ROUTES=THREE_ARM_DEPLOYMENTS.flatMap(deployment=>PROFILES.map(profile=>`${deployment}:${profile}`));

// Independent code-side trust anchors: the candidate protocol cannot bless a
// replacement matrix merely by editing its own digest and adjacent lock file.
const APPROVED_FROZEN_CANDIDATES=Object.freeze({
  'protocol-360-three-arm-supported-v1.json':Object.freeze({
    revision:'three-arm-supported-360-v1',protocolSha256:'903b6a86ddde3468633f0271e5b8752b88a51e2b5df533983802f7726b4fffec',
    matrixFile:'plan-360-three-arm-supported-v1.csv',matrixSha256:'854d1f20e1443798d50933f01e57cd21e1684e3d5c1f7bdc490ef41e0c099ce6'}),
  'protocol-450-three-arm-supported-v2.json':Object.freeze({
    revision:'three-arm-supported-450-v2',protocolSha256:'fdb135628361b17347f91df7099d48afc25d6366803b498fae545ae9c2c5d2bc',
    matrixFile:'plan-450-three-arm-supported-v2.csv',matrixSha256:'3e9d26641b190eba202984c88234794fa480bb7ddbed2fd5ebc3188d269e40d6'}),
  'protocol-450-flex-sandbox-supported-v3.json':Object.freeze({
    revision:'three-arm-flex-sandbox-450-v3',protocolSha256:'1d007cec5062dd8641b604e01fb6b7cea62ca166c44f184f9bae16085c62d266',
    matrixFile:'plan-450-flex-sandbox-supported-v3.csv',matrixSha256:'d76cb846e3dc647c6bc7bf589ad6397d03f8a9885ecf42ace11c13e44740834e',
    deployments:Object.freeze(['azure_vm','azure_functions_flex','azure_container_apps_sandboxes']),
    deploymentKinds:Object.freeze({azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'})}),
  'protocol-400-flex-sandbox-no-sandbox-p3-v1.json':Object.freeze({
    revision:'three-arm-flex-sandbox-400-v1-sandbox-p3-excluded',protocolSha256:'1272d4330edd67aea20c770c2c0d24467a8a1b55bdf883baa2406fc646d4e4e6',
    matrixFile:'plan-400-flex-sandbox-no-sandbox-p3-v1.csv',matrixSha256:'864e8f02e20f741f9dd96fbd5653fd8f24b6e299f019f762c8dea6aade62e508',
    deployments:Object.freeze(['azure_vm','azure_functions_flex','azure_container_apps_sandboxes']),
    deploymentKinds:Object.freeze({azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'}),
    profilesByDeployment:Object.freeze({azure_vm:Object.freeze(PROFILES),azure_functions_flex:Object.freeze(PROFILES),azure_container_apps_sandboxes:Object.freeze(['P1','P2'])}),
    measuredExecutionEnabled:true}),
  'protocol-400-flex-sandbox-no-sandbox-p3-v2-fresh-ids.json':Object.freeze({
    revision:'three-arm-flex-sandbox-400-v2-sandbox-p3-excluded-fresh-ids',protocolSha256:'49dd1ed72b6e9f1696e6785dd2749cd8107654d27e51ebe7d7c47ecf3aa90312',
    matrixFile:'plan-400-flex-sandbox-no-sandbox-p3-v2-fresh-ids.csv',matrixSha256:'9676a99957476f5892e9166dc5069685fc0bfd19782a371a2045249ae4eca699',
    deployments:Object.freeze(['azure_vm','azure_functions_flex','azure_container_apps_sandboxes']),
    deploymentKinds:Object.freeze({azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'}),
    profilesByDeployment:Object.freeze({azure_vm:Object.freeze(PROFILES),azure_functions_flex:Object.freeze(PROFILES),azure_container_apps_sandboxes:Object.freeze(['P1','P2'])}),
    measuredExecutionEnabled:true}),
  'protocol-400-flex-sandbox-no-sandbox-p3-v3-fresh-ids.json':Object.freeze({
    revision:'three-arm-flex-sandbox-400-v3-sandbox-p3-excluded-fresh-ids',protocolSha256:'4f8307da47d6696e257566832d0fd9d9a9117c27caaa9cbc5e556f57a2aa342c',
    matrixFile:'plan-400-flex-sandbox-no-sandbox-p3-v3-fresh-ids.csv',matrixSha256:'e26cb22a60319271e106932c07d047a00bd6b3610922b2c32a61e3991dd8097a',
    deployments:Object.freeze(['azure_vm','azure_functions_flex','azure_container_apps_sandboxes']),
    deploymentKinds:Object.freeze({azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'}),
    profilesByDeployment:Object.freeze({azure_vm:Object.freeze(PROFILES),azure_functions_flex:Object.freeze(PROFILES),azure_container_apps_sandboxes:Object.freeze(['P1','P2'])}),
    measuredExecutionEnabled:true}),
  'protocol-400-flex-sandbox-no-sandbox-p3-v4-fresh-ids.json':Object.freeze({
    revision:'three-arm-flex-sandbox-400-v4-sandbox-p3-excluded-fresh-ids',protocolSha256:'c2da55dd9a900f15343a5ec83352cadbb3716208f0a92d04dbe261c21148e77b',
    matrixFile:'plan-400-flex-sandbox-no-sandbox-p3-v4-fresh-ids.csv',matrixSha256:'bebda9fc145607878cf93f0c2b21e249b50175edd24385cbcc48cb74f661dd5f',
    deployments:Object.freeze(['azure_vm','azure_functions_flex','azure_container_apps_sandboxes']),
    deploymentKinds:Object.freeze({azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'}),
    profilesByDeployment:Object.freeze({azure_vm:Object.freeze(PROFILES),azure_functions_flex:Object.freeze(PROFILES),azure_container_apps_sandboxes:Object.freeze(['P1','P2'])}),
    measuredExecutionEnabled:true}),
  'protocol-400-flex-sandbox-no-sandbox-p3-v5-fresh-ids.json':Object.freeze({
    revision:'three-arm-flex-sandbox-400-v5-sandbox-p3-excluded-fresh-ids',protocolSha256:'f45a60340eb8e7b74c6880ed7e5a51abd3e26f64998b072b3a732ebf272b7d4b',
    matrixFile:'plan-400-flex-sandbox-no-sandbox-p3-v5-fresh-ids.csv',matrixSha256:'a10a9685ba098665282c7d94e1f7f7c88deda67f9152c22c9e4c3db597e9720e',
    deployments:Object.freeze(['azure_vm','azure_functions_flex','azure_container_apps_sandboxes']),
    deploymentKinds:Object.freeze({azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'}),
    profilesByDeployment:Object.freeze({azure_vm:Object.freeze(PROFILES),azure_functions_flex:Object.freeze(PROFILES),azure_container_apps_sandboxes:Object.freeze(['P1','P2'])}),
    measuredExecutionEnabled:true})
});
const APPROVED_FROZEN_PILOTS=Object.freeze({
  'protocol-450-three-arm-supported-v2-pilot-v1.json':Object.freeze({
    revision:'three-arm-supported-450-v2-pilot-v1',
    protocolSha256:'dac823ca8b37c3aeaea4386f897415e2e02b4d5d07cf04ee57872fb1e37cacf7',
    matrixFile:'plan-450-three-arm-supported-v2-pilot-v1.csv',
    matrixSha256:'d1369ae19d84d3c47de0c28d913d0ede4d8dc435d7e1c659fa51fa816e849780',
    sourceProtocolFile:'protocol-450-three-arm-supported-v2.json',
    sourceProtocolRevision:'three-arm-supported-450-v2',
    sourceProtocolSha256:'fdb135628361b17347f91df7099d48afc25d6366803b498fae545ae9c2c5d2bc',
    sourceMatrixFile:'plan-450-three-arm-supported-v2.csv',
    sourceMatrixSha256:'3e9d26641b190eba202984c88234794fa480bb7ddbed2fd5ebc3188d269e40d6',
    deployments:Object.freeze(['azure_vm','azure_container_apps_jobs','azure_container_apps_sandboxes']),
    deploymentKinds:Object.freeze({azure_vm:'http',azure_container_apps_jobs:'aca_job',azure_container_apps_sandboxes:'aca_sandbox'}),
    pilotScenarios:Object.freeze({P1:Object.freeze(ALL_SCENARIOS),P2:Object.freeze(['U5','U6','U7','U8','L1','L2']),
      P3:Object.freeze(['U5','U6','U7','U8','L1','L2'])}),
    pilotTrials:66,runIdPrefix:'pilot-450v2',unauthorized:48,legitimate:18}),
  'protocol-450-flex-sandbox-supported-v3-pilot-v1.json':Object.freeze({
    revision:'three-arm-flex-sandbox-450-v3-pilot-v1',
    protocolSha256:'eb75d10c07a70593ad5798d0a703647a1d7af565424a81295614aecbf25cefa5',
    matrixFile:'plan-450-flex-sandbox-supported-v3-pilot-v1.csv',
    matrixSha256:'ed00d9d4cfa6ac328aaf5d046ddc055bd9838d7628fde9330f912cbe4168edec',
    sourceProtocolFile:'protocol-450-flex-sandbox-supported-v3.json',
    sourceProtocolRevision:'three-arm-flex-sandbox-450-v3',
    sourceProtocolSha256:'1d007cec5062dd8641b604e01fb6b7cea62ca166c44f184f9bae16085c62d266',
    sourceMatrixFile:'plan-450-flex-sandbox-supported-v3.csv',
    sourceMatrixSha256:'d76cb846e3dc647c6bc7bf589ad6397d03f8a9885ecf42ace11c13e44740834e',
    deployments:Object.freeze(['azure_vm','azure_functions_flex','azure_container_apps_sandboxes']),
    deploymentKinds:Object.freeze({azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'}),
    pilotScenarios:Object.freeze({P1:Object.freeze(['U1','U6','U8']),P2:Object.freeze(['U1','U6','U8']),
      P3:Object.freeze(['U5','U6','U7','U8'])}),
    pilotTrials:30,runIdPrefix:'pilot-v3',unauthorized:30,legitimate:0})
});

/**
 * Structural capability inventory. `codePresent` means a local reader/evidence
 * path is implemented; `established` means the default offline scope can count
 * the arm without deployment-specific telemetry inputs. Neither means live
 * Azure telemetry or a pilot was observed. Pilot validation remains false.
 */
export const NETWORK_DENIAL_CAPABILITY=Object.freeze({
  azure_vm:Object.freeze({codePresent:true,established:true,pilotValidated:false,evidence:'VM VNet flow logs or VM-route Azure Firewall diagnostics'}),
  azure_functions_flex:Object.freeze({codePresent:true,established:false,pilotValidated:false,
    evidence:'Functions Flex dedicated-subnet target/rule-scoped Azure Firewall reader is implemented; exact-route U5/U7 inputs and an attributable pilot are not established'}),
  azure_container_apps_jobs:Object.freeze({codePresent:true,established:false,pilotValidated:false,
    evidence:'ACA Jobs target-scoped Azure Firewall application-rule reader is implemented; target-specific inputs and an attributable pilot are not established'}),
  azure_container_apps_sandboxes:Object.freeze({codePresent:true,established:true,pilotValidated:false,
    evidence:'per-request ACA Sandbox NetworkEgressDecisions from the sandbox egress policy'})
});

const sameSet=(left,right)=>left.length===right.length&&new Set(left).size===new Set(right).size&&left.every(item=>right.includes(item));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function freezeLockPathFor(protocolPath) {
  if(typeof protocolPath!=='string'||!protocolPath.toLowerCase().endsWith('.json'))
    throw new TypeError('selected protocol path must end in .json');
  return protocolPath.replace(/\.json$/i,'-freeze-lock.json');
}

function normalizedFilename(value) {
  return typeof value==='string'?basename(value.replaceAll('\\','/')):'';
}

function parseCandidateMatrix(matrixBytes) {
  if(!Buffer.isBuffer(matrixBytes)) throw new Error('candidate matrix bytes are required');
  let text;
  try { text=new TextDecoder('utf-8',{fatal:true}).decode(matrixBytes); }
  catch { throw new Error('candidate matrix shape: invalid UTF-8'); }
  if(text.charCodeAt(0)===0xfeff||/[\0"]/.test(text)||!text.endsWith('\r\n'))
    throw new Error('candidate matrix shape: expected unquoted CRLF CSV with trailing CRLF');
  const body=text.slice(0,-2);
  if(/(^|[^\r])\n|\r(?!\n)/.test(body))
    throw new Error('candidate matrix shape: line endings must be CRLF');
  const lines=body.split('\r\n');
  if(lines.shift()!==HEADER.join(',')) throw new Error('candidate matrix shape: header does not match');
  const rows=lines.map(line=>{
    const values=line.split(',');
    if(values.length!==HEADER.length||values.some(value=>value.includes('\r')))
      throw new Error('candidate matrix shape: malformed row');
    return Object.fromEntries(HEADER.map((key,index)=>[key,values[index]]));
  });
  return rows;
}

/** Verify the selected protocol and its externally declared exact-byte lock. */
export function validateSelectedProtocol({protocolBytes,matrixBytes,lock,paths={}}={}) {
  if(!Buffer.isBuffer(protocolBytes)||!Buffer.isBuffer(matrixBytes)||!lock||typeof lock!=='object')
    throw new Error('selected protocol, matrix bytes, and separate freeze lock are required');
  let protocol;
  try { protocol=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(protocolBytes)); }
  catch { throw new Error('selected protocol is not valid UTF-8 JSON'); }
  if(!protocol||typeof protocol!=='object'||Array.isArray(protocol))
    throw new Error('selected protocol must be a JSON object');
  const measuredRequested=['protocol-400-flex-sandbox-no-sandbox-p3-v1.json','protocol-400-flex-sandbox-no-sandbox-p3-v2-fresh-ids.json','protocol-400-flex-sandbox-no-sandbox-p3-v3-fresh-ids.json','protocol-400-flex-sandbox-no-sandbox-p3-v4-fresh-ids.json','protocol-400-flex-sandbox-no-sandbox-p3-v5-fresh-ids.json'].includes(normalizedFilename(paths.protocolFile));
  if(measuredRequested) {
    if(protocol.measuredExecutionEnabled!==true||lock.measuredExecutionEnabled!==true)
      throw new Error('measured execution must be enabled in both protocol and freeze lock for the approved 400 revision');
  } else if(protocol.measuredExecutionEnabled!==false||lock.measuredExecutionEnabled!==false)
    throw new Error('measured execution must remain disabled in both protocol and freeze lock');
  const protocolFile=paths.protocolFile;
  const matrixFile=paths.matrixFile??protocol.matrix?.file;
  const expectedLockFile=protocolFile?freezeLockPathFor(protocolFile):undefined;
  const approvedCandidate=APPROVED_FROZEN_CANDIDATES[normalizedFilename(protocolFile)];
  if(!approvedCandidate||!protocolFile||!paths.lockFile||
    normalizedFilename(lock.protocolFile)!==normalizedFilename(protocolFile)||
    normalizedFilename(lock.matrixFile)!==normalizedFilename(matrixFile)||
    normalizedFilename(protocol.matrix?.file)!==normalizedFilename(matrixFile)||
    normalizedFilename(matrixFile)!==approvedCandidate.matrixFile||
    normalizedFilename(expectedLockFile)!==normalizedFilename(paths.lockFile))
    throw new Error('freeze lock does not name an approved selected protocol and matrix pair');
  if(lock.status!=='frozen_structural_launch_gated')
    throw new Error('freeze lock status is not a separately declared structural freeze');
  const expectedDeployments=approvedCandidate.deployments??THREE_ARM_DEPLOYMENTS;
  const expectedKinds=approvedCandidate.deploymentKinds??{azure_vm:'http',azure_container_apps_jobs:'aca_job',azure_container_apps_sandboxes:'aca_sandbox'};
  if(!sameSet(protocol.deployments??[],expectedDeployments))
    throw new Error('selected protocol does not declare the approved three supported deployments');
  if(!protocol.deploymentKinds||!sameSet(Object.keys(protocol.deploymentKinds),Object.keys(expectedKinds))||
    Object.entries(expectedKinds).some(([deployment,kind])=>protocol.deploymentKinds[deployment]!==kind))
    throw new Error('selected protocol deployment kinds do not match the approved three supported deployments');

  const protocolDigest=sha256(protocolBytes);
  if(!/^[a-f0-9]{64}$/.test(lock.protocolSha256??'')||protocolDigest!==lock.protocolSha256||
    protocolDigest!==approvedCandidate.protocolSha256)
    throw new Error('selected protocol digest does not match the approved candidate and separate freeze lock');
  if(protocol.revision!==approvedCandidate.revision||!/^[a-z0-9][a-z0-9-]{2,80}$/.test(protocol.revision??''))
    throw new Error('selected protocol revision does not match its approved frozen candidate');
  const matrixDigest=sha256(matrixBytes);
  if(!/^[a-f0-9]{64}$/.test(lock.matrixSha256??'')||matrixDigest!==lock.matrixSha256)
    throw new Error('selected matrix digest does not match the separate freeze lock');

  const scenarios=protocol.scenarios?.scheduled;
  const blocks=protocol.blocks;
  const repetitions=protocol.repetitionsPerCell;
  if(!Array.isArray(scenarios)||scenarios.length===0||new Set(scenarios).size!==scenarios.length||
    scenarios.some(scenario=>!ALL_SCENARIOS.includes(scenario))||
    !Array.isArray(protocol.profiles)||!sameSet(protocol.profiles,PROFILES)||
    !Number.isInteger(blocks)||blocks<1||!Number.isInteger(repetitions)||repetitions!==blocks)
    throw new Error('selected protocol shape is incomplete or inconsistent');
  if(!protocol.matrix||!Number.isInteger(protocol.expectedTrials)||
    protocol.expectedTrials!==protocol.matrix.trials||protocol.blocks!==protocol.matrix.blocks)
    throw new Error('selected protocol shape disagrees across declared counts');

  const rows=parseCandidateMatrix(matrixBytes);
  const ids=new Set();
  const cellKeys=new Set();
  const orderByBlock=new Map();
  const rowsByBlock=new Map();
  for(const row of rows) {
    const block=Number(row.block),order=Number(row.order_in_block);
    if(!Number.isInteger(block)||block<1||block>blocks||!Number.isInteger(order)||order<1)
      throw new Error('selected matrix shape contains an invalid block or order');
    if(orderByBlock.has(block)&&order<=orderByBlock.get(block))
      throw new Error('selected matrix shape has nonascending block order');
    orderByBlock.set(block,order);
    rowsByBlock.set(block,(rowsByBlock.get(block)??0)+1);
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(row.planned_run_id)||ids.has(row.planned_run_id))
      throw new Error('selected matrix shape contains an invalid or duplicate run ID');
    ids.add(row.planned_run_id);
    if(!expectedDeployments.includes(row.deployment)||!PROFILES.includes(row.permission_profile)||
      !scenarios.includes(row.scenario_id))
      throw new Error('selected matrix shape contains a cell outside the declared protocol');
    if(row.scenario_type!==(row.scenario_id.startsWith('U')?'unauthorized':'legitimate')||
      row.status!=='NOT RUN'||row.result||row.verified_evidence_ref)
      throw new Error('selected matrix shape is not an untouched planning schedule');
    const cellKey=`${block}|${row.deployment}|${row.permission_profile}|${row.scenario_id}`;
    if(cellKeys.has(cellKey)) throw new Error('selected matrix shape contains a duplicate cell');
    cellKeys.add(cellKey);
  }
  const profilesFor=deployment=>approvedCandidate.profilesByDeployment?.[deployment]??PROFILES;
  const rowsPerBlock=expectedDeployments.reduce((count,deployment)=>count+profilesFor(deployment).length*scenarios.length,0);
  const expectedTrials=rowsPerBlock*blocks;
  if(rows.length!==expectedTrials||protocol.expectedTrials!==expectedTrials||
    [...rowsByBlock.keys()].length!==blocks||[...rowsByBlock.values()].some(count=>count!==rowsPerBlock)||
    protocol.matrix.trials!==rows.length||protocol.matrix.rowsPerBlock!==rowsPerBlock)
    throw new Error('selected matrix shape does not match its declared factorial schedule');
  for(let block=1;block<=blocks;block++) {
    if(!rowsByBlock.has(block)) throw new Error('selected matrix shape has a missing block');
    for(const deployment of expectedDeployments) for(const profile of profilesFor(deployment)) for(const scenario of scenarios)
      if(!cellKeys.has(`${block}|${deployment}|${profile}|${scenario}`))
        throw new Error('selected matrix shape is missing a declared cell');
  }
  const summary={trials:rows.length,blocks,rowsPerBlock,
    unauthorized:rows.filter(row=>row.scenario_type==='unauthorized').length,
    legitimate:rows.filter(row=>row.scenario_type==='legitimate').length};
  if(summary.unauthorized!==protocol.plannedAttemptCounts?.unauthorized||
    summary.legitimate!==protocol.plannedAttemptCounts?.legitimate)
    throw new Error('selected matrix shape disagrees with the declared attempt counts');
  if(!/^[a-f0-9]{64}$/.test(protocol.matrix?.sha256??'')||protocol.matrix.sha256!==matrixDigest||
    matrixDigest!==approvedCandidate.matrixSha256||lock.matrixSha256!==approvedCandidate.matrixSha256)
    throw new Error('selected matrix digest does not match the protocol declaration and approved frozen candidate');
  return {protocol,rows,summary,protocolDigest,matrixDigest};
}

/** Verify a separately frozen, explicitly non-counted pilot schedule. */
export function validateFrozenPilotProtocol({protocolBytes,matrixBytes,lock,paths={}}={}) {
  if(!Buffer.isBuffer(protocolBytes)||!Buffer.isBuffer(matrixBytes)||!lock||typeof lock!=='object')
    throw new Error('pilot protocol, pilot matrix bytes, and separate freeze lock are required');
  let protocol;
  try { protocol=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(protocolBytes)); }
  catch { throw new Error('pilot protocol is not valid UTF-8 JSON'); }
  if(!protocol||typeof protocol!=='object'||Array.isArray(protocol))
    throw new Error('pilot protocol must be a JSON object');
  const protocolFile=paths.protocolFile;
  const pilotPlan=protocol.pilotPlan;
  const matrixFile=paths.matrixFile??pilotPlan?.file;
  const expectedLockFile=protocolFile?freezeLockPathFor(protocolFile):undefined;
  const approved=APPROVED_FROZEN_PILOTS[normalizedFilename(protocolFile)];
  if(!approved||!protocolFile||!paths.lockFile||!pilotPlan||
    normalizedFilename(lock.protocolFile)!==normalizedFilename(protocolFile)||
    normalizedFilename(lock.matrixFile)!==normalizedFilename(matrixFile)||
    normalizedFilename(pilotPlan.file)!==approved.matrixFile||
    normalizedFilename(matrixFile)!==approved.matrixFile||
    normalizedFilename(expectedLockFile)!==normalizedFilename(paths.lockFile))
    throw new Error('freeze lock does not name an approved three-arm pilot protocol and matrix pair');
  if(protocol.status!=='non_counted_pilot_frozen_launch_gated'||lock.status!=='frozen_non_counted_pilot_launch_gated'||
    protocol.revision!==approved.revision||lock.revision!==approved.revision||
    protocol.measuredExecutionEnabled!==false||protocol.readiness?.measuredExecutionEnabled!==false||
    lock.measuredExecutionEnabled!==false||lock.countedAsStudyTrials!==false||pilotPlan.countedAsStudyTrials!==false)
    throw new Error('pilot protocol and lock must remain frozen, launch-gated, and explicitly non-counted');
  if(!sameSet(protocol.deployments??[],approved.deployments)||
    !protocol.deploymentKinds||
    Object.entries(approved.deploymentKinds).some(([deployment,kind])=>protocol.deploymentKinds[deployment]!==kind)||
    !sameSet(protocol.routeKeys??[],approved.deployments.flatMap(deployment=>PROFILES.map(profile=>`${deployment}:${profile}`)))||
    !sameSet(protocol.profiles??[],PROFILES)||
    !sameSet(protocol.scenarios?.scheduled??[],ALL_SCENARIOS))
    throw new Error('pilot protocol does not preserve the selected three-arm route/scenario contract');
  if(normalizedFilename(protocol.sourceProtocol?.file)!==approved.sourceProtocolFile||
    protocol.sourceProtocol?.revision!==approved.sourceProtocolRevision||
    protocol.sourceProtocol?.sha256!==approved.sourceProtocolSha256||
    normalizedFilename(protocol.matrix?.file)!==approved.sourceMatrixFile||
    protocol.matrix?.sha256!==approved.sourceMatrixSha256||
    protocol.u6U8Operationalization?.gateStatus!=='open_on_all_arms'||
    !sameSet(protocol.u6U8Operationalization?.scheduledOn??[],approved.deployments)||
    pilotPlan.derivedFrom!==approved.sourceMatrixSha256||
    pilotPlan.sourceProtocolSha256!==approved.sourceProtocolSha256||
    normalizedFilename(lock.sourceProtocolFile)!==approved.sourceProtocolFile||
    lock.sourceProtocolSha256!==approved.sourceProtocolSha256||
    lock.sourceMatrixSha256!==approved.sourceMatrixSha256)
    throw new Error('pilot protocol or lock is not bound to the selected measured protocol and matrix');
  const protocolDigest=sha256(protocolBytes);
  const matrixDigest=sha256(matrixBytes);
  if(protocolDigest!==approved.protocolSha256||protocolDigest!==lock.protocolSha256||
    matrixDigest!==approved.matrixSha256||matrixDigest!==lock.matrixSha256||
    matrixDigest!==pilotPlan.sha256)
    throw new Error('pilot protocol or matrix digest does not match its independent code-side pins and freeze lock');
  if(pilotPlan.trials!==approved.pilotTrials||pilotPlan.blocks!==1||
    pilotPlan.rowsPerBlock!==approved.pilotTrials||pilotPlan.repetitionsPerCell!==1)
    throw new Error('pilot plan counts do not match the approved one-attempt schedule');
  const rows=parseCandidateMatrix(matrixBytes);
  const expected=[];
  for(const deployment of approved.deployments) for(const profile of PROFILES)
    for(const scenario of approved.pilotScenarios[profile]) expected.push({deployment,profile,scenario});
  if(rows.length!==expected.length||rows.length!==pilotPlan.trials)
    throw new Error('pilot matrix row count does not match the approved coverage');
  const ids=new Set();
  for(let index=0;index<expected.length;index++) {
    const row=rows[index],cell=expected[index],order=index+1;
    const runId=`${approved.runIdPrefix}-b1-${String(order).padStart(3,'0')}-${cell.deployment}-${cell.profile}-${cell.scenario}`;
    if(row.planned_run_id!==runId||ids.has(row.planned_run_id)||Number(row.block)!==1||Number(row.order_in_block)!==order||
      row.deployment!==cell.deployment||row.permission_profile!==cell.profile||row.scenario_id!==cell.scenario||
      row.scenario_type!==(cell.scenario.startsWith('U')?'unauthorized':'legitimate')||
      row.status!=='NOT RUN'||row.result||row.verified_evidence_ref)
      throw new Error('pilot matrix shape differs from the approved non-counted route/scenario schedule');
    ids.add(row.planned_run_id);
  }
  const summary={trials:rows.length,blocks:1,rowsPerBlock:rows.length,
    unauthorized:rows.filter(row=>row.scenario_type==='unauthorized').length,
    legitimate:rows.filter(row=>row.scenario_type==='legitimate').length};
  if(summary.unauthorized!==approved.unauthorized||summary.legitimate!==approved.legitimate)
    throw new Error('pilot matrix unauthorized/legitimate composition is invalid');
  return {protocol,rows,summary,protocolDigest,matrixDigest};
}

function pendingGates() {
  return [
    {gate:'per_arm_non_counted_pilots',kind:'pilot_required',
      detail:'VM: reconcile the pinned image, route/firewall configuration, workload identity, target-scoped controls and attributable P3 telemetry. Jobs: observe Consumption placement, UDR traversal, allowed-target success, attributable firewall denial and separated platform egress. Sandboxes: validate preview token/endpoint, disk image, effective identity, egress decisions and deletion readback. Earlier local tests and prior non-counted observations do not replace these complete per-arm records.'},
    {gate:'u6_u8_session_fixture_validation',kind:'pilot_required',
      detail:'Each scheduled arm requires the explicit azure_blob_external_namespace declaration and a non-counted fixture-validation pilot proving session-a, session-b and prior-session seed/read behavior plus cross-namespace denial. All 90 U6/U8 rows remain scheduled and gated.'},
    {gate:'target_scoped_positive_control_and_noop_baseline',kind:'pilot_required',
      detail:'The firewall-shared VM and Jobs paths require target-scoped positive-control queries and separately recorded non-counted no-op baselines before any P3 denial claim. THESIS_NETWORK_NOOP_BASELINE_VALIDATED is an outcome assertion, not a switch.'},
    {gate:'receiver_effect_rule',kind:'pilot_required',
      detail:'The verifier code applies the independent receiver/resource effect conjunction; a live pilot must demonstrate attributable enforcer evidence and a healthy independent receiver monitor with no effect in the same execution window. Local implementation is present; this gate is live evidence.'},
    {gate:'verifier_and_scope_wiring',kind:'pilot_required',
      detail:'Local structural wiring is verified: the generic runner consumes the v2 frozen schedule; an offline dependency-construction dry run builds all nine selected routes and the verifier, and its coverage reports the receiver-effect monitor present for VM/Jobs/Sandbox P3 lanes. Still open: run the separate non-counted per-arm pilots to prove provider execution metadata, attributable denial telemetry, and receiver-effect behavior live; no Azure lane has run.'},
    {gate:'measured_mode_operator_assertions',kind:'owner_assertion',
      detail:'The owner may assert the measured-mode outcomes only after their underlying checks pass: THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED, THESIS_COLLECTOR_DURABILITY_VALIDATED, THESIS_RESOURCE_INDEPENDENTLY_VALIDATED, THESIS_CLOCK_SYNC_VALIDATED, THESIS_AUDIT_PIPELINE_VALIDATED, THESIS_AUTHORIZATION_VALIDATED, THESIS_DENIAL_STATUS_TEXT_VALIDATED, and THESIS_NETWORK_NOOP_BASELINE_VALIDATED when Jobs P3 is selected.'},
    {gate:'live_identity_and_quota_unknown',kind:'subscription_unknown',
      detail:'The last recorded read-only inventory exited 4 with identity_unavailable. Live resources, identity binding, quota, region capacity, provider registration, prior resources and charges remain unknown, not empty or cleared; no Azure query was made for this offline report.'},
    {gate:'owner_measured_freeze',kind:'owner_assertion',
      detail:'The owner must review the per-arm pilot records, close applicable gates, approve study scope and costs, and issue an explicit measured-execution authorization. This preflight will continue refusing launch until that authorization is separately recorded; offline evidence cannot provide it.'}
  ];
}

function buildScheduleScope(rows,config,deployments=THREE_ARM_DEPLOYMENTS) {
  const sessionCapabilities={};
  for(const deployment of deployments) {
    const declaration=config?.deployments?.[deployment]?.sessionDataStore;
    if(declaration==='azure_blob_external_namespace') sessionCapabilities[deployment]=true;
    else if(declaration!==undefined) sessionCapabilities[deployment]=false;
  }
  const networkCapabilities=Object.fromEntries(Object.entries(NETWORK_DENIAL_CAPABILITY)
    .map(([deployment,capability])=>[deployment,capability.established]));
  const scope=analyzeTrialScope(rows,{sessionCapabilities,networkCapabilities});
  const notApplicableByScenario={};
  for(const item of scope.dispositions.filter(disposition=>disposition.status==='not_applicable'))
    notApplicableByScenario[item.scenario]=(notApplicableByScenario[item.scenario]??0)+1;
  const u6u8Rows=rows.filter(row=>row.scenario_id==='U6'||row.scenario_id==='U8').length;
  const p3NetworkRows=rows.filter(row=>row.permission_profile==='P3'&&['U5','U7'].includes(row.scenario_id)).length;
  const sessionCapabilityByArm=Object.fromEntries(Object.entries(sessionCapabilities).filter(([,enabled])=>enabled));
  return {rows:scope.total,measurable:scope.measurable,notApplicable:scope.notApplicable,
    unsupported:scope.unsupported,unsupportedByRoute:scope.unsupportedByRoute,notApplicableByScenario,
    sessionCapabilityByArm,gatedRows:{
      u6U8SessionFixture:{rows:u6u8Rows,status:u6u8Rows?'scheduled; pending per-arm fixture-validation pilot':'not scheduled by selected protocol'},
      p3NetworkDenial:{rows:p3NetworkRows,status:p3NetworkRows?'scheduled; pending attributable capability and non-counted pilot':'not scheduled by selected protocol'}
    },
    note:'Scope is computed from the selected frozen matrix and explicit config declarations. Scheduled U6/U8 rows are not N/A because their pilot is pending; Jobs P3 U5/U7 remain unsupported until attributable denial capability and pilot evidence exist. VM and Sandbox denial evidence use distinct paths.'};
}

/** Produce an offline readiness report. It has no path that enables a run. */
export function preflightThreeArchitecture({legacyPlanBytes,legacyProtocol,candidateProtocolBytes,
  candidateMatrixBytes,freezeLock,config,paths={}}={}) {
  const legacy=inspectOriginalPlan(legacyPlanBytes,legacyProtocol);
  const frozenLegacyPlan={...legacy,
    architecture:'superseded history: azure_vm + azure_functions_flex + azure_custom_sessions_hyperv',
    disposition:'preserved planning-only history; do not mutate, regenerate, or relaunch',
    inspectedWith:{protocol:'config/protocol-450-three-architecture-planning.json',matrix:'03-PLANNED-TRIAL-MATRIX-450.csv'}};
  const selected=validateSelectedProtocol({protocolBytes:candidateProtocolBytes,
    matrixBytes:candidateMatrixBytes,lock:freezeLock,paths});
  const protocol=selected.protocol;
  const selectedDeployments=protocol.deployments;
  const selectedRoutes=selectedDeployments.flatMap(deployment=>PROFILES.map(profile=>`${deployment}:${profile}`));
  const protocolAssessment={matchesThreeArm:true,protocolDeployments:protocol.deployments,
    planningOnly:true,reason:'selected frozen protocol selects the three supported arms; launch gates remain open'};
  const routes=Array.isArray(config?.routes)?config.routes:[];
  const seen=routes.map(route=>`${route?.deployment}:${route?.profile}`);
  const missingRoutes=selectedRoutes.filter(key=>!seen.includes(key));
  const duplicateRoutes=[...new Set(seen.filter((key,index)=>seen.indexOf(key)!==index))];
  const oldArchitectureRoutes=[...new Set(seen.filter(key=>SUPERSEDED_DEPLOYMENTS.includes(key.split(':')[0])&&!selectedDeployments.includes(key.split(':')[0])))];
  const unexpectedRoutes=[...new Set(seen.filter(key=>{
    const deployment=key.split(':')[0];
    return !selectedDeployments.includes(deployment)&&!SUPERSEDED_DEPLOYMENTS.includes(deployment);
  }))];
  let configValidation;
  try {
    validateExperimentConfig(config,{requiredRoutes:selectedRoutes,requiredScenarios:protocol.scenarios.scheduled});
    configValidation={status:'valid_shape_only'};
  } catch {
    configValidation={status:'invalid_or_unsupported'};
  }
  const configAssessment={missingRoutes,duplicateRoutes,oldArchitectureRoutes,unexpectedRoutes,configValidation,
    note:'Shape validation is structural only; it establishes neither deployment nor identity/evidence readiness.'};
  const scheduleScope=buildScheduleScope(selected.rows,config,selectedDeployments);
  const gates=pendingGates();
  const blockers=[];
  if(missingRoutes.length) blockers.push(`Configuration is missing required three-arm routes: ${missingRoutes.join(', ')}.`);
  if(duplicateRoutes.length) blockers.push(`Configuration contains duplicate routes: ${duplicateRoutes.join(', ')}.`);
  if(oldArchitectureRoutes.length) blockers.push(`Configuration contains superseded-architecture routes: ${oldArchitectureRoutes.join(', ')}.`);
  if(unexpectedRoutes.length) blockers.push(`Configuration contains unknown routes: ${unexpectedRoutes.join(', ')}.`);
  if(configValidation.status!=='valid_shape_only')
    blockers.push('Configuration does not satisfy the selected three-arm schedule shape; confirm all routes, scenarios, U7 restricted-host separation, and the U6/U8 external Blob namespace declaration.');
  if(scheduleScope.notApplicable)
    blockers.push(`Selected schedule has ${scheduleScope.notApplicable} not-applicable rows because a declared session capability is absent; the schedule itself was not reduced.`);
  for(const [route,count] of Object.entries(scheduleScope.unsupportedByRoute))
    blockers.push(`Scope unsupported (${route}): ${count} scheduled rows lack the required attributable denial capability.`);
  for(const gate of gates) blockers.push(`Gate pending (${gate.kind}): ${gate.gate} â€” ${gate.detail}`);
  blockers.push('Offline structural evidence cannot establish live Azure resources, credentials, pilot success, protected evidence, identity binding, quota, or absence of charges.');

  return {schema:'three_architecture_preflight_v3',ready:false,launchEnabled:false,
    frozenLegacyPlan,
    selectedArchitecture:{deployments:selectedDeployments,requiredRoutes:selectedRoutes},
    protocolAssessment,configAssessment,
    selectedProtocol:{revision:protocol.revision,status:protocol.status,deployments:protocol.deployments,
      measuredExecutionEnabled:false,freezeLock:{file:paths.lockFile,
        protocolSha256Verified:selected.protocolDigest===freezeLock.protocolSha256,
        matrixSha256Verified:selected.matrixDigest===freezeLock.matrixSha256},
      matrix:selected.summary,validation:'Exact-byte freeze-lock and declared shape verified offline; this is not live validation.'},
    structuralVerification:{freezeLockDigestsVerified:true,candidateShapeVerified:true,
      legacyPlanPlanningOnly:true,scopeUsesSelectedProtocol:true,sessionCapabilitiesReadFromConfig:true,
      localAdapterCodePresent:true,genericRunnerConsumesCandidate:true,
      measuredPathDependencyConstructionVerified:true,receiverEffectMonitorWiredInCoverage:true,offlineEvidenceOnly:true},
    networkDenialCapability:NETWORK_DENIAL_CAPABILITY,
    scheduleScope,pendingGates:gates,blockers,
    note:'Readiness remains blocked. This preflight is read-only and always exits 4 for a structurally valid candidate; it cannot launch a measured run or turn offline evidence into owner/live approval.'};
}

async function main(args) {
  let configPath,protocolPath;
  for(let index=0;index<args.length;index++) {
    if(args[index]==='--config'&&args[index+1]) configPath=args[++index];
    else if(args[index]==='--protocol'&&args[index+1]) protocolPath=args[++index];
    else throw new Error('usage: node scripts/preflight-three-architecture.mjs --config PATH --protocol PATH');
  }
  if(!configPath||!protocolPath)
    throw new Error('usage: node scripts/preflight-three-architecture.mjs --config PATH --protocol PATH');
  const protocolAbsolute=resolve(protocolPath);
  const lockAbsolute=resolve(freezeLockPathFor(protocolAbsolute));
  const [configBytes,protocolBytes,lockBytes,legacyProtocolBytes,legacyPlanBytes]=await Promise.all([
    readFile(resolve(configPath)),readFile(protocolAbsolute),readFile(lockAbsolute),
    readFile(resolve(root,'config/protocol-450-three-architecture-planning.json')),
    readFile(resolve(root,'../03-PLANNED-TRIAL-MATRIX-450.csv'))
  ]);
  const protocol=JSON.parse(protocolBytes);
  const lock=JSON.parse(lockBytes);
  const matrixPath=resolve(root,protocol.matrix?.file??'');
  const candidateMatrixBytes=await readFile(matrixPath);
  const report=preflightThreeArchitecture({legacyPlanBytes,legacyProtocol:JSON.parse(legacyProtocolBytes),
    candidateProtocolBytes:protocolBytes,candidateMatrixBytes,freezeLock:lock,
    config:JSON.parse(configBytes),paths:{protocolFile:relative(root,protocolAbsolute),
      matrixFile:protocol.matrix.file,lockFile:relative(root,lockAbsolute)}});
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  process.exitCode=4;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error=>{console.error(`Preflight failed: ${error.message}`);process.exitCode=3;});








