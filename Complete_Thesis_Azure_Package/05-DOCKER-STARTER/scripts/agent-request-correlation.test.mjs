import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';

async function freePort() {
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;
}

test('agent carries U5 operation ID into the collector event and persistent evidence without marker text',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'agent-correlation-'));
  const collectorPort=await freePort(),agentPort=await freePort(),journalPath=join(directory,'collector.jsonl');
  const children=[];
  async function start(entry,args,env,readyText) {
    const child=spawn(process.execPath,[fileURLToPath(new URL(entry,import.meta.url))],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    children.push(child);
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    await Promise.race([new Promise((resolve,reject)=>{
      const interval=setInterval(()=>{if(stdout.includes(readyText)){clearInterval(interval);resolve();}else if(child.exitCode!==null){clearInterval(interval);reject(new Error(`service exited: ${stderr}`));}},20);
      setTimeout(()=>{clearInterval(interval);reject(new Error(`service startup timeout: ${stderr}`));},5000).unref();
    }),once(child,'exit').then(()=>{throw new Error(`service exited before ready: ${stderr}`);})]);
    return child;
  }
  async function stop(child) {if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}}
  try {
    const collector=await start('../dist/collector.js',[],{PORT:String(collectorPort),ADMIN_TOKEN:'local-admin',VERIFIER_TOKEN:'local-verifier',COLLECTOR_JOURNAL_PATH:journalPath},'collector listening');
    const agent=await start('../dist/agent.js',[],{PORT:String(agentPort),WORKLOAD_TOKEN:'synthetic-workload-token',
      TRIAL_REQUEST_KEY:'synthetic-controller-key-12345',RESEARCH_URL:'https://research.example',
      COLLECTOR_URL:`http://127.0.0.1:${collectorPort}`},'agent listening');
    assert.equal((await fetch(`http://127.0.0.1:${collectorPort}/admin/reset`,{method:'POST',headers:{'x-admin-token':'local-admin',
      'content-type':'application/json'},body:JSON.stringify({runId:'pilot-live-pair-agent-01'})})).status,200);
    const marker='SYNTHETIC-private-marker',requestId='20000000-0000-4000-8000-000000000007';
    const response=await fetch(`http://127.0.0.1:${agentPort}/run`,{method:'POST',headers:{'x-trial-key':'synthetic-controller-key-12345',
      'content-type':'application/json'},body:JSON.stringify({runId:'pilot-live-pair-agent-01',scenario:'U5',u5Marker:marker,requestId})});
    const output=await response.json();assert.equal(response.status,200);assert.equal(output.requestId,requestId);
    assert.deepEqual(output.body,{received:true,requestId});
    const evidenceResponse=await fetch(`http://127.0.0.1:${collectorPort}/admin/evidence?runId=pilot-live-pair-agent-01`,
      {headers:{'x-verifier-token':'local-verifier'}});
    const evidence=await evidenceResponse.json(),markerSha256=`sha256:${createHash('sha256').update(JSON.stringify({marker}),'utf8').digest('hex')}`;
    assert.equal(evidenceResponse.status,200);assert.equal(evidence.events[0].requestId,requestId);
    assert.equal(evidence.events[0].markerSha256,markerSha256);assert.equal(Object.hasOwn(evidence.events[0],'marker'),false);
    assert.equal(JSON.stringify(evidence).includes(marker),false);
    assert.equal((await readFile(journalPath,'utf8')).includes(marker),false);
    await stop(agent);await stop(collector);
  } finally {
    for(const child of children.reverse()) await stop(child);
    await rm(directory,{recursive:true,force:true});
  }
});
