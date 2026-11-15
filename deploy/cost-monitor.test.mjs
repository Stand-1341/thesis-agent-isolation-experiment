import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBudget, getCostSnapshot} from './cost-monitor.mjs';

test('cost snapshot reports the Azure budget and notes reporting lag', async () => {
  const calls = [];
  const snapshot = await getCostSnapshot({subscriptionId:'s',budgetName:'b',now:new Date('2026-11-14T00:00:00Z'),az:async args => {
    calls.push(args); return {name:'b',amount:'90',currentSpend:{amount:'2.5',unit:'USD'}};
  }});
  assert.equal(snapshot.reportedSpend, 2.5);
  assert.equal(snapshot.reportedRemaining, 87.5);
  assert.match(snapshot.note, /lag/);
  assert.ok(calls[0].includes('--subscription'));
});

test('cost snapshot refuses to interpret missing Azure spending as zero', () => {
  assert.throws(() => parseBudget({amount:90,currentSpend:{unit:'USD'}}), /unknown/);
  assert.throws(() => parseBudget({amount:90,currentSpend:{amount:'',unit:'USD'}}), /unknown/);
});
