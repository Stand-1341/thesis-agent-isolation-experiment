import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Treat source line endings as text-file formatting, not part of the Bicep contract.
const readBicep=async path=>(await readFile(new URL(path,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const composition=await readBicep('../infra/azure-supported-three-arm.bicep');
const evidenceEndpoint=await readBicep('../infra/evidence-private-endpoint-pilot.bicep');
const fixtureEndpoint=await readBicep('../infra/fixture-private-endpoint-pilot.bicep');
const declarationBlock=(kind,name)=>{
  const lines=composition.split('\n');
  const start=lines.findIndex(line=>line.startsWith(`${kind} ${name} `));
  if(start<0) return '';
  const end=lines.findIndex((line,index)=>index>start&&line==='}');
  return end<0?'':lines.slice(start,end+1).join('\n');
};
const hasLine=(block,expected)=>block.split('\n').some(line=>line.trim()===expected);

test('shared Blob private DNS exists for storage arms and regional P3 support',()=>{
  assert.ok(composition.split('\n').includes('var deployBlobPrivateDns = deployEvidenceStore || deploySyntheticFixtures || deployRegionalP3Support'));
  const zone=declarationBlock('resource','blobPrivateDnsZone');
  const link=declarationBlock('resource','blobPrivateDnsVnetLink');
  assert.ok(zone,'shared private DNS zone declaration must exist');
  assert.ok(link,'shared private DNS VNet link declaration must exist');
  const zoneHeader=zone.split('\n')[0].trim();
  const linkHeader=link.split('\n')[0].trim();
  assert.ok(zoneHeader.startsWith("resource blobPrivateDnsZone 'Microsoft.Network/privateDnsZones@"));
  assert.ok(linkHeader.startsWith("resource blobPrivateDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@"));
  assert.ok(zoneHeader.endsWith('= if (deployBlobPrivateDns) {'));
  assert.ok(linkHeader.endsWith('= if (deployBlobPrivateDns) {'));
  assert.ok(hasLine(link,'parent: blobPrivateDnsZone'));
  assert.ok(hasLine(link,'properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }'));
});

test('both private endpoints use the shared DNS zone without requiring the other endpoint',()=>{
  const evidenceStoreBlock=declarationBlock('module','evidenceStore');
  const evidenceBlock=declarationBlock('module','evidenceEndpoint');
  const fixtureStoreBlock=declarationBlock('module','fixtureStore');
  const fixtureBlock=declarationBlock('module','fixtureEndpoint');
  for(const [name,block] of Object.entries({evidenceStoreBlock,evidenceBlock,fixtureStoreBlock,fixtureBlock}))
    assert.ok(block,`${name} declaration must exist`);
  assert.ok(evidenceStoreBlock.split('\n')[0].endsWith('= if (deployEvidenceStore) {'));
  assert.ok(evidenceBlock.split('\n')[0].endsWith('= if (deployEvidenceStore) {'));
  assert.ok(fixtureStoreBlock.split('\n')[0].endsWith('= if (deploySyntheticFixtures) {'));
  assert.ok(fixtureBlock.split('\n')[0].endsWith('= if (deploySyntheticFixtures) {'));
  assert.ok(hasLine(evidenceBlock,'blobDnsZoneId: blobPrivateDnsZone!.id'));
  assert.ok(hasLine(evidenceBlock,'storageAccountId: evidenceStore!.outputs.accountId'));
  assert.ok(hasLine(evidenceBlock,'dependsOn: [blobPrivateDnsVnetLink]'));
  assert.ok(hasLine(fixtureBlock,'blobDnsZoneId: blobPrivateDnsZone!.id'));
  assert.ok(hasLine(fixtureBlock,'endpointSubnetId: privateEndpointSubnet.id'));
  assert.ok(hasLine(fixtureBlock,'storageAccountId: fixtureStore!.outputs.accountId'));
  assert.ok(hasLine(fixtureBlock,'dependsOn: [blobPrivateDnsVnetLink]'));
  assert.doesNotMatch(fixtureStoreBlock,/evidenceStore|deployEvidenceStore|evidenceEndpoint/);
  assert.doesNotMatch(fixtureBlock,/evidenceStore|deployEvidenceStore|evidenceEndpoint/);
  assert.ok(hasLine(evidenceEndpoint,'param blobDnsZoneId string'));
  assert.ok(hasLine(evidenceEndpoint,"privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: blobDnsZoneId } }]"));
  assert.doesNotMatch(evidenceEndpoint,/^resource\s+\S+\s+'Microsoft\.Network\/privateDnsZones(?:\/[^']*)?@/m);
  assert.ok(hasLine(fixtureEndpoint,'param blobDnsZoneId string'));
  assert.ok(hasLine(fixtureEndpoint,"properties: { privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: blobDnsZoneId } }] }"));
  assert.doesNotMatch(fixtureEndpoint,/^resource\s+\S+\s+'Microsoft\.Network\/privateDnsZones(?:\/[^']*)?@/m);
});
