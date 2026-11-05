#!/usr/bin/env node
/**
 * Guarded measured launcher for the versioned VM/Functions Rev5 IDFIX restart.
 * The corrected schedule has fresh run IDs; Rev4 claims and artifacts remain
 * associated with the Rev4 matrix and are never replayed here.
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadVmFunctionsPreflightEnvironment} from './run-keyvault-vmfns-rev4-preflight.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const EXPECTED_REVISION='azure-proposed-v1-rev5-vm-functions-idfix';
const EXPECTED_MATRIX_FILE='03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V4-IDFIX.csv';
const EXPECTED_MATRIX_SHA256='2bd601c4de01900c318857901b36578b62fff95385f33f2e34a2c05b78a4bee5';
const EXPECTED_OWNER_DIRECTION_REFERENCE='User instruction in this session to prepare a full 400-row VM/Functions-only plan after removing ACA and stopping ACI.';
export const REV5_IDFIX_RETENTION_SCOPE='rev5_idfix_owner_directed_measured_study';
export const REV5_IDFIX_RETENTION_REFERENCE='file:docs/400-REV5-IDFIX-OWNER-DIRECTED-RETENTION.md';
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
const PROTOCOL=resolve(ROOT,'config/protocol-400-rev5-vm-functions-idfix.json');
const FREEZE_LOCK=resolve(ROOT,'config/protocol-400-rev5-vm-functions-idfix-freeze-lock.json');
const CONFIG=resolve(ROOT,'config/experiment.azure-live.json');
const DEPS=resolve(ROOT,'scripts/deps-live.mjs');
const CLI=resolve(ROOT,'scripts/run-experiment-cli.mjs');

function fail(message){throw new Error(message);}

export function validateMeasuredRev5IdfixReadiness({protocol,protocolBytes,matrixBytes,freezeLock,env={}}={}){
  if(!protocol||protocol.revision!==EXPECTED_REVISION||protocol.matrix?.file!==EXPECTED_MATRIX_FILE||
    protocol.matrix?.sha256!==EXPECTED_MATRIX_SHA256||protocol.matrix?.trials!==400||
    protocol.ownerDirection?.authorized!==true||
    protocol.ownerDirection?.reference!==EXPECTED_OWNER_DIRECTION_REFERENCE)
    fail('Rev5 IDFIX revision, owner direction, or pinned 400-row matrix does not match');
  const digest=createHash('sha256').update(matrixBytes??Buffer.alloc(0)).digest('hex');
  if(digest!==EXPECTED_MATRIX_SHA256) fail('Rev5 IDFIX matrix digest does not match the pinned revision');
  const protocolDigest=createHash('sha256').update(protocolBytes??Buffer.alloc(0)).digest('hex');
  if(freezeLock?.status!==FROZEN_STATUS||freezeLock?.protocolFile!=='config/protocol-400-rev5-vm-functions-idfix.json'||
    freezeLock?.protocolSha256!==protocolDigest||freezeLock?.matrixFile!==EXPECTED_MATRIX_FILE||
    freezeLock?.matrixSha256!==digest)
    fail('separate Rev5 IDFIX freeze lock is absent or does not bind the exact protocol and matrix digests');
  if(protocol.readiness?.measuredExecutionEnabled!==true)
    fail('Rev5 IDFIX measuredExecutionEnabled is not explicitly true in the reviewed protocol');
  if(protocol.status!==FROZEN_STATUS||protocol.runner?.measuredExecutionEnabled!==true)
    fail('Rev5 IDFIX protocol status or runner readiness does not explicitly mark this exact revision frozen for measured execution');
  const readiness=protocol.readiness??{};
  const missingGates=Object.entries(GATE_MAP).filter(([,field])=>readiness[field]!=='validated').map(([gate])=>gate);
  if(missingGates.length) fail(`Rev5 IDFIX protocol readiness gates are not validated: ${missingGates.join(', ')}`);
  const missingAssertions=ASSERTIONS.filter(name=>env[name]!=='true');
  if(missingAssertions.length) fail(`verifier assertions are absent: ${missingAssertions.join(', ')}`);
  return {gateArguments:GATES.join(','),matrixSha256:digest,protocolSha256:protocolDigest};
}

export function validateRev5IdfixStructuralDryRun(report){
  if(report?.dryRun!==true||report?.mode!=='measured'||report?.studyCounted!==true||
    report?.matrixSha256!==EXPECTED_MATRIX_SHA256||report?.plannedMatrixRows!==400||
    report?.selectedRows!==400||report?.measurableRows!==400||report?.notApplicableRows!==0||
    report?.unsupportedRows!==0||report?.missingCredentialVariables?.length!==0||
    report?.runtimeDependencies?.status!=='constructed'||report?.runtimeDependencies?.routeCount!==6||
    report?.runtimeDependencies?.verifierConstructed!==true||
    report?.runtimeDependencies?.networkVerifierSupported!==true||
    Object.keys(report?.runtimeDependencies?.resourceVerifierGaps??{}).length!==0)
    fail('Rev5 IDFIX structural dry-run did not prove exact 400-row adapter/verifier construction; no trials started');
  return true;
}

export function buildRev5IdfixMeasuredArgs(gateArguments){
  if(gateArguments!==GATES.join(',')) fail('all four reviewed readiness gates are required');
  return [CLI,'--config',CONFIG,'--protocol',PROTOCOL,'--deps',DEPS,'--gates',gateArguments,'--json'];
}

export function buildRev5IdfixDryRunArgs(gateArguments){
  if(gateArguments!==GATES.join(',')) fail('all four reviewed readiness gates are required');
  return [CLI,'--config',CONFIG,'--protocol',PROTOCOL,'--deps',DEPS,'--dry-run','--gates',gateArguments,'--json'];
}

export function applyRev5IdfixRetentionBasis(env){
  return {...env,THESIS_EVIDENCE_RETENTION_OWNER_APPROVED:'true',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE:REV5_IDFIX_RETENTION_SCOPE,
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE:REV5_IDFIX_RETENTION_REFERENCE};
}

export function captureRev5IdfixSpawn(args,{env,spawnImpl=spawn}={}){
  return new Promise((resolvePromise,reject)=>{
    const child=spawnImpl(process.execPath,args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',tooLarge=false;
    child.stdout?.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>2_000_000)tooLarge=true;});
    child.stderr?.on('data',chunk=>{stderr+=chunk.toString();if(stderr.length>200_000)tooLarge=true;});
    child.once('error',reject);
    child.once('close',(code,signal)=>resolvePromise({code,signal,stdout,stderr,tooLarge}));
  });
}

export async function runMeasuredRev5Idfix({env=process.env,fetchImpl=globalThis.fetch,spawnImpl=spawn}={}){
  const [protocolText,matrixBytes,lockText]=await Promise.all([
    readFile(PROTOCOL,'utf8'),readFile(resolve(ROOT,'..',EXPECTED_MATRIX_FILE)),readFile(FREEZE_LOCK,'utf8')
  ]);
  let protocol,freezeLock;
  try{protocol=JSON.parse(protocolText);freezeLock=JSON.parse(lockText);}catch{fail('Rev5 IDFIX protocol or freeze lock JSON is invalid');}
  const readiness=validateMeasuredRev5IdfixReadiness({protocol,protocolBytes:protocolText,matrixBytes,freezeLock,env});
  const childEnv=applyRev5IdfixRetentionBasis(await loadVmFunctionsPreflightEnvironment({env,fetchImpl}));
  const dry=await captureRev5IdfixSpawn(buildRev5IdfixDryRunArgs(readiness.gateArguments),{env:childEnv,spawnImpl});
  if(dry.signal||dry.code!==4||dry.tooLarge) fail('Rev5 IDFIX structural preflight failed; no measured rows started');
  let report;
  try{report=JSON.parse(dry.stdout);}catch{fail('Rev5 IDFIX structural preflight returned invalid JSON; no measured rows started');}
  validateRev5IdfixStructuralDryRun(report);
  const child=spawnImpl(process.execPath,buildRev5IdfixMeasuredArgs(readiness.gateArguments),
    {cwd:ROOT,env:childEnv,stdio:'inherit'});
  return await new Promise((resolvePromise,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(signal) return reject(new Error(`Rev5 IDFIX measured runner stopped by signal ${signal}`));
      resolvePromise(Number.isInteger(code)?code:1);
    });
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--launch')
      fail('usage: run-keyvault-vmfns-rev5-idfix-measured.mjs --launch');
    process.exitCode=await runMeasuredRev5Idfix();
  }catch(error){
    console.error(error?.message||'measured Rev5 IDFIX launch refused');
    process.exitCode=3;
  }
}
