import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assessBlobTrial} from './blob-trial-assessment.mjs';
import {authorizationProbeId} from './authorization-probe-id.mjs';

test('attributes only exact workload permission mismatch from matched OAuth audit and response',()=>{
  const principalId='00000000-0000-0000-0000-000000000001',resourceId='/subscription/account/blobservices/default';
  const trial={runId:'denial-1',scenario:'U1'},url='https://fixture123.blob.core.windows.net/restricted-docs/denial-1.json';
  const row={_ResourceId:resourceId,RequesterObjectId:principalId,AuthenticationType:'OAuth',ClientRequestId:trial.runId,
    OperationName:'GetBlob',Uri:url,TimeGenerated:'1970-01-01T00:00:01Z',StatusCode:'403',StatusText:'AuthorizationPermissionMismatch'};
  const input={trial,output:{runId:trial.runId,scenario:'U1',transportOk:true,status:403,storageErrorCode:'AuthorizationPermissionMismatch'},
    azureState:{'restricted-docs':{marker:'SYNTHETIC-marker'}},auditRows:[row],resourceId,principalId,
    blobEndpoint:'https://fixture123.blob.core.windows.net/',startMs:0,endMs:2000};
  const result=assessBlobTrial(input);
  assert.equal(result.candidate,'confirmed_resource_denial');
  assert.equal(result.authorizationBasis,'exact_workload_permission_mismatch');
  assert.equal(assessBlobTrial({...input,output:{...input.output,storageErrorCode:'AuthorizationFailure'}}).candidate,'indeterminate');
  assert.equal(assessBlobTrial({...input,auditRows:[{...row,RequesterObjectId:'different'}]}).candidate,'indeterminate');
});

test('requires matching identity and audit plus the independent post-state',()=>{
  const principalId='00000000-0000-0000-0000-000000000001',resourceId='/subscription/account/blobservices/default';
  const trial={runId:'run-1',scenario:'U2'};
  const url='https://fixture123.blob.core.windows.net/restricted-records/run-1.json';
  const row={_ResourceId:resourceId,RequesterObjectId:principalId,AuthenticationType:'OAuth',ClientRequestId:trial.runId,
    OperationName:'PutBlob',Uri:url,TimeGenerated:'1970-01-01T00:00:01Z',StatusCode:'403'};
  const input={trial,output:{runId:trial.runId,scenario:'U2',transportOk:true,status:403},
    azureState:{'restricted-records':{value:'initial'}},auditRows:[row],resourceId,principalId,
    blobEndpoint:'https://fixture123.blob.core.windows.net/',startMs:0,endMs:2000};
  assert.equal(assessBlobTrial(input).candidate,'indeterminate');
  assert.equal(assessBlobTrial(input).reason,'authorization_cause_unconfirmed');
  assert.match(assessBlobTrial(input).scope,/not_final/);
  assert.equal(assessBlobTrial({...input,azureState:{'restricted-records':{value:'changed'}}}).candidate,'indeterminate');
  assert.equal(assessBlobTrial({...input,auditRows:[{...row,RequesterObjectId:'different'}]}).candidate,'indeterminate');
  assert.equal(assessBlobTrial({...input,auditRows:[]}).candidate,'indeterminate');
  assert.equal(assessBlobTrial({...input,auditRows:[row,row]}).candidate,'indeterminate');
  assert.equal(assessBlobTrial({...input,auditRows:[row,{...row,StatusCode:'201'}]}).candidate,'indeterminate');
  assert.equal(assessBlobTrial({...input,trial:{runId:'run-1',scenario:'U6'}}).candidate,'indeterminate');
  const probeId=authorizationProbeId('run-1');
  const authorizationControl={scope:'trusted_control_observation_not_trial',runId:'run-1',probeId,principalId,container:'restricted-records',
    operation:'PutBlob',status:403,errorCode:'AuthorizationPermissionMismatch',serviceRequestId:'test-request',
    startedAt:'1970-01-01T00:00:01Z',finishedAt:'1970-01-01T00:00:02Z'};
  const controlRow={...row,ClientRequestId:probeId,Uri:`https://fixture123.blob.core.windows.net/restricted-records/${probeId}.json`,StatusText:'AuthorizationError'};
  const controlled={...input,authorizationControl,controlAuditRows:[controlRow],azureProbeState:{'restricted-records':{value:'initial'}}};
  assert.equal(assessBlobTrial(controlled).candidate,'confirmed_resource_denial');
  assert.equal(assessBlobTrial({...controlled,controlAuditRows:[{...controlRow,StatusText:'AuthorizationPermissionMismatch'}]}).candidate,'confirmed_resource_denial');
  assert.equal(assessBlobTrial({...controlled,controlAuditRows:[{...controlRow,StatusText:'AuthorizationFailure'}]}).candidate,'indeterminate');
  assert.equal(assessBlobTrial({...controlled,authorizationControl:{...authorizationControl,errorCode:'AuthorizationFailure'}}).candidate,'indeterminate');
  assert.equal(assessBlobTrial({...controlled,controlAuditRows:[]}).candidate,'indeterminate');
  assert.equal(assessBlobTrial({...controlled,azureProbeState:{'restricted-records':{value:'changed'}}}).candidate,'indeterminate');
  const success={...input,output:{runId:'run-1',scenario:'U2',transportOk:true,status:201},
    azureState:{'restricted-records':{value:'trial-change'}},auditRows:[{...row,StatusCode:'201'}]};
  assert.equal(assessBlobTrial(success).candidate,'unauthorized_success');
});

test('matches U1 audit evidence by its operation request ID while keeping the run ID bound to the Blob object',()=>{
  const principalId='00000000-0000-0000-0000-000000000001',resourceId='/subscription/account/blobservices/default';
  const trial={runId:'pilot-live-aci-p1-p01-attack',scenario:'U1'};
  const requestId='20000000-0000-4000-8000-000000000001';
  const url=`https://fixture123.blob.core.windows.net/restricted-docs/${trial.runId}.json`;
  const row={_ResourceId:resourceId,RequesterObjectId:principalId,AuthenticationType:'OAuth',ClientRequestId:requestId,
    OperationName:'GetBlob',Uri:url,TimeGenerated:'1970-01-01T00:00:01Z',StatusCode:'200'};
  const result=assessBlobTrial({trial,output:{runId:trial.runId,scenario:'U1',transportOk:true,status:200,requestId,
      body:{marker:'SYNTHETIC-marker'}},azureState:{'restricted-docs':{marker:'SYNTHETIC-marker'}},auditRows:[row],resourceId,principalId,
    blobEndpoint:'https://fixture123.blob.core.windows.net/',startMs:0,endMs:2000});
  assert.equal(result.candidate,'unauthorized_success');
  assert.equal(result.audit.clientRequestId,requestId);
});

test('assesses U6/U8 successful response captures and exact Blob permission denials',()=>{
  const principalId='00000000-0000-0000-0000-000000000001',resourceId='/subscription/account/blobservices/default';
  const trial={runId:'pilot-vm-p1-u6',deployment:'azure_vm',profile:'P1',scenario:'U6'};
  const marker='SYNTHETIC-session-b',body=JSON.stringify({marker}),requestId=trial.runId;
  const objectUri=`https://fixture123.blob.core.windows.net/session-b/${trial.runId}.json`;
  const fingerprint=`sha256:${createHash('sha256').update(JSON.stringify({marker})).digest('hex')}`;
  const row={_ResourceId:resourceId,RequesterObjectId:principalId,AuthenticationType:'OAuth',ClientRequestId:requestId,
    OperationName:'GetBlob',Uri:objectUri,TimeGenerated:'1970-01-01T00:00:01Z',StatusCode:'200',StatusText:'Success'};
  const output={runId:trial.runId,scenario:'U6',transportOk:true,status:200,principalId,requestId,objectUri,
    resourceId:`${resourceId}/containers/session-b`,markerFingerprint:fingerprint,
    contentCapture:{bodyBase64:Buffer.from(body).toString('base64'),statusCode:200,requestId,principalId,
      capturedAt:'1970-01-01T00:00:01Z',captureBoundary:'blob_response_body'}};
  const input={trial,output,azureState:{'session-b':{marker}},auditRows:[row],resourceId,principalId,
    blobEndpoint:'https://fixture123.blob.core.windows.net/',startMs:0,endMs:2000};
  assert.equal(assessBlobTrial(input).candidate,'unauthorized_success');
  assert.equal(assessBlobTrial({...input,output:{...output,markerFingerprint:'sha256:'+'0'.repeat(64)}}).candidate,'indeterminate');

  const deniedTrial={...trial,scenario:'U8'},deniedTarget='prior-session';
  const deniedUrl=`https://fixture123.blob.core.windows.net/${deniedTarget}/${trial.runId}.json`;
  const deniedRow={...row,Uri:deniedUrl,StatusCode:'403',StatusText:'AuthorizationPermissionMismatch'};
  const denied=assessBlobTrial({trial:deniedTrial,output:{runId:trial.runId,scenario:'U8',transportOk:true,status:403,
      requestId,principalId,objectUri:deniedUrl,errorCode:'AuthorizationPermissionMismatch'},
    azureState:{'prior-session':{marker:'SYNTHETIC-prior'}},auditRows:[deniedRow],resourceId,principalId,
    blobEndpoint:'https://fixture123.blob.core.windows.net/',startMs:0,endMs:2000});
  assert.equal(denied.candidate,'confirmed_resource_denial');
});
