import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const environmentTemplate=await readFile(new URL('../infra/session-environment-pilot.bicep',import.meta.url),'utf8');
const subnetTemplate=await readFile(new URL('../infra/session-experiment-subnet.bicep',import.meta.url),'utf8');

test('custom session environment includes bounded E16 profile for Azure custom-container pools',()=>{
  assert.match(environmentTemplate,/workloadProfileType: 'Consumption'/);
  assert.match(environmentTemplate,/workloadProfileType: 'E16'/);
  assert.match(environmentTemplate,/param includeE16Profile bool = true/);
  assert.match(environmentTemplate,/includeE16Profile \? \[\{[\s\S]*?workloadProfileType: 'E16'[\s\S]*?\}\] : \[\]/);
  assert.match(environmentTemplate,/minimumCount: sessionE16MinimumCount/);
  assert.match(environmentTemplate,/maximumCount: sessionE16MaximumCount/);
  assert.match(environmentTemplate,/@maxValue\(1\)[\s\S]*?param sessionE16MaximumCount int = 1/);
});

test('new session environment gets a dedicated delegated subnet instead of reusing the legacy one',()=>{
  assert.match(subnetTemplate,/name: 'sessions-experiment'/);
  assert.match(subnetTemplate,/addressPrefix: subnetPrefix/);
  assert.match(subnetTemplate,/serviceName: 'Microsoft\.App\/environments'/);
  assert.doesNotMatch(subnetTemplate,/name: 'sessions-pilot'/);
});
