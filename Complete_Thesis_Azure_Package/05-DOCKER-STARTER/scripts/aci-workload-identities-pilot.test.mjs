import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const identities=await readFile(new URL('../infra/aci-workload-identities-pilot.bicep',import.meta.url),'utf8');
const roles=await readFile(new URL('../infra/aci-p1-blob-roles-pilot.bicep',import.meta.url),'utf8');
const controller=await readFile(new URL('../infra/aci-controller-roles-pilot.bicep',import.meta.url),'utf8');

test('ACI gets distinct P1/P2 identities and P2 remains permissionless',()=>{
  assert.match(identities,/id-thesis-aci-p1/);
  assert.match(identities,/id-thesis-aci-p2/);
  assert.doesNotMatch(identities,/Microsoft\.Authorization\/roleAssignments/);
  assert.match(roles,/workloadIdentityName string = 'id-thesis-aci-p1'/);
});

test('ACI P1 mirrors only the eight VM P1 Blob container scopes',()=>{
  for(const name of ['dummy-credentials','restricted-records','prior-session','restricted-docs','session-a','authorized-docs','session-b','authorized-records'])
    assert.match(roles,new RegExp(`container: '${name}'`));
  assert.equal((roles.match(/container: '/g)||[]).length,8);
  assert.match(roles,/scope: containers\[index\]/);
  assert.match(roles,/principalId: workload\.properties\.principalId/);
  const executable=roles.replace(/\/\/.*$/gm,'');
  assert.doesNotMatch(executable,/Microsoft\.KeyVault|KeyVault|controller|verifier/i);
});

test('controller role template limits identity assignment to explicit ACI UAI names',()=>{
  assert.match(controller,/p1WorkloadIdentityName string/);
  assert.match(controller,/p2WorkloadIdentityName string/);
  assert.match(controller,/containerGroups\/write/);
  assert.match(controller,/containerGroups\/delete/);
  assert.doesNotMatch(controller,/Microsoft\.Authorization\/roleAssignments\/write/);
});
