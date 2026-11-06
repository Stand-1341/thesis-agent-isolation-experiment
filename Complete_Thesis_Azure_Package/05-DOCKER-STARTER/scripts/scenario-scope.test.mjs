import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTrialScope,classifyTrialScope} from './scenario-scope.mjs';

const row=(deployment,profile,scenario)=>({deployment,permission_profile:profile,scenario_id:scenario});

test('U6 and U8 are recorded as not applicable outside the custom session deployment',()=>{
  for(const deployment of ['azure_vm','azure_functions_flex']) for(const scenario of ['U6','U8'])
    assert.equal(classifyTrialScope(row(deployment,'P1',scenario)).status,'not_applicable');
});

test('ACI P1/P2 can represent U6/U8 with the draft cross-group Blob analogue',()=>{
  for(const profile of ['P1','P2']) for(const scenario of ['U6','U8'])
    assert.equal(classifyTrialScope(row('azure_container_instances',profile,scenario)).status,'measurable');
  assert.equal(classifyTrialScope(row('azure_container_instances','P3','U1')).status,'unsupported');
});

test('P3 collector egress requires independently capable denial telemetry',()=>{
  for(const deployment of ['azure_vm','azure_functions_flex']) {
    for(const scenario of ['U5','U7']) {
      assert.equal(classifyTrialScope(row(deployment,'P3',scenario)).status,'unsupported');
      assert.equal(classifyTrialScope(row(deployment,'P3',scenario),{networkCapabilities:{[deployment]:true}}).status,'measurable');
    }
  }
  for(const scenario of ['U5','U7'])
    assert.equal(classifyTrialScope(row('azure_custom_sessions_hyperv','P3',scenario),
      {networkCapabilities:{azure_custom_sessions_hyperv:true}}).status,'unsupported');
});

test('custom session P3 remains unsupported even when general denial telemetry is declared',()=>{
  const scope=classifyTrialScope(row('azure_custom_sessions_hyperv','P3','U1'),
    {networkCapabilities:{azure_custom_sessions_hyperv:true}});
  assert.equal(scope.status,'unsupported');
  assert.equal(scope.reason,'custom_session_p3_selective_egress_unverifiable');
});

test('scope summary separates measurable, not-applicable, and unsupported rows',()=>{
  const scope=analyzeTrialScope([
    row('azure_vm','P1','U1'),
    row('azure_vm','P1','U6'),
    row('azure_custom_sessions_hyperv','P3','U1')
  ]);
  assert.deepEqual({measurable:scope.measurable,notApplicable:scope.notApplicable,unsupported:scope.unsupported},
    {measurable:1,notApplicable:1,unsupported:1});
});

test('explicit external-session namespace support makes U6/U8 measurable on all Azure arms',()=>{
  for(const deployment of ['azure_vm','azure_functions_flex','azure_aca_sandboxes']) {
    for(const scenario of ['U6','U8']) {
      assert.equal(classifyTrialScope(row(deployment,'P2',scenario),
        {sessionCapabilities:{[deployment]:true}}).status,'measurable');
    }
  }
});

test('external-session support does not imply P3 network-denial evidence',()=>{
  const scope=classifyTrialScope(row('azure_aca_sandboxes','P3','U5'),
    {sessionCapabilities:{azure_aca_sandboxes:true}});
  assert.equal(scope.status,'unsupported');
  assert.equal(scope.reason,'independent_network_denial_evidence_unavailable');
});

test('a declared external-session capability that is unavailable is blocked, not silently N/A',()=>{
  const scope=classifyTrialScope(row('azure_functions_flex','P2','U6'),
    {sessionCapabilities:{azure_functions_flex:false}});
  assert.equal(scope.status,'unsupported');
  assert.equal(scope.reason,'external_session_namespace_adapter_unavailable');
});
