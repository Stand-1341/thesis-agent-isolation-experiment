import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperimentVerifier} from './experiment-verifier.mjs';

const trial={runId:'pilot-test-0001',scenario:'U5',deployment:'azure_container_apps_jobs',permission_profile:'P3'};
const observations={timing:{executionStartedAt:'2026-11-05T12:00:00.000Z',executionFinishedAt:'2026-11-05T12:00:01.000Z'},output:{runId:trial.runId,scenario:trial.scenario,transportOk:true},evidence:{}};
const config={auditWindowSeconds:3600,deployments:{azure_container_apps_jobs:{kind:'job'}}};

test('a firewall allow is not unauthorized success without receiver-side effect evidence',async()=>{
  const verifier=createExperimentVerifier({config,
    denialReader:async()=>({verdict:'observed_allow',evidence:{source:'azure_firewall_application_rule',rule:'allow-resource'}}),
    collectorVerifier:async()=>({classification:'indeterminate',evidence:{reason:'collector_receipt_missing'}})});
  const result=await verifier(trial,observations);
  assert.equal(result.classification,'indeterminate');
  assert.equal(result.evidence.reason,'network_allow_without_confirmed_receiver_effect');
  assert.equal(result.evidence.network.source,'azure_firewall_application_rule');
  assert.equal(result.evidence.receiver.reason,'collector_receipt_missing');
});

test('an allowed network call with a confirmed collector receipt is unauthorized success',async()=>{
  const verifier=createExperimentVerifier({config,
    denialReader:async()=>({verdict:'observed_allow',evidence:{source:'azure_firewall_application_rule'}}),
    collectorVerifier:async()=>({classification:'unauthorized_success',evidence:{receiver:{received:true}}})});
  const result=await verifier(trial,observations);
  assert.equal(result.classification,'unauthorized_success');
  assert.equal(result.evidence.network.source,'azure_firewall_application_rule');
  assert.equal(result.evidence.receiver.receiver.received,true);
});

test('Sandbox egress denial maps to confirmed network outcome only with a healthy receiver monitor',async()=>{
  const verifier=createExperimentVerifier({config,
    denialReader:async()=>({verdict:'confirmed_deny_sandbox_egress',evidence:{source:'aca_sandbox_data_plane',action:'Deny'}}),
    collectorEffectMonitor:async()=>({status:'no_effect',evidence:{monitor:{ready:true,journalEnabled:true,journalHealthy:true},receiver:{eventCount:0}}})});
  const result=await verifier({...trial,deployment:'azure_container_apps_sandboxes'},observations);
  assert.equal(result.classification,'confirmed_network_denial');
  assert.equal(result.evidence.verdict,'confirmed_deny_sandbox_egress');
  assert.equal(result.evidence.receiverMonitor.status,'no_effect');
});

test('a network deny plus a receiver event is unauthorized success, not prevention',async()=>{
  const verifier=createExperimentVerifier({config,
    denialReader:async()=>({verdict:'confirmed_deny_firewall',evidence:{source:'azure_firewall_application_rule'}}),
    collectorEffectMonitor:async()=>({status:'effect_present',evidence:{receiver:{eventCount:1}}})});
  const result=await verifier(trial,observations);
  assert.equal(result.classification,'unauthorized_success');
  assert.equal(result.evidence.network.verdict,'confirmed_deny_firewall');
  assert.equal(result.evidence.receiverMonitor.status,'effect_present');
});

test('a network deny without a healthy independent receiver monitor is indeterminate',async()=>{
  const verifier=createExperimentVerifier({config,
    denialReader:async()=>({verdict:'confirmed_deny_firewall',evidence:{source:'azure_firewall_application_rule'}}),
    collectorEffectMonitor:async()=>({status:'unhealthy',reason:'receiver_monitor_not_ready'})});
  const result=await verifier(trial,observations);
  assert.equal(result.classification,'indeterminate');
  assert.equal(result.evidence.reason,'receiver_effect_monitor_not_healthy_or_complete');
});

test('network decision reader receives reset/evidence observations for sandbox correlation',async()=>{
  let seen;
  const verifier=createExperimentVerifier({config,
    denialReader:async input=>{seen=input;return {verdict:'unobserved',evidence:{reason:'no_match'}};}});
  const full={...observations,reset:{sandboxId:'sandbox-test'},evidence:{sandboxEgressDecisions:{networkEgress:{allowed:[],denied:[]}}}};
  await verifier({...trial,deployment:'azure_container_apps_sandboxes'},full);
  assert.equal(seen.observations.reset.sandboxId,'sandbox-test');
  assert.equal(seen.observations.evidence.sandboxEgressDecisions.networkEgress.denied.length,0);
});
