import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSessionPilotAdapter} from './session-pilot-adapter.mjs';
const controllerId='00000000-0000-0000-0000-000000000099';
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const controlToken=()=>`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://dynamicsessions.io',oid:controllerId,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;

test('session request requires header-isolation assertion and uses a unique identifier',async()=>{
  const original=globalThis.fetch;
  let observed;
  globalThis.fetch=async(url,options)=>{observed={url,options}; return new Response('{"status":200}',{status:200});};
  try {
    const fixtureAdapter={reset:async()=>({}),collect:async()=>({})};
    const stored=[];
    const config={fixtureAdapter,managementEndpoint:'https://testpool.env123.eastus.azurecontainerapps.io/',poolName:'testpool',region:'eastus',sessionRegistry:{save:async value=>stored.push(value)},
      getAccessToken:async()=>controlToken(),expectedControllerPrincipalId:controllerId,controllerToken:'trial-token'};
    assert.throws(()=>createSessionPilotAdapter(config),/isolation is unverified/);
    const adapter=createSessionPilotAdapter({...config,headerIsolationVerified:true});
    await adapter.execute({runId:'run-1',scenario:'U5'},{u5Marker:'SYNTHETIC-test'});
    assert.equal(observed.url.pathname,'/run');
    const sessionId=observed.url.searchParams.get('identifier');
    assert.match(sessionId,/^[a-f0-9]{48}$/);
    assert.notEqual(sessionId,'run-1');
    assert.equal(stored[0].sessionId,sessionId);
    assert.match(observed.options.headers.authorization,/^Bearer /);
    assert.equal(JSON.parse(observed.options.body).u5Marker,'SYNTHETIC-test');
    assert.equal(JSON.parse(observed.options.body).requestId,`u5-${createHash('sha256').update('run-1').digest('hex')}`);
    await assert.rejects(adapter.execute({runId:'run-1',scenario:'U5'},{u5Marker:'SYNTHETIC-test'}),/already assigned/);
    await assert.rejects(adapter.execute({runId:'../bad',scenario:'U1'},{}),/invalid session/);
    globalThis.fetch=async(url)=>new Response(JSON.stringify({echo:url.searchParams.get('identifier')}),{status:200});
    const exposed=await adapter.execute({runId:'run-2',scenario:'U1'},{});
    assert.equal(exposed.errorType,'SessionIdentifierExposed');
    assert.ok(!JSON.stringify(exposed).includes(stored[1].sessionId));
  } finally {globalThis.fetch=original;}
});

test('delegates only the configured workload identity and redacts reflected credentials',async()=>{
  const original=globalThis.fetch,stored=[],principal='00000000-0000-0000-0000-000000000001';
  const delegated=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://storage.azure.com/',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  const mock='m'.repeat(32);
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.azureAccessToken,delegated);
    assert.equal(body.expectedPrincipalId,principal);
    assert.equal(body.mockWorkloadToken,mock);
    return new Response(JSON.stringify({reflected:delegated}),{status:200});
  };
  try {
    const adapter=createSessionPilotAdapter({fixtureAdapter:{reset:async()=>({}),collect:async()=>({})},
      managementEndpoint:'https://testpool.env123.eastus.azurecontainerapps.io/',poolName:'testpool',region:'eastus',getAccessToken:async()=>controlToken(),expectedControllerPrincipalId:controllerId,controllerToken:'controller-token',
      sessionRegistry:{save:async value=>stored.push(value)},headerIsolationVerified:true,
      delegatedCredentials:{expectedPrincipalId:principal,getStorageToken:async()=>delegated,getMockToken:async()=>mock}});
    const result=await adapter.execute({runId:'run-delegated',scenario:'U1'},{});
    assert.equal(result.errorType,'WorkloadCredentialExposed');
    assert.ok(!JSON.stringify(result).includes(delegated));
    assert.equal(stored.length,1);
  } finally {globalThis.fetch=original;}
});
