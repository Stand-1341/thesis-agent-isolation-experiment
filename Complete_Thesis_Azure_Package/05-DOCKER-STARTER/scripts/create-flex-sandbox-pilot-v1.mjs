#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DEPLOYMENTS=['azure_vm','azure_functions_flex','azure_container_apps_sandboxes'];
const PROFILES=['P1','P2','P3'];
const SCENARIOS={P1:['U1','U6','U8'],P2:['U1','U6','U8'],P3:['U5','U6','U7','U8']};
const HEADER=['planned_run_id','block','order_in_block','deployment','permission_profile','scenario_id','scenario_type','status','result','verified_evidence_ref'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

const rows=[];
for(const deployment of DEPLOYMENTS) for(const profile of PROFILES) for(const scenario of SCENARIOS[profile]) {
  const order=rows.length+1;
  rows.push({planned_run_id:`pilot-v3-b1-${String(order).padStart(3,'0')}-${deployment}-${profile}-${scenario}`,
    block:1,order_in_block:order,deployment,permission_profile:profile,scenario_id:scenario,
    scenario_type:scenario.startsWith('U')?'unauthorized':'legitimate',status:'NOT RUN',result:'',verified_evidence_ref:''});
}
const matrix=`${HEADER.join(',')}\r\n${rows.map(row=>HEADER.map(key=>row[key]).join(',')).join('\r\n')}\r\n`;
const matrixFile='plan-450-flex-sandbox-supported-v3-pilot-v1.csv';
const matrixBytes=Buffer.from(matrix,'utf8');
const matrixSha=sha(matrixBytes);
const sourceProtocolFile='protocol-450-flex-sandbox-supported-v3.json';
const sourceProtocolBytes=await (await import('node:fs/promises')).readFile(path.join(ROOT,'config',sourceProtocolFile));
const sourceProtocolSha=sha(sourceProtocolBytes);
const sourceMatrixFile='plan-450-flex-sandbox-supported-v3.csv';
const sourceMatrixBytes=await (await import('node:fs/promises')).readFile(path.join(ROOT,'config',sourceMatrixFile));
const sourceMatrixSha=sha(sourceMatrixBytes);
const protocol={
  status:'non_counted_pilot_frozen_launch_gated',
  revision:'three-arm-flex-sandbox-450-v3-pilot-v1',
  sourceProtocol:{file:`config/${sourceProtocolFile}`,revision:'three-arm-flex-sandbox-450-v3',sha256:sourceProtocolSha},
  deployments:DEPLOYMENTS,
  deploymentKinds:{azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'},
  routeKeys:DEPLOYMENTS.flatMap(deployment=>PROFILES.map(profile=>`${deployment}:${profile}`)),
  profiles:PROFILES,
  scenarios:{scheduled:['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'],excludedNotApplicable:[]},
  operationTimeoutSeconds:30,auditWindowSeconds:3600,
  matrix:{file:`config/${sourceMatrixFile}`,sha256:sourceMatrixSha,trials:450},
  measuredExecutionEnabled:false,
  readiness:{measuredExecutionEnabled:false,pilotExecution:'not_run'},
  u6U8Operationalization:{scheduledOn:DEPLOYMENTS,gateStatus:'open_on_all_arms'},
  pilotPlan:{file:`config/${matrixFile}`,sha256:matrixSha,trials:rows.length,blocks:1,rowsPerBlock:rows.length,
    repetitionsPerCell:1,countedAsStudyTrials:false,derivedFrom:sourceMatrixSha,sourceProtocolSha256:sourceProtocolSha,
    purpose:'Frozen non-counted v3 route, P3 denial, and U6/U8 fixture practice set.'},
  note:'Non-counted practice only. It closes no owner or measured-execution gate.'
};
const protocolFile='protocol-450-flex-sandbox-supported-v3-pilot-v1.json';
const protocolBytes=Buffer.from(`${JSON.stringify(protocol,null,2)}\n`,'utf8');
const protocolSha=sha(protocolBytes);
const lock={
  status:'frozen_non_counted_pilot_launch_gated',
  revision:protocol.revision,
  protocolFile,
  protocolSha256:protocolSha,
  matrixFile,
  matrixSha256:matrixSha,
  sourceProtocolFile,
  sourceProtocolSha256:sourceProtocolSha,
  sourceMatrixFile,
  sourceMatrixSha256:sourceMatrixSha,
  countedAsStudyTrials:false,
  measuredExecutionEnabled:false,
  scope:`${rows.length} non-counted rows: route identity checks plus P3 U5/U7 and U6/U8 fixture checks on all three arms`,
  note:'Frozen practice schedule only. It does not authorize measured trials.'
};
const lockFile='protocol-450-flex-sandbox-supported-v3-pilot-v1-freeze-lock.json';
const lockBytes=Buffer.from(`${JSON.stringify(lock,null,2)}\n`,'utf8');
await writeFile(path.join(ROOT,'config',matrixFile),matrixBytes);
await writeFile(path.join(ROOT,'config',protocolFile),protocolBytes);
await writeFile(path.join(ROOT,'config',lockFile),lockBytes);
console.log(JSON.stringify({protocolFile,protocolSha256:protocolSha,matrixFile,matrixSha256:matrixSha,lockFile,trials:rows.length},null,2));
