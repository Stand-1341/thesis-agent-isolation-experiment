import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const CLI=fileURLToPath(new URL('./run-experiment-cli.mjs',import.meta.url));
const CONFIG=fileURLToPath(new URL('../config/experiment.azure-three-arm.example.json',import.meta.url));
const PROTOCOL=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2.json',import.meta.url));
const LOCK=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2-freeze-lock.json',import.meta.url));
const PILOT_PROTOCOL=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2-pilot-v1.json',import.meta.url));
const PILOT_LOCK=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2-pilot-v1-freeze-lock.json',import.meta.url));

function cleanEnvironment() {
  const env={...process.env};
  for(const name of Object.keys(env)) if(name.startsWith('THESIS_')||name.startsWith('AZURE_')) delete env[name];
  return env;
}

test('generic runner rejects protocol drift against the independent v2 freeze lock before dry-run reporting',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'azure-v2-lock-tamper-'));
  const protocol=JSON.parse(await readFile(PROTOCOL,'utf8'));
  protocol.measuredExecutionEnabled=true;
  protocol.readiness.measuredExecutionEnabled=true;
  const protocolPath=join(dir,basename(PROTOCOL));
  const lockPath=join(dir,basename(LOCK));
  await writeFile(protocolPath,`${JSON.stringify(protocol,null,2)}\n`);
  await writeFile(lockPath,await readFile(LOCK));
  const result=spawnSync(process.execPath,[CLI,'--config',CONFIG,'--protocol',protocolPath,'--dry-run','--json'],
    {encoding:'utf8',env:cleanEnvironment(),timeout:120000});
  assert.equal(result.status,4);
  assert.equal(result.stdout,'','tampered protocol must fail before producing a structural report');
  assert.match(result.stderr,/protocol error:.*freeze|protocol error:.*approved|protocol error:/i);
});

test('generic runner rejects drifted v2 pilot bytes against the separate non-counted lock',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'azure-v2-pilot-lock-tamper-'));
  const protocol=JSON.parse(await readFile(PILOT_PROTOCOL,'utf8'));
  protocol.note+=' tampered for lock test';
  const protocolPath=join(dir,basename(PILOT_PROTOCOL));
  const lockPath=join(dir,basename(PILOT_LOCK));
  await writeFile(protocolPath,`${JSON.stringify(protocol,null,2)}\n`);
  await writeFile(lockPath,await readFile(PILOT_LOCK));
  const result=spawnSync(process.execPath,[CLI,'--config',CONFIG,'--protocol',protocolPath,'--pilot','--dry-run','--json'],
    {encoding:'utf8',env:cleanEnvironment(),timeout:120000});
  assert.equal(result.status,4);
  assert.equal(result.stdout,'','tampered pilot protocol must fail before producing a structural report');
  assert.match(result.stderr,/three-arm exact-byte freeze-lock validation failed:.*digest/i);
});
