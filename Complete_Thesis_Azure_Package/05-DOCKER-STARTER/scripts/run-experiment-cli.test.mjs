import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {writePilotEvidenceIndex} from './run-experiment-cli.mjs';

const CLI=fileURLToPath(new URL('./run-experiment-cli.mjs',import.meta.url));
const EXAMPLE=fileURLToPath(new URL('../config/experiment.example.json',import.meta.url));
const ACI_PROTOCOL=fileURLToPath(new URL('../config/protocol-400-rev4-aci-draft.json',import.meta.url));
const ACI_EXAMPLE=fileURLToPath(new URL('../config/experiment.400-aci-draft.example.json',import.meta.url));
const VM_FUNCTIONS_PROTOCOL=fileURLToPath(new URL('../config/protocol-400-rev4-vm-functions-draft.json',import.meta.url));
const VM_FUNCTIONS_EXAMPLE=EXAMPLE;
const THREE_ARM_PROTOCOL_V2=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2.json',import.meta.url));
const THREE_ARM_PROTOCOL_V1=fileURLToPath(new URL('../config/protocol-360-three-arm-supported-v1.json',import.meta.url));
const THREE_ARM_PILOT_PROTOCOL=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2-pilot-v1.json',import.meta.url));
const THREE_ARM_PILOT_LOCK=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2-pilot-v1-freeze-lock.json',import.meta.url));
const THREE_ARM_EXAMPLE=fileURLToPath(new URL('../config/experiment.azure-three-arm.example.json',import.meta.url));

test('pilot index writer indexes only intact runner envelopes and derives route claims from completed evidence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pilot-index-writer-'));
  try {
    const payload=JSON.stringify({runId:'pilot-azure_vm-P1-U1',mode:'non_counted_pilot',
      trial:{deployment:'azure_vm',permission_profile:'P1',scenario:'U1'},classification:'unauthorized_success',
      verificationEvidence:{scope:'azure_blob_verifier',deploymentValidation:{schemaVersion:1}}});
    const envelope=Buffer.from(`${JSON.stringify({version:1,payload,sha256:createHash('sha256').update(payload).digest('hex')})}\n`);
    await writeFile(join(root,'pilot-record.json'),envelope);
    const {path,index}=await writePilotEvidenceIndex({directory:root,routes:[{deployment:'azure_vm',profile:'P1'},{deployment:'azure_vm',profile:'P2'}]});
    assert.equal(index.evidenceFiles[0].sha256,createHash('sha256').update(envelope).digest('hex'));
    assert.deepEqual(index.routesValidated,['azure_vm:P1']);
    assert.deepEqual(JSON.parse(await (await import('node:fs/promises')).readFile(path,'utf8')),index);
  } finally {await rm(root,{recursive:true,force:true});}
});
const V2_MATRIX_SHA256='3e9d26641b190eba202984c88234794fa480bb7ddbed2fd5ebc3188d269e40d6';
const V1_MATRIX_SHA256='854d1f20e1443798d50933f01e57cd21e1684e3d5c1f7bdc490ef41e0c099ce6';

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
  assert.match(blocked.err,/not all readiness gates/);
  assert.match(blocked.err,/deploymentValidated: false/);
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
    return {denialReader,blobVerifier:verifier,collectorVerifier:verifier,collectorEffectMonitor:verifier,resourceVerifier:verifier,
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

test('measured schedule dry-runs always construct dependencies in non-counted mode even with asserted gates',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-measured-dryrun-deps-'));
  const deps=join(dir,'deps.mjs');
  await writeFile(deps,`export default async ({mode,env})=>{
    if(mode!=='non_counted_pilot') throw new Error('dry-run dependency construction must remain non-counted');
    if(!['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_COLLECTOR_DURABILITY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
      'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED','THESIS_AUTHORIZATION_VALIDATED',
      'THESIS_DENIAL_STATUS_TEXT_VALIDATED'].every(name=>env[name]==='true'))
      throw new Error('reviewed assertions were not forwarded');
    const denialReader=async()=>({verdict:'unobserved',evidence:{}});
    denialReader.capabilities={azure_vm:true,azure_functions_flex:true};
    const verifier=async()=>({classification:'indeterminate'});
    return {denialReader,blobVerifier:verifier,collectorVerifier:verifier,collectorEffectMonitor:verifier,resourceVerifier:verifier,
      httpFactory:()=>({reset:async()=>({}),execute:async()=>({}),collect:async()=>({})})};
  };\n`);
  const assertions=Object.fromEntries(['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_COLLECTOR_DURABILITY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
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

function threeArmCredentialEnv() {
  const env={};
  const raw=JSON.parse(readFileSync(THREE_ARM_EXAMPLE,'utf8'));
  for(const route of raw.routes) for(const name of Object.values(route.credentials)) env[name]=`value-for-${name.toLowerCase()}`;
  return env;
}

test('the frozen three-arm v2 schedule reaches a structural dry-run report',()=>{
  const {code,out,err}=run(['--config',THREE_ARM_EXAMPLE,'--protocol',THREE_ARM_PROTOCOL_V2,'--dry-run','--json'],{});
  assert.equal(code,4,err); // Structural blockers are expected; dry-run never runs trials.
  const report=JSON.parse(out);
  assert.equal(report.matrixSha256,V2_MATRIX_SHA256,'exact frozen bytes from the starter-root config/ tree');
  assert.equal(report.plannedMatrixRows,450);
  assert.equal(report.selectedRows,450);
  assert.equal(report.readiness,'structural_only_not_ready');
  assert.equal(report.studyCounted,true);
  // U6/U8 are scheduled and fixture-gated on the declared capability, never relabeled N/A.
  assert.equal(report.notApplicableRows,0);
  assert.deepEqual(report.sessionCapabilities,
    {azure_vm:true,azure_container_apps_jobs:true,azure_container_apps_sandboxes:true});
  // Without a denialReader, each arm's P3 U5/U7 rows honestly report the missing capability.
  assert.equal(report.measurableRows,420);
  assert.equal(report.unsupportedRows,30);
  assert.deepEqual(report.unsupportedByRoute,{
    'azure_vm:P3:independent_network_denial_evidence_unavailable':10,
    'azure_container_apps_jobs:P3:independent_network_denial_evidence_unavailable':10,
    'azure_container_apps_sandboxes:P3:independent_network_denial_evidence_unavailable':10});
  assert.equal(report.networkCapabilitySource,'no --deps supplied');
  assert.ok(report.routes.some(route=>route.route==='azure_container_apps_jobs:P3'&&route.kind==='aca_job'));
  assert.ok(report.routes.some(route=>route.route==='azure_container_apps_sandboxes:P3'&&route.kind==='aca_sandbox'));
});

test('renaming the frozen pilot revision cannot bypass the code-side lock or measured/pilot separation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'three-arm-renamed-pilot-'));
  const protocolPath=join(dir,'protocol-450-three-arm-supported-v2-pilot-v1.json');
  const lockPath=join(dir,'protocol-450-three-arm-supported-v2-pilot-v1-freeze-lock.json');
  const mutated=JSON.parse(readFileSync(THREE_ARM_PILOT_PROTOCOL,'utf8'));
  mutated.revision='attacker-renamed-three-arm-protocol';
  mutated.readiness.measuredExecutionEnabled=true;
  try {
    await writeFile(protocolPath,JSON.stringify(mutated,null,2));
    await writeFile(lockPath,readFileSync(THREE_ARM_PILOT_LOCK));
    const result=run(['--config',THREE_ARM_EXAMPLE,'--protocol',protocolPath,'--dry-run','--json'],{});
    assert.equal(result.code,4);
    assert.equal(result.out,'','unapproved protocol bytes must fail before a structural report');
    assert.match(result.err,/protocol error: .*frozen|protocol error: .*lock|protocol error: .*candidate/i);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test('renaming the frozen measured candidate cannot bypass the code-side lock',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'three-arm-renamed-candidate-'));
  const protocolPath=join(dir,'protocol-450-three-arm-supported-v2.json');
  const lockPath=join(dir,'protocol-450-three-arm-supported-v2-freeze-lock.json');
  const mutated=JSON.parse(readFileSync(THREE_ARM_PROTOCOL_V2,'utf8'));
  mutated.revision='attacker-renamed-three-arm-protocol';
  mutated.readiness.measuredExecutionEnabled=true;
  try {
    await writeFile(protocolPath,JSON.stringify(mutated,null,2));
    await writeFile(lockPath,readFileSync(THREE_ARM_PROTOCOL_V2.replace(/\.json$/,'-freeze-lock.json')));
    const result=run(['--config',THREE_ARM_EXAMPLE,'--protocol',protocolPath,'--dry-run','--json'],{});
    assert.equal(result.code,4);
    assert.equal(result.out,'','unapproved protocol bytes must fail before a structural report');
    assert.match(result.err,/protocol error: .*frozen|protocol error: .*lock|protocol error: .*candidate/i);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test('v2 scope keeps Jobs P3 unsupported while VM and Sandbox denial channels stay distinct',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-v2-deps-'));
  const deps=join(dir,'deps.mjs');
  // VM (flow log/firewall) and Sandbox (egress decisions) advertise capability; Jobs does not.
  await writeFile(deps,`const adapter=()=>({reset:async()=>({}),execute:async()=>({}),collect:async()=>({})});
const verifier=async()=>({classification:'indeterminate'});
const denialReader=Object.assign(async()=>({verdict:'unobserved',evidence:{}}),
  {capabilities:{azure_vm:true,azure_container_apps_sandboxes:true}});
export default {denialReader,blobVerifier:verifier,collectorVerifier:verifier,collectorEffectMonitor:verifier,
  resourceVerifier:verifier,httpFactory:adapter,sessionFactory:adapter};\n`);
  const {code,out,err}=run(['--config',THREE_ARM_EXAMPLE,'--protocol',THREE_ARM_PROTOCOL_V2,'--deps',deps,'--dry-run','--json'],threeArmCredentialEnv());
  assert.equal(code,4,err);
  const report=JSON.parse(out);
  assert.equal(report.measurableRows,440);
  assert.equal(report.notApplicableRows,0);
  assert.equal(report.unsupportedRows,10);
  assert.deepEqual(report.unsupportedByRoute,
    {'azure_container_apps_jobs:P3:independent_network_denial_evidence_unavailable':10});
  assert.equal(report.networkCapabilitySource,'deps.denialReader');
  assert.deepEqual(report.runtimeDependencies,{status:'constructed',routeCount:9,verifierConstructed:true,
    resourceVerifierGaps:{},networkVerifierSupported:false,
    networkVerifierReason:'azure_container_apps_jobs:independent_network_denial_evidence_unavailable',
    evidenceStore:'not checked in dry-run'});
});

test('the v2 candidate can never start a measured run from offline assertions',()=>{
  const plain=run(['--config',THREE_ARM_EXAMPLE,'--protocol',THREE_ARM_PROTOCOL_V2],threeArmCredentialEnv());
  assert.equal(plain.code,3);
  assert.match(plain.err,/not all readiness gates/);
  assert.match(plain.err,/measuredExecutionEnabled: false/);
  // Asserting every gate changes nothing: the frozen measured flag stays false.
  const gated=run(['--config',THREE_ARM_EXAMPLE,'--protocol',THREE_ARM_PROTOCOL_V2,
    '--gates','protocolFrozen,deploymentValidated,isolationValidated,verifierValidated'],threeArmCredentialEnv());
  assert.equal(gated.code,3);
  assert.match(gated.err,/measuredExecutionEnabled: false/);
});

test('the superseded 360-v1 three-arm matrix also resolves from the starter root',()=>{
  const {code,out,err}=run(['--config',THREE_ARM_EXAMPLE,'--protocol',THREE_ARM_PROTOCOL_V1,'--dry-run','--json'],{});
  assert.equal(code,4,err);
  const report=JSON.parse(out);
  assert.equal(report.matrixSha256,V1_MATRIX_SHA256);
  assert.equal(report.plannedMatrixRows,360);
  assert.equal(report.notApplicableRows,0,'v1 withdrew U6/U8 from the schedule itself');
});

test('a declared matrix missing from both fixed roots fails closed and names them',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-missing-matrix-'));
  const protocol=join(dir,'protocol.json');
  await writeFile(protocol,JSON.stringify({revision:'test-missing',readiness:{measuredExecutionEnabled:false},
    matrix:{file:'config/plan-definitely-absent.csv',sha256:'0'.repeat(64),trials:1}}));
  const {code,err}=run(['--config',THREE_ARM_EXAMPLE,'--protocol',protocol,'--dry-run']);
  assert.equal(code,4);
  assert.match(err,/schedule error: config\/plan-definitely-absent\.csv not found under/);
  assert.match(err,/Complete_Thesis_Azure_Package/);
  assert.match(err,/05-DOCKER-STARTER/);
});

test('a protocol naming the v2 matrix with the wrong digest is refused',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-wrong-digest-'));
  const protocol=join(dir,'protocol.json');
  // Root resolution must never authenticate bytes: the v1 digest against the v2 file fails.
  await writeFile(protocol,JSON.stringify({revision:'test-digest',readiness:{measuredExecutionEnabled:false},
    u6U8Operationalization:{scheduledOn:['azure_vm','azure_container_apps_jobs','azure_container_apps_sandboxes']},
    matrix:{file:'config/plan-450-three-arm-supported-v2.csv',sha256:V1_MATRIX_SHA256,trials:450}}));
  const {code,err}=run(['--config',THREE_ARM_EXAMPLE,'--protocol',protocol,'--dry-run','--json'],{});
  assert.equal(code,4);
  assert.match(err,/three-arm exact-byte freeze-lock validation failed/);
});

test('legacy protocols keep their prior U6/U8 scope semantics unchanged',()=>{
  const {code,out}=run(['--config',EXAMPLE,'--dry-run'],credentialEnv());
  assert.equal(code,4);
  assert.match(out,/Scope: 220 measurable, 60 not applicable, 20 unsupported/);
});

test('dry-run with gates remains non-counted and reports a custom dependency refusal',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cli-measured-dryrun-unasserted-'));
  const deps=join(dir,'deps.mjs');
  await writeFile(deps,`export default async ({mode,env})=>{
    if(mode!=='non_counted_pilot') throw new Error('dry-run requested measured dependency construction');
    const required=['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_COLLECTOR_DURABILITY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
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
