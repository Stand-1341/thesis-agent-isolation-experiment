import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const network=await readFile(new URL('../infra/aci-network-pilot.bicep',import.meta.url),'utf8');
const group=await readFile(new URL('../infra/aci-agent-group-pilot.bicep',import.meta.url),'utf8');

test('ACI network uses a dedicated delegated /24, NAT Gateway egress, and controller-only HTTP ingress',()=>{
  assert.match(network,/param subnetPrefix string = '10\.48\.13\.0\/24'/);
  assert.match(network,/serviceName: 'Microsoft\.ContainerInstance\/containerGroups'/);
  assert.match(network,/Microsoft\.Network\/natGateways@2023-09-01/);
  assert.match(network,/Microsoft\.Network\/publicIPAddresses@2023-09-01/);
  assert.match(network,/natGateway: \{ id: natGateway\.id \}/);
  assert.match(network,/privateEndpointNetworkPolicies: 'Disabled'/);
  assert.match(network,/privateLinkServiceNetworkPolicies: 'Enabled'/);
  assert.doesNotMatch(network,/routeTable:|VirtualAppliance|firewallPrivateIp/);
  assert.match(network,/sourceAddressPrefix: controllerPrefix[\s\S]*?destinationPortRange: '8080'/);
  assert.match(network,/name: 'controller-to-aci-agent-http'[\s\S]*?direction: 'Outbound'[\s\S]*?sourceAddressPrefix: controllerPrefix[\s\S]*?destinationAddressPrefix: subnetPrefix[\s\S]*?destinationPortRange: '8080'/);
  assert.match(network,/name: 'deny-other-inbound'[\s\S]*?access: 'Deny'/);
  assert.match(network,/p3Validated: 'false'/);
});

test('ACI NAT egress is documented as a permissive P1/P2 path, not a P3 enforcement claim',()=>{
  assert.match(network,/P1\/P2 only/);
  assert.match(network,/NAT Gateway/);
  assert.match(network,/p3Validated: 'false'/);
});

test('ACI group is private, digest-pinned, least-privilege by separate identities, and uses secure app settings',()=>{
  assert.match(group,/Microsoft\.ContainerInstance\/containerGroups@2023-05-01/);
  assert.match(group,/image: imageDigestReference/);
  assert.match(group,/identity: \{\s*type: 'UserAssigned'[\s\S]*?\$\{pullIdentityId\}[\s\S]*?\$\{workloadIdentityId\}/);
  assert.match(group,/imageRegistryCredentials: \[\{ server: registryServer, identity: pullIdentityId \}\]/);
  assert.match(group,/type: 'Private'/);
  assert.match(group,/restartPolicy: 'Never'/);
  assert.match(group,/secureValue: workloadToken/);
  assert.match(group,/secureValue: trialRequestKey/);
  assert.match(group,/dnsConfig: \{ nameServers: \[dnsServer\] \}/);
});
