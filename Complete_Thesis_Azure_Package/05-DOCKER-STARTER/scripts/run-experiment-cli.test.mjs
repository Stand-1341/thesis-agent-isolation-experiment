import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

const CLI=fileURLToPath(new URL('./run-experiment-cli.mjs',import.meta.url));
const EXAMPLE=fileURLToPath(new URL('../config/experiment.example.json',import.meta.url));

function credentialEnv() {
  const env={} ;
  const raw=JSON.parse(readFileSync(EXAMPLE,'utf8'));
  for(const route of raw.routes) for(const name of Object.values(route.credentials)) env[name]=`value-for-${name.toLowerCase()}`;
  return env;
}

function run(args,env={}) {
  // Start from a clean credential slate: an inherited THESIS_* variable from the
  // developer's shell must not make a "missing credentials" assertion pass.
  const inherited={};
  for(const [name,value] of Object.entries(process.env)) if(!name.startsWith('THESIS_')) inherited[name]=value;
  const result=spawnSync(process.execPath,[CLI,...args],{encoding:'utf8',env:{...inherited,...env},timeout:60000});
  return {code:result.status,out:result.stdout??'',err:result.stderr??''};
}

test('--help exits 0 and documents the exit codes',()=>{
  const {code,out}=run(['--help']);
  assert.equal(code,0);
  assert.match(out,/--dry-run/);
  assert.match(out,/run-experiment-cli/);
});

test('usage errors exit 5 without touching configuration',()=>{
  assert.equal(run([]).code,5);
  assert.equal(run(['--config']).code,5);
  assert.equal(run(['--config','x','--limit','0']).code,5);
  assert.equal(run(['--config','x','--nope']).code,5);
});

test('a missing configuration file exits 4',()=>{
  const {code,err}=run(['--config','/nonexistent/config.json','--dry-run']);
  assert.equal(code,4);
  assert.match(err,/configuration error/);
});

test('missing credential variables are named, never printed as values',()=>{
  const {code,out}=run(['--config',EXAMPLE,'--dry-run'],{});
  assert.equal(code,4);
  assert.match(out,/missing credential environment variables: THESIS_FN_P1_COLLECTOR_ADMIN_KEY/);
});

test('a dry run over the frozen matrix reports the real digest and its blockers',()=>{
  const {code,out}=run(['--config',EXAMPLE,'--dry-run'],credentialEnv());
  assert.equal(code,4);
  assert.match(out,/matrix hash d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863/);
  assert.match(out,/400 planned trials, 400 selected/);
  assert.match(out,/20 unsupported/);
  assert.match(out,/Readiness gates remain unverified/);
});

test('filters reduce the selected rows without changing the matrix digest',()=>{
  const {code,out}=run(['--config',EXAMPLE,'--dry-run','--deployment','azure_vm','--profile','P1','--limit','5'],credentialEnv());
  assert.equal(code,4);
  assert.match(out,/400 planned trials, 5 selected/);
  assert.match(out,/matrix hash d904392e/);
});

test('a measured run without all four gates exits 3 and executes nothing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-'));
  const deps=join(dir,'deps.mjs');
  await writeFile(deps,'export default {denialReader:()=>({denied:false,evidence:{}}),blobVerifier:()=>({}),collectorVerifier:()=>({}),resourceVerifier:()=>({})};\n');
  const {code,err}=run(['--config',EXAMPLE,'--deps',deps,'--limit','1','--gates','protocolFrozen'],credentialEnv());
  assert.equal(code,3);
  assert.match(err,/refusing to run: not all readiness gates/);
  assert.match(err,/deploymentValidated: false/);
});

test('a dry run remains structural and never reports deployment readiness',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-'));
  const deps=join(dir,'deps.mjs');
  await writeFile(deps,`export default {
    denialReader:()=>({denied:false,evidence:{}}),
    blobVerifier:()=>({classification:'indeterminate'}),
    collectorVerifier:()=>({classification:'indeterminate'}),
    resourceVerifier:()=>({classification:'indeterminate'}),
    httpFactory:()=>({reset:async()=>{},execute:async()=>({}),collect:async()=>({})}),
    sessionFactory:()=>({reset:async()=>{},execute:async()=>({}),collect:async()=>({})})
  };\n`);
  const {code,out}=run(['--config',EXAMPLE,'--deps',deps,'--dry-run'],credentialEnv());
  assert.equal(code,4,out);
  assert.match(out,/BLOCKER/);
  assert.match(out,/Structural preflight only/);
  assert.match(out,/Not deployment-ready/);
});
