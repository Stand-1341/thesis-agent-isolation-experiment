import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSelectedVmCredentials,buildPreflightArgs} from './run-keyvault-measured-preflight.mjs';

function fakeFetch(calls) {
  return async (url,options={})=>{
    calls.push({url:String(url),options});
    if(String(url).startsWith('http://169.254.169.254/'))
      return Response.json({access_token:'mock-access-token'});
    return Response.json({value:'x'.repeat(40)});
  };
}

test('Central VM P3 preflight loads its route key and exact firewall reader inputs without asserting gates',async()=>{
  const calls=[];
  const env=await loadSelectedVmCredentials({profile:'P3',env:{},fetchImpl:fakeFetch(calls)});
  assert.ok(calls.some(call=>call.url.includes('/secrets/vm-p3-centralus-trial-request-key?')));
  assert.equal(env.THESIS_VM_P3_CONTROLLER_KEY,'x'.repeat(40));
  assert.equal(env.THESIS_VM_P3_DENIAL_TELEMETRY,'azure_diagnostics_firewall');
  assert.equal(env.THESIS_VM_P3_FIREWALL_SOURCE_IP,'10.49.8.4');
  assert.equal(env.THESIS_DENIAL_DESTINATION_IP,'10.48.9.5');
  assert.equal(env.THESIS_VM_P3_FIREWALL_DESTINATION_PORT,'8443');
  assert.equal(env.THESIS_VM_P3_FIREWALL_DENY_RULE,'deny-centralus-p3-collector');
  assert.equal(env.NODE_EXTRA_CA_CERTS,'/opt/thesis-aci-runner-20261104/certs/thesis-pilot-ca.pem');
  for(const name of ['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
    'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED','THESIS_AUTHORIZATION_VALIDATED',
    'THESIS_DENIAL_STATUS_TEXT_VALIDATED']) assert.equal(env[name],undefined);
  const args=buildPreflightArgs('P3');
  assert.ok(args.includes('P3'));
  assert.ok(args.includes('--dry-run'));
  assert.ok(args.includes('--protocol'));
  assert.ok(args.some(arg=>arg.endsWith('protocol-400-rev4-vm-functions-draft.json')));
});

test('P1 preflight does not inherit Central P3 denial telemetry',async()=>{
  const env=await loadSelectedVmCredentials({profile:'P1',env:{},fetchImpl:fakeFetch([])});
  assert.equal(env.THESIS_VM_P3_DENIAL_TELEMETRY,undefined);
  assert.ok(buildPreflightArgs('P1').includes('--dry-run'));
});

test('preflight args reject unknown profiles',()=>{
  assert.throws(()=>buildPreflightArgs('P4'),/only VM P1, P2, or Central P3/);
});
