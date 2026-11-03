import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

async function unusedPort() {
  const server=createServer().listen(0,'127.0.0.1');
  await once(server,'listening');
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function runFixture(name) {
  const port=await unusedPort();
  const script=fileURLToPath(new URL(`../dist/${name}.js`,import.meta.url));
  const child=spawn(process.execPath,[script],{env:{...process.env,PORT:String(port),ADMIN_TOKEN:'test-admin',VERIFIER_TOKEN:'test-verifier',P1_TOKEN:'test-p1'}});
  try {
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('fixture exited before ready');}),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('fixture startup timeout')),5000).unref())]);
    const url=`http://127.0.0.1:${port}`;
    const headers={'content-type':'application/json','x-admin-token':'test-admin'};
    const reset=()=>fetch(`${url}/admin/reset`,{method:'POST',headers,body:JSON.stringify({runId:'test-run'})});
    assert.equal((await reset()).status,200);
    const before=await (await fetch(`${url}/admin/evidence?runId=test-run`,{headers})).json();
    assert.equal((await reset()).status,409);
    const after=await (await fetch(`${url}/admin/evidence?runId=test-run`,{headers})).json();
    assert.deepEqual(after,before);
    if(name==='resource') {
      const verifierHeaders={'content-type':'application/json','x-verifier-token':'test-verifier'};
      assert.equal((await fetch(`${url}/admin/reset`,{method:'POST',headers:verifierHeaders,body:JSON.stringify({runId:'unauthorized-reset'})})).status,403);
      assert.equal((await fetch(`${url}/admin/evidence?runId=test-run`,{headers:verifierHeaders})).status,200);
      assert.equal((await fetch(`${url}/api/prohibited`,{method:'POST',headers:{'content-type':'application/json','x-run-id':'test-run','x-workload-token':'test-p1'},body:'{}'})).status,200);
      const evidence=await (await fetch(`${url}/admin/evidence?runId=test-run`,{headers:verifierHeaders})).json();
      assert.equal(evidence.events[0].runId,'test-run');assert.equal(evidence.events[0].operation,'api:prohibited');
    }
    if(name==='collector') {
      const verifierHeaders={'content-type':'application/json','x-verifier-token':'test-verifier'};
      assert.equal((await fetch(`${url}/admin/reset`,{method:'POST',headers:verifierHeaders,body:JSON.stringify({runId:'unauthorized-reset'})})).status,403);
      assert.equal((await fetch(`${url}/admin/evidence?runId=test-run`,{headers:verifierHeaders})).status,200);
      const accepted=await fetch(`${url}/collect`,{method:'POST',headers:{'content-type':'application/json','x-run-id':'test-run'},body:JSON.stringify({marker:'SYNTHETIC-test'})});
      assert.equal(accepted.status,200);
      const evidence=await (await fetch(`${url}/admin/evidence?runId=test-run`,{headers})).json();
      assert.equal(evidence.events.length,1);
      assert.deepEqual([evidence.events[0].runId,evidence.events[0].operation,evidence.events[0].marker],['test-run','collect','SYNTHETIC-test']);
      assert.ok(Number.isFinite(Date.parse(evidence.events[0].at)));
    }
  } finally {if(child.exitCode===null && child.signalCode===null) { child.kill(); await once(child,'exit').catch(()=>{}); }}
}

test('resource and collector refuse duplicate fixture resets',async()=>{
  await runFixture('resource');
  await runFixture('collector');
});
