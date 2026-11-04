import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const template=await readFile(new URL('../infra/controller-vm-pilot.bicep',import.meta.url),'utf8');
const registryReader=await readFile(new URL('../infra/controller-acr-metadata-reader.bicep',import.meta.url),'utf8');

test('controller pilot gets a dedicated subnet and does not mutate the session subnet',()=>{
  assert.match(template,/name: 'experiment-controller'/);
  assert.match(template,/controllerSubnetPrefix string = '10\.48\.11\.0\/24'/);
  assert.doesNotMatch(template,/name: 'sessions-pilot'/);
  assert.match(template,/addressPrefix: controllerSubnetPrefix/);
});

test('controller VM has no public IP or inbound access, routes public egress through Firewall, and uses VNet system routes',()=>{
  assert.match(template,/name: 'deny-all-inbound'[\s\S]*?direction: 'Inbound'[\s\S]*?access: 'Deny'/);
  assert.match(template,/name: 'default-to-firewall'[\s\S]*?nextHopType: 'VirtualAppliance'/);
  assert.doesNotMatch(template,/name: 'vnet-to-firewall'/);
  assert.doesNotMatch(template,/addressPrefix: '10\.48\.0\.0\/16'[\s\S]*?nextHopType: 'VirtualAppliance'/);
  assert.doesNotMatch(template,/Microsoft\.Network\/publicIPAddresses/);
});

test('controller public egress is restricted to exact application destinations',()=>{
  assert.match(template,/targetFqdns: allowedApplicationFqdns/);
  assert.doesNotMatch(template,/name: 'private-acr-pull'/);
  assert.doesNotMatch(template,/name: 'fixture-and-session-blob'/);
  assert.doesNotMatch(template,/controller-return-via-firewall/);
});

test('controller identities are attached as explicit user-assigned identities',()=>{
  assert.match(template,/controllerIdentity\.id/);
  assert.match(template,/auditIdentity\.id/);
  assert.match(template,/sessionIdentity\.id/);
  assert.match(template,/userAssignedIdentities:/);
  assert.match(template,/resource sessionRegistryWriterRole[\s\S]*?scope: sessionRegistryContainer/);
  assert.match(template,/acrPullIdentity\.id/);
  assert.doesNotMatch(template,/resource controllerAcrPullRole[\s\S]*?Microsoft\.Authorization\/roleAssignments/);
  assert.match(template,/controllerIdentity\.properties\.principalId/);
});

test('ACR pull identity gets metadata-only Reader at the registry scope',()=>{
  assert.match(registryReader,/scope: registry/);
  assert.match(registryReader,/id-thesis-acr-pull/);
  assert.match(registryReader,/acdd72a7-3385-48ef-bd42-f606fba81ae7/);
  assert.doesNotMatch(registryReader,/Contributor|Owner/);
});

test('example egress list names current Entra, ARM, Log Analytics, and diagnostic Function FQDNs explicitly',async()=>{
  const params=JSON.parse(await readFile(new URL('../infra/controller-vm-pilot.parameters.example.json',import.meta.url),'utf8')).parameters;
  for(const fqdn of ['login.microsoftonline.com','management.azure.com','api.loganalytics.azure.com','thesisacr74a95224.azurecr.io','thesisacr74a95224.eastus.data.azurecr.io','thesisfixture20261103.blob.core.windows.net','thesispilotblob20261102.blob.core.windows.net','thesis-flex-pilot-20261103.azurewebsites.net'])
    assert.ok(params.allowedApplicationFqdns.value.includes(fqdn),`missing ${fqdn}`);
});
