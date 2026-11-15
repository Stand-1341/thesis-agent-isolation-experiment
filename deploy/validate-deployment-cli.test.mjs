import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {probeEndpoint, probeEffectivePermissions, evaluatePermissionProbes, evidenceRoundTrip, makeVmStorageProbeScript, matchPilotPermissionEvidence, readValidationPilotRecords} from './validate-deployment.mjs';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

test('private listener probe targets the requested IP and port with verified host CA TLS', async () => {
  let call;
  const reachable = await probeEndpoint({
    az: async (args, options) => { call = {args, options}; return {value: [{message: 'Enable succeeded: {"status":"ok"}'}]}; },
    ip: '10.48.9.6', port: 9443, resourceGroup: 'thesis-rg'
  });
  assert.equal(reachable, true);
  const script = call.args[call.args.indexOf('--scripts') + 1];
  assert.match(script, /--cacert \/etc\/thesis-research\/tls\/ca\.crt/);
  assert.match(script, /https:\/\/10\.48\.9\.6:9443\/health/);
  assert.doesNotMatch(script, /curl -sk/);
  assert.equal(call.options.json, true);
});

test('private listener probe rejects invalid address/port and missing resource group', async () => {
  let calls = 0;
  const az = async () => { calls += 1; };
  assert.equal(await probeEndpoint({az, ip: 'not-an-ip', port: 9443, resourceGroup: 'rg'}), false);
  assert.equal(await probeEndpoint({az, ip: '10.48.9.6', port: 0, resourceGroup: 'rg'}), false);
  assert.equal(await probeEndpoint({az, ip: '10.48.9.6', port: 9443}), false);
  assert.equal(calls, 0);
});

test('unsupported route probes fail closed without asking controller credentials for a token', async () => {
  let calls = 0;
  const probes = await probeEffectivePermissions({
    az: async () => { calls += 1; return {accessToken: 'controller-token'}; },
    scope: 'https://storage.azure.com/.default',
    fixtureEndpoint: 'https://fixtures.blob.core.windows.net/',
    identities: [{name: 'aca_sandboxes/P1', deployment: 'azure_container_apps_sandboxes', clientId: 'client-id'}]
  });
  assert.equal(calls, 0);
  assert.equal(probes[0].status, 'pilot-evidence-pending');
  assert.equal(evaluatePermissionProbes(probes).length, 0);
});

test('VM permission probe executes in the VM, verifies both token claims, and checks expected blob access', async () => {
  const principalObjectId = '11111111-1111-4111-8111-111111111111';
  const clientId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const probes = await probeEffectivePermissions({
    az: async (args, options) => {
      calls.push({args, options});
      assert.ok(args.includes('--ids'));
      assert.ok(args.includes('/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-p1'));
      assert.ok(args.includes('--command-id') && args.includes('RunShellScript'));
      const script = args[args.indexOf('--scripts') + 1];
      assert.match(script, /python3 -c/);
      const encoded = /b64decode\('([^']+)'\)/.exec(script)?.[1];
      const python = Buffer.from(encoded, 'base64').toString('utf8');
      assert.match(python, /base64\.b64decode/);
      const encodedConfig = /json\.loads\(base64\.b64decode\('([^']+)'\)\)/.exec(python)?.[1];
      const config = JSON.parse(Buffer.from(encodedConfig, 'base64').toString('utf8'));
      assert.equal(config.containerUrl, 'https://fixtures.blob.core.windows.net/authorized-docs');
      assert.doesNotMatch(script, /controller-token/);
      return {value: [{message: `Enable succeeded: WORKLOAD_PERMISSION_PROBE:{"oid":"${principalObjectId}","clientId":"${clientId}","httpStatus":200}`} ]};
    },
    fixtureEndpoint: 'https://fixtures.blob.core.windows.net/',
    scope: 'https://storage.azure.com/.default',
    identities: [{name: 'azure_vm/P1', deployment: 'azure_vm', profile: 'P1', clientId, principalObjectId,
      resourceId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-p1'}]
  });
  assert.equal(probes[0].status, 'token-ok', probes[0].error);
  assert.equal(probes[0].dataPlaneStatus, 200);
  assert.equal(evaluatePermissionProbes(probes).length, 0);
  assert.equal(calls.length, 1);
});

test('VM permission probe rejects controller or wrong workload token claims', async () => {
  const probes = await probeEffectivePermissions({
    az: async () => ({value: [{message: 'WORKLOAD_PERMISSION_PROBE:{"oid":"controller","clientId":"controller","httpStatus":200}'}]}),
    fixtureEndpoint: 'https://fixtures.blob.core.windows.net', scope: 'https://storage.azure.com/.default',
    identities: [{name: 'azure_vm/P1', deployment: 'azure_vm', profile: 'P1', clientId: 'workload-client', principalObjectId: 'workload-principal',
      resourceId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-p1'}]
  });
  assert.equal(probes[0].status, 'probe-failed');
  assert.match(probes[0].error, /token claims do not match/);
  assert.equal(evaluatePermissionProbes(probes).length, 1);
});

test('VM probe refuses non-account-root fixture URLs before executing in the VM', async () => {
  let calls = 0;
  const probes = await probeEffectivePermissions({
    az: async () => { calls += 1; }, fixtureEndpoint: 'https://attacker.example/collect?token=',
    identities: [{name: 'azure_vm/P1', deployment: 'azure_vm', profile: 'P1', clientId: 'client', principalObjectId: 'principal',
      resourceId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-p1'}]
  });
  assert.equal(calls, 0);
  assert.equal(probes[0].status, 'in-resource-probe-unavailable');
});

test('P3 HTTP 403 is not accepted as evidence of its required network denial pilot', async () => {
  const clientId = '22222222-2222-4222-8222-222222222222';
  const principalObjectId = '11111111-1111-4111-8111-111111111111';
  const probes = await probeEffectivePermissions({
    az: async () => ({value: [{message: `WORKLOAD_PERMISSION_PROBE:{"oid":"${principalObjectId}","clientId":"${clientId}","httpStatus":403}`}]}),
    fixtureEndpoint: 'https://fixtures.blob.core.windows.net/', scope: 'https://storage.azure.com/.default',
    identities: [{name: 'azure_vm/P3', deployment: 'azure_vm', profile: 'P3', clientId, principalObjectId,
      resourceId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-p3'}]
  });
  assert.equal(probes[0].status, 'pilot-evidence-pending');
  assert.match(probes[0].pendingReason, /not a permission result/);
  assert.equal(evaluatePermissionProbes(probes).length, 0);
});

test('indexed pilot proof is bound to route, workload identities, resource, endpoint, and verified outcome', () => {
  const identity = {name:'azure_container_apps_jobs/P1', deployment:'azure_container_apps_jobs', profile:'P1',
    clientId:'client-1', principalObjectId:'principal-1', resourceId:'/subscriptions/s/resourceGroups/r/providers/Microsoft.App/jobs/j1'};
  const proof = {schemaVersion:1, independent:true, source:'independent_verifier', principalObjectId:'principal-1', clientId:'client-1',
    resourceId:identity.resourceId, endpoint:'https://fixture.blob.core.windows.net/restricted-docs', dataPlaneStatus:200};
  const record = {runId:'pilot-azure_container_apps_jobs-P1-U1',mode:'non_counted_pilot', trial:{deployment:identity.deployment, permission_profile:'P1', scenario:'U1'},
    classification:'unauthorized_success', verificationEvidence:{scope:'azure_blob_verifier',deploymentValidation:proof}};
  assert.equal(matchPilotPermissionEvidence({identity, records:[record], fixtureEndpoint:'https://fixture.blob.core.windows.net/'}).ok, true);
  for (const changed of [
    {...record, trial:{...record.trial, deployment:'azure_container_apps_sandboxes'}},
    {...record, verificationEvidence:{deploymentValidation:{...proof, clientId:'controller'}}},
    {...record, verificationEvidence:{deploymentValidation:{...proof, endpoint:'https://other.blob.core.windows.net/restricted-docs'}}},
    {...record, verificationEvidence:{deploymentValidation:{...proof, independent:false}}},
    {...record, classification:'synthetic'}
  ]) assert.equal(matchPilotPermissionEvidence({identity, records:[changed], fixtureEndpoint:'https://fixture.blob.core.windows.net/'}).ok, false);
});

test('P3 requires both exact-route denial controls, matching identity, and healthy receiver evidence', () => {
  const identity = {name:'azure_vm/P3', deployment:'azure_vm', profile:'P3', clientId:'client-3', principalObjectId:'principal-3',
    resourceId:'/subscriptions/s/resourceGroups/r/providers/Microsoft.Compute/virtualMachines/vm-p3'};
  const records = ['U5','U7'].map(scenario => ({runId:`pilot-azure_vm-P3-${scenario}`,mode:'non_counted_pilot', trial:{deployment:'azure_vm', permission_profile:'P3', scenario},
    classification:'confirmed_network_denial', verificationEvidence:{scope:'experiment_verifier',deploymentValidation:{schemaVersion:1, independent:true, source:'independent_verifier',
      principalObjectId:'principal-3', clientId:'client-3', resourceId:identity.resourceId,
      endpoint:scenario==='U5'?'https://collector.example/':'https://restricted.example/', networkDenial:{scenario, outcome:'blocked',
        target:scenario==='U5'?'https://collector.example/':'https://restricted.example/', verifiedBy:'independent_verifier'}, healthyReceiver:true}}}));
  identity.networkEndpoints={U5:'https://collector.example/',U7:'https://restricted.example/'};
  assert.equal(matchPilotPermissionEvidence({identity, records, fixtureEndpoint:'https://fixture.blob.core.windows.net/'}).ok, true);
  assert.equal(matchPilotPermissionEvidence({identity, records:records.slice(0,1), fixtureEndpoint:'https://fixture.blob.core.windows.net/'}).ok, false);
  records[1].verificationEvidence.deploymentValidation.healthyReceiver = false;
  assert.equal(matchPilotPermissionEvidence({identity, records, fixtureEndpoint:'https://fixture.blob.core.windows.net/'}).ok, false);
});

test('pilot evidence reader verifies indexed envelope and rejects tampering', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deployment-pilot-proof-'));
  try {
    const payload = JSON.stringify({mode:'non_counted_pilot'});
    const envelope = JSON.stringify({version:1, payload, sha256:createHash('sha256').update(payload).digest('hex')});
    const bytes = Buffer.from(envelope);
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(root, 'record.json'), bytes);
    const index = path.join(root, 'pilot-index.json');
    await fs.writeFile(index, JSON.stringify({evidenceFiles:[{file:'record.json', sha256:createHash('sha256').update(bytes).digest('hex')}]}));
    assert.equal((await readValidationPilotRecords({indexPath:index, root})).records.length, 1);
    await fs.writeFile(path.join(root, 'record.json'), 'tampered');
    assert.match((await readValidationPilotRecords({indexPath:index, root})).error, /digest mismatch/);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('VM probe script safely encodes dynamic values and does only a blob container read', () => {
  const script = makeVmStorageProbeScript({clientId: 'client', principalObjectId: 'principal',
    containerUrl: "https://storage.example/container'; touch /tmp/nope #", expectedHttpStatus: 200,
    scope: 'https://storage.azure.com/.default'});
  assert.match(script, /base64/);
  assert.doesNotMatch(script, /touch \/tmp\/nope/);
  const encoded = /b64decode\('([^']+)'\)/.exec(script)?.[1];
  const python = Buffer.from(encoded, 'base64').toString('utf8');
  assert.match(python, /comp=list/);
  assert.doesNotMatch(python, /PUT|DELETE|upload|delete/i);
});

test('evidence round-trip uses supported blob-url CLI options and cleans up', async () => {
  const calls = [];
  let payload;
  const az = async (args) => {
    calls.push(args);
    if (args[2] === 'upload') {
      const file = args[args.indexOf('--file') + 1];
      payload = await readFile(file, 'utf8');
    } else if (args[2] === 'download') {
      const file = args[args.indexOf('--file') + 1];
      await writeFile(file, payload, 'utf8');
    }
  };
  const result = await evidenceRoundTrip({az, containerUrl: 'https://account.blob.core.windows.net/evidence'});
  assert.deepEqual(result, {ok: true});
  assert.equal(calls.length, 3);
  assert.match(calls[0].join(' '), /--blob-url https:\/\/account\.blob\.core\.windows\.net\/evidence\/validation\/non-counted-/);
  assert.ok(calls.every(args => args.includes('--auth-mode') && args.includes('login')));
  assert.ok(calls.every(args => !args.includes('--container-url') && !args.includes('--no-authenticate')));
  assert.equal(calls[2][2], 'delete');
});
