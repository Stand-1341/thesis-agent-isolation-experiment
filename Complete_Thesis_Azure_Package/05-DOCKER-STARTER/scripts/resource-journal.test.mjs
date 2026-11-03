import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {openResourceJournal} from '../dist/resource-journal.js';
test('resource service recovers update and denial after restart, and rejects a torn journal',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'resource-restart-')),path=join(directory,'journal.jsonl');
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));let child;
  async function start(){child=spawn(process.execPath,[fileURLToPath(new URL('../dist/resource.js',import.meta.url))],
    {env:{...process.env,PORT:String(port),ADMIN_TOKEN:'admin',VERIFIER_TOKEN:'verifier',P1_TOKEN:'p1-secret',P2_TOKEN:'p2-secret',RESOURCE_JOURNAL_PATH:path}});
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('resource exited');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('startup timeout')),5000).unref())]);}
  async function stop(){if(child && child.exitCode===null && child.signalCode===null){child.kill();await once(child,'exit');}child=undefined;}
  try {
    await start();const base=`http://127.0.0.1:${port}`,headers={'content-type':'application/json','x-admin-token':'admin'};
    assert.equal((await fetch(`${base}/admin/reset`,{method:'POST',headers,body:JSON.stringify({runId:'run-1'})})).status,200);
    const call=(path,token,value)=>fetch(`${base}${path}`,{method:'POST',headers:{'content-type':'application/json','x-run-id':'run-1','x-workload-token':token},body:JSON.stringify(value)});
    assert.equal((await call('/records/restricted','p1-secret',{value:'trial-change'})).status,200);
    assert.equal((await call('/api/prohibited','p2-secret',{requested:true})).status,403);
    await stop();await start();
    const response=await fetch(`${base}/admin/evidence?runId=run-1`,{headers:{'x-verifier-token':'verifier'}}),evidence=await response.json();
    assert.equal(evidence.restrictedRecord,'trial-change');assert.equal(evidence.prohibitedInvoked,false);
    assert.deepEqual(evidence.events.map(event=>[event.operation,event.allowed]),[['restricted:update',true],['api:prohibited',false]]);
    assert.equal((await fetch(`${base}/admin/reset`,{method:'POST',headers,body:JSON.stringify({runId:'run-1'})})).status,409);
    await stop();await appendFile(path,'{"type":');
    await assert.rejects(openResourceJournal(path,new Map()),/incomplete resource journal/);
  } finally {await stop();await rm(directory,{recursive:true,force:true});}
});
