#!/usr/bin/env node
/**
 * Guarded measured launcher for the owner-directed VM/Functions Rev4 candidate.
 * It never creates readiness assertions: the protocol must already be frozen and
 * all four gates must be explicitly marked validated. Key Vault values remain in
 * the child environment and are never printed. Run only on the private controller.
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadVmFunctionsPreflightEnvironment} from './run-keyvault-vmfns-rev4-preflight.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const EXPECTED_REVISION='azure-proposed-v1-rev4-vm-functions-only-draft';
const EXPECTED_MATRIX_SHA256='2ecce88dab8e7a61fa457ee6e27e5c6551a0035528aacd51d6e7502c6c0b0abe';
const EXPECTED_OWNER_DIRECTION_REFERENCE='User instruction in this session to prepare a full 400-row VM/Functions-only plan after removing ACA and stopping ACI.';
const FROZEN_STATUS='frozen_for_measured_execution';
const GATE_MAP=Object.freeze({
  protocolFrozen:'protocolFreeze',deploymentValidated:'deploymentValidation',
  isolationValidated:'isolationValidation',verifierValidated:'independentVerifierValidation'
});
const GATES=Object.keys(GATE_MAP);
const ASSERTIONS=[
  'THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
  'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED',
  'THESIS_AUTHORIZATION_VALIDATED','THESIS_DENIAL_STATUS_TEXT_VALIDATED'
];
const PROTOCOL=resolve(ROOT,'config/protocol-400-rev4-vm-functions-draft.json');
const FREEZE_LOCK=resolve(ROOT,'config/protocol-400-rev4-vm-functions-freeze-lock.json');
const CONFIG=resolve(ROOT,'config/experiment.azure-live.json');
const DEPS=resolve(ROOT,'scripts/deps-live.mjs');
const CLI=resolve(ROOT,'scripts/run-experiment-cli.mjs');

function fail(message){throw new Error(message);}

export function validateMeasuredRev4Readiness({protocol,protocolBytes,matrixBytes,freezeLock,env={}}={}){
  if(!protocol||protocol.revision!==EXPECTED_REVISION||protocol.matrix?.sha256!==EXPECTED_MATRIX_SHA256||
    protocol.matrix?.trials!==400||protocol.ownerDirection?.authorized!==true||
    protocol.ownerDirection?.reference!==EXPECTED_OWNER_DIRECTION_REFERENCE)
    fail('candidate revision, owner direction, or pinned 400-row matrix does not match');
  const digest=createHash('sha256').update(matrixBytes??Buffer.alloc(0)).digest('hex');
  if(digest!==EXPECTED_MATRIX_SHA256) fail('candidate matrix digest does not match the pinned revision');
  const protocolDigest=createHash('sha256').update(protocolBytes??Buffer.alloc(0)).digest('hex');
  if(freezeLock?.status!==FROZEN_STATUS||freezeLock?.protocolFile!=='config/protocol-400-rev4-vm-functions-draft.json'||
    freezeLock?.protocolSha256!==protocolDigest||freezeLock?.matrixFile!==protocol.matrix.file||
    freezeLock?.matrixSha256!==digest)
    fail('separate freeze lock is absent or does not bind the exact protocol and matrix digests');
  if(protocol.readiness?.measuredExecutionEnabled!==true)
    fail('measuredExecutionEnabled is not explicitly true in the reviewed protocol');
  if(protocol.status!==FROZEN_STATUS||protocol.runner?.measuredExecutionEnabled!==true)
    fail('protocol status or runner readiness does not explicitly mark this exact revision frozen for measured execution');
  const readiness=protocol.readiness??{};
  const missingGates=Object.entries(GATE_MAP).filter(([,field])=>readiness[field]!=='validated').map(([gate])=>gate);
  if(missingGates.length) fail(`protocol readiness gates are not validated: ${missingGates.join(', ')}`);
  const missingAssertions=ASSERTIONS.filter(name=>env[name]!=='true');
  if(missingAssertions.length) fail(`verifier assertions are absent: ${missingAssertions.join(', ')}`);
  return {gateArguments:GATES.join(','),matrixSha256:digest,protocolSha256:protocolDigest};
}

export function validateStructuralDryRun(report){
  if(report?.dryRun!==true||report?.mode!=='measured'||report?.studyCounted!==true||
    report?.matrixSha256!==EXPECTED_MATRIX_SHA256||report?.plannedMatrixRows!==400||
    report?.selectedRows!==400||report?.measurableRows!==400||report?.notApplicableRows!==0||
    report?.unsupportedRows!==0||report?.missingCredentialVariables?.length!==0||
    report?.runtimeDependencies?.status!=='constructed'||report?.runtimeDependencies?.routeCount!==6||
    report?.runtimeDependencies?.verifierConstructed!==true||
    report?.runtimeDependencies?.networkVerifierSupported!==true||
    Object.keys(report?.runtimeDependencies?.resourceVerifierGaps??{}).length!==0)
    fail('structural dry-run did not prove exact 400-row adapter/verifier construction; no trials started');
  return true;
}

export function buildMeasuredRev4Args(gateArguments){
  if(gateArguments!==GATES.join(',')) fail('all four reviewed readiness gates are required');
  return [CLI,'--config',CONFIG,'--protocol',PROTOCOL,'--deps',DEPS,'--gates',gateArguments,'--json'];
}

export function buildMeasuredRev4DryRunArgs(gateArguments){
  if(gateArguments!==GATES.join(',')) fail('all four reviewed readiness gates are required');
  return [CLI,'--config',CONFIG,'--protocol',PROTOCOL,'--deps',DEPS,'--dry-run','--gates',gateArguments,'--json'];
}

export function captureSpawn(args,{env,spawnImpl=spawn}={}){
  return new Promise((resolvePromise,reject)=>{
    const child=spawnImpl(process.execPath,args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',tooLarge=false;
    child.stdout?.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>2_000_000)tooLarge=true;});
    child.stderr?.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>200_000)tooLarge=true;});
    child.once('error',reject);
    // Node emits `exit` before the child's stdio streams are necessarily drained.
    // Wait for `close` so callers can safely parse the complete captured output.
    child.once('close',(code,signal)=>resolvePromise({code,signal,stdout,stderr,tooLarge}));
  });
}

export async function runMeasuredRev4({env=process.env,fetchImpl=globalThis.fetch,spawnImpl=spawn}={}){
  const [protocolText,matrixBytes,lockText]=await Promise.all([
    readFile(PROTOCOL,'utf8'),
    readFile(resolve(ROOT,'..','03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V3.csv')),
    readFile(FREEZE_LOCK,'utf8')
  ]);
  let protocol,freezeLock;
  try{protocol=JSON.parse(protocolText);freezeLock=JSON.parse(lockText);}catch{fail('candidate protocol or freeze lock JSON is invalid');}
  const readiness=validateMeasuredRev4Readiness({protocol,protocolBytes:protocolText,matrixBytes,freezeLock,env});

  // Only after protocol/gate checks pass do we fetch route credentials.
  const childEnv=await loadVmFunctionsPreflightEnvironment({env,fetchImpl});
  const dryArgs=buildMeasuredRev4DryRunArgs(readiness.gateArguments);
  const dry=await captureSpawn(dryArgs,{env:childEnv,spawnImpl});
  if(dry.signal||dry.code!==4||dry.tooLarge) fail('candidate structural preflight failed; no measured rows started');
  let report;
  try{report=JSON.parse(dry.stdout);}catch{fail('candidate structural preflight returned invalid JSON; no measured rows started');}
  validateStructuralDryRun(report);

  // The only gate values passed to the CLI are the four statuses just checked in
  // the reviewed protocol. No readiness flag is added to the environment here.
  const args=buildMeasuredRev4Args(readiness.gateArguments);
  const child=spawnImpl(process.execPath,args,{cwd:ROOT,env:childEnv,stdio:'inherit'});
  return await new Promise((resolvePromise,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(signal) return reject(new Error(`measured runner stopped by signal ${signal}`));
      resolvePromise(Number.isInteger(code)?code:1);
    });
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--launch')
      fail('usage: run-keyvault-vmfns-rev4-measured.mjs --launch');
    process.exitCode=await runMeasuredRev4();
  }catch(error){
    console.error(error?.message||'measured Rev4 launch refused');
    process.exitCode=3;
  }
}
