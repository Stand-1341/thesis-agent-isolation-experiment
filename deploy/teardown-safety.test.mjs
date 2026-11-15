import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listEvidenceBlobs, parseEvidenceContainerUrl, identifyChargedSurvivors} from './teardown.mjs';

test('evidence listing authenticates against the actual Azure account and fails when unavailable', async () => {
  let command;
  const list = await listEvidenceBlobs({containerUrl:'https://testaccount.blob.core.windows.net/evidence', az: async args => {command=args; return ['trial/1'];}});
  assert.deepEqual(list,['trial/1']);
  assert.ok(command.includes('--auth-mode') && command.includes('login'));
  await assert.rejects(listEvidenceBlobs({containerUrl:'https://testaccount.blob.core.windows.net/evidence', az:async()=>{throw new Error('access denied');}}),/access denied/);
  assert.throws(()=>parseEvidenceContainerUrl('https://example.com/evidence'),/Azure Blob/);
});

test('charged survivor check excludes the managed group given by name', () => {
  const resources=[{id:'/subscriptions/s/resourceGroups/managed/providers/Microsoft.Storage/storageAccounts/a',type:'Microsoft.Storage/storageAccounts'},
    {id:'/subscriptions/s/resourceGroups/other/providers/Microsoft.Storage/storageAccounts/b',type:'Microsoft.Storage/storageAccounts'}];
  assert.deepEqual(identifyChargedSurvivors({subscriptionResources:resources,managedResourceGroup:'managed'}).map(x=>x.id),[resources[1].id]);
});
