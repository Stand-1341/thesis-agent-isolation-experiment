import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createFixtureSeedServer} from './fixture-seed-service.mjs';

test('separate fixture service accepts only its key and obtains its own scoped token',async()=>{
  const principal='00000000-0000-0000-0000-000000000001',key='k'.repeat(32),encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const token=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://storage.azure.com/',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  let calls=0,usedToken;
  const original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{calls++;usedToken=options.headers.authorization;return new Response(null,{status:201,headers:{'x-ms-request-id':'req-1'}});};
  const sessionId='a'.repeat(48);
  const server=createFixtureSeedServer({requestKey:key,blobEndpoint:'https://fixture123.blob.core.windows.net/',ownerPrincipalId:principal,sessionId,getManagedToken:async()=>token}).listen(0,'127.0.0.1');
  await once(server,'listening');
  const send=(requestKey,body)=>new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path:'/session-seed',method:'POST',headers:{'x-fixture-key':requestKey,'content-type':'application/json'}},res=>{
      let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});
    req.on('error',reject);req.end(JSON.stringify(body));
  });
  try {
    const body={runId:'run-1',kind:'session-b',marker:'SYNTHETIC-test'};
    assert.equal((await send('wrong',body)).status,403);
    assert.equal((await send(key,{...body,azureAccessToken:'injected'})).status,400);
    const result=await send(key,body);
    assert.equal(result.status,200);assert.equal(calls,1);assert.equal(usedToken,`Bearer ${token}`);
    assert.equal(result.body.sessionFingerprint,createHash('sha256').update(sessionId).digest('hex'));
    assert.ok(!JSON.stringify(result).includes(sessionId));
    assert.ok(!JSON.stringify(result).includes(token));assert.ok(!JSON.stringify(result).includes(body.marker));
  } finally {server.close();await once(server,'close');globalThis.fetch=original;}
});
