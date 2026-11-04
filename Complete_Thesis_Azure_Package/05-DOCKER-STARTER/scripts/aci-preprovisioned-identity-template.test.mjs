import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const template=await readFile(new URL('../infra/aci-preprovisioned-run-identities.bicep',import.meta.url),'utf8');
const createTemplate=await readFile(new URL('../infra/aci-create-run-identities.bicep',import.meta.url),'utf8');
const module=await readFile(new URL('../infra/aci-run-identity-access.bicep',import.meta.url),'utf8');
const docs=await readFile(new URL('../infra/ACI-PREPROVISIONED-RUN-IDENTITIES.md',import.meta.url),'utf8');

test('controller gets attach/delete only at individual pre-provisioned UAI scopes',()=>{
  assert.match(template,/resource identityResources .*\[for spec in identitySpecs/);
  assert.match(template,/module perIdentityAccess .*\[for \(spec, i\) in identitySpecs/);
  assert.match(template,/userAssignedIdentities\/assign\/action/);
  assert.match(template,/userAssignedIdentities\/delete/);
  assert.doesNotMatch(template,/userAssignedIdentities\/write/);
  assert.match(module,/scope: identity/);
  assert.match(module,/Microsoft\.Authorization\/roleAssignments:PrincipalId/);
  assert.match(module,/Microsoft\.Authorization\/roleAssignments:RoleDefinitionId/);
  assert.match(template,/spec\.principalId/);
  assert.match(createTemplate,/resource runIdentities/);
  assert.doesNotMatch(createTemplate,/roleAssignments/);
});

test('Blob permissions are limited to source/cleanup at exact marker containers and conditioned controller deletion',()=>{
  assert.match(template,/u6MarkerRoleAssignments/);assert.match(template,/scope: u6Container/);
  assert.match(template,/u8MarkerRoleAssignments/);assert.match(template,/scope: u8Container/);
  assert.match(template,/roleDefinitionId: subscriptionResourceId\('Microsoft\.Authorization\/roleDefinitions', blobContributorRoleId\)/);
  assert.equal((template.match(/conditionVersion: '2\.0'/g)||[]).length,2);
  assert.match(template,/spec\.role == 'source' \|\| spec\.role == 'cleanup'/);
  assert.match(template,/@Request\[Microsoft\.Authorization\/roleAssignments:PrincipalId\]/);
  assert.match(template,/@Resource\[Microsoft\.Authorization\/roleAssignments:PrincipalId\]/);
  assert.ok(docs.includes('Probe UAIs get no direct Blob role.'));
});

test('deployment guidance binds specs to the frozen schedule digest and uses what-if only',()=>{
  assert.ok(docs.includes('fails on mismatch'));
  assert.ok(docs.includes('az deployment group what-if'));
  assert.ok(docs.includes('has **not** been deployed'));
});
