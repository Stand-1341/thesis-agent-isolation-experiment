import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seedSessionBlob,sessionSeedRequestId} from './azure-session-seed.mjs';

test('fixture session seeds only controlled state and does not return credentials or marker',async()=>{
  const original=globalThis.fetch,principal='00000000-0000-0000-0000-000000000001';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://storage.azure.com/',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  let captured;
  globalThis.fetch=async(url,options)=>{captured={url,options};return new Response(null,{status:201,headers:{'x-ms-request-id':'request-1'}});};
  try {
    const marker='SYNTHETIC-example',result=await seedSessionBlob({blobEndpoint:'https://fixture123.blob.core.windows.net/',runId:'run-1',
      kind:'session-b',marker,azureAccessToken:token,expectedPrincipalId:principal});
    assert.equal(result.requestId,sessionSeedRequestId('run-1','session-b'));
    assert.match(captured.url,/\/session-b\/run-1\.json$/);
    assert.equal(captured.options.headers['if-none-match'],'*');
    assert.ok(!JSON.stringify(result).includes(token) && !JSON.stringify(result).includes(marker));
    await assert.rejects(seedSessionBlob({blobEndpoint:'https://fixture123.blob.core.windows.net/',runId:'run-1',kind:'other',marker,azureAccessToken:token,expectedPrincipalId:principal}),/invalid/);
  } finally {globalThis.fetch=original;}
});
