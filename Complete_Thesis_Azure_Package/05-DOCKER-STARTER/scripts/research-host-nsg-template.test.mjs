import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../infra/research-host-pilot.bicep',import.meta.url),'utf8');

test('research host accepts explicit separate research and collector source lists',()=>{
  assert.match(source,/@minLength\(1\)\s*@maxLength\(100\)\s*param researchSourcePrefixes array/);
  assert.match(source,/@minLength\(1\)\s*@maxLength\(100\)\s*param collectorSourcePrefixes array/);
  assert.doesNotMatch(source,/param (?:workloadSourcePrefixes|researchSourcePrefixes|collectorSourcePrefixes) array\s*=/);
  assert.match(source,/name: 'research-https',[\s\S]*?sourceAddressPrefixes: researchSourcePrefixes/);
  assert.match(source,/name: 'collector-https',[\s\S]*?sourceAddressPrefixes: collectorSourcePrefixes/);
  assert.match(source,/Include every active VM, Functions, and session route source subnet, including P1\/P2\/P3/);
  assert.match(source,/Include VM P1\/P2, Functions P1\/P2, and session P1\/P2 subnets\. Exclude every P3 subnet/);
});
