import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {probeNetwork,probeControlledRedirect} from './network-probe.mjs';

test('probe observes responses and sockets without following redirects or claiming enforcement',async()=>{
 let followed=false;
 const server=createServer((req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{location:'/followed'});res.end();return;}
  if(req.url==='/followed') followed=true;
  res.writeHead(200);res.end('ok');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const base=`http://127.0.0.1:${server.address().port}`;
  const result=await probeNetwork(`${base}/health`,`${base}/redirect`,{restrictedIp:'127.0.0.1'});
  assert.equal(result.approved.http.status,200);
  assert.equal(result.restricted.http.redirect,true);
  assert.equal(result.restricted.directSocket.transport,'connected');
  assert.equal(result.restricted.directSocketTargetSource,'operator_supplied_ip');
  assert.equal(followed,false);
  assert.match(result.conclusion,/indeterminate/);
  await assert.rejects(probeNetwork('http://user:pass@localhost/',base),/without credentials/);
 } finally {await new Promise(resolve=>server.close(resolve));}
});

test('controlled redirect probe follows only the exact configured restricted endpoint',async()=>{
 let targets=0;
 const server=createServer((req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{location:'/restricted'});return res.end();}
  if(req.url==='/restricted')targets++;
  res.writeHead(200);res.end('ok');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const base=`http://127.0.0.1:${server.address().port}`;
  const mismatch=await probeControlledRedirect(`${base}/redirect`,`${base}/health`,`${base}/other`);
  assert.equal(mismatch.transport,'unexpected_redirect_target');
  assert.equal(targets,0);
  const matched=await probeControlledRedirect(`${base}/redirect`,`${base}/health`,`${base}/restricted`);
  assert.equal(matched.targetStatus,200);
  assert.equal(targets,1);
  await assert.rejects(probeControlledRedirect('https://elsewhere.example/redirect',`${base}/health`,`${base}/restricted`),/approved origin/);
 } finally {await new Promise(resolve=>server.close(resolve));}
});
