import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateP3Network} from './validate-p3-network.mjs';

test('requires distinct controlled addresses and a private research path',()=>{
  const config={researchIp:'10.48.9.4',fixtureBlobIp:'10.48.4.4',collectorIp:'192.0.2.1',researchPort:443};
  assert.match(validateP3Network(config).status,/unverified/);
  assert.throws(()=>validateP3Network({...config,collectorIp:config.fixtureBlobIp}),/distinct/);
  assert.throws(()=>validateP3Network({...config,researchIp:'0.0.0.0'}),/invalid/);
  assert.throws(()=>validateP3Network({...config,researchPort:0}),/port/);
});
