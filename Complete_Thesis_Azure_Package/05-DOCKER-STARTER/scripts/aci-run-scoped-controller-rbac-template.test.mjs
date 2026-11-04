import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const template=await readFile(new URL('../infra/aci-run-scoped-controller-rbac.bicep',import.meta.url),'utf8');
const guide=await readFile(new URL('../infra/ACI-RUN-SCOPED-CONTROLLER-RBAC.md',import.meta.url),'utf8');

function resource(name) {
  const match=template.match(new RegExp(`resource ${name} '[^']+' = \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match,`missing resource ${name}`);
  return match[1];
}

test('run UAI lifecycle custom role has only identity read/write/delete at resource-group scope',()=>{
  assert.match(template,/targetScope = 'resourceGroup'/);
  const role=resource('identityLifecycleRole');
  for(const action of [
    'Microsoft.ManagedIdentity/userAssignedIdentities/read',
    'Microsoft.ManagedIdentity/userAssignedIdentities/write',
    'Microsoft.ManagedIdentity/userAssignedIdentities/delete'
  ]) assert.ok(role.includes(`'${action}'`),`missing ${action}`);
  assert.equal((role.match(/'Microsoft\.ManagedIdentity\//g)??[]).length,3);
  assert.match(role,/assignableScopes: \[resourceGroup\(\)\.id\]/);
  assert.doesNotMatch(role,/assign\/action|roleAssignments/);
  assert.match(resource('identityLifecycleAssignment'),/principalId: controllerPrincipalId/);
  assert.match(template,/protectedIdentityDeleteLocks[\s\S]*?level: 'CanNotDelete'/);
  assert.match(template,/protectedIdentityNames array/);
});

test('RBAC administrator delegation is scoped exactly to the two marker containers',()=>{
  assert.match(template,/u6MarkerContainerName string = 'session-b'/);
  assert.match(template,/u8MarkerContainerName string = 'prior-session'/);
  for(const assignment of ['u6ContainerRoleAssignmentOperator','u8ContainerRoleAssignmentOperator']) {
    const block=resource(assignment);
    assert.match(block,/scope: u[68]MarkerContainer/);
    assert.match(block,/roleBasedAccessControlAdministrator\.id/);
    assert.match(block,/conditionVersion: '2\.0'/);
    assert.match(block,/condition: roleAssignmentCondition/);
  }
  assert.equal((template.match(/resource u[68]ContainerRoleAssignmentOperator/g)??[]).length,2);
  assert.doesNotMatch(resource('identityLifecycleAssignment'),/roleAssignmentCondition/);
});

test('creation and deletion conditions constrain only Blob Data Contributor service-principal assignments',()=>{
  const condition=template.slice(template.indexOf('var roleAssignmentCondition'),template.indexOf("resource identityLifecycleRole"));
  assert.match(condition,/ActionMatches\{'Microsoft\.Authorization\/roleAssignments\/write'\}/);
  assert.match(condition,/@Request\[Microsoft\.Authorization\/roleAssignments:RoleDefinitionId\] ForAnyOfAnyValues:GuidEquals \{ba92f5b4-2d11-453d-a403-e96b0029c9fe\}/);
  assert.match(condition,/@Request\[Microsoft\.Authorization\/roleAssignments:PrincipalType\] ForAnyOfAnyValues:StringEqualsIgnoreCase \{'ServicePrincipal'\}/);
  assert.match(condition,/ActionMatches\{'Microsoft\.Authorization\/roleAssignments\/delete'\}/);
  assert.match(condition,/@Resource\[Microsoft\.Authorization\/roleAssignments:RoleDefinitionId\] ForAnyOfAnyValues:GuidEquals \{ba92f5b4-2d11-453d-a403-e96b0029c9fe\}/);
  assert.match(condition,/@Resource\[Microsoft\.Authorization\/roleAssignments:PrincipalType\] ForAnyOfAnyValues:StringEqualsIgnoreCase \{'ServicePrincipal'\}/);
  assert.equal((condition.match(/ba92f5b4-2d11-453d-a403-e96b0029c9fe/g)??[]).length,2);
});

test('template and guidance fail closed on unscopable dynamic identity attachment',()=>{
  assert.match(template,/output controllerMayAttachDynamicRunIdentities bool = false/);
  assert.doesNotMatch(template,/Microsoft\.ManagedIdentity\/userAssignedIdentities\/assign\/action/);
  assert.ok(guide.includes('does **not** grant `Microsoft.ManagedIdentity/userAssignedIdentities/assign/action`'));
  assert.match(guide,/trusted identity broker/);
  assert.match(guide,/not been deployed/);
});
