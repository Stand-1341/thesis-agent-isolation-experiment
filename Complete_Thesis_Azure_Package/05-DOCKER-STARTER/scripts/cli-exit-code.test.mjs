import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readdirSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/**
 * The exit code has to have a success path.
 *
 * `complete` required matrixComplete, matrixComplete required a full 450-row
 * selection, and a full selection is refused because the session P3 cells have no
 * selective-egress design. Every executable run is therefore a scoped subset that
 * could never exit 0, so a flawless run reported the same code as a halt.
 *
 * This drives the real CLI as a child process against a fake dependency module and
 * asserts the success path, the halt path, and that the refused path writes nothing.
 */
const CONFIG=new URL('../config/experiment.example.json',import.meta.url).pathname;
const CLI=new URL('./run-experiment-cli.mjs',import.meta.url).pathname;
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
  const out=run(['--config',CONFIG,'--deps',deps,'--evidence',evidence,
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
  const out=run(['--config',CONFIG,'--deps',deps,'--evidence',evidence,
    '--deployment','azure_vm','--limit','3','--gates',GATES,'--json']);
  assert.ok(out.summary);
  assert.equal(out.summary.halted,true);
  assert.equal(out.code,2,`expected exit 2 from a halt, got ${out.code}`);
  assert.notEqual(out.code,0);
});

test('an unsupported scope is refused before any run ID is claimed',()=>{
  const {deps,evidence}=scaffold(PASSING_DEPS);
  // No --deployment/--profile/--limit: the full 450 rows include the 50 session P3
  // cells that have no selective-egress design, so the run must be refused whole.
  const out=run(['--config',CONFIG,'--deps',deps,'--evidence',evidence,'--gates',GATES]);
  assert.notEqual(out.code,0);
  assert.match(out.stdout+out.stderr,/refusing to run/i);
  const written=existsSync(evidence)?readdirSync(evidence):[];
  assert.deepEqual(written,[],'a refused scope must not leave evidence behind');
});
