import test from 'node:test';
import assert from 'node:assert/strict';
import {createAci400DirectAdapters,createAci400LiveDependencies,createAci400AzureEvidenceReaders} from './aci-400-direct-adapters.mjs';

const guid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const identity=n=>({deployment:'azure_container_instances',profile:n,principalObjectId:guid(n==='P1'?1:2),
  credentials:{controller:`controller-${n}-secret`,resourceAdmin:'resource-admin-secret',collectorAdmin:'collector-admin-secret'}});
const config={deployments:{azure_container_instances:{kind:'aci',resourceUrl:'https://resource.example',
  collectorUrl:'https://collector.example',timeoutMs:12000}},routes:[identity('P1'),identity('P2')]};
const env={
  THESIS_ACI_P1_IDENTITY_RESOURCE_ID:'/subscriptions/00000000-0000-4000-8000-000000000010/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/p1',
  THESIS_ACI_P1_IDENTITY_CLIENT_ID:guid(11),THESIS_ACI_P1_PRINCIPAL_OBJECT_ID:guid(1),
  THESIS_ACI_P2_IDENTITY_RESOURCE_ID:'/subscriptions/00000000-0000-4000-8000-000000000020/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/p2',
  THESIS_ACI_P2_IDENTITY_CLIENT_ID:guid(22),THESIS_ACI_P2_PRINCIPAL_OBJECT_ID:guid(2),
  THESIS_ACI_PULL_IDENTITY_RESOURCE_ID:'/subscriptions/00000000-0000-4000-8000-000000000030/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull',
  THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID:guid(31),THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID:guid(32),
  THESIS_ACI_SUBSCRIPTION_ID:guid(40),THESIS_ACI_RESOURCE_GROUP:'aci-rg',THESIS_ACI_LOCATION:'westus2',
  THESIS_ACI_IMAGE_DIGEST_REFERENCE:`registryexample.azurecr.io/agent@sha256:${'a'.repeat(64)}`,
  THESIS_ACI_REGISTRY_SERVER:'registryexample.azurecr.io',
  THESIS_ACI_SUBNET_ID:'/subscriptions/00000000-0000-4000-8000-000000000040/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/aci',
  THESIS_FIXTURE_BLOB_ENDPOINT:'https://fixturedata.blob.core.windows.net/',
  THESIS_BLOB_RESOURCE_ID:'/subscriptions/00000000-0000-4000-8000-000000000050/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/fixturedata/blobServices/default',
  THESIS_KEY_VAULT_URI:'https://pilot.vault.azure.net/',THESIS_ACI_WORKLOAD_TOKEN_SECRET_NAME:'aci-workload-token'
};

function componentsFor(captured) {
  return {
    identity:clientId=>({clientId,getToken:async()=>({token:'managed-identity-token'})}),
    storageTokenProvider:({clientId})=>async()=>`storage:${clientId}`,
    readWorkloadToken:async options=>{captured.secretRead=options;return 'workload-token-secret';},
    groupClient:options=>{captured.groupClient=options;return {create:async()=>{},delete:async()=>{}};},
    httpAdapter:options=>({options}),
    fixtureAdapter:options=>({options}),
    groupBody:options=>{captured.bodies.push(options);return options;},
    trialAdapter:options=>{captured.adapters.push(options);return {reset(){},execute(){},collect(){}};}
  };
}

test('direct ACI composition binds P1 and P2 adapters to separate configured identities',async()=>{
  const captured={bodies:[],adapters:[]};
  const adapters=await createAci400DirectAdapters({config,env,components:componentsFor(captured)});
  assert.deepEqual(Object.keys(adapters).sort(),['azure_container_instances:P1','azure_container_instances:P2']);
  assert.notEqual(adapters['azure_container_instances:P1'],adapters['azure_container_instances:P2']);
  assert.equal(captured.adapters.length,2);
  assert.equal(captured.secretRead.name,'aci-workload-token');
  assert.equal(captured.secretRead.vaultUri,'https://pilot.vault.azure.net');

  const p1Body=await captured.adapters[0].groupBodyForTrial({deployment:'azure_container_instances',profile:'P1'});
  const p2Body=await captured.adapters[1].groupBodyForTrial({deployment:'azure_container_instances',profile:'P2'});
  assert.equal(p1Body.workloadIdentityId,env.THESIS_ACI_P1_IDENTITY_RESOURCE_ID);
  assert.equal(p1Body.workloadIdentityClientId,env.THESIS_ACI_P1_IDENTITY_CLIENT_ID);
  assert.equal(p1Body.workloadPrincipalObjectId,env.THESIS_ACI_P1_PRINCIPAL_OBJECT_ID);
  assert.equal(p2Body.workloadIdentityId,env.THESIS_ACI_P2_IDENTITY_RESOURCE_ID);
  assert.equal(p2Body.workloadIdentityClientId,env.THESIS_ACI_P2_IDENTITY_CLIENT_ID);
  assert.equal(p2Body.workloadPrincipalObjectId,env.THESIS_ACI_P2_PRINCIPAL_OBJECT_ID);
  assert.notEqual(p1Body.workloadIdentityId,p2Body.workloadIdentityId);
  assert.notEqual(p1Body.trialRequestKey,p2Body.trialRequestKey);
});

test('direct ACI composition rejects mismatched or reused workload identities',async()=>{
  await assert.rejects(createAci400DirectAdapters({config,env:{...env,THESIS_ACI_P2_PRINCIPAL_OBJECT_ID:guid(1)},
    components:componentsFor({bodies:[],adapters:[]})}),/does not match the validated route config/);
  await assert.rejects(createAci400DirectAdapters({config,env:{...env,THESIS_ACI_P2_IDENTITY_CLIENT_ID:env.THESIS_ACI_P1_IDENTITY_CLIENT_ID},
    components:componentsFor({bodies:[],adapters:[]})}),/separate workload identities/);
});

test('direct ACI composition refuses missing P2 configuration',async()=>{
  const incomplete={...env}; delete incomplete.THESIS_ACI_P2_IDENTITY_RESOURCE_ID;
  await assert.rejects(createAci400DirectAdapters({config,env:incomplete,components:componentsFor({bodies:[],adapters:[]})}),
    /missing or invalid ACI adapter setting THESIS_ACI_P2_IDENTITY_RESOURCE_ID/);
});

test('live dependency composition requires and separately wires the U6/U8 verifier',async()=>{
  const captured={bodies:[],adapters:[]};
  const noop=async()=>({});
  const analogueCallbacks={methodDecision:{status:'approved',reference:'https://method.example/decision',
    approvalEvidenceReference:'https://method.example/review',reviewerPrincipalId:guid(50),
    unauthorizedOperations:{U6:'read_other_active_group_blob_marker',U8:'read_retired_group_blob_marker'}},
    verifyMethodApproval:async()=>true,createIdentity:noop,deleteIdentity:noop,evaluateEffectiveAccess:noop,
    createGroup:noop,deleteGroup:noop,observeGroup:noop,targetForMarker:noop,seedMarker:noop,deleteMarker:noop,
    readMarker:noop,attemptRead:noop,readAudit:noop,persistMarkerContentProof:noop};
  const independentVerifierOptions={observerPrincipalId:guid(51),requiredRetentionDays:365,
    verifyMethodDecision:noop,readStorageBlobLogs:noop,loadProtectedEvidence:noop,readAciLifecycleEvidence:noop};
  const result=await createAci400LiveDependencies({config,env,rows:[
    {deployment:'azure_container_instances',permission_profile:'P1',scenario_id:'U6'},
    {deployment:'azure_container_instances',permission_profile:'P2',scenario_id:'U8'}],
    analogueCallbacks,independentVerifierOptions,components:componentsFor(captured)});
  assert.equal(typeof result.sessionAnalogVerifier,'function');
  assert.equal(captured.adapters.length,2);
  assert.equal(typeof captured.adapters[0].sessionAnalog,'function');
  assert.equal(captured.adapters[0].sessionAnalog,captured.adapters[1].sessionAnalog);
  assert.notEqual(captured.adapters[0].sessionAnalog,result.sessionAnalogVerifier);
});

test('live dependency composition refuses U6/U8 when independent readers are missing',async()=>{
  await assert.rejects(createAci400LiveDependencies({config,env,rows:[
    {deployment:'azure_container_instances',permission_profile:'P2',scenario_id:'U8'}],
    components:componentsFor({bodies:[],adapters:[]})}),/require the Azure cross-group analogue and independent verifier callbacks/);
});

test('400 evidence readers bind to configured audit MSI, private evidence scope, and owner-directed basis',()=>{
  let proofOptions;
  const observer={observeGroup:async()=>({}),observeGroupDeletion:async()=>({}),readAciLifecycleEvidence:async()=>({})};
  const proofRuntime={observerPrincipalId:guid(61),requiredRetentionDays:146000,retentionBasis:'owner_directed',
    retentionAuthorityReference:'file:docs/ACI-400-OWNER-DIRECTED-RETENTION.md',writeProtectedSnapshot:async()=>({}),
    loadProtectedEvidence:async()=>({})};
  const readers=createAci400AzureEvidenceReaders({env:{
    THESIS_EVIDENCE_BLOB_CONTAINER_URL:'https://thesispilotblob20261102.blob.core.windows.net/trial-evidence',
    THESIS_EVIDENCE_CONTAINER_RESOURCE_ID:'/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/thesispilotblob20261102/blobServices/default/containers/trial-evidence',
    THESIS_EVIDENCE_IDENTITY_CLIENT_ID:guid(62),THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID:guid(63),
    THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID:guid(64),THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID:guid(61),
    THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID:guid(65),THESIS_EVIDENCE_RETENTION_APPROVED:'false',
    THESIS_EVIDENCE_RETENTION_DAYS:'146000',THESIS_ACI_SUBSCRIPTION_ID:guid(1),THESIS_ACI_RESOURCE_GROUP:'aci-rg',
    THESIS_LOG_ANALYTICS_WORKSPACE_ID:guid(66)},components:{
    identity:()=>({}),proofRuntime:options=>{proofOptions=options;return proofRuntime;},
    logsTokenProvider:()=>async()=>'logs-token',auditReader:()=>async()=>[],lifecycleObserver:()=>observer
  }});
  assert.deepEqual(proofOptions.retentionAuthority,{basis:'owner_directed',scope:'aci_400_study_evidence_only',
    reference:'file:docs/ACI-400-OWNER-DIRECTED-RETENTION.md'});
  assert.equal(readers.observerPrincipalId,guid(61));
  assert.equal(readers.requiredRetentionDays,146000);
  assert.equal(readers.retentionBasis,'owner_directed');
});
