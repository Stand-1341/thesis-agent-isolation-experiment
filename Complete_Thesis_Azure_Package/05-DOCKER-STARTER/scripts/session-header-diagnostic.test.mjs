import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createSessionHeaderDiagnostic} from './session-header-diagnostic.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

test('trusted diagnostic reports token and session presence without echoing values',async()=>{
  const reserve=createServer().listen(0,'127.0.0.1'); await once(reserve,'listening');
  const port=reserve.address().port; await new Promise(resolve=>reserve.close(resolve));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/header-audit.js',import.meta.url))],{env:{...process.env,PORT:String(port)}});
  const token='synthetic-token-value-that-is-long-enough',sessionId='synthetic-session-identifier';
  try {
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('diagnostic exited');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('diagnostic timeout')),5000).unref())]);
    const response=await fetch(`http://127.0.0.1:${port}/inspect?identifier=${sessionId}`,{method:'POST',
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({tokenSha256:hash(token),sessionIdSha256:hash(sessionId)})});
    const text=await response.text(),result=JSON.parse(text);
    assert.equal(result.controlTokenValuePresent,true);
    assert.equal(result.sessionIdentifierValuePresent,true);
    assert.ok(!text.includes(token) && !text.includes(sessionId));
  } finally {if(child.exitCode===null && child.signalCode===null) {child.kill();await once(child,'exit').catch(()=>{});}}
});

test('fixed-target P3 probe reports only connection outcomes and HTTP status',async()=>{
  const servers=[200,403,400].map(status=>createHttpServer((req,res)=>{res.writeHead(status);res.end('discarded response body');}));
  await Promise.all(servers.map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))));
  const urls=servers.map(server=>`http://127.0.0.1:${server.address().port}/health`);
  const reserve=createServer().listen(0,'127.0.0.1'); await once(reserve,'listening');
  const port=reserve.address().port; await new Promise(resolve=>reserve.close(resolve));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/header-audit.js',import.meta.url))],{env:{...process.env,PORT:String(port),
    P3_RESEARCH_PROBE_URL:urls[0],P3_COLLECTOR_PROBE_URL:urls[1],P3_BLOB_PROBE_URL:urls[2],
    P3_PUBLIC_IP_PROBE_HOST:'127.0.0.1',P3_PUBLIC_IP_PROBE_PORT:String(servers[0].address().port)}});
  try {
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('diagnostic exited');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('diagnostic timeout')),5000).unref())]);
    const response=await fetch(`http://127.0.0.1:${port}/probe`,{method:'POST'});
    const text=await response.text(),result=JSON.parse(text);
    assert.equal(response.status,200);
    assert.equal(result.scope,'fixed_pilot_network_probe');
    assert.deepEqual(result.results,[
      {name:'research',connected:true,status:200},
      {name:'collector',connected:true,status:403},
      {name:'blob',connected:true,status:400},
      {name:'publicIp',connected:true,status:null}
    ]);
    assert.ok(!text.includes('discarded response body') && !text.includes('127.0.0.1'));
  } finally {
    if(child.exitCode===null && child.signalCode===null) {child.kill();await once(child,'exit').catch(()=>{});}
    await Promise.all(servers.map(server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})));
  }
});

test('diagnostic client sends only fingerprints in the body',async()=>{
  const original=globalThis.fetch,stored=[],principal='00000000-0000-0000-0000-000000000099';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://dynamicsessions.io',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url.hostname,'testpool.env123.eastus.azurecontainerapps.io');
    const body=JSON.parse(options.body);
    assert.equal(body.tokenSha256,hash(token));
    assert.equal(body.sessionIdSha256,hash(stored[0].sessionId));
    assert.ok(!options.body.includes(token) && !options.body.includes(stored[0].sessionId));
    return new Response(JSON.stringify({authorizationHeaderPresent:false,proxyAuthorizationHeaderPresent:false,
      credentialLikeHeaderNames:[],controlTokenValuePresent:false,sessionIdentifierValuePresent:false}),{status:200});
  };
  try {
    const inspect=createSessionHeaderDiagnostic({managementEndpoint:'https://testpool.env123.eastus.azurecontainerapps.io/',poolName:'testpool',region:'eastus',
      getDiagnosticToken:async()=>token,diagnosticPrincipalId:principal,sessionRegistry:{save:async value=>stored.push(value)}});
    const result=await inspect('diagnostic-1');
    assert.equal(result.controlTokenValuePresent,false);
    assert.match(result.scope,/observation_only/);
    assert.throws(()=>createSessionHeaderDiagnostic({managementEndpoint:'https://attacker.example/',poolName:'testpool',region:'eastus',getDiagnosticToken:async()=>token}),/does not match/);
  } finally {globalThis.fetch=original;}
});

test('network probe client validates fixed result names without logging identifiers',async()=>{
  const original=globalThis.fetch,stored=[],principal='00000000-0000-0000-0000-000000000099';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const token=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://dynamicsessions.io',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).pathname,'/probe');
    const body=JSON.parse(options.body);
    assert.equal(body.tokenSha256,hash(token));
    assert.equal(body.sessionIdSha256,hash(stored[0].sessionId));
    assert.ok(!options.body.includes(token) && !options.body.includes(stored[0].sessionId));
    return new Response(JSON.stringify({scope:'fixed_pilot_network_probe',results:[
      {name:'research',connected:true,status:200},
      {name:'collector',connected:false,status:null},
      {name:'blob',connected:true,status:400},
      {name:'publicIp',connected:false,status:null}
    ]}),{status:200});
  };
  try {
    const probe=createSessionHeaderDiagnostic({managementEndpoint:'https://testpool.env123.eastus.azurecontainerapps.io/',poolName:'testpool',region:'eastus',
      getDiagnosticToken:async()=>token,diagnosticPrincipalId:principal,sessionRegistry:{save:async value=>stored.push(value)},probeNetwork:true});
    const result=await probe('diagnostic-network-1');
    assert.equal(result.scope,'diagnostic_network_observation_only');
    assert.deepEqual(result.results.map(value=>value.name),['research','collector','blob','publicIp']);
    assert.equal(result.results[1].connected,false);
    assert.equal(result.results[3].status,null);
  } finally {globalThis.fetch=original;}
});
