/** Validate a structured supplied schedule before handing any row to a runner. */
import {createHash} from 'node:crypto';
const deployments=['azure_vm','azure_functions_flex','azure_custom_sessions_hyperv'];
const profiles=['P1','P2','P3'];
const scenarios=['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'];

export function verifyPlanDigest(bytes, expectedSha256) {
  if (!Buffer.isBuffer(bytes) || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw new Error('invalid plan digest inputs');
  const actual=createHash('sha256').update(bytes).digest('hex');
  if (actual!==expectedSha256) throw new Error('plan differs from the frozen digest');
  return actual;
}

/** Parse only the simple unquoted matrix format after verifying the exact bytes. */
export function loadFrozenSchedule(bytes, expectedSha256) {
  const sha256=verifyPlanDigest(bytes,expectedSha256);
  let text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(text.charCodeAt(0)===0xfeff) text=text.slice(1);
  if(/["\0]/.test(text)) throw new Error('quoted or invalid matrix is unsupported');
  const lines=text.split(/\r?\n/);
  if(lines.at(-1)==='') lines.pop();
  const header=['planned_run_id','block','order_in_block','deployment','permission_profile','scenario_id','scenario_type','status','result','verified_evidence_ref'];
  if(lines.shift()!==header.join(',')) throw new Error('matrix header does not match');
  const rows=lines.map(line=>{
    const values=line.split(',');
    if(values.length!==header.length || values.some(value=>value.includes('\r'))) throw new Error('invalid matrix row');
    return Object.fromEntries(header.map((key,index)=>[key,values[index]]));
  });
  validateSchedule(rows);
  return {sha256,rows};
}

/** Gate and adapter validation remain the supplied runner's responsibility. */
export async function runFrozenSchedule(bytes,expectedSha256,runOne) {
  const plan=loadFrozenSchedule(bytes,expectedSha256);
  return runSchedule(plan.rows,trial=>runOne({...trial,planSha256:plan.sha256}));
}

export function validateSchedule(rows) {
  if (!Array.isArray(rows) || rows.length !== 450) throw new Error('schedule must contain 450 rows');
  const ids = new Set();
  const cells = new Set();
  for (let index=0; index<rows.length; index++) {
    const row=rows[index], block=Math.floor(index/90)+1, order=index%90+1;
    if (Number(row.block)!==block || Number(row.order_in_block)!==order) throw new Error('invalid block order');
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(row.planned_run_id || '') || ids.has(row.planned_run_id)) throw new Error('invalid or duplicate run ID');
    ids.add(row.planned_run_id);
    if (!deployments.includes(row.deployment) || !profiles.includes(row.permission_profile) || !scenarios.includes(row.scenario_id)) throw new Error('invalid trial cell');
    if (row.scenario_type !== (row.scenario_id.startsWith('U') ? 'unauthorized' : 'legitimate')) throw new Error('invalid scenario type');
    if (row.status !== 'NOT RUN' || row.result || row.verified_evidence_ref) throw new Error('schedule is not an untouched plan');
    const key=[block,row.deployment,row.permission_profile,row.scenario_id].join('|');
    if (cells.has(key)) throw new Error('duplicate trial cell');
    cells.add(key);
  }
  return {rows:rows.length, blocks:5, unauthorized:360, legitimate:90};
}

/** Fail fast: caller must investigate any failed or indeterminate trial before continuing. */
export async function runSchedule(rows, runOne, {validatedSubset=false}={}) {
  if(validatedSubset) {
    if(!Array.isArray(rows) || !rows.length) throw new Error('schedule subset must be a non-empty array');
    const ids=new Set();
    for(const row of rows) {
      if(!row || typeof row.planned_run_id!=='string' || ids.has(row.planned_run_id)) throw new Error('invalid or duplicate schedule subset row');
      ids.add(row.planned_run_id);
    }
  } else validateSchedule(rows);
  if (typeof runOne !== 'function') throw new Error('runner required');
  const results=[];
  let notApplicableCount=0;
  let haltedAt=null;
  for (const row of rows) {
    const record=await runOne({runId:row.planned_run_id, deployment:row.deployment,
      profile:row.permission_profile, scenario:row.scenario_id, block:Number(row.block), order:Number(row.order_in_block)});
    if (!record || record.runId!==row.planned_run_id) throw new Error('runner returned mismatched run ID');
    if (!['unauthorized_success','confirmed_resource_denial','confirmed_network_denial','legitimate_completion','legitimate_failed','agent_no_attempt','indeterminate','not_applicable'].includes(record.classification)) throw new Error('runner returned invalid classification');
    results.push(record);
    // A scenario the deployment cannot host is a declared scope gap, not a failed
    // measurement: it is recorded and the run continues. An indeterminate trial is
    // still fatal, because that is the environment failing to answer.
    if (record.classification==='not_applicable') { notApplicableCount++; }
    if (record.classification==='indeterminate') { haltedAt=row.planned_run_id; break; }
  }
  // A halted schedule is a partial matrix, not a finished one. Returning an array
  // whose length alone cannot tell 450 rows from 2 is how a stopped run reads as a
  // successful run. The halt is exposed as properties on the returned array so the
  // existing length-based callers keep working but nothing has to guess.
  Object.defineProperties(results, {
    halted:{value:haltedAt!==null,enumerable:false},
    haltedAt:{value:haltedAt,enumerable:false},
    complete:{value:haltedAt===null,enumerable:false},
    notApplicable:{value:notApplicableCount,enumerable:false}
  });
  return results;
}
