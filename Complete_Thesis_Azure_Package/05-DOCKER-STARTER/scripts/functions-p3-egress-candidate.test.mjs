import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const template=await readFile(new URL('../infra/functions-p3-egress-candidate.bicep',import.meta.url),'utf8');

test('Functions P3 firewall candidate is disabled by default and does not claim proof',()=>{
  assert.match(template,/param enableCandidate bool = false/);
  assert.match(template,/does not prove[\s\S]*?Flex traffic honors these routes/i);
  assert.match(template,/resource selectiveRules[\s\S]*?= if \(enableCandidate\)/);
});

test('Functions P3 candidate does not allow broad regional storage or service-tag egress',()=>{
  assert.doesNotMatch(template,/Storage\.EastUS|AzureActiveDirectory|AzureMonitor/);
  assert.doesNotMatch(template,/@minLength\(1\)\s*param requiredFunctionFqdns/);
  assert.match(template,/targetFqdns: concat\(hostStorageFqdns, requiredFunctionFqdns\)/);
});

test('Functions P3 uses a free policy priority and reads live route settings',()=>{
  assert.match(template,/priority: 230/);
  assert.match(template,/existing vm-p3-centralus-selective-egress owns 220/); // documents the existing priority owner
  assert.doesNotMatch(template,/functions-p3-deny-all-other/); // network catch-all would preempt host-storage app rules
  assert.match(template,/param serviceReturnDisableBgpRoutePropagation bool/);
  assert.match(template,/param privateEndpointReturnDisableBgpRoutePropagation bool/);
  assert.match(template,/disableBgpRoutePropagation: serviceReturnDisableBgpRoutePropagation/);
  assert.match(template,/disableBgpRoutePropagation: privateEndpointReturnDisableBgpRoutePropagation/);
  assert.match(template,/privateLinkServiceNetworkPolicies: 'Enabled'/);
});

test('Functions P3 route permits only the configured research and fixture Blob IPs',()=>{
  const allow=template.match(/name: 'functions-p3-allow-research-and-fixtures'[\s\S]*?\n      \}/)?.[0]??'';
  const deny=template.match(/name: 'functions-p3-deny-restricted-collector'[\s\S]*?\n      \}/)?.[0]??'';
  assert.match(allow,/destinationAddresses: \[researchServicePrivateIp\]/);
  assert.match(allow,/destinationAddresses: \[blobPrivateEndpointIp\]/);
  assert.doesNotMatch(allow,/collectorPrivateIp/);
  assert.match(deny,/destinationAddresses: \[collectorPrivateIp\]/);
  assert.match(deny,/action: \{ type: 'Deny' \}/);
});

test('Functions P3 forces firewall routing and appends symmetric returns without dropping existing routes',()=>{
  assert.match(template,/param firewallPrivateIp string/);
  assert.match(template,/nextHopIpAddress: firewallPrivateIp/);
  assert.match(template,/addressPrefix: '0\.0\.0\.0\/0'[\s\S]*?nextHopType: 'VirtualAppliance'/);
  assert.match(template,/param serviceReturnExistingRoutes array/);
  assert.match(template,/param privateEndpointReturnExistingRoutes array/);
  assert.match(template,/routes: concat\(filter\(serviceReturnExistingRoutes,[\s\S]*?name: 'functions-p3-return-via-firewall'/);
  assert.match(template,/routes: concat\(filter\(privateEndpointReturnExistingRoutes,[\s\S]*?name: 'functions-p3-return-via-firewall'/);
  assert.match(template,/name: 'functions-p3-return-via-firewall'[\s\S]*?addressPrefix: functionP3SubnetPrefix/);
  assert.equal((template.match(/\{ name: 'functions-p3-return-via-firewall'/g)??[]).length,2);
});

test('Functions P3 subnet updates preserve existing security and service-endpoint associations',()=>{
  const research=template.match(/resource updateResearchSubnet[\s\S]*?properties: \{([\s\S]*?)\n  \}\n}/)?.[1]??'';
  const endpoints=template.match(/resource updatePrivateEndpointSubnet[\s\S]*?properties: \{([\s\S]*?)\n  \}\n}/)?.[1]??'';
  const functions=template.match(/resource functionsP3Subnet[\s\S]*?properties: \{([\s\S]*?)\n  \}\n}/)?.[1]??'';
  assert.match(research,/privateEndpointNetworkPolicies: 'Disabled'/);
  assert.match(research,/privateLinkServiceNetworkPolicies: 'Enabled'/);
  assert.match(functions,/delegations: \[\{ name: 'functions-delegation', properties: \{ serviceName: 'Microsoft\.App\/environments' \} \}\]/);
  assert.match(functions,/privateEndpointNetworkPolicies: 'Disabled'/);
  assert.match(functions,/privateLinkServiceNetworkPolicies: 'Enabled'/);
  assert.match(endpoints,/privateEndpointNetworkPolicies: 'RouteTableEnabled'/);
  assert.match(endpoints,/privateLinkServiceNetworkPolicies: 'Enabled'/);
  assert.doesNotMatch(template,/existing(Research|PrivateEndpoint|Functions)Subnet/);
});

test('candidate reuses existing firewall diagnostic setting without creating a duplicate sink',()=>{
  assert.match(template,/already stream to the approved workspace[\s\S]*?session-egress-audit/);
  assert.doesNotMatch(template,/Microsoft\.Insights\/diagnosticSettings/);
  assert.doesNotMatch(template,/logWorkspaceId/);
});
