import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadFrozenSchedule} from './trial-schedule.mjs';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const CLI=fileURLToPath(new URL('./run-experiment-cli.mjs',import.meta.url));
const CONFIG=fileURLToPath(new URL('../config/experiment.azure-three-arm.example.json',import.meta.url));
const PROTOCOL=fileURLToPath(new URL('../config/protocol-450-three-arm-supported-v2.json',import.meta.url));
const protocol=JSON.parse(readFileSync(PROTOCOL,'utf8'));
const matrixBytes=readFileSync(fileURLToPath(new URL('../config/plan-450-three-arm-supported-v2.csv',import.meta.url)));

function cleanEnvironment() {
  const env={...process.env};
  for(const name of Object.keys(env)) if(name.startsWith('THESIS_')||name.startsWith('AZURE_')) delete env[name];
  return env;
}

test('generic schedule validator accepts the frozen three-arm v2 deployment names',()=>{
  const loaded=loadFrozenSchedule(matrixBytes,protocol.matrix.sha256);
  assert.equal(loaded.rows.length,450);
  assert.equal(loaded.rows[0].deployment,'azure_vm');
  assert.ok(loaded.rows.some(row=>row.deployment==='azure_container_apps_jobs'));
  assert.ok(loaded.rows.some(row=>row.deployment==='azure_container_apps_sandboxes'));
});

test('generic runner dry-run resolves the v2 matrix, includes configured U6/U8, and stays non-executable',()=>{
  const result=spawnSync(process.execPath,[CLI,'--config',CONFIG,'--protocol',PROTOCOL,'--dry-run','--json'],
    {encoding:'utf8',env:cleanEnvironment(),timeout:120000});
  assert.equal(result.status,4,`structural dry-run must remain blocked, stderr=${result.stderr}`);
  let report;
  assert.doesNotThrow(()=>{report=JSON.parse(result.stdout);},
    `expected structural JSON, not an input/path error; stdout=${result.stdout}; stderr=${result.stderr}`);
  assert.equal(report.dryRun,true);
  assert.equal(report.readiness,'structural_only_not_ready');
  assert.equal(report.matrixSha256,protocol.matrix.sha256);
  assert.equal(report.plannedMatrixRows,450);
  assert.equal(report.selectedRows,450);
  assert.equal(report.notApplicableRows,0,'configured Blob namespaces make U6/U8 structurally in scope');
  assert.equal(report.measurableRows,420,'without a dependency bundle, only the 30 P3 network rows lack capability');
  assert.equal(report.unsupportedRows,30);
  assert.equal(report.scopeSummary?.u6u8Rows??90,90);
  assert.match(report.note,/no trials executed|Structural preflight only/i);
});
