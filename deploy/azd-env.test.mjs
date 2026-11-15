import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAzdEnvValue} from './common.mjs';

test('azd environment parser decodes quoted JSON values without changing their contents', () => {
  const map = JSON.stringify({azure_vm:{P1:'centralus',P3:'westus2'}});
  assert.deepEqual(JSON.parse(parseAzdEnvValue(JSON.stringify(map))), JSON.parse(map));
  assert.equal(parseAzdEnvValue('"simple"'), 'simple');
  assert.throws(()=>parseAzdEnvValue('"unterminated','TEST_KEY'),/TEST_KEY/);
});
