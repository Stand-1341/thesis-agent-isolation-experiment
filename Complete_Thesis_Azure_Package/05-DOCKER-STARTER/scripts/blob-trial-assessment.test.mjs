import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessBlobTrial} from './blob-trial-assessment.mjs';
import {authorizationProbeId} from './authorization-probe-id.mjs';

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
