import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assignFreshVmFnsRunIds,assertVmFnsRunIdsMatchRows} from './vmfns-run-ids.mjs';

test('fresh VM/Functions run IDs derive from final route, profile, scenario, and row order',()=>{
  const rows=[
    {block:'1',order_in_block:'1',deployment:'azure_functions_flex',permission_profile:'P3',scenario_id:'U2',planned_run_id:'stale-P1-id'},
    {block:'1',order_in_block:'2',deployment:'azure_functions_flex',permission_profile:'P3',scenario_id:'U2',planned_run_id:'stale-P1-id-2'},
    {block:'1',order_in_block:'3',deployment:'azure_functions_flex',permission_profile:'P1',scenario_id:'U2',planned_run_id:'stale-P3-id'},
  ];
  const assigned=assignFreshVmFnsRunIds(rows);
  assert.deepEqual(assigned.map(row=>row.planned_run_id),[
    'r4-vmfns-idfix-v1-b01-azure_functions_flex-P3-U2-r01',
    'r4-vmfns-idfix-v1-b01-azure_functions_flex-P3-U2-r02',
    'r4-vmfns-idfix-v1-b01-azure_functions_flex-P1-U2-r01',
  ]);
  assert.deepEqual(assigned.map(({block,order_in_block,deployment,permission_profile,scenario_id})=>
    ({block,order_in_block,deployment,permission_profile,scenario_id})),
    rows.map(({block,order_in_block,deployment,permission_profile,scenario_id})=>
      ({block,order_in_block,deployment,permission_profile,scenario_id})));
  assert.equal(rows[0].planned_run_id,'stale-P1-id');
  assert.equal(assertVmFnsRunIdsMatchRows(assigned),true);
  assert.throws(()=>assertVmFnsRunIdsMatchRows([{...assigned[0],planned_run_id:'r4-vmfns-idfix-v1-b01-azure_functions_flex-P1-U2-r01'}]),
    /does not match/);
});

test('400-row IDFIX matrix IDs match all route/profile/scenario cells without changing assignments or order',()=>{
  const parse=path=>{
    const [header,...lines]=readFileSync(path,'utf8').trimEnd().split(/\r?\n/);
    const keys=header.split(',');
    return lines.map(line=>Object.fromEntries(line.split(',').map((value,index)=>[keys[index],value])));
  };
  const oldRows=parse(new URL('../../03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V3.csv',import.meta.url));
  const newRows=parse(new URL('../../03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V4-IDFIX.csv',import.meta.url));
  assert.equal(oldRows.length,400);
  assert.equal(newRows.length,400);
  assertVmFnsRunIdsMatchRows(newRows);
  const assignmentFields=['block','order_in_block','deployment','permission_profile','scenario_id','scenario_type','status','result','verified_evidence_ref'];
  assert.deepEqual(newRows.map(row=>assignmentFields.map(field=>row[field])),
    oldRows.map(row=>assignmentFields.map(field=>row[field])));
  assert.equal(newRows.some(row=>oldRows.some(old=>old.planned_run_id===row.planned_run_id)),false);
});
