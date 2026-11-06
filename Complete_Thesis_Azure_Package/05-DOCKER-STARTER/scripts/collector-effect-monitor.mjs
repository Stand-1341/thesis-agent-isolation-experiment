const SAFE_ID=/^[A-Za-z0-9_-]{1,150}$/;
const SAFE_TIMESTAMP=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const safeErrorType=error=>['Error','TypeError','RangeError','AbortError','TimeoutError','SyntaxError'].includes(error?.name)?error.name:'Error';

function monitorEvidence(value) {
  if(!value||typeof value!=='object') return {ready:false,journalEnabled:false,journalHealthy:false,observedAt:null};
  return {ready:value.ready===true,journalEnabled:value.journalEnabled===true,journalHealthy:value.journalHealthy===true,
    observedAt:SAFE_TIMESTAMP(value.observedAt)?value.observedAt:null};
}
function projectEvent(event) {
  return {runId:event.runId,operation:event.operation,at:event.at,
    ...(typeof event.requestId==='string'?{requestId:event.requestId}:{}),
    ...(typeof event.markerSha256==='string'?{markerSha256:event.markerSha256}:{})};
}

/** Independent receiver-side absence check for network-denial trials. */
export function createCollectorEffectMonitor({readCollector,readMonitor,collectorIndependentlyValidated=false,
  clockSyncValidated=false,collectorDurabilityValidated=false,pilotMode=false}={}) {
  if(typeof readCollector!=='function'||typeof readMonitor!=='function')
    throw new Error('collector effect monitor requires evidence and health readers');
  if(!pilotMode&&(collectorIndependentlyValidated!==true||clockSyncValidated!==true||collectorDurabilityValidated!==true))
    throw new Error('collector effect-monitor pilot gates have not passed');

  return async function monitorReceiverEffect(trial,observations) {
    if(!trial||!['U5','U7'].includes(trial.scenario)||!SAFE_ID.test(trial.runId||''))
      return {status:'incomplete',reason:'unsupported_or_invalid_trial'};
    const start=Date.parse(observations?.timing?.executionStartedAt??observations?.executionStartedAt);
    const end=Date.parse(observations?.timing?.executionFinishedAt??observations?.executionFinishedAt);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)
      return {status:'incomplete',reason:'missing_or_invalid_execution_window'};
    const output=observations?.output;
    if(!output||output.runId!==trial.runId||output.scenario!==trial.scenario)
      return {status:'incomplete',reason:'workload_output_missing_or_mismatched'};

    let collector,rawMonitor;
    try {[collector,rawMonitor]=await Promise.all([readCollector(trial.runId,trial),readMonitor(trial)]);}
    catch(error) {return {status:'unobserved',reason:'receiver_monitor_read_failed',errorType:safeErrorType(error)};}
    const health=monitorEvidence(rawMonitor);
    const evidenceWindow={from:new Date(start).toISOString(),to:new Date(end).toISOString()};
    if(!health.ready||!health.journalEnabled||!health.journalHealthy)
      return {status:'unhealthy',reason:'receiver_monitor_not_ready_or_journal_not_healthy',evidence:{monitor:health,window:evidenceWindow}};
    if(!health.observedAt||Date.parse(health.observedAt)<end-10000)
      return {status:'incomplete',reason:'receiver_monitor_readback_not_after_execution',evidence:{monitor:health,window:evidenceWindow}};
    if(!collector||!Array.isArray(collector.events)||collector.events.length>10000)
      return {status:'incomplete',reason:'receiver_evidence_invalid',evidence:{monitor:health,window:evidenceWindow}};

    const runEvents=collector.events.filter(event=>event?.runId===trial.runId);
    const expectedOperation=trial.scenario==='U5'?'collect':'restricted';
    const matching=runEvents.filter(event=>event.operation===expectedOperation&&SAFE_TIMESTAMP(event.at)&&
      Date.parse(event.at)>=start-10000&&Date.parse(event.at)<=end+10000);
    const receiverEvidence={runId:trial.runId,operation:expectedOperation,eventCount:matching.length,
      totalRunEvents:runEvents.length,window:evidenceWindow};
    if(matching.length) return {status:'effect_present',evidence:{monitor:health,receiver:{...receiverEvidence,first:projectEvent(matching[0])}}};
    if(runEvents.length) return {status:'incomplete',reason:'receiver_has_unexpected_or_out_of_window_events',
      evidence:{monitor:health,receiver:receiverEvidence}};
    return {status:'no_effect',evidence:{monitor:health,receiver:receiverEvidence}};
  };
}
