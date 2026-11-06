import assert from 'node:assert/strict';
import test from 'node:test';

import {executeSingleTrial,parseTrialEnvelope,requestIdForScenario} from '../dist/agent-runner.js';

const validEnvironment={
  RESEARCH_URL:'https://resource.example.test',
  COLLECTOR_URL:'https://collector.example.test',
  RESTRICTED_URL:'https://restricted.example.test',
  WORKLOAD_TOKEN:'synthetic-workload-token-for-tests',
  TRIAL_INPUT_JSON:'{}'
};

test('trial envelope accepts only the scheduled operation and synthetic marker',()=>{
  assert.deepEqual(parseTrialEnvelope(JSON.stringify({runId:'block1_run1',scenario:'U5',u5Marker:'SYNTHETIC-marker'})),
    {runId:'block1_run1',scenario:'U5',u5Marker:'SYNTHETIC-marker'});
  assert.throws(()=>parseTrialEnvelope('{bad json'),/valid JSON/);
  assert.throws(()=>parseTrialEnvelope(JSON.stringify({runId:'r1',scenario:'U4',azureAccessToken:'secret'})),/unsupported field/);
  assert.throws(()=>parseTrialEnvelope(JSON.stringify({runId:'r1',scenario:'U5',u5Marker:'real-secret'})),/synthetic marker/);
});

test('trial request IDs are stable, scenario-scoped, and valid for correlated Azure reads',()=>{
  for(const scenario of ['U1','U5','U6','U8']) {
    const a=requestIdForScenario('block1_run1',scenario),b=requestIdForScenario('block1_run1',scenario);
    assert.equal(a,b);
    assert.match(a,new RegExp(`^${scenario.toLowerCase()}-[a-f0-9]{64}$`));
  }
  assert.equal(requestIdForScenario('block1_run1','U4'),undefined);
});

test('one-shot agent uses the shared core without starting an HTTP listener',async()=>{
  const originalFetch=globalThis.fetch,observed=[];
  globalThis.fetch=async(url,options)=>{
    observed.push({url:String(url),options});
    return new Response(JSON.stringify({executed:true}),{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const output=await executeSingleTrial({runId:'block1_run2',scenario:'U4'},
      {env:validEnvironment,blobRunnerFactory:async()=>{throw new Error('Blob path must not be used for U4');}});
    assert.equal(output.runId,'block1_run2');
    assert.equal(output.scenario,'U4');
    assert.equal(output.transportOk,true);
    assert.equal(output.status,200);
    assert.equal(observed.length,1);
    assert.equal(new URL(observed[0].url).pathname,'/api/prohibited');
    assert.equal(observed[0].options.headers['x-workload-token'],validEnvironment.WORKLOAD_TOKEN);
  } finally {globalThis.fetch=originalFetch;}
});

test('one-shot agent resolves its mock-service workload token from a Key Vault URI without putting it in trial input',async()=>{
  const originalFetch=globalThis.fetch,observed=[];
  globalThis.fetch=async(url,options)=>{
    observed.push({url:String(url),options});
    return new Response('{"executed":true}',{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const env={...validEnvironment,THESIS_WORKLOAD_TOKEN_SECRET_URI:'https://thesis-secrets.vault.azure.net/secrets/p1-workload-token',
      THESIS_SECRET_READER_CLIENT_ID:'00000000-0000-4000-8000-000000000001'};
    delete env.WORKLOAD_TOKEN;
    const output=await executeSingleTrial({runId:'block1-run-keyvault',scenario:'U4'},
      {env,workloadTokenReader:async(uri,options)=>{
        assert.equal(uri,env.THESIS_WORKLOAD_TOKEN_SECRET_URI);
        assert.equal(options.clientId,env.THESIS_SECRET_READER_CLIENT_ID);
        return 'synthetic-workload-token-from-keyvault';
      }});
    assert.equal(output.transportOk,true);
    assert.equal(observed[0].options.headers['x-workload-token'],'synthetic-workload-token-from-keyvault');
  } finally {globalThis.fetch=originalFetch;}
});

test('one-shot U7 requires the distinct restricted service URL',async()=>{
  const env={...validEnvironment};delete env.RESTRICTED_URL;
  await assert.rejects(()=>executeSingleTrial({runId:'block1_run3',scenario:'U7'},
    {env,blobRunnerFactory:async()=>undefined}),/RESTRICTED_URL is required/);
});

test('one-shot Blob scenarios use the managed Blob runner and generated correlation ID',async()=>{
  let received;
  const output=await executeSingleTrial({runId:'block1_run4',scenario:'U6'},
    {env:{...validEnvironment,AZURE_BLOB_ENDPOINT:'https://fixture123.blob.core.windows.net',AZURE_CLIENT_ID:'00000000-0000-4000-8000-000000000001'},
      blobRunnerFactory:async({clientId})=>{
        assert.equal(clientId,'00000000-0000-4000-8000-000000000001');
        return async input=>{received=input;return {runId:input.runId,scenario:input.scenario,transportOk:true,status:403,requestId:input.requestId};};
      }});
  assert.equal(output.status,403);
  assert.equal(received.requestId,requestIdForScenario('block1_run4','U6'));
});
