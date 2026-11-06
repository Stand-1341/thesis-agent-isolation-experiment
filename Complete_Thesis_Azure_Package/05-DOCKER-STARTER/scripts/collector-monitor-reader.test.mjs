import assert from 'node:assert/strict';
import test from 'node:test';
import {createCollectorMonitorReader} from './collector-monitor-reader.mjs';

const base='https://collector.example.test';
const monitor={ready:true,journalEnabled:true,journalHealthy:true,observedAt:'2026-11-05T12:00:02.000Z'};

test('collector monitor reader fetches the protected health record and validates its shape',async()=>{
  let seen;
  const read=createCollectorMonitorReader({collectorUrl:base,verifierKey:'synthetic-verifier-key',fetchImpl:async(url,options)=>{
    seen={url:String(url),options};return new Response(JSON.stringify(monitor),{status:200,headers:{'content-type':'application/json'}});
  }});
  assert.deepEqual(await read(),monitor);
  assert.equal(seen.url,`${base}/admin/monitor`);
  assert.equal(seen.options.headers['x-verifier-token'],'synthetic-verifier-key');
  assert.equal(seen.options.redirect,'error');
});

test('collector monitor reader rejects unsafe URLs, credentials and invalid monitor bodies',async()=>{
  for(const value of ['http://collector.example.test','https://user:pass@collector.example.test','https://collector.example.test/path'])
    assert.throws(()=>createCollectorMonitorReader({collectorUrl:value,verifierKey:'synthetic-verifier-key'}));
  const read=createCollectorMonitorReader({collectorUrl:base,verifierKey:'synthetic-verifier-key',
    fetchImpl:async()=>new Response(JSON.stringify({ready:true}),{status:200})});
  await assert.rejects(()=>read(),/invalid collector monitor response/);
});

test('collector monitor reader does not leak verifier credentials or response bodies',async()=>{
  const verifier='never-print-this-verifier',body='never-print-provider-body';
  const read=createCollectorMonitorReader({collectorUrl:base,verifierKey:verifier,fetchImpl:async()=>new Response(body,{status:403})});
  await assert.rejects(()=>read(),error=>{
    assert.equal(error.message.includes(verifier),false);assert.equal(error.message.includes(body),false);
    return /HTTP 403/.test(error.message);
  });
  const transport=createCollectorMonitorReader({collectorUrl:base,verifierKey:verifier,
    fetchImpl:async()=>{throw new Error(`${verifier} ${body}`);}});
  await assert.rejects(()=>transport(),error=>{
    assert.equal(error.message.includes(verifier),false);assert.equal(error.message.includes(body),false);return true;
  });
});
