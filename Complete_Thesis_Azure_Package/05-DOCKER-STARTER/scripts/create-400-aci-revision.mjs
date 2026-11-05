#!/usr/bin/env node
/** Build a new 400-row ACI replacement draft without modifying historical matrices. */
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'..','..');
const sourcePath=resolve(root,'03-PLANNED-TRIAL-MATRIX-400-REV2.csv');
const archivedProtocolPath=resolve(here,'../config/protocol-400-rev2.archived.json');
const targetPath=resolve(root,'03-PLANNED-TRIAL-MATRIX-400-REV4-ACI-DRAFT.csv');
const protocolPath=resolve(here,'../config/protocol-400-rev4-aci-draft.json');
const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
const source=(await readFile(sourcePath,'utf8')).replace(/^\uFEFF/,'');
const lines=source.trimEnd().split(/\r?\n/);
const header='planned_run_id,block,order_in_block,deployment,permission_profile,scenario_id,scenario_type,status,result,verified_evidence_ref';
if(lines.shift()!==header) throw new Error('revision-2 matrix header differs from expected schema');
const rows=lines.map((line,index)=>{
  const cells=line.split(',');
  if(cells.length!==10) throw new Error(`revision-2 row ${index+1} has an invalid column count`);
  const [,block,order,deployment,profile,scenario,type,status,result,evidence]=cells;
  const replacement=deployment==='azure_custom_sessions_hyperv'?'azure_container_instances':deployment;
  if(!['azure_vm','azure_functions_flex','azure_container_instances'].includes(replacement))
    throw new Error(`unexpected deployment in source row ${index+1}`);
  if(replacement==='azure_container_instances'&&!['P1','P2'].includes(profile))
    throw new Error(`unsupported ACI profile in source row ${index+1}`);
  return {block:Number(block),order:Number(order),deployment:replacement,profile,scenario,type,
    runId:`r4-b${String(block).padStart(2,'0')}-${String(order).padStart(2,'0')}-${replacement}-${profile}-${scenario}`,
    type,status:'NOT RUN',result:'',evidence:''};
});
const cells=new Map();
for(const row of rows) {
  const key=`${row.deployment}:${row.profile}`;
  cells.set(key,(cells.get(key)??0)+1);
}
if(rows.length!==400||cells.size!==8||[...cells.values()].some(count=>count!==50))
  throw new Error('generated matrix is not 400 rows across eight 50-row cells');
const unauthorized=rows.filter(row=>row.type==='unauthorized').length;
const legitimate=rows.filter(row=>row.type==='legitimate').length;
if(unauthorized!==320||legitimate!==80) throw new Error('scenario balance differs from the frozen rev-2 plan');
const matrix=[header,...rows.map(row=>[row.runId,row.block,row.order,row.deployment,row.profile,row.scenario,row.type,
  row.status,row.result,row.evidence].join(','))].join('\n')+'\n';
const digest=sha256(matrix);
const old=JSON.parse(await readFile(archivedProtocolPath,'utf8'));
const protocol={...old,
  status:'owner_approved_pending_validation',
  revision:'azure-proposed-v1-rev4-aci-draft',
  deployments:['azure_vm','azure_functions_flex','azure_container_instances'],
  expectedDeterministicTrials:400,
  notes:'New owner-directed draft. It preserves VM/Functions rows and substitutes ACI P1/P2 for the two withdrawn ACA cells. ACI group isolation replaces ACA session lifecycle; U6/U8 are cross-group Blob-marker analogues, not native session-memory tests. This draft is not frozen and no counted row may run until route, scenario, verifier, and evidence gates pass.',
  matrix:{file:'03-PLANNED-TRIAL-MATRIX-400-REV4-ACI-DRAFT.csv',sha256:digest,trials:400,blocks:5,rowsPerBlock:80,
    unauthorized,legitimate,supersedes:{file:'03-PLANNED-TRIAL-MATRIX-400-REV2.csv',
      sha256:old.matrix?.sha256??'d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863',trials:400},
    predecessor:{file:'03-PLANNED-TRIAL-MATRIX-300-REV3.csv',sha256:'a6bc3ffe78d677d25e07452e06cfc437062fdd9e8322b4c834d31118337ccc7e',trials:300}},
  methodChange:{approvedByStudyOwner:true,approvalReference:'file:../docs/400-ACI-OWNER-METHOD-DIRECTION.md',
    changes:['ACA P1/P2 cells replaced by ACI P1/P2 cells','U6/U8 use cross-group Blob marker analogues',
      'ACI P1/P2 are sequential per-trial container groups'],
    externalReviewStatus:'not_claimed',validationStatus:'pending'}
};
await writeFile(targetPath,matrix,'utf8');
await writeFile(protocolPath,JSON.stringify(protocol,null,2)+'\n','utf8');
console.log(JSON.stringify({scope:'draft_matrix_generation_only_no_trials',matrixFile:targetPath,
  protocolFile:protocolPath,rows:rows.length,unauthorized,legitimate,routeCells:Object.fromEntries(cells),sha256:digest,
  countedTrialsExecuted:0}));
