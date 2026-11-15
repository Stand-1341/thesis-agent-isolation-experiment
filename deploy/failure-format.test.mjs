import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatFailures} from './common.mjs';

test('study launcher failures identify their gate', () => {
  const report = formatFailures('Study blocked', [{gate:'G3', problem:'missing pilot'}]);
  assert.match(report,/G3: missing pilot/);
  assert.doesNotMatch(report,/undefined/);
});
