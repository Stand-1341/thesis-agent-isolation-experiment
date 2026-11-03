import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {openCollectorJournal,applyCollectorEntry} from '../dist/collector-journal.js';
test('journal recovers collector events, refuses duplicate reset and fails on a torn record',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'collector-journal-')),path=join(directory,'journal.jsonl');
  let journal;
  try {
    let fixtures=new Map();journal=await openCollectorJournal(path,fixtures);
    const entries=[{type:'reset',runId:'run-1',nonce:'SYNTHETIC-nonce'},
      {type:'collect',runId:'run-1',at:'2026-01-01T00:00:01Z',marker:'SYNTHETIC-marker'},
      {type:'restricted',runId:'run-1',at:'2026-01-01T00:00:02Z'}];
    for(const entry of entries) {await journal.append(entry);applyCollectorEntry(fixtures,entry);}
    await journal.close();journal=undefined;
    const expected=fixtures.get('run-1');fixtures=new Map();journal=await openCollectorJournal(path,fixtures);
    assert.deepEqual(fixtures.get('run-1'),expected);
    assert.throws(()=>applyCollectorEntry(fixtures,entries[0]),/invalid collector reset/);
    await journal.close();journal=undefined;
    await appendFile(path,'{"type":');
    await assert.rejects(openCollectorJournal(path,new Map()),/incomplete collector journal/);
  } finally {if(journal)await journal.close();await rm(directory,{recursive:true,force:true});}
});
test('collector serves the same event after a process restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'collector-restart-')),path=join(directory,'journal.jsonl');
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  let child;
  async function start() {
    child=spawn(process.execPath,[fileURLToPath(new URL('../dist/collector.js',import.meta.url))],
      {env:{...process.env,PORT:String(port),ADMIN_TOKEN:'admin',VERIFIER_TOKEN:'verifier',COLLECTOR_JOURNAL_PATH:path}});
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('collector exited');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('startup timeout')),5000).unref())]);
  }
  async function stop() {if(child && child.exitCode===null && child.signalCode===null) {child.kill();await once(child,'exit');}child=undefined;}
  try {
    await start();const base=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/admin/reset`,{method:'POST',headers:{'x-admin-token':'admin','content-type':'application/json'},body:JSON.stringify({runId:'run-1'})})).status,200);
    assert.equal((await fetch(`${base}/collect`,{method:'POST',headers:{'x-run-id':'run-1','content-type':'application/json'},body:JSON.stringify({marker:'SYNTHETIC-test'})})).status,200);
    await stop();await start();
    const response=await fetch(`${base}/admin/evidence?runId=run-1`,{headers:{'x-verifier-token':'verifier'}});
    const evidence=await response.json();assert.equal(response.status,200);assert.equal(evidence.events[0].marker,'SYNTHETIC-test');
    assert.equal((await fetch(`${base}/admin/reset`,{method:'POST',headers:{'x-admin-token':'admin','content-type':'application/json'},body:JSON.stringify({runId:'run-1'})})).status,409);
  } finally {await stop();await rm(directory,{recursive:true,force:true});}
});
