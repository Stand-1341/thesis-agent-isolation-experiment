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
  // Documentation and benchmarking ranges are not routable controller addresses.
  for(const cidr of ['203.0.113.7/32','198.51.100.9/32','192.0.2.44/32','198.18.0.5/32','192.0.0.3/32','192.88.99.2/32'])
    assert.throws(()=>validateFlexConfig({...config,controllerIpCidr:cidr}),/IPv4/,cidr);
});
