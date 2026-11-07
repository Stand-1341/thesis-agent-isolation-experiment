import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

import {main, parsePlanCsv, selectRows} from './synthetic-pipeline-run.mjs';

const PLAN = await readFile(
  new URL('../config/plan-450-three-arm-supported-v2.csv', import.meta.url), 'utf8');

test('the plan parser reads the frozen matrix header and 450 rows', () => {
  const rows = parsePlanCsv(PLAN);
  assert.equal(rows.length, 450);
  assert.equal(rows[0].planned_run_id, 'tas450-b01-01-azure_vm-P1-U1');
  assert.equal(rows[0].scenario_type, 'unauthorized');
  assert.equal(typeof rows[0].block, 'string');
});

test('row selection spans every arm and profile, and is deterministic', () => {
  const rows = parsePlanCsv(PLAN);
  const picked = selectRows(rows, 18);
  assert.equal(picked.length, 18);
  assert.deepEqual(picked.map(r => r.planned_run_id), selectRows(rows, 18).map(r => r.planned_run_id));
  const arms = new Set(picked.map(r => r.deployment));
  const profiles = new Set(picked.map(r => r.permission_profile));
  assert.equal(arms.size, 3, 'all three arms must be represented');
  assert.equal(profiles.size, 3, 'all three profiles must be represented');
  // No duplicate arm/profile/scenario cell.
  const cells = picked.map(r => `${r.deployment}:${r.permission_profile}:${r.scenario_id}`);
  assert.equal(new Set(cells).size, cells.length);
});

test('selection respects the limit and never exceeds available rows', () => {
  const rows = parsePlanCsv(PLAN);
  assert.equal(selectRows(rows, 2).length, 2);
  assert.ok(selectRows(rows, 54).length <= 54);
});

test('the harness refuses to run without the explicit synthetic acknowledgement', async () => {
  let out = ''; let err = '';
  const code = await main({
    argv: [],
    stdout: {write: t => { out += t; }}, stderr: {write: t => { err += t; }}
  });
  assert.equal(code, 5);
  assert.match(err, /--i-understand-this-is-synthetic/);
  assert.match(err, /not evidence/);
  assert.equal(out, '');
});

test('help is available without the acknowledgement and launches nothing', async () => {
  let out = '';
  const code = await main({
    argv: ['--help'],
    stdout: {write: t => { out += t; }}, stderr: {write: () => {}}
  });
  assert.equal(code, 0);
  assert.match(out, /NO Azure/);
});

test('an out-of-range --rows value is rejected before any execution', async () => {
  let err = '';
  const code = await main({
    argv: ['--i-understand-this-is-synthetic', '--rows', '5000'],
    stdout: {write: () => {}}, stderr: {write: t => { err += t; }}
  });
  assert.equal(code, 5);
  assert.match(err, /--rows must be an integer from 1 to 54/);
});
