import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateFlexConfig} from './validate-flex-config.mjs';

test('rejects broad ingress and missing or overlapping credentials',()=>{
  const config={controllerIpCidr:'8.8.8.8/32',hostStorageName:'fixture123',researchUrl:'https://research.example',collectorUrl:'https://collector.example',
    fixtureBlobEndpoint:'https://fixture123.blob.core.windows.net/',workloadToken:'a'.repeat(32),trialRequestKey:'b'.repeat(32)};
  assert.match(validateFlexConfig(config).status,/unverified/);
  assert.throws(()=>validateFlexConfig({...config,controllerIpCidr:'0.0.0.0/0'}),/IPv4/);
  assert.throws(()=>validateFlexConfig({...config,controllerIpCidr:'10.0.0.1/32'}),/IPv4/);
  assert.throws(()=>validateFlexConfig({...config,trialRequestKey:config.workloadToken}),/credentials/);
  assert.throws(()=>validateFlexConfig({...config,fixtureBlobEndpoint:'https://attacker.example/'}),/Blob/);
});
