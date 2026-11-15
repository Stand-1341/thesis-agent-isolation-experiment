import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveVmImageVersion, VM_IMAGE} from './resolve-inputs.mjs';

test('resolveVmImageVersion selects the latest pinned version of the deployed VM image', async () => {
  let args;
  const result = await resolveVmImageVersion({region:'centralus',subscriptionId:'sub',az:async value => {
    args=value; return ['22.04.20259','22.04.202610220','22.04.2026'];
  }});
  assert.equal(result.value,'22.04.202610220');
  assert.ok(args.includes(VM_IMAGE.offer));
  assert.ok(args.includes(VM_IMAGE.sku));
  assert.ok(args.includes('centralus'));
});

test('resolveVmImageVersion does not select an unpinned or unavailable image', async () => {
  assert.equal(await resolveVmImageVersion({region:'centralus',subscriptionId:'sub',az:async () => ['latest']}),undefined);
});
