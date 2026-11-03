import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

test('delegated agent does not echo per-trial credentials and rejects identity mismatch',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'delegated-agent-'));
  const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');
  const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const hook=join(temporary,'hook.mjs');
  await writeFile(hook,`const original=globalThis.fetch;globalThis.fetch=(url,options)=>String(url).startsWith('https://fixture123.blob.core.windows.net/')?Promise.resolve(options?.method==='PUT'?new Response(null,{status:201,headers:{'x-ms-request-id':'request-1'}}):new Response('{"marker":"SYNTHETIC-test"}',{status:200})):original(url,options);`);
  const agent=fileURLToPath(new URL('../dist/agent.js',import.meta.url));
  const env={...process.env,PORT:String(port),RESEARCH_URL:'https://research.example',COLLECTOR_URL:'https://collector.example',
    TRIAL_REQUEST_KEY:'controller-key',AZURE_BLOB_ENDPOINT:'https://fixture123.blob.core.windows.net/',AZURE_TOKEN_MODE:'delegated'};
  delete env.WORKLOAD_TOKEN; delete env.AZURE_CLIENT_ID;
  const principal='00000000-0000-0000-0000-000000000001',encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const token=`${encode({alg:'RS256',padding:'x'.repeat(50)})}.${encode({aud:'https://storage.azure.com/',oid:principal,exp:Math.floor(Date.now()/1000)+3600})}.synthetic-signature`;
  const mock='m'.repeat(32),child=spawn(process.execPath,['--import',pathToFileURL(hook).href,agent],{env});
  try {
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('agent exited');}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('agent timeout')),5000).unref())]);
    const send=expectedPrincipalId=>fetch(`http://127.0.0.1:${port}/run`,{method:'POST',headers:{'content-type':'application/json','x-trial-key':'controller-key'},
      body:JSON.stringify({runId:'run-1',scenario:'U1',azureAccessToken:token,expectedPrincipalId,mockWorkloadToken:mock})});
    const response=await send(principal),text=await response.text();
    assert.equal(response.status,200);
    assert.equal(JSON.parse(text).body.marker,'SYNTHETIC-test');
    assert.ok(!text.includes(token) && !text.includes(mock));
    const wrong=await send('00000000-0000-0000-0000-000000000002');
    assert.equal(wrong.status,400);
    assert.ok(!(await wrong.text()).includes(token));
    const seed=await fetch(`http://127.0.0.1:${port}/session-seed?identifier=synthetic`,{method:'POST',headers:{'content-type':'application/json','x-trial-key':'controller-key'},
      body:JSON.stringify({runId:'run-1',kind:'session-b',marker:'SYNTHETIC-b',azureAccessToken:token,expectedPrincipalId:principal})});
    const seedText=await seed.text();
    assert.equal(seed.status,200);
    assert.equal(JSON.parse(seedText).status,201);
    assert.ok(!seedText.includes(token) && !seedText.includes('SYNTHETIC-b'));
    const invalid=spawnSync(process.execPath,[agent],{env:{...env,WORKLOAD_TOKEN:'should-not-be-present'},timeout:5000,encoding:'utf8'});
    assert.notEqual(invalid.status,0);
    assert.ok(!(invalid.stderr || '').includes(token));
  } finally {if(child.exitCode===null && child.signalCode===null) {child.kill();await once(child,'exit').catch(()=>{});} await rm(temporary,{recursive:true,force:true});}
});
