/** Validate a structured supplied schedule before handing any row to a runner. */
import {createHash} from 'node:crypto';
const deployments=['azure_vm','azure_functions_flex','azure_custom_sessions_hyperv','azure_container_instances'];
const profiles=['P1','P2','P3'];
const scenarios=['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'];

export function verifyPlanDigest(bytes, expectedSha256) {
  if (!Buffer.isBuffer(bytes) || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw new Error('invalid plan digest inputs');
  const actual=createHash('sha256').update(bytes).digest('hex');
  if (actual!==expectedSha256) throw new Error('plan differs from the frozen digest');
  return actual;
}

/** Parse only the simple unquoted matrix format after verifying the exact bytes. */
export function loadFrozenSchedule(bytes, expectedSha256, {allowRepeatedCellsWithinBlock=false}={}) {
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
  validateSchedule(rows,{allowRepeatedCellsWithinBlock});
  return {sha256,rows};
}

/** Gate and adapter validation remain the supplied runner's responsibility. */
export async function runFrozenSchedule(bytes,expectedSha256,runOne) {
  const plan=loadFrozenSchedule(bytes,expectedSha256);
  return runSchedule(plan.rows,trial=>runOne({...trial,planSha256:plan.sha256}));
}

/**
 * Structural validation only. The matrix size is NOT hardcoded: revision 1 withdrew
 * the session-arm P3 cells, so the schedule went from 450 rows to 400, and a
 * validator pinned to 450 would have made the revised plan unloadable. Integrity is
 * enforced by the frozen digest, not by a row count here — this function checks the
 * shape is coherent so a truncated or reordered file cannot pass as a complete one.
 *
 * Block sizes must be equal, block numbers contiguous from 1, order_in_block unique
 * and ascending within a block (gaps are expected: withdrawn cells leave holes).
 * Repeated deployment/profile/scenario cells inside a block are rejected by default;
 * a separately declared protocol may opt in when its plan intentionally schedules
 * multiple repetitions of the same cell within a block.
 */
export function validateSchedule(rows,{allowRepeatedCellsWithinBlock=false}={}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('schedule must contain rows');
  const ids = new Set();
  const cells = new Set();
  const perBlock = new Map();
  const lastOrder = new Map();
  for (const row of rows) {
    const block = Number(row.block);
    const order = Number(row.order_in_block);
    if (!Number.isInteger(block) || block < 1) throw new Error('invalid block number');
    if (!Number.isInteger(order) || order < 1) throw new Error('invalid block order');
    if (lastOrder.has(block) && order <= lastOrder.get(block)) throw new Error('invalid block order');
    lastOrder.set(block, order);
    perBlock.set(block, (perBlock.get(block) ?? 0) + 1);
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(row.planned_run_id || '') || ids.has(row.planned_run_id)) throw new Error('invalid or duplicate run ID');
    ids.add(row.planned_run_id);
    if (!deployments.includes(row.deployment) || !profiles.includes(row.permission_profile) || !scenarios.includes(row.scenario_id)) throw new Error('invalid trial cell');
    if(row.deployment==='azure_container_instances'&&!['P1','P2'].includes(row.permission_profile))
      throw new Error('azure_container_instances supports only P1 and P2');
    if (row.scenario_type !== (row.scenario_id.startsWith('U') ? 'unauthorized' : 'legitimate')) throw new Error('invalid scenario type');
    if (row.status !== 'NOT RUN' || row.result || row.verified_evidence_ref) throw new Error('schedule is not an untouched plan');
    const key=[block,row.deployment,row.permission_profile,row.scenario_id].join('|');
    if (cells.has(key) && !allowRepeatedCellsWithinBlock) throw new Error('duplicate trial cell');
    cells.add(key);
  }
  const blocks = [...perBlock.keys()].sort((a,b)=>a-b);
  if (blocks.length !== blocks.at(-1)) throw new Error('block numbers must be contiguous from 1');
  const sizes = new Set([...perBlock.values()]);
  if (sizes.size !== 1) throw new Error(`blocks must be the same size, got ${[...perBlock.entries()].map(([b,n])=>`${b}:${n}`).join(' ')}`);
  return {rows:rows.length, blocks:blocks.length, rowsPerBlock:[...sizes][0],
    unauthorized:rows.filter(row=>row.scenario_type==='unauthorized').length,
    legitimate:rows.filter(row=>row.scenario_type==='legitimate').length};
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
