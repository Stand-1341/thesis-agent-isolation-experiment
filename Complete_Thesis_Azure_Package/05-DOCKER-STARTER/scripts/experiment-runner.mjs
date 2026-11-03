/** Compose the existing scheduler and trial runner; readiness flags remain operator assertions. */
import {loadFrozenSchedule,runSchedule} from './trial-schedule.mjs';
import {runScheduleParallel,laneByDeployment} from './parallel-schedule.mjs';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';
import {runTrial} from './trial-runner.mjs';
import {createGPT5MiniLiveAdapter} from './live-agent-trial.mjs';
import {verifyImplementationManifest} from './implementation-manifest.mjs';
import {analyzeTrialScope,classifyTrialScope} from './scenario-scope.mjs';

export async function runExperiment({planBytes,planSha256,routes,gates,verifier,evidenceStore,arm='deterministic',modelEndpoint,getModelToken,maxPhaseSpendUsd=19,implementationSha256,rowFilter,concurrency=1,laneFor=laneByDeployment,networkCapabilities={}}) {
  if(!['deterministic','gpt5mini_live'].includes(arm)) throw new Error('invalid experiment arm');
  if(typeof verifier!=='function' || !evidenceStore || typeof evidenceStore.claim!=='function' || typeof evidenceStore.save!=='function')
    throw new Error('verifier and evidence store are required');
  // Capture gate values once so later mutation cannot change the configuration
  // midway through a scheduled run. These flags are not proof of the gates.
  const gateSnapshot=Object.freeze(Object.fromEntries(['protocolFrozen','deploymentValidated','isolationValidated','verifierValidated'].map(key=>[key,gates?.[key]===true])));
  if(Object.values(gateSnapshot).some(value=>!value)) throw new Error('experiment readiness gates have not all passed');
  if(arm==='gpt5mini_live') await verifyImplementationManifest(implementationSha256);
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
  const scope=analyzeTrialScope(rows,{networkCapabilities});
  if(scope.unsupported) {
    const details=Object.entries(scope.unsupportedByRoute).map(([route,count])=>`  ${route}: ${count} row(s)`).join('\n');
    throw new Error(`run scope includes unsupported trial cells; no trials were claimed or executed:\n${details}`);
  }
  const requiredRoutes=new Set(rows.map(row=>`${row.deployment}:${row.permission_profile ?? row.profile}`));
  const selectedRoutes=Object.fromEntries(Object.entries(routes).filter(([key])=>requiredRoutes.has(key)));
  const router=createTrialAdapterRouter(selectedRoutes,{requiredRoutes:[...requiredRoutes]});
  const adapter=arm==='gpt5mini_live'?createGPT5MiniLiveAdapter({baseAdapter:router,endpoint:modelEndpoint,getToken:getModelToken,maxPhaseSpendUsd}):router;
  // The in-process model budget counter cannot be safely restored after a
  // crash or an uncertain response. A durable exclusive phase claim prevents
  // an automatic relaunch with a fresh counter; manual reconciliation is required.
  if(arm==='gpt5mini_live') await evidenceStore.claim('phase-gpt5mini-live');
  const runOne=async trial=>{
    const disposition=classifyTrialScope(trial,{networkCapabilities});
    if(disposition.status==='not_applicable') {
      const startedAt=new Date().toISOString();
      await evidenceStore.claim(trial.runId);
      const record={runId:trial.runId,arm,trial:{...trial,planSha256:plan.sha256},startedAt,
        finishedAt:new Date().toISOString(),classification:'not_applicable',executionAttempted:false,
        evidence:{scope:'preflight_applicability',reason:disposition.reason,deployment:trial.deployment,scenario:trial.scenario}};
      await evidenceStore.save(record);
      return record;
    }
    return runTrial({trial:{...trial,planSha256:plan.sha256},gates:gateSnapshot,adapter,arm,
      verifier:(t,observations)=>verifier(t,{...observations,workloadPrincipalId:router.principalObjectId(t),arm}),evidenceStore});
  };
  // Lanes, not raw concurrency: a lane owns the fixture its trials reset, so two
  // trials may only overlap when they cannot observe each other's state.
  if(!Number.isInteger(concurrency) || concurrency<1) throw new Error('invalid concurrency');
  const fullMatrixSelected=rows.length===plan.rows.length && rows.every((row,index)=>row.planned_run_id===plan.rows[index].planned_run_id);
  // `rows` is a filtered view of the already digest-verified 400-row plan.
  const results=concurrency===1?await runSchedule(rows,runOne,{validatedSubset:true}):await runScheduleParallel(rows,runOne,{laneFor,concurrency});
  Object.defineProperties(results,{
    fullMatrixSelected:{value:fullMatrixSelected,enumerable:false},
    matrixComplete:{value:fullMatrixSelected && results.complete===true,enumerable:false},
    scopeSummary:{value:{plannedMatrixRows:plan.rows.length,selectedRows:rows.length,
      measurableRows:scope.measurable,notApplicableRows:scope.notApplicable,unsupportedRows:scope.unsupported},enumerable:false}
  });
  return results;
}
