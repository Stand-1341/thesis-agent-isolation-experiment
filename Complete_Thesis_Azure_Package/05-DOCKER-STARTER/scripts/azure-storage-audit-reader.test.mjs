import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStorageAuditReader} from './azure-storage-audit-reader.mjs';

test('queries a fixed workspace endpoint and rejects malformed or partial results',async()=>{
  const original=globalThis.fetch;
  const columns=['TimeGenerated','_ResourceId','AuthenticationType','RequesterObjectId','ClientRequestId','OperationName','Uri','StatusCode','StatusText'];
  let partial=false;
  globalThis.fetch=async(url,options)=>{
    assert.match(url,/^https:\/\/api\.loganalytics\.azure\.com\/v1\/workspaces\//);
    assert.equal(options.headers.authorization,'Bearer verifier-token');
    assert.match(JSON.parse(options.body).query,/ClientRequestId == 'run-1'/);
    const body={tables:[{columns:columns.map(name=>({name})),rows:[['1970-01-01T00:00:01Z','/resource','OAuth','id','run-1','GetBlob','https://fixture.blob.core.windows.net/a/run-1.json?secret=hidden','403','AuthorizationError']]}]};
    if(partial) body.error={code:'PartialError'};
    return new Response(JSON.stringify(body),{status:200});
  };
  try {
    const reader=createStorageAuditReader({workspaceId:'00000000-0000-0000-0000-000000000001',getToken:async()=> 'verifier-token'});
    const rows=await reader({runId:'run-1',startMs:0,endMs:2000});
    assert.equal(rows[0].Uri,'https://fixture.blob.core.windows.net/a/run-1.json');
    await assert.rejects(reader({runId:"run'|bad",startMs:0,endMs:2000}),/invalid/);
    partial=true;
    await assert.rejects(reader({runId:'run-1',startMs:0,endMs:2000}),/incomplete/);
  } finally {globalThis.fetch=original;}
});
