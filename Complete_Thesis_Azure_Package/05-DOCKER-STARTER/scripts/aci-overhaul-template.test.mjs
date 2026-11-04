import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const network=await readFile(new URL('../infra/aci-network-pilot.bicep',import.meta.url),'utf8');
const group=await readFile(new URL('../infra/aci-agent-group-pilot.bicep',import.meta.url),'utf8');

test('ACI network uses a dedicated delegated /24, existing Firewall route, and controller-only HTTP ingress',()=>{
  assert.match(network,/param subnetPrefix string = '10\.48\.13\.0\/24'/);
  assert.match(network,/serviceName: 'Microsoft\.ContainerInstance\/containerGroups'/);
  assert.match(network,/routeTable: \{ id: routeTable\.id \}/);
  assert.match(network,/param routeTableName string = 'thesis-p3-routes'/);
  assert.doesNotMatch(network,/publicIPAddresses|natGateways|natGateway:/);
  assert.match(network,/aci-experiment-return'[\s\S]*?nextHopIpAddress: firewallPrivateIp/);
  assert.match(network,/sourceAddressPrefix: controllerPrefix[\s\S]*?destinationPortRange: '8080'/);
  assert.match(network,/name: 'deny-other-inbound'[\s\S]*?access: 'Deny'/);
  assert.match(network,/p3Validated: 'false'/);
});

test('ACI P1/P2 egress is explicitly routed through existing Firewall without implying P3 restriction',async()=>{
  const firewall=await readFile(new URL('../infra/aci-firewall-egress-pilot.bicep',import.meta.url),'utf8');
  assert.match(firewall,/sourcePrefix string = '10\.48\.13\.0\/24'/);
  assert.match(firewall,/ruleType: 'NetworkRule'[\s\S]*?ipProtocols: \['Any'\]/);
  assert.match(firewall,/destinationAddresses: \['\*'\][\s\S]*?destinationPorts: \['\*'\]/);
  assert.match(firewall,/Do not associate this source range with an ACI P3 claim/);
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
