import assert from 'node:assert/strict';
import test from 'node:test';
import {createCollectorEffectMonitor} from './collector-effect-monitor.mjs';

const trial={runId:'monitor-run-001',scenario:'U5',deployment:'azure_container_apps_jobs',permission_profile:'P3'};
const observations={timing:{executionStartedAt:'2026-11-05T12:00:00.000Z',executionFinishedAt:'2026-11-05T12:00:01.000Z'},
  output:{runId:trial.runId,scenario:'U5',transportOk:false,errorType:'NetworkError'}};
const health={ready:true,journalEnabled:true,journalHealthy:true,observedAt:'2026-11-05T12:00:02.000Z'};
const validGates={collectorIndependentlyValidated:true,clockSyncValidated:true,collectorDurabilityValidated:true};

function monitorFor({collector={events:[]},health:healthValue=health,...options}={}) {
  return createCollectorEffectMonitor({...validGates,...options,
    readCollector:async runId=>{assert.equal(runId,trial.runId);return collector;},
    readMonitor:async()=>healthValue,pilotMode:true});
}

test('healthy durable receiver monitor plus no matching event confirms absence of effect',async()=>{
  const monitor=monitorFor();
  const result=await monitor(trial,observations);
  assert.equal(result.status,'no_effect');
  assert.equal(result.evidence.receiver.eventCount,0);
  assert.equal(result.evidence.monitor.journalEnabled,true);
  assert.equal(result.evidence.monitor.journalHealthy,true);
});

test('a receiver event in the execution window defeats a prevention claim',async()=>{
  const collector={events:[{runId:trial.runId,operation:'collect',at:'2026-11-05T12:00:00.500Z',requestId:'u5-123456789012'}]};
  const result=await monitorFor({collector})(trial,observations);
  assert.equal(result.status,'effect_present');
  assert.equal(result.evidence.receiver.eventCount,1);
});

test('missing, unhealthy, or non-durable monitor state is never absence evidence',async()=>{
  for(const monitorHealth of [null,{ready:false,journalEnabled:true,journalHealthy:false,observedAt:'2026-11-05T12:00:02.000Z'},
    {ready:true,journalEnabled:false,journalHealthy:false,observedAt:'2026-11-05T12:00:02.000Z'}]) {
    const result=await monitorFor({health:monitorHealth})(trial,observations);
    assert.notEqual(result.status,'no_effect');
  }
});

test('monitor readback must be after the trial window and event rows must be attributable',async()=>{
  const oldHealth={...health,observedAt:'2026-11-05T11:59:00.000Z'};
  assert.equal((await monitorFor({health:oldHealth})(trial,observations)).status,'incomplete');
  const unrelated={events:[{runId:trial.runId,operation:'restricted',at:'2026-11-05T12:00:00.500Z'}]};
  assert.equal((await monitorFor({collector:unrelated})(trial,observations)).status,'incomplete');
});

test('receiver monitor refuses mismatched workload output and enforces measured assertions',async()=>{
  const mismatched={...observations,output:{runId:'other-run',scenario:'U5'}};
  assert.equal((await monitorFor()(trial,mismatched)).status,'incomplete');
  assert.throws(()=>createCollectorEffectMonitor({
    readCollector:async()=>({events:[]}),readMonitor:async()=>health,
    collectorIndependentlyValidated:true,clockSyncValidated:true,collectorDurabilityValidated:false}),/pilot gates/);
});

test('U7 monitors the independent restricted-service contact event',async()=>{
  const restrictedTrial={...trial,scenario:'U7'};
  let requestedRun;
  const monitor=createCollectorEffectMonitor({...validGates,pilotMode:true,
    readCollector:async runId=>{requestedRun=runId;return {events:[]};},readMonitor:async()=>health});
  const result=await monitor(restrictedTrial,{...observations,output:{...observations.output,scenario:'U7'}});
  assert.equal(requestedRun,trial.runId);
  assert.equal(result.status,'no_effect');
  assert.equal(result.evidence.receiver.operation,'restricted');
});
