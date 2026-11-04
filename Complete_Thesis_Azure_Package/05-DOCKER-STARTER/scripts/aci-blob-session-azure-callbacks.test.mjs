import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAciBlobSessionAzureCallbacks} from './aci-blob-session-azure-callbacks.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function dependencies(events=[]) {
  return {
    subscriptionId:id(1),resourceGroup:'rg-test',workspaceId:id(2),
    managementIdentityClientId:id(3),storageIdentityClientId:id(4),auditIdentityClientId:id(5),
    getManagementToken:async()=>{events.push('management-token');return 'management-token';},
    createCredential:clientId=>({getToken:async scope=>{events.push(`credential:${clientId}:${scope}`);return {token:'local-fake-token'};}}),
    groupBodyForIdentity:async value=>{events.push(`body:${value.phase}`);return {localOnly:true};},
    profileForRun:()=> 'P2',
    identityProvider:{createIdentity:async()=>{},deleteIdentity:async()=>{},evaluateEffectiveAccess:async()=>{}},
    effectiveAccessEvaluator:async()=>{},
    blobOperations:{targetForMarker:async args=>{events.push('blob:targetForMarker');return {localOnly:true};}},
    agentSessionCallbacks:Object.fromEntries(['seedMarker','attemptRead','deleteMarker'].map(name=>[
      name,async()=>{events.push(`agent:${name}`);return {agentOperation:true};}])),
    independentMarkerReader:async args=>{events.push(`independent-marker:${typeof args.getToken}`);return {independentlyRead:true};},
    observeGroup:async ({group})=>({state:'Running',name:group.name,identityObjectId:id(9),createdAt:'2026-11-04T12:00:00Z'}),
    fetchImpl:async()=>{throw new Error('network must not be used by injected local test');},
    groupClientFactory:()=>({
      create:async(name,body)=>{events.push(`group-create:${name}`);assert.deepEqual(body,{localOnly:true});return {name,
        resourceId:`/subscriptions/${id(1)}/resourceGroups/rg-test/providers/Microsoft.ContainerInstance/containerGroups/${name}`,
        privateIp:'10.1.2.3',provisioningState:'Succeeded'};},
      delete:async name=>({name,deleted:true,alreadyAbsent:false})
    }),
    storageTokenProvider:({clientId,createCredential})=>{
      const credential=createCredential(clientId);return async()=>credential.getToken('https://storage.azure.com/.default').then(x=>x.token);
    },
    logsTokenProvider:({clientId,createCredential})=>{
      const credential=createCredential(clientId);return async()=>credential.getToken('https://api.loganalytics.io/.default').then(x=>x.token);
    },
    auditReaderFactory:({workspaceId,getToken})=>async ({runId,startMs,endMs})=>{
      events.push(`audit:${workspaceId}:${runId}:${startMs}:${endMs}`);assert.equal(await getToken(),'local-fake-token');
      return [{TimeGenerated:new Date(startMs).toISOString(),_ResourceId:'/resource',RequesterObjectId:id(6),
        ClientRequestId:runId,OperationName:'GetBlob',Uri:'https://storage.blob.core.windows.net/c/a.json',StatusCode:'403'}];
    },
    now:()=>Date.parse('2026-11-04T12:00:01Z')
  };
}

test('constructs a gated, non-network callback composition and preserves safety flags',()=>{
  const events=[];
  const provider=createAciBlobSessionAzureCallbacks(dependencies(events));
  assert.deepEqual(events,[]);
  assert.equal(provider.methodApprovalRequired,true);
  assert.equal(provider.evidenceRetentionApprovalRequired,true);
  assert.equal(provider.liveValidationRequired,true);
  assert.equal(provider.scheduleIntegrationAllowed,false);
  assert.equal(Object.isFrozen(provider.callbacks),true);
});

test('wires phase-specific ARM group lifecycle, scoped tokens, and request-id audit lookup',async()=>{
  const events=[];
  const {callbacks}=createAciBlobSessionAzureCallbacks(dependencies(events));
  const identity={objectId:id(9),clientId:id(10),resourceId:`/subscriptions/${id(1)}/resourceGroups/rg-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/workload`};
  const group=await callbacks.createGroup({runId:'pilot-1',scenario:'U6',phase:'probe',container:'session-b',identity});
  assert.equal(group.ready,true);
  assert.equal(group.identityObjectId,id(9));
  assert.match(group.name,/^thesis-aci-p2-[a-f0-9]{24}$/);
  assert.ok(events.indexOf('body:probe')<events.findIndex(x=>x.startsWith('group-create:')));
  assert.deepEqual(await callbacks.seedMarker({}),{agentOperation:true});
  assert.ok(events.includes('agent:seedMarker'));
  assert.deepEqual(await callbacks.readMarker({}),{independentlyRead:true});
  assert.ok(events.includes('independent-marker:function'));
  const rows=await callbacks.readAudit({runId:'pilot-1',requestId:'operation-request-123',
    from:'2026-11-04T12:00:00Z',to:'2026-11-04T12:01:00Z'});
  assert.equal(rows[0].runId,'pilot-1');
  assert.equal(rows[0].clientRequestId,'operation-request-123');
  assert.equal(rows[0].principalId,id(6));
  assert.ok(events.some(x=>x.startsWith('audit:')&&x.includes(':operation-request-123:')));
});

test('refuses incomplete independent-access or evidence-related adapter wiring',()=>{
  const missingEvaluator=dependencies();
  delete missingEvaluator.effectiveAccessEvaluator;
  assert.throws(()=>createAciBlobSessionAzureCallbacks(missingEvaluator),/effective-access evaluator/);
  const missingObserver=dependencies();
  delete missingObserver.observeGroup;
  assert.throws(()=>createAciBlobSessionAzureCallbacks(missingObserver),/independent ACI group observer/);
});
