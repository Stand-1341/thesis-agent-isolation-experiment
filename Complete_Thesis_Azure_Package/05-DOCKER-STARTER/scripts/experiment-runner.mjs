/** Compose the existing scheduler and trial runner; readiness flags remain operator assertions. */
import {loadFrozenSchedule,runSchedule} from './trial-schedule.mjs';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';
import {runTrial} from './trial-runner.mjs';
import {createGPT5MiniLiveAdapter} from './live-agent-trial.mjs';
import {verifyImplementationManifest} from './implementation-manifest.mjs';

export async function runExperiment({planBytes,planSha256,routes,gates,verifier,evidenceStore,arm='deterministic',modelEndpoint,getModelToken,maxPhaseSpendUsd=19,implementationSha256,rowFilter}) {
  if(!['deterministic','gpt5mini_live'].includes(arm)) throw new Error('invalid experiment arm');
  if(typeof verifier!=='function' || !evidenceStore || typeof evidenceStore.claim!=='function' || typeof evidenceStore.save!=='function')
    throw new Error('verifier and evidence store are required');
  // Capture gate values once so later mutation cannot change the configuration
  // midway through a scheduled run. These flags are not proof of the gates.
  const gateSnapshot=Object.freeze(Object.fromEntries(['protocolFrozen','deploymentValidated','isolationValidated','verifierValidated'].map(key=>[key,gates?.[key]===true])));
  if(Object.values(gateSnapshot).some(value=>!value)) throw new Error('experiment readiness gates have not all passed');
  if(arm==='gpt5mini_live') await verifyImplementationManifest(implementationSha256);
  const router=createTrialAdapterRouter(routes);
  const adapter=arm==='gpt5mini_live'?createGPT5MiniLiveAdapter({baseAdapter:router,endpoint:modelEndpoint,getToken:getModelToken,maxPhaseSpendUsd}):router;
  const plan=loadFrozenSchedule(planBytes,planSha256);
  if(plan.rows.some(row=>arm==='gpt5mini_live'?!row.planned_run_id.startsWith('live-'):row.planned_run_id.startsWith('live-')))
    throw new Error('schedule run IDs do not belong to the selected experiment arm');
  // A pilot or a single-arm rerun needs a subset of the frozen schedule without
  // re-freezing it. The digest check above always covers the whole file, so a
  // filtered run still proves which matrix it came from.
  let rows=plan.rows;
  if(rowFilter!==undefined) {
    if(!(rowFilter instanceof Set) || !rowFilter.size) throw new Error('rowFilter must be a non-empty Set of run IDs');
    rows=plan.rows.filter(row=>rowFilter.has(row.planned_run_id));
    if(rows.length!==rowFilter.size) throw new Error('rowFilter contains run IDs that are not in the frozen schedule');
    if(!rows.length) throw new Error('rowFilter selected no scheduled trials');
  }
  // The in-process model budget counter cannot be safely restored after a
  // crash or an uncertain response. A durable exclusive phase claim prevents
  // an automatic relaunch with a fresh counter; manual reconciliation is required.
  if(arm==='gpt5mini_live') await evidenceStore.claim('phase-gpt5mini-live');
  return runSchedule(rows,trial=>runTrial({trial:{...trial,planSha256:plan.sha256},gates:gateSnapshot,adapter,arm,
    verifier:(t,observations)=>verifier(t,{...observations,workloadPrincipalId:router.principalObjectId(t),arm}),evidenceStore}));
}
