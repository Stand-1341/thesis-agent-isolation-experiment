import test from 'node:test';
import assert from 'node:assert/strict';
import {loadVmFunctionsPreflightEnvironment,buildVmFunctionsPreflightArgs} from './run-keyvault-vmfns-rev4-preflight.mjs';

function fixtureFetch(calls) {
  return async (url,options={})=>{
    const value=String(url);
    calls.push(value);
    if(value.startsWith('http://169.254.169.254/')) return Response.json({access_token:'mock-token'});
    return Response.json({value:'s'.repeat(48)});
  };
}

test('full 400 preflight loads confirmed six-route secrets in memory without setting readiness assertions',async()=>{
  const calls=[];
  const env=await loadVmFunctionsPreflightEnvironment({env:{},fetchImpl:fixtureFetch(calls)});
  for(const name of ['vm-p1-controller-key','vm-p2-controller-key','vm-p3-centralus-trial-request-key',
    'functions-p1-controller-key','functions-p1-function-key','functions-p2-controller-key','functions-p2-function-key',
    'functions-p3-controller-key','functions-p3-function-key','resource-admin-key','collector-admin-key',
    'vm-resource-verifier-key','vm-collector-verifier-key','functions-p1-resource-verifier-key','functions-p1-collector-verifier-key'])
    assert.ok(calls.some(url=>url.includes(`/secrets/${name}?`)),`${name} retrieved`);
  assert.equal(env.THESIS_VM_P3_DENIAL_TELEMETRY,'azure_diagnostics_firewall');
  assert.equal(env.THESIS_VM_P3_FIREWALL_DENY_RULE,'deny-centralus-p3-collector');
  assert.equal(env.THESIS_FLEX_P3_DENIAL_TELEMETRY,'azure_diagnostics_firewall');
  assert.equal(env.THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR,'10.48.6.0/24');
  assert.equal(env.THESIS_FLEX_P3_FIREWALL_DENY_RULE,'functions-p3-deny-collector');
  assert.equal(env.NODE_EXTRA_CA_CERTS,'/opt/thesis-aci-runner-20261104/certs/thesis-pilot-ca.pem');
  for(const name of ['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
    'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED','THESIS_AUTHORIZATION_VALIDATED',
    'THESIS_DENIAL_STATUS_TEXT_VALIDATED']) assert.equal(env[name],undefined);
});

test('full candidate launcher is dry-run-only and binds exact no-ACI candidate files',()=>{
  const args=buildVmFunctionsPreflightArgs();
  assert.ok(args.includes('--dry-run'));
  assert.ok(args.some(arg=>arg.endsWith('protocol-400-rev4-vm-functions-draft.json')));
  assert.ok(args.some(arg=>arg.endsWith('experiment.azure-live.json')));
  assert.ok(!args.includes('--gates'));
  assert.ok(!args.includes('--pilot'));
});
