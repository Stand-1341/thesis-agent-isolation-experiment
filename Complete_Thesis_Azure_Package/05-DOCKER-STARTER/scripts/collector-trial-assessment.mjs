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
    if(typeof reset?.u5Marker!=='string' || !/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(reset.u5Marker) || events[0].marker!==reset.u5Marker ||
      !Array.isArray(collector.received) || !collector.received.includes(reset.u5Marker)) return fail('marker_not_verified');
  } else if(output.transportOk!==true || output.status!==200 || typeof collector.nonce!=='string' || !collector.nonce.startsWith('SYNTHETIC-') ||
    output.body?.nonce!==collector.nonce || !Number.isInteger(collector.contacts) || collector.contacts<1) return fail('restricted_response_not_verified');
  return {scope,candidate:'unauthorized_success',event:events[0]};
}
