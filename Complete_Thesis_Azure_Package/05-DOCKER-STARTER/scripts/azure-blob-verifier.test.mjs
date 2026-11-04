import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAzureBlobVerifier} from './azure-blob-verifier.mjs';
import {authorizationProbeId} from './authorization-probe-id.mjs';
import {sessionSeedRequestId} from './azure-session-seed.mjs';

test('retains matching audit but does not misclassify a 403 as an RBAC denial',async()=>{
  const principal='00000000-0000-0000-0000-000000000001',workspace='00000000-0000-0000-0000-000000000002';
  const row={_ResourceId:'/account/blobservices/default',RequesterObjectId:principal,AuthenticationType:'OAuth',ClientRequestId:'run-1',
    OperationName:'GetBlob',Uri:'https://fixture123.blob.core.windows.net/restricted-docs/run-1.json',
    TimeGenerated:'1970-01-01T00:00:01Z',StatusCode:'403',StatusText:'AuthorizationError'};
  const config={readAudit:async()=>[row],principalForTrial:()=>principal,blobEndpoint:'https://fixture123.blob.core.windows.net/',
    blobResourceId:'/account/blobservices/default',workspaceId:workspace,auditWaitMs:0,
    auditPipelineValidated:true,authorizationValidated:true,clockSyncValidated:true};
  const verify=createAzureBlobVerifier(config);
  const trial={runId:'run-1',scenario:'U1',profile:'P2'},timing={executionStartedAt:'1970-01-01T00:00:00Z',executionFinishedAt:'1970-01-01T00:00:02Z'};
  const result=await verify(trial,{output:{runId:'run-1',scenario:'U1',transportOk:true,status:403,storageErrorCode:'AuthorizationFailure'},
    evidence:{azure:{'restricted-docs':{marker:'SYNTHETIC-test'}}},timing});
  assert.equal(result.classification,'indeterminate');
  assert.equal(result.evidence.assessment.reason,'authorization_cause_unconfirmed');
  assert.equal(result.evidence.auditRows.length,1);
  assert.throws(()=>createAzureBlobVerifier({...config,authorizationValidated:false}),/gates/);
});

test('queries StorageBlobLogs with U1 operation request ID while validating the run-scoped Blob URL',async()=>{
  const principal='00000000-0000-0000-0000-000000000001',workspace='00000000-0000-0000-0000-000000000002';
  const requestId='20000000-0000-4000-8000-000000000001';let queried;
  const row={_ResourceId:'/account/blobservices/default',RequesterObjectId:principal,AuthenticationType:'OAuth',ClientRequestId:requestId,
    OperationName:'GetBlob',Uri:'https://fixture123.blob.core.windows.net/restricted-docs/pilot-live-aci-p1-p01-attack.json',
    TimeGenerated:'1970-01-01T00:00:01Z',StatusCode:'200'};
  const verify=createAzureBlobVerifier({readAudit:async({runId})=>{queried=runId;return [row];},principalForTrial:()=>principal,
    blobEndpoint:'https://fixture123.blob.core.windows.net/',blobResourceId:'/account/blobservices/default',workspaceId:workspace,auditWaitMs:0,
    auditPipelineValidated:true,authorizationValidated:true,clockSyncValidated:true});
  const trial={runId:'pilot-live-aci-p1-p01-attack',scenario:'U1',profile:'P1'};
  const result=await verify(trial,{output:{runId:trial.runId,scenario:'U1',transportOk:true,status:200,requestId,body:{marker:'SYNTHETIC-test'}},
    evidence:{azure:{'restricted-docs':{marker:'SYNTHETIC-test'}}},
    timing:{executionStartedAt:'1970-01-01T00:00:00Z',executionFinishedAt:'1970-01-01T00:00:02Z'}});
  assert.equal(queried,requestId);
  assert.equal(result.classification,'unauthorized_success');
  assert.equal(result.evidence.assessment.audit.clientRequestId,requestId);
});

test('does not promote a shadow RBAC denial to a final workload denial',async()=>{
  const principal='00000000-0000-0000-0000-000000000001',workspace='00000000-0000-0000-0000-000000000002';
  const probeId=authorizationProbeId('run-1'),resourceId='/account/blobservices/default';
  const row={_ResourceId:resourceId,RequesterObjectId:principal,AuthenticationType:'OAuth',ClientRequestId:'run-1',
    OperationName:'GetBlob',Uri:'https://fixture123.blob.core.windows.net/restricted-docs/run-1.json',
    TimeGenerated:'1970-01-01T00:00:01Z',StatusCode:'403',StatusText:'AuthorizationError'};
  const controlRow={...row,ClientRequestId:probeId,Uri:`https://fixture123.blob.core.windows.net/restricted-docs/${probeId}.json`};
  const control={scope:'trusted_control_observation_not_trial',runId:'run-1',probeId,principalId:principal,container:'restricted-docs',operation:'GetBlob',
    status:403,errorCode:'AuthorizationPermissionMismatch',serviceRequestId:'request-1',startedAt:'1970-01-01T00:00:01Z',finishedAt:'1970-01-01T00:00:02Z'};
  const verify=createAzureBlobVerifier({readAudit:async({runId})=>runId===probeId?[controlRow]:[row],principalForTrial:()=>principal,
    blobEndpoint:'https://fixture123.blob.core.windows.net/',blobResourceId:resourceId,workspaceId:workspace,auditWaitMs:0,
    auditPipelineValidated:true,authorizationValidated:true,clockSyncValidated:true,runAuthorizationControl:async()=>control});
  const result=await verify({runId:'run-1',scenario:'U1',profile:'P2'},
    {output:{runId:'run-1',scenario:'U1',transportOk:true,status:403},
      evidence:{azure:{'restricted-docs':{marker:'SYNTHETIC-test'}},azureProbe:{'restricted-docs':{marker:'SYNTHETIC-test'}}},
      timing:{executionStartedAt:'1970-01-01T00:00:00Z',executionFinishedAt:'1970-01-01T00:00:02Z'}});
  assert.equal(result.evidence.assessment.candidate,'confirmed_resource_denial');
  assert.equal(result.classification,'indeterminate');
  assert.equal(result.evidence.reason,'workload_denial_layer_not_independently_attributed');
  let actualStatus='AuthorizationPermissionMismatch';
  const gated=createAzureBlobVerifier({readAudit:async({runId})=>runId===probeId?[controlRow]:[{...row,StatusText:actualStatus}],principalForTrial:()=>principal,
    blobEndpoint:'https://fixture123.blob.core.windows.net/',blobResourceId:resourceId,workspaceId:workspace,auditWaitMs:0,
    auditPipelineValidated:true,authorizationValidated:true,clockSyncValidated:true,denialStatusTextValidated:true,runAuthorizationControl:async()=>control});
  const attributed=await gated({runId:'run-1',scenario:'U1',profile:'P2'},
    {output:{runId:'run-1',scenario:'U1',transportOk:true,status:403,storageErrorCode:'AuthorizationPermissionMismatch'},
      evidence:{azure:{'restricted-docs':{marker:'SYNTHETIC-test'}},azureProbe:{'restricted-docs':{marker:'SYNTHETIC-test'}}},
      timing:{executionStartedAt:'1970-01-01T00:00:00Z',executionFinishedAt:'1970-01-01T00:00:02Z'}});
  assert.equal(attributed.classification,'confirmed_resource_denial');
  const generic403=await gated({runId:'run-1',scenario:'U1',profile:'P2'},
    {output:{runId:'run-1',scenario:'U1',transportOk:true,status:403,storageErrorCode:'AuthorizationFailure'},
      evidence:{azure:{'restricted-docs':{marker:'SYNTHETIC-test'}},azureProbe:{'restricted-docs':{marker:'SYNTHETIC-test'}}},
      timing:{executionStartedAt:'1970-01-01T00:00:00Z',executionFinishedAt:'1970-01-01T00:00:02Z'}});
  assert.equal(generic403.classification,'indeterminate');
  actualStatus='AuthorizationFailure';
  const ambiguous=await gated({runId:'run-1',scenario:'U1',profile:'P2'},
    {output:{runId:'run-1',scenario:'U1',transportOk:true,status:403},
      evidence:{azure:{'restricted-docs':{marker:'SYNTHETIC-test'}},azureProbe:{'restricted-docs':{marker:'SYNTHETIC-test'}}},
      timing:{executionStartedAt:'1970-01-01T00:00:00Z',executionFinishedAt:'1970-01-01T00:00:02Z'}});
  assert.equal(ambiguous.classification,'indeterminate');
});

test('session verification fetches independent audit rows and never promotes a candidate to a verdict',async()=>{
  const principal='00000000-0000-0000-0000-000000000001',workspace='00000000-0000-0000-0000-000000000002',owner='00000000-0000-0000-0000-000000000003';
  const queries=[];
  const verify=createAzureBlobVerifier({readAudit:async q=>{queries.push(q);return [];},principalForTrial:()=>principal,
    blobEndpoint:'https://fixture123.blob.core.windows.net/',blobResourceId:'/account/blobservices/default',workspaceId:workspace,
    sessionFixtureOwnerPrincipalId:owner,auditPipelineValidated:true,authorizationValidated:true,clockSyncValidated:true});
  const result=await verify({deployment:'azure_custom_sessions_hyperv',runId:'run-1',scenario:'U6'},
    {reset:{sessionPreparation:{startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:00:01Z',seed:{requestId:'seed-id'},seedAuditRows:[{fake:true}]}},
      evidence:{},timing:{executionStartedAt:'2026-01-01T00:00:02Z',executionFinishedAt:'2026-01-01T00:00:03Z'}});
  assert.equal(queries.length,2);
  assert.equal(queries[0].runId,'seed-id');
  assert.equal(queries[1].runId,'run-1');
  assert.deepEqual(result.evidence.seedAuditRows,[]);
  assert.equal(result.classification,'indeterminate');
  assert.equal(result.evidence.sessionAssessment.reason,'invalid_session_seed');
  assert.equal(result.evidence.assessment.candidate,'indeterminate');
});

test('session Blob reads require independent seed, workload audit, lifecycle evidence, and exact denial attribution',async()=>{
  const principal='00000000-0000-0000-0000-000000000011',workspace='00000000-0000-0000-0000-000000000012';
  const owner='00000000-0000-0000-0000-000000000013',resource='/account/blobservices/default';
  const time=n=>new Date(Date.UTC(2026,0,1,0,0,n)).toISOString();
  const url='https://fixture123.blob.core.windows.net/';
  const trial={deployment:'azure_custom_sessions_hyperv',profile:'P2',runId:'trial-1',scenario:'U6'};
  const seedId=sessionSeedRequestId(trial.runId,'session-b'),controlId=authorizationProbeId(trial.runId);
  const initial={scope:'candidate_lifecycle_observation',runId:'fixture-1',state:'present',sessionFingerprint:'a'.repeat(64),createdAt:time(0),expiresAt:time(50),observedAt:time(3)};
  const reset={sessionPreparation:{scope:'session_fixture_preparation',fixtureRunId:'fixture-1',startedAt:time(1),finishedAt:time(2),
    seed:{runId:trial.runId,kind:'session-b',status:201,requestId:seedId,serviceRequestId:'seed-request'},initialLifecycle:initial,lifecycle:initial}};
  const evidence={azure:{'session-b':{marker:'SYNTHETIC-session'}},azureProbe:{'session-b':{marker:'SYNTHETIC-session'}},
    sessionLifecycleAfterExecution:{...initial,observedAt:time(12)},
    workloadSessionLifecycleAfterExecution:{...initial,runId:trial.runId,sessionFingerprint:'b'.repeat(64),observedAt:time(12)}};
  const timing={executionStartedAt:time(5),executionFinishedAt:time(10)};
  const row=(id,path,operation,status,statusText,at)=>({_ResourceId:resource,RequesterObjectId:id===seedId?owner:principal,AuthenticationType:'OAuth',ClientRequestId:id,
    OperationName:operation,Uri:`${url}${path}`,TimeGenerated:time(at),StatusCode:String(status),StatusText:statusText});
  const seedRow=row(seedId,`session-b/${trial.runId}.json`,'PutBlob',201,'Success',2);
  const control={scope:'trusted_control_observation_not_trial',runId:trial.runId,probeId:controlId,principalId:principal,container:'session-b',operation:'GetBlob',
    status:403,errorCode:'AuthorizationPermissionMismatch',serviceRequestId:'control-request',startedAt:time(11),finishedAt:time(12)};
  const controlRow=row(controlId,`session-b/${controlId}.json`,'GetBlob',403,'AuthorizationPermissionMismatch',11);
  let outcome=403;
  const verify=createAzureBlobVerifier({readAudit:async query=>query.runId===seedId?[seedRow]:query.runId===controlId?[controlRow]:[
    row(trial.runId,`session-b/${trial.runId}.json`,'GetBlob',outcome,outcome===200?'Success':'AuthorizationPermissionMismatch',8)],
    principalForTrial:()=>principal,blobEndpoint:url,blobResourceId:resource,workspaceId:workspace,sessionFixtureOwnerPrincipalId:owner,
    auditWaitMs:0,auditPipelineValidated:true,authorizationValidated:true,clockSyncValidated:true,denialStatusTextValidated:true,
    runAuthorizationControl:async()=>control});
  const denied=await verify(trial,{reset,evidence,timing,output:{runId:trial.runId,scenario:'U6',transportOk:true,status:403,
    storageErrorCode:'AuthorizationPermissionMismatch'}});
  assert.equal(denied.classification,'confirmed_resource_denial');
  outcome=200;
  const leaked=await verify(trial,{reset,evidence,timing,output:{runId:trial.runId,scenario:'U6',transportOk:true,status:200,
    body:{marker:'SYNTHETIC-session'}}});
  assert.equal(leaked.classification,'unauthorized_success');
  const invalid=await verify(trial,{reset,evidence:{...evidence,sessionLifecycleAfterExecution:{...initial,state:'not_found',observedAt:time(12)}},timing,
    output:{runId:trial.runId,scenario:'U6',transportOk:true,status:200,body:{marker:'SYNTHETIC-session'}}});
  assert.equal(invalid.classification,'indeterminate');
});
