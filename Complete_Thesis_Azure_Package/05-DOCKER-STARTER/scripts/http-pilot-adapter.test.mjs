import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHttpPilotAdapter} from './http-pilot-adapter.mjs';

test('pilot adapter keeps controller and fixture credentials on their intended requests', async()=>{
  const seen=[];
  const server=createServer((req,res)=>{
    seen.push({path:req.url,admin:req.headers['x-admin-token'],controller:req.headers['x-trial-key'],functionKey:req.headers['x-functions-key']});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url.endsWith('/health')?{ready:true}:req.url==='/resource/admin/reset'?{u5Marker:'SYNTHETIC-test'}:{ok:true}));
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const adapter=createHttpPilotAdapter({resourceUrl:`${origin}/resource`,collectorUrl:`${origin}/collector`,agentUrl:`${origin}/agent`,
      resourceAdminToken:'resource-secret',collectorAdminToken:'collector-secret',controllerToken:'controller-secret',functionKey:'function-secret'});
    const trial={runId:'test',scenario:'U5'};
    const fixture=await adapter.reset(trial);
    await adapter.execute(trial,fixture);
    await adapter.collect(trial);
    assert.equal(seen.length,7);
    for (const request of seen.filter(value=>!value.path.endsWith('/health'))) {
      if (request.path.startsWith('/resource/')) assert.deepEqual([request.admin,request.controller],['resource-secret',undefined]);
      if (request.path.startsWith('/collector/')) assert.deepEqual([request.admin,request.controller],['collector-secret',undefined]);
      if (request.path.startsWith('/agent/')) assert.deepEqual([request.admin,request.controller],[undefined,'controller-secret']);
      assert.equal(request.functionKey,request.path.startsWith('/agent/')?'function-secret':undefined);
    }
    assert.throws(()=>createHttpPilotAdapter({resourceUrl:`${origin}/resource`,collectorUrl:`${origin}/collector`,agentUrl:`${origin}/agent`,
      resourceAdminToken:'a',collectorAdminToken:'b',controllerToken:'c',functionKey:'bad\nkey'}),/invalid function key/);
    assert.throws(()=>createHttpPilotAdapter({resourceUrl:'http://example.com'}));
  } finally {server.close(); await once(server,'close');}
});

test('retries transient health failures but never repeats a failed reset',async()=>{
  let health=0,resets=0;
  const server=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url.endsWith('/health')) { health++; if(health===1){res.statusCode=502;res.end('{}');} else res.end('{"ready":true}'); return; }
    if(req.url.endsWith('/admin/reset')) {resets++;res.statusCode=500;res.end('{}');return;}
    res.statusCode=404;res.end('{}');
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const adapter=createHttpPilotAdapter({resourceUrl:`${origin}/resource`,collectorUrl:`${origin}/collector`,agentUrl:`${origin}/agent`,
      resourceAdminToken:'r',collectorAdminToken:'c',controllerToken:'t',readinessTimeoutMs:1000,readinessPollMs:5});
    await assert.rejects(adapter.reset({runId:'setup'}),/pilot endpoint HTTP 500/);
    assert.ok(health>=3);
    assert.equal(resets,1);
  } finally {server.closeAllConnections();server.close();await once(server,'close');}
});

test('reports partial reset when collector reset fails after resource reset',async()=>{
  const seen=[];
  const server=createServer((req,res)=>{
    seen.push(req.url);res.setHeader('content-type','application/json');
    if(req.url.endsWith('/health')) return res.end('{"ready":true}');
    if(req.url==='/resource/admin/reset') return res.end('{"u5Marker":"SYNTHETIC-test"}');
    res.statusCode=503;res.end('{}');
  }).listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const adapter=createHttpPilotAdapter({resourceUrl:`${origin}/resource`,collectorUrl:`${origin}/collector`,agentUrl:`${origin}/agent`,resourceAdminToken:'r',collectorAdminToken:'c',controllerToken:'t'});
    await assert.rejects(adapter.reset({runId:'setup'}),error=>{
      assert.deepEqual(error.partialReset,{scope:'fixture_reset_progress',resourceResetCompleted:true,collectorResetConfirmed:false,
        collectorOutcome:'unknown',collectorHttpStatus:503});return true;
    });
    assert.equal(seen.filter(path=>path==='/resource/admin/reset').length,1);
    assert.equal(seen.filter(path=>path==='/collector/admin/reset').length,1);
  } finally {server.closeAllConnections();server.close();await once(server,'close');}
});
