import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildMeasuredRev4Args,buildMeasuredRev4DryRunArgs,validateMeasuredRev4Readiness,validateStructuralDryRun,runMeasuredRev4,captureSpawn} from './run-keyvault-vmfns-rev4-measured.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MATRIX=resolve(ROOT,'..','03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V3.csv');
const GATES=['protocolFrozen','deploymentValidated','isolationValidated','verifierValidated'];
const ASSERTIONS=['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
  'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED','THESIS_AUTHORIZATION_VALIDATED',
  'THESIS_DENIAL_STATUS_TEXT_VALIDATED'];

async function artifacts(){
  const protocolBytes=await readFile(resolve(ROOT,'config/protocol-400-rev4-vm-functions-draft.json'),'utf8');
  return {protocol:JSON.parse(protocolBytes),protocolBytes,matrixBytes:await readFile(MATRIX),
    freezeLock:JSON.parse(await readFile(resolve(ROOT,'config/protocol-400-rev4-vm-functions-freeze-lock.json'),'utf8'))};
}

test('frozen Rev4 lock matches canonical LF protocol bytes and rejects byte drift',async()=>{
  const {protocol,protocolBytes,matrixBytes,freezeLock}=await artifacts();
  const protocolDigest=createHash('sha256').update(protocolBytes,'utf8').digest('hex');
  const env=Object.fromEntries(ASSERTIONS.map(name=>[name,'true']));
  assert.equal(protocolBytes.includes('\r'),false);
  assert.equal(freezeLock.protocolSha256,protocolDigest);
  assert.equal(validateMeasuredRev4Readiness({protocol,protocolBytes,matrixBytes,freezeLock,env}).protocolSha256,protocolDigest);
  assert.throws(()=>validateMeasuredRev4Readiness({protocol,protocolBytes:`${protocolBytes} `,matrixBytes,freezeLock,env}),/freeze lock/);
});

test('measured Rev4 guard rejects an explicitly pending protocol fixture',async()=>{
  const {protocol,protocolBytes,matrixBytes,freezeLock}=await artifacts();
  protocol.status='owner_directed_pending_validation_and_freeze';
  protocol.readiness.protocolFreeze='pending';
  protocol.readiness.deploymentValidation='pending';
  protocol.readiness.isolationValidation='pending';
  protocol.readiness.independentVerifierValidation='pending';
  protocol.readiness.measuredExecutionEnabled=false;
  protocol.runner.measuredExecutionEnabled=false;
  const pendingBytes=JSON.stringify(protocol);
  const pendingLock={...freezeLock,status:'frozen_for_measured_execution',
    protocolSha256:createHash('sha256').update(pendingBytes).digest('hex')};
  assert.throws(()=>validateMeasuredRev4Readiness({protocol,protocolBytes:pendingBytes,matrixBytes,freezeLock:pendingLock,env:{}}),/measuredExecutionEnabled/);
  const wrong=Buffer.from(matrixBytes); wrong[0]^=1;
  assert.throws(()=>validateMeasuredRev4Readiness({protocol,protocolBytes:pendingBytes,matrixBytes:wrong,freezeLock:pendingLock,env:{}}),/digest/);
});

test('measured Rev4 gate mapping requires all six external verifier assertions',async()=>{
  const {protocol,matrixBytes}=await artifacts();
  protocol.readiness.measuredExecutionEnabled=true;
  for(const field of ['protocolFreeze','deploymentValidation','isolationValidation','independentVerifierValidation'])
    protocol.readiness[field]='validated';
  protocol.status='frozen_for_measured_execution';
  protocol.runner.measuredExecutionEnabled=true;
  const env=Object.fromEntries(ASSERTIONS.map(name=>[name,'true']));
  const protocolBytes=JSON.stringify(protocol),protocolSha256=createHash('sha256').update(protocolBytes).digest('hex');
  const freezeLock={status:'frozen_for_measured_execution',protocolFile:'config/protocol-400-rev4-vm-functions-draft.json',
    protocolSha256,matrixFile:protocol.matrix.file,matrixSha256:protocol.matrix.sha256};
  assert.deepEqual(validateMeasuredRev4Readiness({protocol,protocolBytes,matrixBytes,freezeLock,env}),{
    gateArguments:GATES.join(','),matrixSha256:createHash('sha256').update(matrixBytes).digest('hex'),protocolSha256});
  assert.throws(()=>validateMeasuredRev4Readiness({protocol,protocolBytes,matrixBytes,
    freezeLock:{...freezeLock,protocolSha256:'0'.repeat(64)},env}),/freeze lock/);
  delete env[ASSERTIONS[0]];
  assert.throws(()=>validateMeasuredRev4Readiness({protocol,protocolBytes,matrixBytes,freezeLock,env}),/verifier assertions are absent/);
  env[ASSERTIONS[0]]='true';
  protocol.runner.measuredExecutionEnabled=false;
  const staleRunnerBytes=JSON.stringify(protocol);
  const staleRunnerLock={...freezeLock,protocolSha256:createHash('sha256').update(staleRunnerBytes).digest('hex')};
  assert.throws(()=>validateMeasuredRev4Readiness({protocol,protocolBytes:staleRunnerBytes,matrixBytes,freezeLock:staleRunnerLock,env}),/protocol status or runner readiness/);
});

test('structural preflight must prove all 400 rows and six route/verifier construction before launch',()=>{
  const report={dryRun:true,mode:'measured',studyCounted:true,
    matrixSha256:'2ecce88dab8e7a61fa457ee6e27e5c6551a0035528aacd51d6e7502c6c0b0abe',
    plannedMatrixRows:400,selectedRows:400,measurableRows:400,notApplicableRows:0,unsupportedRows:0,
    missingCredentialVariables:[],runtimeDependencies:{status:'constructed',routeCount:6,
      verifierConstructed:true,networkVerifierSupported:true,resourceVerifierGaps:{}}};
  assert.equal(validateStructuralDryRun(report),true);
  assert.throws(()=>validateStructuralDryRun({...report,unsupportedRows:1}),/structural dry-run/);
  assert.throws(()=>validateStructuralDryRun({...report,runtimeDependencies:{...report.runtimeDependencies,routeCount:5}}),/structural dry-run/);
});

test('measured CLI args are pinned to the candidate and include gates without pilot or custom schedule',()=>{
  const args=buildMeasuredRev4Args(GATES.join(','));
  assert.ok(args.includes('--gates'));
  assert.ok(args.includes(GATES.join(',')));
  assert.ok(args.some(arg=>arg.endsWith('protocol-400-rev4-vm-functions-draft.json')));
  assert.ok(!args.includes('--pilot'));
  assert.ok(!args.includes('--schedule'));
  assert.throws(()=>buildMeasuredRev4Args('protocolFrozen'),/all four/);
});

test('measured structural dry-run carries the exact reviewed gate set',()=>{
  const args=buildMeasuredRev4DryRunArgs(GATES.join(','));
  assert.ok(args.includes('--dry-run'));
  assert.ok(args.includes('--gates'));
  assert.equal(args[args.indexOf('--gates')+1],GATES.join(','));
  assert.throws(()=>buildMeasuredRev4DryRunArgs('protocolFrozen'),/all four/);
});

test('captured dry-run output waits for late stdout after child exit',async()=>{
  const child=new EventEmitter();
  child.stdout=new PassThrough();
  child.stderr=new PassThrough();
  const resultPromise=captureSpawn(['unused'],{spawnImpl:()=>child});
  child.emit('exit',4,null);
  setImmediate(()=>{
    child.stdout.end('{"dryRun":true}');
    child.stderr.end();
    child.emit('close',4,null);
  });
  const result=await resultPromise;
  assert.equal(result.code,4);
  assert.deepEqual(JSON.parse(result.stdout),{dryRun:true});
});

test('current frozen candidate still refuses before Key Vault without assertion flags',async()=>{
  const {protocol,protocolBytes,matrixBytes,freezeLock}=await artifacts();
  assert.throws(()=>validateMeasuredRev4Readiness({protocol,protocolBytes,matrixBytes,freezeLock,env:{}}),/verifier assertions are absent/);
  let fetchCalls=0,spawnCalls=0;
  await assert.rejects(runMeasuredRev4({env:{},fetchImpl:async()=>{fetchCalls++;throw new Error('unexpected network');},
    spawnImpl:()=>{spawnCalls++;throw new Error('unexpected child');}}),/verifier assertions are absent/);
  assert.equal(fetchCalls,0);
  assert.equal(spawnCalls,0);
});

test('measured Rev4 reaches credential preflight after validating the clean-checkout lock',async()=>{
  const env=Object.fromEntries(ASSERTIONS.map(name=>[name,'true']));
  let fetchCalls=0,spawnCalls=0;
  await assert.rejects(runMeasuredRev4({env,fetchImpl:async()=>{fetchCalls++;throw new Error('offline test stub');},
    spawnImpl:()=>{spawnCalls++;throw new Error('unexpected child');}}),/managed identity token request failed/);
  assert.equal(fetchCalls,1);
  assert.equal(spawnCalls,0);
});
