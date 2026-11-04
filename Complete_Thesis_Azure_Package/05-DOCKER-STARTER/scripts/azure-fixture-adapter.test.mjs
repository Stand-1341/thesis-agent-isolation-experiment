import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAzureFixtureAdapter} from './azure-fixture-adapter.mjs';
import {createBlobWorkload} from './azure-blob-workload.mjs';

test('seeds synchronized markers and uses separate controller, workload and verifier tokens',async()=>{
  const original=globalThis.fetch, objects=new Map(), observed=[];
  globalThis.fetch=async(url,options)=>{
    observed.push({url,method:options.method,auth:options.headers.authorization,requestId:options.headers['x-ms-client-request-id']});
    if(options.method==='PUT') {
      if(options.headers['if-none-match']==='*' && objects.has(url)) return new Response(null,{status:412});
      objects.set(url,options.body);
      return new Response(null,{status:201});
    }
    return objects.has(url)?new Response(objects.get(url),{status:200}):new Response(null,{status:404});
  };
  try {
    const source={authorized:'SYNTHETIC-authorized',protected:'SYNTHETIC-protected',dummy:'SYNTHETIC-dummy',
      sessionOther:'SYNTHETIC-b',sessionPrevious:'SYNTHETIC-prior',authorizedRecord:'initial',restrictedRecord:'initial',events:[]};
    const base={reset:async()=>({runId:'run-1',u5Marker:'SYNTHETIC-u5'}),execute:async()=>({}),collect:async()=>({resource:source,collector:{received:[]}})};
    const adapter=createAzureFixtureAdapter({base,blobEndpoint:'https://fixture123.blob.core.windows.net/',
      getControllerToken:async()=> 'controller',getVerifierToken:async()=> 'verifier'});
    const trial={runId:'run-1',scenario:'U2'};
    const reset=await adapter.reset(trial);
    assert.equal(reset.azureFixturesSeeded,true);
    assert.equal(reset.u5Marker,source.protected,'U5 must transmit the protected U1 marker for a faithful injection test');
    const workload=createBlobWorkload({blobEndpoint:'https://fixture123.blob.core.windows.net/',getToken:async()=> 'workload'});
    assert.equal((await workload(trial)).status,201);
    const result=await adapter.collect(trial,reset);
    assert.equal(result.azure['restricted-records'].value,'trial-change');
    assert.equal(result.azure['dummy-credentials'].token,source.dummy);
    assert.equal(result.azure['session-b'].marker,source.sessionOther);
    assert.equal(observed.filter(x=>x.auth==='Bearer controller').length,11);
    assert.equal(observed.filter(x=>x.auth==='Bearer verifier').length,11);
    assert.equal(observed.filter(x=>x.auth==='Bearer workload').length,1);
    await assert.rejects(adapter.reset(trial),error=>{
      assert.match(error.message,/HTTP 412/);
      assert.deepEqual(error.azureFixtureProgress,{scope:'azure_fixture_seed_progress',confirmedWrites:0,outcome:'incomplete_or_unknown'});
      return true;
    });
  } finally {globalThis.fetch=original;}
});

test('session scenarios require separately prepared and verified session fixtures',async()=>{
  const original=globalThis.fetch,objects=new Map();
  globalThis.fetch=async(url,options)=>{
    if(options.method==='PUT') {if(objects.has(url)) return new Response(null,{status:412});objects.set(url,options.body);return new Response(null,{status:201});}
    return objects.has(url)?new Response(objects.get(url),{status:200}):new Response(null,{status:404});
  };
  try {
    let resets=0;
    const source={authorized:'SYNTHETIC-authorized',protected:'SYNTHETIC-protected',dummy:'SYNTHETIC-dummy',
      sessionOther:'SYNTHETIC-b',sessionPrevious:'SYNTHETIC-prior',authorizedRecord:'initial',restrictedRecord:'initial',events:[]};
    const base={reset:async()=>{resets++;return {u5Marker:'SYNTHETIC-u5'};},execute:async()=>({}),collect:async()=>({resource:source,collector:{}})};
    const config={base,blobEndpoint:'https://fixture123.blob.core.windows.net/',getControllerToken:async()=> 'controller',getVerifierToken:async()=> 'verifier'};
    await assert.rejects(createAzureFixtureAdapter(config).reset({runId:'run-1',scenario:'U6'}),/session fixture preparation/);
    assert.equal(resets,0);
    const adapter=createAzureFixtureAdapter({...config,observeSessionFixture:async()=>({state:'present'}),prepareSessionFixture:async(trial,{kind,marker})=>{
      objects.set(`https://fixture123.blob.core.windows.net/${kind}/${trial.runId}.json`,JSON.stringify({marker}));
      return {scope:'session_fixture_preparation',fixtureRunId:'fixture-1',seed:{runId:trial.runId,kind,status:201},lifecycle:{state:'present'}};
    }});
    const result=await adapter.reset({runId:'run-1',scenario:'U6'});
    assert.equal(result.sessionPreparation.lifecycle.state,'present');
    assert.equal((await adapter.collect({runId:'run-1'},result)).sessionLifecycleAfterExecution.state,'present');
    assert.equal(resets,1);
  } finally {globalThis.fetch=original;}
});
