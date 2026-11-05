import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildRev5IdfixMeasuredArgs,buildRev5IdfixDryRunArgs,
  validateMeasuredRev5IdfixReadiness,validateRev5IdfixStructuralDryRun,
  runMeasuredRev5Idfix
} from './run-keyvault-vmfns-rev5-idfix-measured.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MATRIX=resolve(ROOT,'..','03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V4-IDFIX.csv');
const ASSERTIONS=['THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
  'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED','THESIS_AUTHORIZATION_VALIDATED',
  'THESIS_DENIAL_STATUS_TEXT_VALIDATED'];

async function artifacts(){
  const protocolBytes=await readFile(resolve(ROOT,'config/protocol-400-rev5-vm-functions-idfix.json'),'utf8');
  return {protocol:JSON.parse(protocolBytes),protocolBytes,matrixBytes:await readFile(MATRIX),
    freezeLock:JSON.parse(await readFile(resolve(ROOT,'config/protocol-400-rev5-vm-functions-idfix-freeze-lock.json'),'utf8'))};
}

test('Rev5 IDFIX protocol and freeze lock pin the corrected 400-row schedule',async()=>{
  const {protocol,protocolBytes,matrixBytes,freezeLock}=await artifacts();
  const env=Object.fromEntries(ASSERTIONS.map(name=>[name,'true']));
  const readiness=validateMeasuredRev5IdfixReadiness({protocol,protocolBytes,matrixBytes,freezeLock,env});
  assert.equal(readiness.matrixSha256,'2bd601c4de01900c318857901b36578b62fff95385f33f2e34a2c05b78a4bee5');
  assert.equal(readiness.protocolSha256,createHash('sha256').update(protocolBytes).digest('hex'));
  assert.equal(protocol.revision,'azure-proposed-v1-rev5-vm-functions-idfix');
  assert.equal(protocol.matrix.file,'03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V4-IDFIX.csv');
  assert.throws(()=>validateMeasuredRev5IdfixReadiness({protocol,protocolBytes,matrixBytes,
    freezeLock:{...freezeLock,protocolSha256:'0'.repeat(64)},env}),/freeze lock/);
  const wrongBytes=Buffer.from(matrixBytes); wrongBytes[0]^=1;
  assert.throws(()=>validateMeasuredRev5IdfixReadiness({protocol,protocolBytes,matrixBytes:wrongBytes,freezeLock,env}),/matrix digest/);
  assert.throws(()=>validateMeasuredRev5IdfixReadiness({protocol,protocolBytes,matrixBytes,freezeLock,env:{}}),/verifier assertions/);
});

test('Rev5 IDFIX corrected schedule agrees with every profile embedded in its fresh run IDs',async()=>{
  const {matrixBytes}=await artifacts();
  const rows=new TextDecoder().decode(matrixBytes).trimEnd().split(/\r?\n/).slice(1);
  const previousBytes=await readFile(resolve(ROOT,'..','03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V3.csv'),'utf8');
  const previousIds=new Set(previousBytes.trimEnd().split(/\r?\n/).slice(1).map(line=>line.split(',')[0]));
  const currentIds=new Set();
  assert.equal(rows.length,400);
  for(const line of rows){
    const [runId,, ,deployment,profile,scenario]=line.split(',');
    assert.match(runId,/^r4-vmfns-idfix-v1-/);
    assert.ok(runId.includes(`-${deployment}-${profile}-${scenario}-`),`mismatched label in ${runId}`);
    assert.ok(!previousIds.has(runId),`old claim ID was reused: ${runId}`);
    assert.ok(!currentIds.has(runId),`duplicate restart ID: ${runId}`);
    currentIds.add(runId);
  }
});

test('Rev5 IDFIX measured and dry-run args use only the new protocol revision',()=>{
  const gates='protocolFrozen,deploymentValidated,isolationValidated,verifierValidated';
  const measured=buildRev5IdfixMeasuredArgs(gates),dry=buildRev5IdfixDryRunArgs(gates);
  assert.ok(measured.some(arg=>arg.endsWith('protocol-400-rev5-vm-functions-idfix.json')));
  assert.ok(dry.includes('--dry-run'));
  assert.ok(!measured.includes('--pilot'));
  assert.ok(!measured.includes('--schedule'));
  assert.throws(()=>buildRev5IdfixMeasuredArgs('protocolFrozen'),/all four/);
});

test('Rev5 IDFIX structural preflight requires exactly 400 rows and six routes/verifiers',()=>{
  const report={dryRun:true,mode:'measured',studyCounted:true,
    matrixSha256:'2bd601c4de01900c318857901b36578b62fff95385f33f2e34a2c05b78a4bee5',
    plannedMatrixRows:400,selectedRows:400,measurableRows:400,notApplicableRows:0,unsupportedRows:0,
    missingCredentialVariables:[],runtimeDependencies:{status:'constructed',routeCount:6,
      verifierConstructed:true,networkVerifierSupported:true,resourceVerifierGaps:{}}};
  assert.equal(validateRev5IdfixStructuralDryRun(report),true);
  assert.throws(()=>validateRev5IdfixStructuralDryRun({...report,unsupportedRows:1}),/structural dry-run/);
});

test('Rev5 IDFIX refuses before Key Vault access unless every verifier assertion is supplied',async()=>{
  let fetchCalls=0,spawnCalls=0;
  await assert.rejects(runMeasuredRev5Idfix({env:{},fetchImpl:async()=>{fetchCalls++;throw new Error('unexpected network');},
    spawnImpl:()=>{spawnCalls++;throw new Error('unexpected child');}}),/verifier assertions are absent/);
  assert.equal(fetchCalls,0);
  assert.equal(spawnCalls,0);
});
