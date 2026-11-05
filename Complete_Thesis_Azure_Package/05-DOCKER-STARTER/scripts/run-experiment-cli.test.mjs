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
const ACI_PROTOCOL=fileURLToPath(new URL('../config/protocol-400-rev4-aci-draft.json',import.meta.url));
const ACI_EXAMPLE=fileURLToPath(new URL('../config/experiment.400-aci-draft.example.json',import.meta.url));
const VM_FUNCTIONS_PROTOCOL=fileURLToPath(new URL('../config/protocol-400-rev4-vm-functions-draft.json',import.meta.url));
const VM_FUNCTIONS_EXAMPLE=fileURLToPath(new URL('../config/experiment.azure-live.json',import.meta.url));

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
  assert.match(out,/--pilot-retry/);
  assert.match(out,/run-experiment-cli/);
});

test('usage errors exit 5 without touching configuration',()=>{
  assert.equal(run([]).code,5);
  assert.equal(run(['--config']).code,5);
  assert.equal(run(['--config','x','--limit','0']).code,5);
  assert.equal(run(['--config','x','--offset','-1']).code,5);
  assert.equal(run(['--config','x','--pilot','--pilot-retry']).code,5);
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
  assert.match(out,/missing credential environment variables: THESIS_COLLECTOR_ADMIN_KEY/);
});

test('a dry run over the frozen matrix reports the real digest and its blockers',()=>{
  const {code,out}=run(['--config',EXAMPLE,'--dry-run'],credentialEnv());
  assert.equal(code,4);
  assert.match(out,/matrix hash a6bc3ffe78d677d25e07452e06cfc437062fdd9e8322b4c834d31118337ccc7e/);
  assert.match(out,/300 planned trials, 300 selected/);
  assert.match(out,/20 unsupported/);
  assert.match(out,/Readiness gates remain unverified/);
});

test('--protocol selects the 400-row ACI draft for structural dry-run only',()=>{
  const {code,out}=run(['--config',ACI_EXAMPLE,'--protocol',ACI_PROTOCOL,'--dry-run','--json'],{});
  assert.equal(code,4);
  const report=JSON.parse(out);
  assert.equal(report.plannedMatrixRows,400);
  assert.equal(report.selectedRows,400);
  assert.equal(report.readiness,'structural_only_not_ready');
  assert.equal(report.studyCounted,true);
  assert.match(report.note,/Structural preflight only/);
  assert.ok(report.routes.some(route=>route.route==='azure_container_instances:P1'));
  assert.ok(report.routes.some(route=>route.route==='azure_container_instances:P2'));
});

test('VM/Functions Rev4 candidate loads the frozen 400-row matrix but stays non-executable',()=>{
  const dry=run(['--config',VM_FUNCTIONS_EXAMPLE,'--protocol',VM_FUNCTIONS_PROTOCOL,'--dry-run','--json'],{});
  assert.equal(dry.code,4); // Structural blockers are expected; dry-run never runs trials.
  const report=JSON.parse(dry.out);
  assert.equal(report.plannedMatrixRows,400);
  assert.equal(report.selectedRows,400);
  assert.equal(report.matrixSha256,'2ecce88dab8e7a61fa457ee6e27e5c6551a0035528aacd51d6e7502c6c0b0abe');
  assert.equal(report.readiness,'structural_only_not_ready');
  assert.equal(report.unsupportedRows,36);
  assert.equal(report.studyCounted,true); // describes the requested schedule type, not execution
  const blocked=run(['--config',VM_FUNCTIONS_EXAMPLE,'--protocol',VM_FUNCTIONS_PROTOCOL,'--limit','1'],{});
  assert.equal(blocked.code,3);
  assert.match(blocked.err,/measuredExecutionEnabled=false/);
});

test('VM/Functions Rev4 Central P3 pilot selects its separate non-counted one-row schedule',()=>{
  const {code,out}=run(['--config',VM_FUNCTIONS_EXAMPLE,'--protocol',VM_FUNCTIONS_PROTOCOL,'--pilot','--dry-run','--json',
    '--deployment','azure_vm','--profile','P3'],{});
  assert.equal(code,4); // No local keys/deps and no attributable P3 capability were supplied.
  const report=JSON.parse(out);
  assert.equal(report.mode,'non_counted_pilot');
  assert.equal(report.studyCounted,false);
  assert.equal(report.plannedMatrixRows,1);
  assert.equal(report.selectedRows,1);
  assert.equal(report.matrixSha256,'79fe077a505ce4f61a468717778193af21a02cd06c1d44acaf9be03e958519fb');
  assert.equal(report.unsupportedRows,1);
});

test('filters reduce the selected rows without changing the matrix digest',()=>{
  const {code,out}=run(['--config',EXAMPLE,'--dry-run','--deployment','azure_vm','--profile','P1','--limit','5'],credentialEnv());
  assert.equal(code,4);
  assert.match(out,/300 planned trials, 5 selected/);
  assert.match(out,/matrix hash a6bc3ffe/);
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

test('the separate frozen pilot runs without measured gates and writes only non-counted evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-pilot-'));
  const deps=join(dir,'deps.mjs');
  await writeFile(deps,`const ok=async trial=>({classification:String(trial.scenario).startsWith('L')?'legitimate_completion':'unauthorized_success'});
const httpFactory=()=>({reset:async()=>({u5Marker:'SYNTHETIC-marker'}),execute:async trial=>({runId:trial.runId,scenario:trial.scenario,status:200}),collect:async()=>({resource:{events:[]},collector:{}})});
export default {denialReader:Object.assign(async()=>({verdict:'observed_allow',evidence:{}}),{capabilities:{azure_vm:true,azure_functions_flex:true}}),blobVerifier:ok,collectorVerifier:ok,resourceVerifier:ok,sessionFactory:httpFactory,httpFactory};\n`);
  const pilotEvidence=join(dir,'pilot-evidence');
  const out=run(['--config',EXAMPLE,'--deps',deps,'--pilot','--deployment','azure_vm','--profile','P1','--limit','1',
    '--pilot-evidence',pilotEvidence,'--json'],credentialEnv());
  const summary=out.out.includes('{')?JSON.parse(out.out.slice(out.out.indexOf('{'))):null;
  assert.ok(summary,`expected a JSON summary, exit ${out.code}:\n${out.out}\n${out.err}`);
  assert.equal(out.code,0,out.err);
  assert.equal(summary.mode,'non_counted_pilot');
  assert.equal(summary.studyCounted,false);
  assert.equal(summary.executed,1);
  assert.equal(summary.matrixComplete,false);
  assert.equal(summary.pilotScheduleComplete,false);
  assert.deepEqual(Object.values(summary.gates),[false,false,false,false]);
  const envelope=JSON.parse(readFileSync(join(pilotEvidence,'pilot-azure_vm-P1-U1.json'),'utf8'));
  const evidence=JSON.parse(envelope.payload);
  assert.equal(evidence.mode,'non_counted_pilot');
  assert.equal(evidence.trial.planSha256,summary.matrixSha256);

  const next=run(['--config',EXAMPLE,'--deps',deps,'--pilot','--deployment','azure_vm','--profile','P1','--offset','1','--limit','1',
    '--pilot-evidence',pilotEvidence,'--json'],credentialEnv());
  assert.equal(next.code,0,next.err);
  const nextEnvelope=JSON.parse(readFileSync(join(pilotEvidence,'pilot-azure_vm-P1-U2.json'),'utf8'));
  assert.equal(JSON.parse(nextEnvelope.payload).trial.scenario,'U2');
});

test('versioned U3 retry plan uses a new ID and writes separate non-counted evidence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-pilot-retry-'));
  const deps=join(dir,'deps.mjs');
  await writeFile(deps,`const classify=async trial=>({classification:trial.scenario.startsWith('L')?'legitimate_completion':'unauthorized_success'});
const httpFactory=()=>({reset:async()=>({u5Marker:'SYNTHETIC-retry-marker'}),execute:async trial=>({runId:trial.runId,scenario:trial.scenario,status:200,body:{}}),collect:async()=>({resource:{events:[]},collector:{}})});
export default {denialReader:Object.assign(async()=>({verdict:'observed_allow',evidence:{}}),{capabilities:{azure_vm:true,azure_functions_flex:true}}),blobVerifier:classify,collectorVerifier:classify,resourceVerifier:classify,httpFactory};\n`);
  const pilotEvidence=join(dir,'pilot-retry-evidence');
  const out=run(['--config',EXAMPLE,'--deps',deps,'--pilot-retry','--deployment','azure_functions_flex','--profile','P1','--limit','1',
    '--pilot-evidence',pilotEvidence,'--json'],credentialEnv());
  const summary=out.out.includes('{')?JSON.parse(out.out.slice(out.out.indexOf('{'))):null;
  assert.ok(summary,`expected a JSON summary, exit ${out.code}:\n${out.out}\n${out.err}`);
  assert.equal(out.code,0,out.err);
  assert.equal(summary.mode,'non_counted_pilot');
  assert.equal(summary.studyCounted,false);
  assert.equal(summary.matrixRows,1);
  assert.equal(summary.executed,1);
  const path=join(pilotEvidence,'pilot-retry-20261103-v3-azure_functions_flex-P1-U3.json');
  const evidence=JSON.parse(JSON.parse(readFileSync(path,'utf8')).payload);
  assert.equal(evidence.mode,'non_counted_pilot');
  assert.equal(evidence.trial.scenario,'U3');
});

test('pilot rejects measured gates and custom schedules',()=>{
  assert.equal(run(['--config',EXAMPLE,'--pilot','--gates','protocolFrozen']).code,5);
  assert.equal(run(['--config',EXAMPLE,'--matrix','unreviewed.csv']).code,5);
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

test('dry-run deps use non-counted construction to report capabilities without measured gates',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-dryrun-deps-'));
  const deps=join(dir,'deps.mjs');
  await writeFile(deps,`export default async ({mode})=>{
    if(mode!=='non_counted_pilot') throw new Error('dry-run received measured mode');
    const denialReader=async()=>({verdict:'unobserved',evidence:{}});
    denialReader.capabilities={azure_vm:true,azure_functions_flex:true};
    const verifier=async()=>({classification:'indeterminate'});
    return {denialReader,blobVerifier:verifier,collectorVerifier:verifier,resourceVerifier:verifier,
      httpFactory:()=>({reset:async()=>({}),execute:async()=>({}),collect:async()=>({})})};
  };\n`);
  const {code,out}=run(['--config',VM_FUNCTIONS_EXAMPLE,'--protocol',VM_FUNCTIONS_PROTOCOL,'--deps',deps,'--dry-run','--json'],credentialEnv());
  assert.equal(code,4); // Structural dry-run stays non-executable.
  const report=JSON.parse(out);
  assert.equal(report.networkCapabilitySource,'deps.denialReader');
  assert.equal(report.unsupportedRows,0);
  assert.equal(report.readiness,'structural_only_not_ready');
  assert.ok(report.readinessGates.every(gate=>gate.endsWith('=unverified')));
  assert.deepEqual(report.runtimeDependencies,{status:'constructed',routeCount:6,verifierConstructed:true,
    resourceVerifierGaps:{},networkVerifierSupported:true,networkVerifierReason:null,evidenceStore:'not checked in dry-run'});
});

test('measured structural dry-run passes reviewed gates into measured dependency construction',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-measured-dryrun-deps-'));
  const deps=join(dir,'deps.mjs');
  await writeFile(deps,`export default async ({mode,env})=>{
    if(mode!=='measured') throw new Error('reviewed measured dry-run was not constructed in measured mode');
    if(!['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
      'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED','THESIS_AUTHORIZATION_VALIDATED',
      'THESIS_DENIAL_STATUS_TEXT_VALIDATED'].every(name=>env[name]==='true'))
      throw new Error('reviewed assertions were not forwarded');
    const denialReader=async()=>({verdict:'unobserved',evidence:{}});
    denialReader.capabilities={azure_vm:true,azure_functions_flex:true};
    const verifier=async()=>({classification:'indeterminate'});
    return {denialReader,blobVerifier:verifier,collectorVerifier:verifier,resourceVerifier:verifier,
      httpFactory:()=>({reset:async()=>({}),execute:async()=>({}),collect:async()=>({})})};
  };\n`);
  const assertions=Object.fromEntries(['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
    'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED','THESIS_AUTHORIZATION_VALIDATED',
    'THESIS_DENIAL_STATUS_TEXT_VALIDATED'].map(name=>[name,'true']));
  const gates='protocolFrozen,deploymentValidated,isolationValidated,verifierValidated';
  const {code,out}=run(['--config',VM_FUNCTIONS_EXAMPLE,'--protocol',VM_FUNCTIONS_PROTOCOL,'--deps',deps,
    '--dry-run','--gates',gates,'--json'],{...credentialEnv(),...assertions});
  assert.equal(code,4); // Dry-run is structural only and never executes rows.
  const report=JSON.parse(out);
  assert.equal(report.mode,'measured');
  assert.equal(report.studyCounted,true);
  assert.equal(report.runtimeDependencies.status,'constructed');
  assert.equal(report.runtimeDependencies.routeCount,6);
  assert.equal(report.unsupportedRows,0);
  assert.equal(report.readiness,'structural_only_not_ready');
});

test('measured structural dry-run stays blocked when reviewed verifier assertions are missing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-measured-dryrun-unasserted-'));
  const deps=join(dir,'deps.mjs');
  await writeFile(deps,`export default async ({mode,env})=>{
    if(mode!=='measured') throw new Error('expected measured dependency validation');
    const required=['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
      'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED','THESIS_AUTHORIZATION_VALIDATED',
      'THESIS_DENIAL_STATUS_TEXT_VALIDATED'];
    const missing=required.filter(name=>env[name]!=='true');
    if(missing.length) throw new Error('verifier pilot gates have not been established');
    throw new Error('test should remain unreachable');
  };\n`);
  const gates='protocolFrozen,deploymentValidated,isolationValidated,verifierValidated';
  const {code,out}=run(['--config',VM_FUNCTIONS_EXAMPLE,'--protocol',VM_FUNCTIONS_PROTOCOL,'--deps',deps,
    '--dry-run','--gates',gates,'--json'],credentialEnv());
  assert.equal(code,4);
  const report=JSON.parse(out);
  assert.equal(report.unsupportedRows,36);
  assert.match(report.networkCapabilitySource,/unavailable .*verifier pilot gates/);
  assert.equal(report.runtimeDependencies.status,'blocked_dependency_construction');
  assert.equal(report.readiness,'structural_only_not_ready');
});
