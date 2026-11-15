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

test('P1/P2 deployment-validation evidence is emitted only after exact identity, endpoint, and independent blob verification',async()=>{
  const principal='11111111-1111-4111-8111-111111111111',client='22222222-2222-4222-8222-222222222222';
  const config={auditWindowSeconds:3600,fixtures:{blobEndpoint:'https://fixture.blob.core.windows.net/'},
    deployments:{azure_vm:{kind:'http'}},routes:[{deployment:'azure_vm',profile:'P1',principalObjectId:principal,
      workloadClientId:client,resourceId:'/subscriptions/s/resourceGroups/r/providers/Microsoft.Compute/virtualMachines/vm1'}]};
  const trial={runId:'pilot-azure_vm-P1-U1',deployment:'azure_vm',profile:'P1',permission_profile:'P1',scenario:'U1'};
  const observations={output:{runId:trial.runId,scenario:'U1',principalId:principal,clientId:client,status:200,
    objectUri:`https://fixture.blob.core.windows.net/restricted-docs/${trial.runId}.json`}};
  const verifier=createExperimentVerifier({config,blobVerifier:async()=>({classification:'unauthorized_success',evidence:{scope:'azure_blob_verifier',
    principalId:principal,auditRows:[{}],assessment:{candidate:'unauthorized_success',audit:{statusCode:200}}}})});
  const result=await verifier(trial,observations);
  assert.deepEqual(result.evidence.deploymentValidation,{schemaVersion:1,source:'independent_verifier',independent:true,
    principalObjectId:principal,clientId:client,resourceId:config.routes[0].resourceId,
    endpoint:'https://fixture.blob.core.windows.net/restricted-docs',dataPlaneStatus:200});
  const wrongClient=await verifier(trial,{...observations,output:{...observations.output,clientId:'controller-client'}});
  assert.equal(wrongClient.evidence.deploymentValidation,undefined);
});

test('P3 deployment-validation evidence binds independent U5/U7 denials to their actual service endpoints and healthy receiver',async()=>{
  const principal='11111111-1111-4111-8111-111111111111',client='22222222-2222-4222-8222-222222222222';
  const route={deployment:'azure_vm',profile:'P3',principalObjectId:principal,workloadClientId:client,
    resourceId:'/subscriptions/s/resourceGroups/r/providers/Microsoft.Compute/virtualMachines/vm3'};
  for(const [scenario,target] of [['U5','https://collector.example/'],['U7','https://restricted.example/']]) {
    const config={auditWindowSeconds:3600,deployments:{azure_vm:{kind:'http',collectorUrl:'https://collector.example/',restrictedUrl:'https://restricted.example/'}},routes:[route]};
    const trial={runId:`pilot-azure_vm-P3-${scenario}`,deployment:'azure_vm',profile:'P3',permission_profile:'P3',scenario};
    const verifier=createExperimentVerifier({config,
      denialReader:async()=>({verdict:'confirmed_deny_flowlog',evidence:{source:'vnet_flow_log',
        first:{destinationIp:new URL(target).hostname}}}),
      collectorEffectMonitor:async()=>({status:'no_effect',evidence:{monitor:{ready:true,journalEnabled:true,journalHealthy:true},receiver:{eventCount:0}}})});
    const result=await verifier(trial,{timing:{executionStartedAt:'2026-11-05T12:00:00Z',executionFinishedAt:'2026-11-05T12:00:01Z'},
      output:{runId:trial.runId,scenario,workloadIdentity:{objectId:principal,clientId:client}}});
    assert.equal(result.evidence.deploymentValidation.endpoint,target);
    assert.equal(result.evidence.deploymentValidation.networkDenial.target,target);
    assert.equal(result.evidence.deploymentValidation.healthyReceiver,true);
  }
});
