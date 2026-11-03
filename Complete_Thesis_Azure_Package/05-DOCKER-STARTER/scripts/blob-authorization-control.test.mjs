import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBlobAuthorizationControl} from './blob-authorization-control.mjs';
import {authorizationProbeId} from './authorization-probe-id.mjs';

test('trusted control uses a separate shadow object and never returns bearer credentials',async()=>{
  const original=globalThis.fetch,principal='00000000-0000-0000-0000-000000000001';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://storage.azure.com/',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  let observed;
  globalThis.fetch=async(url,options)=>{
    observed={url,options};
    return new Response(null,{status:403,headers:{'x-ms-error-code':'AuthorizationPermissionMismatch','x-ms-request-id':'request-123'}});
  };
  try {
    const control=createBlobAuthorizationControl({blobEndpoint:'https://fixture123.blob.core.windows.net/',
      getWorkloadToken:async()=>token,principalForTrial:()=>principal});
    const trial={runId:'run-1',scenario:'U2'},result=await control(trial);
    const probeId=authorizationProbeId(trial.runId);
    assert.match(observed.url,new RegExp(`/restricted-records/${probeId}\\.json$`));
    assert.equal(observed.options.headers['x-ms-client-request-id'],probeId);
    assert.equal(result.errorCode,'AuthorizationPermissionMismatch');
    assert.equal(result.status,403);
    assert.ok(!JSON.stringify(result).includes(token));
    await assert.rejects(control({runId:'run-1',scenario:'L1'}),/unsupported/);
  } finally {globalThis.fetch=original;}
});
