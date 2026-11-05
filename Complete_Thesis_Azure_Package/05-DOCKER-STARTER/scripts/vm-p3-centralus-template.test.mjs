import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const template=await readFile(new URL('../infra/vm-p3-centralus-pilot.bicep',import.meta.url),'utf8');

test('Central P3 spoke links the existing Blob private DNS zone before VM deployment',()=>{
  assert.match(template,/resource blobPrivateDnsZone .*privateDnsZones.* existing/);
  assert.match(template,/name: 'privatelink\.blob\.\$\{environment\(\)\.suffixes\.storage\}'/);
  assert.match(template,/resource blobPrivateDnsLink .*privateDnsZones\/virtualNetworkLinks/);
  assert.match(template,/name: '\$\{spokeVnetName\}-blob'/);
  assert.match(template,/registrationEnabled: false/);
  assert.match(template,/virtualNetwork: \{ id: spokeVnet\.id \}/);
  assert.match(template,/dependsOn:\s*\[[\s\S]*?blobPrivateDnsLink[\s\S]*?vmP3CentralFirewallRules/);
});
