import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {preflightThreeArchitecture} from './preflight-three-architecture.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const protocol=JSON.parse(readFileSync(resolve(root,'config/protocol-450-three-architecture-planning.json')));
const planBytes=readFileSync(resolve(root,'../03-PLANNED-TRIAL-MATRIX-450.csv'));
const config=JSON.parse(readFileSync(resolve(root,'config/experiment.azure-live.json')));

test('reports missing session routes and refuses launch without side effects',()=>{
  const report=preflightThreeArchitecture({planBytes,protocol,config});
  assert.equal(report.ready,false);
  assert.equal(report.launchEnabled,false);
  assert.equal(report.plannedRows,450);
  assert.deepEqual(report.missingRoutes,['azure_custom_sessions_hyperv:P1','azure_custom_sessions_hyperv:P2','azure_custom_sessions_hyperv:P3']);
  assert.equal(report.scope.notApplicable,60);
  assert.ok(report.scope.unsupported>0);
});

test('invalid and duplicate configuration cannot unlock the run',()=>{
  const route=config.routes[0];
  const report=preflightThreeArchitecture({planBytes,protocol,config:{...config,routes:[...config.routes,route]}});
  assert.deepEqual(report.duplicateRoutes,['azure_vm:P1']);
  assert.equal(report.configValidation.status,'invalid_or_unsupported');
  assert.equal(report.launchEnabled,false);
  assert.throws(()=>preflightThreeArchitecture({planBytes,protocol:{...protocol,measuredExecutionEnabled:true},config}),/planning only/);
});
