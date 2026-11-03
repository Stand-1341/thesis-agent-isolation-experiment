import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {implementationManifest,verifyImplementationManifest} from './implementation-manifest.mjs';

test('detects changed and newly added execution files',async()=>{
  const root=await mkdtemp(join(tmpdir(),'manifest-'));
  const base=join(root,'05-DOCKER-STARTER');
  try {
    for(const dir of ['config','scripts','src','dist','infra']) await mkdir(join(base,dir),{recursive:true});
    for(const name of ['package.json','package-lock.json','compose.yaml','Dockerfile.node','Dockerfile.functions','Dockerfile.header-audit','Dockerfile.session-diagnostic-job']) await writeFile(join(base,name),name);
    await writeFile(join(base,'scripts','adapter.mjs'),'original');
    const frozen=await implementationManifest(root);
    assert.equal(await verifyImplementationManifest(frozen.sha256,root),frozen.sha256);
    await writeFile(join(base,'scripts','adapter.mjs'),'changed');
    await assert.rejects(verifyImplementationManifest(frozen.sha256,root),/differs/);
    await writeFile(join(base,'scripts','adapter.mjs'),'original');
    await writeFile(join(base,'scripts','new-verifier.mjs'),'new');
    await assert.rejects(verifyImplementationManifest(frozen.sha256,root),/differs/);
    await assert.rejects(verifyImplementationManifest('',root),/digest required/);
  } finally {await rm(root,{recursive:true,force:true});}
});
