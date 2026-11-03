import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {verifyResearchPackage} from './verify-research-package.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
test('requires independently recorded manifest digest and rejects tampering or unexpected files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'research-package-'));
 try {
  await mkdir(join(dir,'dist'));
  const names=['dist/resource.js','dist/collector.js','dist/resource-journal.js','dist/collector-journal.js','dist/service-config.js','dist/helpers.js',
    'research-service.service','collector-service.service','research-proxy.nginx.template','check-research-data-disk.sh','package.json'];
  const files={};for(const name of names){await writeFile(join(dir,name),name);files[name]=hash(name);}
  const manifest=JSON.stringify({scope:'research-service-package-only',files});await writeFile(join(dir,'manifest.json'),manifest);
  const digest=hash(manifest);assert.equal((await verifyResearchPackage(dir,digest)).files,names.length);
  await assert.rejects(verifyResearchPackage(dir,'0'.repeat(64)),/digest mismatch/);
  await writeFile(join(dir,'dist/resource.js'),'altered');await assert.rejects(verifyResearchPackage(dir,digest),/checksum mismatch/);
  await writeFile(join(dir,'dist/resource.js'),'dist/resource.js');await writeFile(join(dir,'extra'),'unexpected');
  await assert.rejects(verifyResearchPackage(dir,digest),/unexpected package contents/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
