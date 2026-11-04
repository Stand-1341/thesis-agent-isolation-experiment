import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const template=await readFile(new URL('../infra/aci-controller-roles-pilot.bicep',import.meta.url),'utf8');
const assignmentTemplate=await readFile(new URL('../infra/aci-controller-role-assignments-pilot.bicep',import.meta.url),'utf8');

function resourceBlock(name,source=template) {
  const match=source.match(new RegExp(`resource ${name} '[^']+' = \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match,`missing resource ${name}`);
  return match[1];
}

test('ACI controller role template is subscription-scoped but limits custom roles to the pilot RG',()=>{
  assert.match(template,/targetScope = 'subscription'/);
  assert.equal((template.match(/resource .*'Microsoft\.Authorization\/roleDefinitions@/g)??[]).length,3);
  assert.equal((template.match(/assignableScopes: \[pilotResourceGroup\.id\]/g)??[]).length,3);
  assert.match(template,/module assignments '\.\/aci-controller-role-assignments-pilot\.bicep'[\s\S]*?scope: pilotResourceGroup/);
  assert.match(assignmentTemplate,/targetScope = 'resourceGroup'/);
});

test('container-group lifecycle grants only read, write, and delete at pilot-RG scope',()=>{
  const role=resourceBlock('aciLifecycleRole');
  for(const action of [
    'Microsoft.ContainerInstance/containerGroups/read',
    'Microsoft.ContainerInstance/containerGroups/write',
    'Microsoft.ContainerInstance/containerGroups/delete'
  ]) assert.ok(role.includes(`'${action}'`),`missing ${action}`);
  assert.doesNotMatch(role,/Microsoft\.ContainerInstance\/containerGroups\/\*/);
  assert.match(resourceBlock('aciLifecycleAssignment',assignmentTemplate),/name: guid\(resourceGroup\(\)\.id, controllerPrincipalId,/);
  assert.match(resourceBlock('aciLifecycleAssignment',assignmentTemplate),/principalId: controllerPrincipalId/);
});

test('subnet role is limited to read and join on only aci-experiment',()=>{
  const role=resourceBlock('aciSubnetJoinRole');
  assert.match(role,/Microsoft\.Network\/virtualNetworks\/subnets\/read/);
  assert.match(role,/Microsoft\.Network\/virtualNetworks\/subnets\/join\/action/);
  assert.equal((role.match(/'Microsoft\.Network\//g)??[]).length,2);
  assert.match(template,/param subnetName string = 'aci-experiment'/);
  assert.match(assignmentTemplate,/resource aciSubnet[\s\S]*?parent: vnet[\s\S]*?name: subnetName/);
  assert.match(resourceBlock('aciSubnetJoinAssignment',assignmentTemplate),/scope: aciSubnet/);
});

test('identity attach role grants only read and assign on the explicit pull/P1/P2 identities',()=>{
  const role=resourceBlock('uaiAttachRole');
  assert.match(role,/Microsoft\.ManagedIdentity\/userAssignedIdentities\/read/);
  assert.match(role,/Microsoft\.ManagedIdentity\/userAssignedIdentities\/assign\/action/);
  assert.equal((role.match(/'Microsoft\.ManagedIdentity\//g)??[]).length,2);
  for(const name of ['pullIdentityName','p1WorkloadIdentityName','p2WorkloadIdentityName'])
    assert.match(template,new RegExp(`param ${name} string`));
  for(const assignment of ['pullIdentityAttachAssignment','p1IdentityAttachAssignment','p2IdentityAttachAssignment']) {
    assert.match(resourceBlock(assignment,assignmentTemplate),/scope: (pullIdentity|p1WorkloadIdentity|p2WorkloadIdentity)/);
    assert.match(resourceBlock(assignment,assignmentTemplate),/principalId: controllerPrincipalId/);
  }
  assert.doesNotMatch(role,/\*/);
  assert.doesNotMatch(template,/Microsoft\.Authorization\/roleAssignments\/(write|\*)/);
});
