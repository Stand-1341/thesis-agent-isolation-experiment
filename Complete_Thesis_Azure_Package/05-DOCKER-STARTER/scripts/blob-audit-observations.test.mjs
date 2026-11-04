import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findBlobAuditCandidates} from './blob-audit-observations.mjs';

test('requires matching identity, target, operation and run for audit candidates',()=>{
  const principal='00000000-0000-0000-0000-000000000001';
  const query={resourceId:'/subscriptions/example/blobservices/default',principalId:principal,runId:'run-1',
    expectedUrl:'https://fixture123.blob.core.windows.net/restricted-docs/run-1.json',operation:'GetBlob',startMs:0,endMs:2000};
  const row={_ResourceId:query.resourceId,RequesterObjectId:principal,AuthenticationType:'OAuth',ClientRequestId:'run-1',
    OperationName:'GetBlob',Uri:query.expectedUrl,TimeGenerated:'1970-01-01T00:00:01Z',StatusCode:'403'};
  const result=findBlobAuditCandidates([row,{...row,RequesterObjectId:'different'},{...row,ClientRequestId:'other'}],query);
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].statusCode,403);
  assert.match(result.scope,/not_verified/);
  assert.throws(()=>findBlobAuditCandidates([row],{...query,expectedUrl:'https://attacker.example/run-1.json'}),/invalid audit target/);
});

test('matches the exact operation clientRequestId while retaining the distinct condition runId for the Blob path',()=>{
  const principal='00000000-0000-0000-0000-000000000001';
  const query={resourceId:'/subscriptions/example/blobservices/default',principalId:principal,runId:'pilot-condition-01',
    clientRequestId:'20000000-0000-4000-8000-000000000001',
    expectedUrl:'https://fixture123.blob.core.windows.net/restricted-docs/pilot-condition-01.json',
    operation:'GetBlob',startMs:0,endMs:2000};
  const row={_ResourceId:query.resourceId,RequesterObjectId:principal,AuthenticationType:'OAuth',ClientRequestId:query.clientRequestId,
    OperationName:'GetBlob',Uri:query.expectedUrl,TimeGenerated:'1970-01-01T00:00:01Z',StatusCode:'200'};
  const result=findBlobAuditCandidates([row,{...row,ClientRequestId:query.runId}],query);
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].clientRequestId,query.clientRequestId);
  assert.throws(()=>findBlobAuditCandidates([row],{...query,clientRequestId:'invalid id'}),/invalid audit query/);
});
