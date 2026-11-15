import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=(await readFile(new URL('../infra/regional-p3-spoke.bicep',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const block=(kind,name)=>{
  const lines=source.split('\n');
  const start=lines.findIndex(line=>line.startsWith(`${kind} ${name} `));
  if(start<0) return '';
  const end=lines.findIndex((line,index)=>index>start&&line==='}');
  return end<0?'':lines.slice(start,end+1).join('\n');
};

test('regional ACA P3 subnet is delegated and attached to the firewall UDR',()=>{
  const subnet=block('resource','jobsP3Subnet');
  assert.match(subnet,/serviceName: 'Microsoft\.App\/environments'/);
  assert.match(subnet,/routeTable: \{ id: egressRouteTable\.id \}/);
  assert.doesNotMatch(subnet,/networkSecurityGroup:/,'ACA subnet avoids an unvalidated NSG attachment');
  const routes=block('resource','egressRouteTable');
  assert.match(routes,/addressPrefix: '0\.0\.0\.0\/0'/);
  assert.match(routes,/nextHopType: 'VirtualAppliance'/);
  assert.match(routes,/nextHopIpAddress: firewallPrivateIp/);
});

test('regional firewall explicitly allows shared fixture/research and denies collector plus all other egress',()=>{
  const rules=block('resource','studyEgressRules');
  assert.match(rules,/p3-allow-research-service/);
  assert.match(rules,/destinationAddresses: \[researchServicePrivateIp\]/);
  assert.match(rules,/p3-allow-fixture-blob/);
  assert.match(rules,/destinationAddresses: \[fixtureEndpointPrivateIp\]/);
  assert.match(rules,/p3-deny-collector/);
  assert.match(rules,/destinationAddresses: \[collectorPrivateIp\]/);
  assert.match(rules,/p3-deny-restricted-service/);
  assert.match(rules,/destinationAddresses: \[restrictedServicePrivateIp\]/);
  assert.match(rules,/p3-default-deny/);
  assert.match(rules,/destinationAddresses: \['\*'\]/);
});

test('P3 VM ingress is controller scoped and the module exposes cross-region connectivity requirements',()=>{
  const nsg=block('resource','vmNsg');
  assert.match(nsg,/sourceAddressPrefixes: controllerSourcePrefixes/);
  assert.match(nsg,/destinationPortRange: '443'/);
  assert.match(nsg,/deny-all-other-inbound/);
  assert.match(source,/output requiredSharedHubRoutes array/);
  assert.match(source,/sharedHubVnetResourceId string = ''/);
  assert.match(source,/allowForwardedTraffic: true/);
  assert.match(source,/sharedHubPeeringId string/);
  assert.match(source,/module reciprocalHubPeering/);
  assert.match(source,/module sharedHubReturnRoutes/);
  assert.match(source,/sharedPrivateDnsZoneLinked bool = length\(sharedPrivateDnsZoneResourceIds\) > 0/);
  assert.match(source,/module sharedDnsLinks/);
  assert.match(source,/NOT deployed or pilot-validated/);
});

test('hub return routes traverse the regional firewall and shared DNS links disable registration',async()=>{
  const source=await readFile(new URL('../infra/regional-p3-spoke.bicep',import.meta.url),'utf8');
  const peering=await readFile(new URL('../infra/hub-p3-peering.bicep',import.meta.url),'utf8');
  const routes=await readFile(new URL('../infra/hub-p3-return-routes.bicep',import.meta.url),'utf8');
  const links=await readFile(new URL('../infra/regional-p3-private-dns-link.bicep',import.meta.url),'utf8');
  assert.match(source,/spokeVnetResourceId: vnet\.id/);
  assert.match(peering,/remoteVirtualNetwork: \{ id: spokeVnetResourceId \}/);
  assert.match(peering,/allowForwardedTraffic: true/);
  assert.match(routes,/addressPrefix: prefix/);
  assert.match(routes,/nextHopType: 'VirtualAppliance'/);
  assert.match(routes,/nextHopIpAddress: firewallPrivateIp/);
  assert.match(links,/registrationEnabled: false/);
  assert.match(links,/virtualNetwork: \{ id: virtualNetworkId \}/);
});
