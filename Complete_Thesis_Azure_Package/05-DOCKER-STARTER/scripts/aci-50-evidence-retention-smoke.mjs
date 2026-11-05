#!/usr/bin/env node
/** Non-counted Blob WORM pre-lock smoke; writes only synthetic preflight objects. */
import {randomUUID} from 'node:crypto';
import {ManagedIdentityCredential} from '@azure/identity';

const env=process.env;
const containerUrl=env.THESIS_EVIDENCE_BLOB_CONTAINER_URL;
const writerId=env.THESIS_EVIDENCE_IDENTITY_CLIENT_ID;
const readerId=env.THESIS_EVIDENCE_READER_IDENTITY_CLIENT_ID;
if(!containerUrl||!writerId||!readerId||writerId.toLowerCase()===readerId.toLowerCase())
  throw new Error('separate evidence writer and reader identities plus container URL are required');
const endpoint=new URL(containerUrl);
if(endpoint.protocol!=='https:'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password)
  throw new Error('invalid evidence container URL');
const getToken=async clientId=>{
  const result=await new ManagedIdentityCredential({clientId}).getToken('https://storage.azure.com/.default');
  if(typeof result?.token!=='string'||!result.token) throw new Error('managed identity Storage token unavailable');
  return result.token;
};
const [writerToken,readerToken]=await Promise.all([getToken(writerId),getToken(readerId)]);
const blobId=randomUUID();
const blobUrl=new URL(`${endpoint.pathname.replace(/\/$/,'')}/preflight/retention-smoke-${blobId}.json`,endpoint.origin);
const immutableRecord=JSON.stringify({schema:'aci_50_retention_smoke_v1',scope:'non_counted_pilot_preflight',blobId,
  createdAt:new Date().toISOString(),retentionDays:146000});
const headers={
  'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString(),
  'content-type':'application/json; charset=utf-8','x-ms-blob-type':'BlockBlob'
};
const create=await fetch(blobUrl,{method:'PUT',headers:{...headers,authorization:`Bearer ${writerToken}`,'if-none-match':'*'},
  body:immutableRecord,redirect:'error',signal:AbortSignal.timeout(15000)});
if(!create.ok) throw new Error(`retention smoke create failed HTTP ${create.status}; code=${create.headers.get('x-ms-error-code')??'unknown'}`);
const etag=create.headers.get('etag');
const read=await fetch(blobUrl,{headers:{authorization:`Bearer ${readerToken}`,'x-ms-version':'2023-11-03',
  'x-ms-date':new Date().toUTCString()},redirect:'error',signal:AbortSignal.timeout(15000)});
const readBody=read.ok?await read.text():'';
const separateReaderReadback=read.ok&&readBody===immutableRecord;
const overwrite=await fetch(blobUrl,{method:'PUT',headers:{...headers,authorization:`Bearer ${writerToken}`,
  'if-match':etag??'*'},body:'{"modified":true}',redirect:'error',signal:AbortSignal.timeout(15000)});
const overwriteDenied=overwrite.status===409;
const remove=await fetch(blobUrl,{method:'DELETE',headers:{authorization:`Bearer ${writerToken}`,
  'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString()},redirect:'error',signal:AbortSignal.timeout(15000)});
const deleteDenied=remove.status===409;
const report={scope:'non_counted_preflight_not_trial',blobReference:blobUrl.href,retentionDays:146000,
  writeStatus:create.status,separateReaderReadStatus:read.status,separateReaderReadback,
  overwriteStatus:overwrite.status,overwriteErrorCode:overwrite.headers.get('x-ms-error-code')??null,overwriteDenied,
  deleteStatus:remove.status,deleteErrorCode:remove.headers.get('x-ms-error-code')??null,deleteDenied,
  contentsDisplayed:false,tokensDisplayed:false,passed:separateReaderReadback&&overwriteDenied&&deleteDenied};
console.log(JSON.stringify(report));
if(!report.passed) process.exitCode=1;
