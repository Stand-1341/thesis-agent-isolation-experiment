import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readdirSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * The exit code has to have a success path.
 *
 * A complete scoped execution must exit 0; indeterminate or incomplete execution
 * must remain distinguishable from success.
 *
 * This drives the real CLI as a child process against a fake dependency module and
 * asserts the success path, the halt path, and that the refused path writes nothing.
 */
const CONFIG=fileURLToPath(new URL('../config/experiment.example.json',import.meta.url));
const CLI=fileURLToPath(new URL('./run-experiment-cli.mjs',import.meta.url));
const GATES='protocolFrozen,deploymentValidated,isolationValidated,verifierValidated';

const PASSING_DEPS=`
// Legitimate scenarios must complete legitimately; only the U scenarios are
// successes for the attacker.
const ok=async trial=>({classification:String(trial.scenario).startsWith('L')?'legitimate_completion':'unauthorized_success'});
const httpFactory=()=>({
    reset:async()=>({u5Marker:'SYNTHETIC-abcdef'}),
    execute:async trial=>({runId:trial.runId,scenario:trial.scenario,status:200,body:{}}),
    collect:async()=>({resource:{events:[]},collector:{}}),
    cleanup:async()=>{}
  });
export default {
  evidenceStore:{claim:async()=>{},save:async()=>{}},
  denialReader:Object.assign(async()=>({verdict:'observed_allow',evidence:{}}),
    {capabilities:{azure_vm:true,azure_functions_flex:true}}),
  blobVerifier:ok,collectorVerifier:ok,resourceVerifier:ok,
  sessionFactory:httpFactory,httpFactory
};`;

const HALTING_DEPS=`
const indeterminate=async()=>({classification:'indeterminate',evidence:{reason:'synthetic_halt'}});
const httpFactory=()=>({
    reset:async()=>({u5Marker:'SYNTHETIC-abcdef'}),
    execute:async trial=>({runId:trial.runId,scenario:trial.scenario,status:200,body:{}}),
    collect:async()=>({resource:{events:[]},collector:{}}),
    cleanup:async()=>{}
  });
export default {
  evidenceStore:{claim:async()=>{},save:async()=>{}},
  denialReader:Object.assign(async()=>({verdict:'observed_allow',evidence:{}}),
    {capabilities:{azure_vm:true,azure_functions_flex:true}}),
  blobVerifier:indeterminate,collectorVerifier:indeterminate,resourceVerifier:indeterminate,
  sessionFactory:httpFactory,httpFactory
};`;

function scaffold(body) {
  const dir=mkdtempSync(join(tmpdir(),'thesis-exit-'));
  const deps=join(dir,'deps.mjs');
  writeFileSync(deps,body.trim());
  return {dir,deps,evidence:join(dir,'evidence')};
}

function credentials() {
  const config=JSON.parse(readFileSync(CONFIG,'utf8'));
  const env={};
  for(const [key,value] of Object.entries(process.env)) if(!key.startsWith('THESIS_')) env[key]=value;
  for(const route of config.routes) for(const name of Object.values(route.credentials)) env[name]='value-for-'+name.toLowerCase();
  return env;
}

function run(args) {
  const result=spawnSync(process.execPath,[CLI,...args],{env:credentials(),encoding:'utf8',timeout:180000});
  const stdout=result.stdout??'';
  const summary=stdout.includes('{')?JSON.parse(stdout.slice(stdout.indexOf('{'))):null;
  return {code:result.status,stdout,stderr:result.stderr??'',summary};
}

test('a fully executed scoped run exits 0',()=>{
  const {deps,evidence}=scaffold(PASSING_DEPS);
  const out=run(['--config',CONFIG,'--deps',deps,
    '--deployment','azure_vm','--limit','3','--gates',GATES,'--json']);
  assert.ok(out.summary,`expected a JSON summary, got:\n${out.stdout}\n${out.stderr}`);
  assert.equal(out.summary.executed,3);
  assert.equal(out.summary.halted,false);
  assert.equal(out.summary.scopeComplete,true);
  // The scope truth is still reported: this was not the whole matrix.
  assert.equal(out.summary.matrixComplete,false);
  assert.equal(out.code,0,`expected exit 0 from a clean scoped run, got ${out.code}\n${out.stderr}`);
});

test('a halted run exits 2, so success and failure stay distinguishable',()=>{
  const {deps,evidence}=scaffold(HALTING_DEPS);
  const out=run(['--config',CONFIG,'--deps',deps,
    '--deployment','azure_vm','--limit','3','--gates',GATES,'--json']);
  assert.ok(out.summary);
  assert.equal(out.summary.halted,true);
  assert.equal(out.code,2,`expected exit 2 from a halt, got ${out.code}`);
  assert.notEqual(out.code,0);
});

test('the simulated revision-3 300-row matrix can execute end to end',()=>{
  const {deps,evidence}=scaffold(PASSING_DEPS);
  // This uses mocked passing capabilities to test runner behavior, not cloud readiness.
  const out=run(['--config',CONFIG,'--deps',deps,'--gates',GATES,'--json']);
  assert.ok(out.summary,`expected a JSON summary, got:\n${out.stdout}\n${out.stderr}`);
  assert.equal(out.summary.executed,300);
  assert.equal(out.summary.halted,false);
  assert.equal(out.summary.matrixComplete,true);
  assert.equal(out.summary.scope.unsupportedRows,0);
  assert.equal(out.code,0,`expected a complete matrix run to exit 0, got ${out.code}`);
});

test('a selection with an unsupported row is still refused before any claim',()=>{
  // Without advertised denial capability the VM and Functions P3 U5/U7 cells have no
  // evidence source, so a selection containing them must be refused whole.
  const dir=mkdtempSync(join(tmpdir(),'thesis-refuse-'));
  const deps=join(dir,'deps.mjs');
  writeFileSync(deps,PASSING_DEPS.replace('{azure_vm:true,azure_functions_flex:true}','{}'));
  const evidence=join(dir,'evidence');
  const out=run(['--config',CONFIG,'--deps',deps,'--gates',GATES]);
  assert.notEqual(out.code,0);
  assert.match(out.stdout+out.stderr,/refusing to run/i);
  const written=existsSync(evidence)?readdirSync(evidence):[];
  assert.deepEqual(written,[],'a refused scope must not leave evidence behind');
});

test('measured runs fail closed without a locked Azure evidence store',()=>{
  const {deps}=scaffold(PASSING_DEPS.replace('  evidenceStore:{claim:async()=>{},save:async()=>{}},',''));
  const out=run(['--config',CONFIG,'--deps',deps,'--deployment','azure_vm','--limit','1','--gates',GATES,'--json']);
  assert.equal(out.code,3);
  assert.match(out.stderr,/evidence store error: institution-approved evidence retention is not asserted/);
  assert.equal(out.summary,null,'no trial summary may be emitted when evidence is unprotected');
});

test('measured runs reject the local evidence-directory option',()=>{
  const {code,stderr}=run(['--config',CONFIG,'--evidence','results/test']);
  assert.equal(code,5);
  assert.match(stderr,/Measured evidence uses locked Azure Blob storage/);
});
