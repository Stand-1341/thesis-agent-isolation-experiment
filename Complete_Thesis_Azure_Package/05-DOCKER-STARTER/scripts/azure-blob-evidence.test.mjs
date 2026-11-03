import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAzureBlobEvidenceStore} from './azure-blob-evidence.mjs';
import {runTrial} from './trial-runner.mjs';

test('conditional Blob claims and evidence reject duplicates and preserve results',async()=>{
  const original=globalThis.fetch, blobs=new Map();
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.headers.authorization,'Bearer test-token');
    assert.ok(!String(url).includes('test-token'));
    if (options.method==='PUT') {
      assert.equal(options.headers['if-none-match'],'*');
      if (blobs.has(url)) return new Response(null,{status:412});
      blobs.set(url,options.body);
      return new Response(null,{status:201});
    }
    return blobs.has(url)?new Response(blobs.get(url),{status:200}):new Response(null,{status:404});
  };
  try {
    const store=createAzureBlobEvidenceStore({containerUrl:'https://abc123.blob.core.windows.net/evidence',getToken:async()=> 'test-token'});
    const gates={protocolFrozen:true,deploymentValidated:true,isolationValidated:true,verifierValidated:true};
    const adapter={reset:async()=>({}),execute:async t=>({runId:t.runId,scenario:t.scenario,status:200}),collect:async()=>({events:[]})};
    const args={trial:{runId:'run-1',scenario:'L1'},gates,adapter,verifier:async()=> 'legitimate_completion',evidenceStore:store};
    const record=await runTrial(args);
    assert.deepEqual(await store.read('run-1'),record);
    await assert.rejects(runTrial(args),/already exists/);
    await assert.rejects(store.save(record),/already exists/);
    const recordUrl='https://abc123.blob.core.windows.net/evidence/run-1.json';
    const altered=JSON.parse(blobs.get(recordUrl));
    altered.payload=JSON.stringify({...record,classification:'unauthorized_success'});
    blobs.set(recordUrl,JSON.stringify(altered));
    await assert.rejects(store.read('run-1'),/integrity/);
    assert.throws(()=>createAzureBlobEvidenceStore({containerUrl:'https://attacker.example/evidence',getToken:async()=> 'test-token'}),/invalid/);
  } finally {globalThis.fetch=original;}
});
