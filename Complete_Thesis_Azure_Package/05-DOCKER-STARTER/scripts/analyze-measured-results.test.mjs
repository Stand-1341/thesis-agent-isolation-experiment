import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {analyzeMeasuredResults} from './analyze-measured-results.mjs';
const header='planned_run_id,block,order_in_block,deployment,permission_profile,scenario_id,scenario_type,status,result,verified_evidence_ref';
const planBytes=Buffer.from([header,'r1,1,1,azure_vm,P1,U1,unauthorized,NOT RUN,,','r2,1,2,azure_functions_flex,P2,L1,legitimate,NOT RUN,,','r3,1,3,azure_custom_sessions_hyperv,P3,U6,unauthorized,NOT RUN,,'].join('\n')+'\n');
const planSha256=createHash('sha256').update(planBytes).digest('hex');
const trial=(runId,deployment,profile,scenario,order,classification)=>({runId,mode:'measured',arm:'deterministic',trial:{runId,planSha256,deployment,profile,scenario,block:1,order},classification});
const args={planBytes,planSha256};
test('reports missing and indeterminate separately for VM, Functions and session cells',()=>{
 const records=[trial('r1','azure_vm','P1','U1',1,'unauthorized_success'),trial('r3','azure_custom_sessions_hyperv','P3','U6',3,'indeterminate')];
 const report=analyzeMeasuredResults({...args,records});
 assert.deepEqual(report.totals,{planned:3,recorded:2,missing:1,classifications:{unauthorized_success:1,indeterminate:1},determinate:1});
 assert.equal(report.complete,false); assert.deepEqual(report.missingRunIds,['r2']);
 assert.equal(report.cells.find(c=>c.scenario==='U6').classifications.indeterminate,1);
});
test('rejects pilot, duplicate, unplanned, mismatched and inappropriate records',()=>{
 const r=trial('r1','azure_vm','P1','U1',1,'unauthorized_success');
 assert.throws(()=>analyzeMeasuredResults({...args,records:[{...r,mode:'non_counted_pilot'}]}),/selected measured arm/);
 assert.throws(()=>analyzeMeasuredResults({...args,records:[r,r]}),/duplicate/);
 assert.throws(()=>analyzeMeasuredResults({...args,records:[{...r,runId:'other'}]}),/not in the schedule/);
 assert.throws(()=>analyzeMeasuredResults({...args,records:[{...r,trial:{...r.trial,planSha256:'wrong'}}]}),/differ/);
 assert.throws(()=>analyzeMeasuredResults({...args,records:[{...r,classification:'legitimate_completion'}]}),/invalid classification/);
});
test('rejects wrong digest and does not treat not applicable as determinate',()=>{
 assert.throws(()=>analyzeMeasuredResults({planBytes,planSha256:'0'.repeat(64),records:[]}),/digest/);
 const records=[trial('r1','azure_vm','P1','U1',1,'confirmed_resource_denial'),trial('r2','azure_functions_flex','P2','L1',2,'legitimate_completion'),trial('r3','azure_custom_sessions_hyperv','P3','U6',3,'not_applicable')];
 assert.equal(analyzeMeasuredResults({...args,records}).complete,false);
});
