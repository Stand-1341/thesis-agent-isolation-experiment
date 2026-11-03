import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const template=await readFile(new URL('../infra/vm-route.bicep',import.meta.url),'utf8');

test('VM route uses a dedicated profile UAI and preserves the separate host identity',()=>{
  assert.match(template,/@allowed\(\[\s*'P1'\s*'P2'\s*'P3'/);
  assert.match(template,/resource workloadIdentity .* existing/);
  assert.match(template,/type: 'SystemAssigned, UserAssigned'/);
  assert.match(template,/workloadIdentity\.properties\.principalId/);
  assert.match(template,/workloadIdentity\.properties\.clientId/);
  assert.match(template,/networkIsolationValidated: 'false'/);
});

test('VM route requires explicit controller/operator CIDRs and denies other ingress',()=>{
  assert.match(template,/param subnetId string/);
  assert.match(template,/param controllerSourcePrefixes array/);
  assert.match(template,/param operatorSourcePrefixes array/);
  assert.match(template,/sourceAddressPrefixes: controllerSourcePrefixes/);
  assert.match(template,/name: 'controller-https'/);
  assert.match(template,/name: 'operator-ssh'/);
  assert.match(template,/name: 'deny-other-inbound'/);
  assert.match(template,/dedicated VM subnet/);
  assert.match(template,/does not provision/);
  assert.match(template,/P3 egress enforcement/);
});

test('VM route is private-only and explicitly disclaims egress isolation',()=>{
  assert.doesNotMatch(template,/Microsoft\.Network\/publicIPAddresses/);
  assert.match(template,/reviewed egress policy/);
  assert.match(template,/networkIsolationValidated: 'false'/);
});
