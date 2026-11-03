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
 async function serve(port,handler){
  const server=createServer(handler); servers.push(server);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
 }
 const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data))};
 try {
  await serve(9000,(req,res)=>req.url==='/admin/reset'?json(res,200,{u5Marker:'SYNTHETIC-test'}):json(res,503,{error:'unavailable'}));
  await serve(9001,(_req,res)=>json(res,200,{seeded:true}));
  await serve(8081,(_req,res)=>json(res,200,{status:200,body:{marker:'synthetic-result'}}));
  const script=join(dirname(fileURLToPath(import.meta.url)),'local-smoke.mjs');
  const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[script],{cwd:dir,stdio:'ignore'});child.on('error',reject);child.on('exit',resolve)});
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
