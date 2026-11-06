import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectOriginalPlan} from './inspect-three-architecture-plan.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(readFileSync(resolve(root,'config/protocol-450-three-architecture-planning.json'),'utf8'));
const bytes=readFileSync(resolve(root,'..',config.matrixFile));
test('original plan covers all 450 cells and identifies current scope gaps',()=>{
  const report=inspectOriginalPlan(bytes,config);
  assert.equal(report.rows,450);
  assert.equal(report.scope.notApplicable,60);
  assert.ok(report.scope.unsupported>0);
  assert.equal(report.measuredExecutionEnabled,false);
});
test('rejects modified matrix and an attempt to enable measured execution',()=>{
  assert.throws(()=>inspectOriginalPlan(Buffer.concat([bytes,Buffer.from('x')]),config),/digest/);
  assert.throws(()=>inspectOriginalPlan(bytes,{...config,measuredExecutionEnabled:true}),/planning only/);
});
