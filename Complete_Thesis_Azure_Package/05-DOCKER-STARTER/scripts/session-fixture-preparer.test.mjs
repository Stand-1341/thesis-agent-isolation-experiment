import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSessionFixturePreparer} from './session-fixture-preparer.mjs';
import {sessionSeedRequestId} from './azure-session-seed.mjs';

test('requires an independently logged seed and observes prior-session retirement',async()=>{
  const original=globalThis.fetch,now=Date.now(),stored=new Map(),stopped=new Set();
  const controller='00000000-0000-0000-0000-000000000001',owner='00000000-0000-0000-0000-000000000002';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const make=(oid,aud)=>`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud,oid,exp:Math.floor(now/1000)+3600})}.synthetic-signature`;
  const controlToken=make(controller,'https://dynamicsessions.io'),ownerToken=make(owner,'https://storage.azure.com/');
  let activeTrial,activeKind;
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(url.pathname,'/session-seed');
    assert.equal(body.azureAccessToken,ownerToken);
    activeTrial=body.runId;activeKind=body.kind;
    return new Response(JSON.stringify({scope:'fixture_session_seed_observation',runId:body.runId,kind:body.kind,
      requestId:sessionSeedRequestId(body.runId,body.kind),status:201,serviceRequestId:'request-1'}),{status:200});
  };
  const registry={save:async mapping=>stored.set(mapping.runId,mapping)};
  const lifecycle={observe:async id=>({state:stopped.has(id)?'not_found':'present',sessionFingerprint:createHash('sha256').update(stored.get(id).sessionId).digest('hex')}),
    requestStop:async(id,options)=>{assert.equal(options.evidenceCollected,true);stopped.add(id);return {scope:'stop_requested_not_confirmed'};}};
  const readAudit=async()=>[{_ResourceId:'/account/blobservices/default',RequesterObjectId:owner,AuthenticationType:'OAuth',
    ClientRequestId:sessionSeedRequestId(activeTrial,activeKind),OperationName:'PutBlob',
    Uri:`https://fixture123.blob.core.windows.net/${activeKind}/${activeTrial}.json`,TimeGenerated:new Date(now).toISOString(),StatusCode:'201'}];
  try {
    const prepare=createSessionFixturePreparer({managementEndpoint:'https://testpool.env123.eastus.azurecontainerapps.io/',poolName:'testpool',region:'eastus',
      blobEndpoint:'https://fixture123.blob.core.windows.net/',blobResourceId:'/account/blobservices/default',controllerToken:'c'.repeat(32),
      getControlToken:async()=>controlToken,controlPrincipalId:controller,getOwnerToken:async()=>ownerToken,ownerPrincipalId:owner,
      sessionRegistry:registry,lifecycleObserver:lifecycle,readAudit,waitMs:0,clock:()=>now});
    await assert.rejects(prepare({deployment:'azure_vm',runId:'wrong-arm',scenario:'U6'},{kind:'session-b',marker:'SYNTHETIC-b'}),/another deployment/);
    const active=await prepare({deployment:'azure_custom_sessions_hyperv',runId:'run-1',scenario:'U6'},{kind:'session-b',marker:'SYNTHETIC-b'});
    assert.equal(active.lifecycle.state,'present');
    const prior=await prepare({deployment:'azure_custom_sessions_hyperv',runId:'run-2',scenario:'U8'},{kind:'prior-session',marker:'SYNTHETIC-prior'});
    assert.equal(prior.lifecycle.state,'not_found');
    assert.ok(!JSON.stringify(prior).includes(ownerToken));
    assert.ok(!JSON.stringify(prior).includes(stored.get(prior.fixtureRunId).sessionId));
  } finally {globalThis.fetch=original;}
});
