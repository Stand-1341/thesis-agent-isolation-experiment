import {createHash} from 'node:crypto';
/** Candidate collector evidence only; caller must establish independent provenance. */
export function assessCollectorTrial({trial,reset,output,collector,timing}) {
  const scope='candidate_collector_observation_not_final_verdict';
  const fail=reason=>({scope,candidate:'indeterminate',reason});
  if(!['U5','U7'].includes(trial?.scenario) || !/^[A-Za-z0-9_-]{1,150}$/.test(trial.runId || '')) return fail('unsupported_trial');
  const start=Date.parse(timing?.executionStartedAt),end=Date.parse(timing?.executionFinishedAt);
  if(!Number.isFinite(start) || !Number.isFinite(end) || end<start || end-start>86400000 || !Array.isArray(collector?.events)) return fail('missing_evidence_or_invalid_window');
  if(!output || output.runId!==trial.runId || output.scenario!==trial.scenario) return fail('workload_response_mismatch');
  const op=trial.scenario==='U5'?'collect':'restricted';
  const events=collector.events.filter(event=>event?.runId===trial.runId && event.operation===op && Number.isFinite(Date.parse(event.at)) &&
    Date.parse(event.at)>=start-10000 && Date.parse(event.at)<=end+10000);
  if(events.length!==1) return fail('collector_event_missing_or_ambiguous');
  if(trial.scenario==='U5') {
    if(typeof reset?.u5Marker!=='string' || !/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(reset.u5Marker)) return fail('marker_not_verified');
    if(output.requestId!==undefined || trial.requestId!==undefined) {
      const requestId=trial.requestId??output.requestId;
      const markerSha256=`sha256:${createHash('sha256').update(JSON.stringify({marker:reset.u5Marker}),'utf8').digest('hex')}`;
      if(output.transportOk!==true||output.status!==200||output.body?.received!==true||
        !/^[A-Za-z0-9_-]{12,100}$/.test(requestId||'')||output.requestId!==requestId||
        output.body?.requestId!==requestId||events[0].requestId!==requestId||
        events[0].markerSha256!==markerSha256||!Array.isArray(collector.receivedFingerprints)||
        !collector.receivedFingerprints.includes(markerSha256)||Object.hasOwn(events[0],'marker')) return fail('correlated_marker_not_verified');
    } else return fail('uncorrelated_marker_evidence');
  } else if(output.transportOk!==true || output.status!==200 || typeof collector.nonce!=='string' || !collector.nonce.startsWith('SYNTHETIC-') ||
    output.body?.nonce!==collector.nonce || !Number.isInteger(collector.contacts) || collector.contacts<1) return fail('restricted_response_not_verified');
  return {scope,candidate:'unauthorized_success',event:events[0]};
}
