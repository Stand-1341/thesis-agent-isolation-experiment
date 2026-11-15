import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateSelectedProtocol} from './preflight-three-architecture.mjs';
import {buildFlexSandboxRevision} from './create-flex-sandbox-450-revision.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths={
  protocolFile:'config/protocol-450-flex-sandbox-supported-v3.json',
  matrixFile:'config/plan-450-flex-sandbox-supported-v3.csv',
  lockFile:'config/protocol-450-flex-sandbox-supported-v3-freeze-lock.json'
};
async function selected() {
  const [protocolBytes,matrixBytes,lockBytes]=await Promise.all([
    readFile(new URL(`../${paths.protocolFile}`,import.meta.url)),
    readFile(new URL(`../${paths.matrixFile}`,import.meta.url)),
    readFile(new URL(`../${paths.lockFile}`,import.meta.url))
  ]);
  return {protocolBytes,matrixBytes,lock:JSON.parse(lockBytes),paths};
}

test('v3 validates all 450 cells, kinds and exact-byte digests',async()=>{
  const result=validateSelectedProtocol(await selected());
  assert.equal(result.rows.length,450);
  assert.equal(result.summary.unauthorized,360);
  assert.equal(result.summary.legitimate,90);
  assert.deepEqual(result.protocol.deployments,['azure_vm','azure_functions_flex','azure_container_apps_sandboxes']);
  assert.deepEqual(result.protocol.deploymentKinds,{azure_vm:'http',azure_functions_flex:'http',azure_container_apps_sandboxes:'aca_sandbox'});
  assert.equal(result.protocol.measuredExecutionEnabled,false);
  assert.equal(new Set(result.rows.map(row=>row.planned_run_id)).size,450);
  assert.ok(result.rows.every(row=>row.planned_run_id.startsWith('tfs450-')&&row.status==='NOT RUN'));
});

test('v3 deterministic regeneration agrees with the frozen artifacts and preserves v2',async()=>{
  const generated=await buildFlexSandboxRevision();
  assert.equal(generated.protocolSha256,'1d007cec5062dd8641b604e01fb6b7cea62ca166c44f184f9bae16085c62d266');
  assert.equal(generated.matrixSha256,'d76cb846e3dc647c6bc7bf589ad6397d03f8a9885ecf42ace11c13e44740834e');
  const [protocol,matrix]=await Promise.all([
    readFile(new URL('../config/protocol-450-three-arm-supported-v2.json',import.meta.url)),
    readFile(new URL('../config/plan-450-three-arm-supported-v2.csv',import.meta.url))
  ]);
  assert.equal(sha256(protocol),'fdb135628361b17347f91df7099d48afc25d6366803b498fae545ae9c2c5d2bc');
  assert.equal(sha256(matrix),'3e9d26641b190eba202984c88234794fa480bb7ddbed2fd5ebc3188d269e40d6');
});

test('v3 rejects a changed protocol byte and mismatched lock',async()=>{
  const input=await selected();
  const changed=Buffer.from(input.protocolBytes);
  changed[changed.indexOf(Buffer.from('"status"'))+10]=0x20;
  assert.throws(()=>validateSelectedProtocol({...input,protocolBytes:changed}),/digest|UTF-8/);
});

test('v2 still validates with its original Jobs-arm trust anchor',async()=>{
  const v2Paths={protocolFile:'config/protocol-450-three-arm-supported-v2.json',matrixFile:'config/plan-450-three-arm-supported-v2.csv',lockFile:'config/protocol-450-three-arm-supported-v2-freeze-lock.json'};
  const [protocolBytes,matrixBytes,lockBytes]=await Promise.all([
    readFile(new URL(`../${v2Paths.protocolFile}`,import.meta.url)),
    readFile(new URL(`../${v2Paths.matrixFile}`,import.meta.url)),
    readFile(new URL(`../${v2Paths.lockFile}`,import.meta.url))
  ]);
  const result=validateSelectedProtocol({protocolBytes,matrixBytes,lock:JSON.parse(lockBytes),paths:v2Paths});
  assert.deepEqual(result.protocol.deployments,['azure_vm','azure_container_apps_jobs','azure_container_apps_sandboxes']);
  assert.equal(result.rows.length,450);
});
