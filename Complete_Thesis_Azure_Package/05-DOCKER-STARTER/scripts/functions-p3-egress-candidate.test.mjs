import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const template=await readFile(new URL('../infra/functions-p3-egress-candidate.bicep',import.meta.url),'utf8');

test('Functions P3 firewall candidate is disabled by default and does not claim proof',()=>{
  assert.match(template,/param enableCandidate bool = false/);
  assert.match(template,/does not prove[\s\S]*?Flex traffic honors these routes/i);
  assert.match(template,/resource selectiveRules[\s\S]*?= if \(enableCandidate\)/);
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
  assert.match(template,/addressPrefix: '0\.0\.0\.0\/0'[\s\S]*?nextHopType: 'VirtualAppliance'/);
  assert.match(template,/param serviceReturnExistingRoutes array/);
  assert.match(template,/param privateEndpointReturnExistingRoutes array/);
  assert.match(template,/routes: concat\(filter\(serviceReturnExistingRoutes,[\s\S]*?name: 'functions-p3-return-via-firewall'/);
  assert.match(template,/routes: concat\(filter\(privateEndpointReturnExistingRoutes,[\s\S]*?name: 'functions-p3-return-via-firewall'/);
  assert.match(template,/name: 'functions-p3-return-via-firewall'[\s\S]*?addressPrefix: functionP3SubnetPrefix/);
  assert.equal((template.match(/\{ name: 'functions-p3-return-via-firewall'/g)??[]).length,2);
});

test('Functions P3 subnet updates preserve existing security and service-endpoint associations',()=>{
  assert.match(template,/resource existingResearchSubnet[\s\S]*?name: 'research-services'/);
  assert.match(template,/resource existingPrivateEndpointSubnet[\s\S]*?name: 'evidence-private-endpoints'/);
  const research=template.match(/resource updateResearchSubnet[\s\S]*?properties: \{([\s\S]*?)\n  \}\n}/)?.[1]??'';
  const endpoints=template.match(/resource updatePrivateEndpointSubnet[\s\S]*?properties: \{([\s\S]*?)\n  \}\n}/)?.[1]??'';
  for (const [body,source] of [[research,'existingResearchSubnet'],[endpoints,'existingPrivateEndpointSubnet']]) {
    assert.match(body,new RegExp(`networkSecurityGroup: empty\\(${source}\\.properties\\.networkSecurityGroup\\) \\? null : \\{ id: ${source}\\.properties\\.networkSecurityGroup\\.id \\}`));
    assert.match(body,new RegExp(`serviceEndpoints: ${source}\\.properties\\.serviceEndpoints`));
    assert.match(body,new RegExp(`serviceEndpointPolicies: ${source}\\.properties\\.serviceEndpointPolicies`));
    assert.match(body,new RegExp(`delegations: ${source}\\.properties\\.delegations`));
  }
});

test('firewall application and network rule logs are sent to the chosen workspace',()=>{
  assert.match(template,/category: 'AzureFirewallApplicationRule', enabled: true/);
  assert.match(template,/category: 'AzureFirewallNetworkRule', enabled: true/);
  assert.match(template,/workspaceId: logWorkspaceId/);
});
