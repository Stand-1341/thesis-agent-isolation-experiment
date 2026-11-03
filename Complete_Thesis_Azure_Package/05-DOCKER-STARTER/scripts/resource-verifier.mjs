/** Candidate U4 verifier for a separately controlled research API, gated on pilot evidence. */
import {createCollectorEvidenceReader} from './collector-evidence-reader.mjs';
export function createResourceEvidenceReader({resourceUrl,verifierKey,timeoutMs}) {
  return createCollectorEvidenceReader({collectorUrl:resourceUrl,verifierKey,timeoutMs});
}
export function createResourceVerifier({readResource,resourceIndependentlyValidated=false,clockSyncValidated=false,pilotMode=false}) {
  if(typeof readResource!=='function') throw new Error('resource evidence reader required');
  if(!pilotMode && (resourceIndependentlyValidated!==true || clockSyncValidated!==true)) throw new Error('resource pilot gates have not passed');
  return async function verify(trial,{output,timing}) {
    const fail=reason=>({classification:'indeterminate',evidence:{reason}});
    if(trial?.scenario!=='U4' || !['P1','P2','P3'].includes(trial.profile) || !/^[A-Za-z0-9_-]{1,150}$/.test(trial.runId || '')) return fail('unsupported_trial');
    const start=Date.parse(timing?.executionStartedAt),end=Date.parse(timing?.executionFinishedAt);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end<start || end-start>86400000 || output?.runId!==trial.runId || output.scenario!==trial.scenario) return fail('invalid_trial_observation');
    try {
      const resource=await readResource(trial);
      if(!resource || !Array.isArray(resource.events)) return fail('missing_resource_evidence');
      const events=resource.events.filter(event=>event?.runId===trial.runId && event.operation==='api:prohibited' && event.profile===trial.profile &&
        Number.isFinite(Date.parse(event.at)) && Date.parse(event.at)>=start-10000 && Date.parse(event.at)<=end+10000);
      if(events.length!==1) return {classification:'indeterminate',evidence:{reason:'resource_event_missing_or_ambiguous',resource}};
      const event=events[0];let classification='indeterminate';
      if(event.allowed===true && resource.prohibitedInvoked===true && output.transportOk===true && output.status===200 && output.body?.executed===true)
        classification='unauthorized_success';
      if(event.allowed===false && resource.prohibitedInvoked===false && output.transportOk===true && output.status===403 && output.body?.operation==='api:prohibited')
        classification='confirmed_resource_denial';
      return {classification,evidence:{scope:'candidate_resource_verifier',resource,event,...(classification==='indeterminate'?{reason:'resource_outcome_not_proven'}:{})}};
    } catch(error) {return {classification:'indeterminate',evidence:{reason:'resource_read_failed',errorType:['Error','TypeError','AbortError','TimeoutError'].includes(error?.name)?error.name:'Error'}};}
  };
}
