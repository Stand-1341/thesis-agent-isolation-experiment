/**
 * Parallel execution of the frozen schedule.
 *
 * The sequential runner is correct but slow: 400 trials with a verification wait
 * each is a day, not an afternoon. Parallelising it carelessly would destroy the
 * data, because a trial owns the fixture it resets — two trials sharing one
 * resource service would read each other's records and every denial would be
 * unattributable.
 *
 * So concurrency is expressed as lanes. A lane is the unit of exclusive fixture
 * access: rows whose fixture identity matches run one-at-a-time inside that lane,
 * and distinct lanes run at the same time. The default lane key is the deployment,
 * because all three profiles of a deployment share its resource and collector.
 * A route that is given its own fixture endpoints becomes its own lane.
 *
 * Guarantees, all covered by tests:
 *   - two rows in the same lane never run concurrently;
 *   - results come back in the original schedule order, whatever order the lanes
 *     finished in, so evidence files stay deterministic;
 *   - the first indeterminate trial stops every lane from taking new work, and
 *     in-flight trials are allowed to finish rather than being abandoned;
 *   - the returned array carries the same halted/haltedAt/complete properties as
 *     the sequential runner, so nothing has to guess whether the matrix completed.
 */
const CLASSIFICATIONS=['unauthorized_success','confirmed_resource_denial','confirmed_network_denial',
  'legitimate_completion','legitimate_failed','agent_no_attempt','indeterminate','not_applicable'];

function validate(rows) {
  if(!Array.isArray(rows)) throw new Error('schedule must be an array');
  const ids=new Set();
  for(const row of rows) {
    if(!row || typeof row.planned_run_id!=='string' || !row.planned_run_id) throw new Error('schedule row has no run ID');
    if(ids.has(row.planned_run_id)) throw new Error(`duplicate run ID ${row.planned_run_id}`);
    ids.add(row.planned_run_id);
  }
}

/**
 * Default lane: one in-flight trial per deployment. Pass your own `laneFor` to go
 * wider, but only when the fixtures are genuinely separate — the function decides
 * how much of the experiment runs at once.
 */
export const laneByDeployment = row => row.deployment;

export async function runScheduleParallel(rows, runOne, {laneFor=laneByDeployment,concurrency=3}={}) {
  validate(rows);
  if(typeof runOne!=='function') throw new Error('runner required');
  if(typeof laneFor!=='function') throw new Error('laneFor must be a function');
  if(!Number.isInteger(concurrency) || concurrency<1 || concurrency>32) throw new Error('concurrency must be 1..32');

  const lanes=new Map();
  rows.forEach((row,index)=>{
    const key=laneFor(row);
    if(typeof key!=='string' || !key) throw new Error('laneFor must return a non-empty string');
    if(!lanes.has(key)) lanes.set(key,[]);
    lanes.get(key).push({row,index});
  });
  if(lanes.size>rows.length) throw new Error('impossible lane count');

  const results=new Array(rows.length).fill(undefined);
  const queue=[...lanes.entries()];
  let haltedAt=null;
  let notApplicableCount=0;
  let stopped=false;
  let firstError=null;

  async function runLane(items) {
    for(const {row,index} of items) {
      if(stopped) return;
      let record;
      try {
        record=await runOne({runId:row.planned_run_id,deployment:row.deployment,
          profile:row.permission_profile,scenario:row.scenario_id,
          block:Number(row.block),order:Number(row.order_in_block)});
      } catch (error) {
        firstError=firstError ?? error;
        stopped=true;
        return;
      }
      if(!record || record.runId!==row.planned_run_id) {
        firstError=firstError ?? new Error('runner returned mismatched run ID');
        stopped=true;
        return;
      }
      if(!CLASSIFICATIONS.includes(record.classification)) {
        firstError=firstError ?? new Error('runner returned invalid classification');
        stopped=true;
        return;
      }
      results[index]=record;
      if(record.classification==='not_applicable') { notApplicableCount++; continue; }
      if(record.classification==='indeterminate') {
        haltedAt=row.planned_run_id;
        // One unclassifiable trial invalidates the rest of the matrix, in every
        // lane. Stop taking work; trials already running are not killed.
        stopped=true;
        return;
      }
    }
  }

  const workerCount=Math.min(concurrency,queue.length);
  const workers=Array.from({length:workerCount},async()=>{
    while(queue.length && !stopped) {
      const entry=queue.shift();
      if(!entry) break;
      await runLane(entry[1]);
    }
  });
  await Promise.all(workers);

  const collected=results.filter(record=>record!==undefined);
  Object.defineProperties(collected,{
    halted:{value:haltedAt!==null,enumerable:false},
    haltedAt:{value:haltedAt,enumerable:false},
    complete:{value:haltedAt===null && firstError===null && collected.length===rows.length,enumerable:false},
    notApplicable:{value:notApplicableCount,enumerable:false},
    laneCount:{value:lanes.size,enumerable:false},
    concurrency:{value:workerCount,enumerable:false}
  });
  if(firstError) throw firstError;
  return collected;
}
