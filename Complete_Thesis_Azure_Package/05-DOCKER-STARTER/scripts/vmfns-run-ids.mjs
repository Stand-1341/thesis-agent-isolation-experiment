const PROFILE=/^P[123]$/;
const SCENARIO=/^(?:U[1-8]|L[12])$/;
const DEPLOYMENT=/^(?:azure_vm|azure_functions_flex)$/;

/** Assign fresh IDs only after profile allocation is final. The ID encodes the
 * actual row fields, and its repetition suffix is counted in frozen row order.
 */
export function assignFreshVmFnsRunIds(rows,{prefix='r4-vmfns-idfix-v1'}={}) {
  if(!Array.isArray(rows)||!rows.length||!/^r4-vmfns-[a-z0-9-]{1,32}$/.test(prefix))
    throw new Error('invalid rows or VM/Functions run-ID prefix');
  const counts=new Map();
  const assigned=rows.map(row=>{
    if(!/^\d+$/.test(String(row?.block??''))||!DEPLOYMENT.test(row?.deployment??'')||
      !PROFILE.test(row?.permission_profile??'')||!SCENARIO.test(row?.scenario_id??''))
      throw new Error('cannot derive a run ID from an invalid VM/Functions row');
    const key=[row.block,row.deployment,row.permission_profile,row.scenario_id].join('|');
    const repetition=(counts.get(key)??0)+1;
    counts.set(key,repetition);
    return {...row,planned_run_id:`${prefix}-b${String(row.block).padStart(2,'0')}-${row.deployment}-${row.permission_profile}-${row.scenario_id}-r${String(repetition).padStart(2,'0')}`};
  });
  assertVmFnsRunIdsMatchRows(assigned,{prefix});
  return assigned;
}

export function assertVmFnsRunIdsMatchRows(rows,{prefix='r4-vmfns-idfix-v1'}={}) {
  const ids=new Set();
  for(const row of rows) {
    const escaped=prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const expected=new RegExp(`^${escaped}-b${String(row.block).padStart(2,'0')}-${row.deployment}-${row.permission_profile}-${row.scenario_id}-r\\d{2}$`);
    if(!expected.test(row.planned_run_id)||ids.has(row.planned_run_id))
      throw new Error(`run ID does not match its route/profile/scenario or is duplicated: ${row.planned_run_id}`);
    ids.add(row.planned_run_id);
  }
  return true;
}
