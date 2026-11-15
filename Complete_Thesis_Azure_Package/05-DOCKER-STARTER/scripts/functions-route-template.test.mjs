import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../infra/functions-route.bicep',import.meta.url),'utf8');

test('Functions route template separates Flex host identity, workload UAI, and Key Vault reader',()=>{
  assert.match(source,/resource workloadIdentity '[^']+' existing/);
  assert.match(source,/resource secretReaderIdentity '[^']+' existing/);
  assert.match(source,/type:\s*'SystemAssigned, UserAssigned'/);
  assert.match(source,/userAssignedIdentities:\s*\{\s*'\$\{workloadIdentity\.id\}':\s*\{\}\s*'\$\{secretReaderIdentity\.id\}':\s*\{\}\s*\}/);
  assert.match(source,/name:\s*'AZURE_CLIENT_ID',[\s\S]*?value:\s*workloadIdentity\.properties\.clientId/);
  assert.match(source,/keyVaultReferenceIdentity:\s*secretReaderIdentity\.id/);
  assert.match(source,/principalId:\s*app\.identity\.principalId/);
  assert.match(source,/output workloadPrincipalId string = workloadIdentity\.properties\.principalId/);
});

test('Functions route template constrains supported profiles and disclaims isolation proof',()=>{
  assert.match(source,/@allowed\(\[[\s\S]*?'P1'[\s\S]*?'P2'[\s\S]*?'P3'[\s\S]*?\]\)\s*param profile string/);
  assert.match(source,/Network isolation is not asserted by this template/);
  assert.match(source,/experimentProfile: profile/);
});
