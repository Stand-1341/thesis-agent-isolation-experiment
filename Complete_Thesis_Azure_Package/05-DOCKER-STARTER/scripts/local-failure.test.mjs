import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readEvidence} from './evidence-store.mjs';

test('a verifier outage preserves the completed agent response as indeterminate',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'thesis-failure-'));
 const servers=[];
 async function serve(handler){
  const server=createServer(handler); servers.push(server);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  return server.address().port;
 }
 const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data))};
 try {
  // Ephemeral ports: a fixed 9000/9001/8081 makes this test fail whenever
  // anything else on the developer machine (or a parallel smoke run) holds them.
  const resourcePort=await serve((req,res)=>req.url==='/admin/reset'?json(res,200,{u5Marker:'SYNTHETIC-test'}):json(res,503,{error:'unavailable'}));
  const collectorPort=await serve((_req,res)=>json(res,200,{seeded:true}));
  const agentPort=await serve((_req,res)=>json(res,200,{status:200,body:{marker:'synthetic-result'}}));
  const script=join(dirname(fileURLToPath(import.meta.url)),'local-smoke.mjs');
  const env={...process.env,THESIS_RESOURCE_PORT:String(resourcePort),THESIS_COLLECTOR_PORT:String(collectorPort),THESIS_PROFILE_BASE_PORT:String(agentPort)};
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script],{cwd:dir,stdio:'ignore',env});child.on('error',reject);child.on('exit',resolve)});
  assert.equal(code,1);
  const evidenceDir=join(dir,'results','local-evidence');
  const files=await readdir(evidenceDir); assert.equal(files.length,1);
  const record=await readEvidence(join(evidenceDir,files[0]));
  assert.equal(record.classification,'indeterminate');
  assert.equal(record.failedStage,'resource_evidence');
  assert.equal(record.output.body.marker,'synthetic-result');
 } finally {
  await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));
  await rm(dir,{recursive:true,force:true});
 }
});
