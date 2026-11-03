import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateResearchHostNetwork} from './validate-research-host-network.mjs';
test('research host source networks require non-overlapping explicit private CIDRs',()=>{
 const input={workloadSourcePrefixes:['10.48.0.0/24','10.48.5.0/24'],operatorSourcePrefixes:['10.49.0.0/24']};
 assert.match(validateResearchHostNetwork(input).status,/unverified/);
 assert.throws(()=>validateResearchHostNetwork({...input,operatorSourcePrefixes:['10.48.0.128/25']}),/overlap/);
 assert.throws(()=>validateResearchHostNetwork({...input,operatorSourcePrefixes:['0.0.0.0/0']}),/invalid/);
 assert.throws(()=>validateResearchHostNetwork({...input,operatorSourcePrefixes:['10.49.0.1/24']}),/network address/);
 assert.throws(()=>validateResearchHostNetwork({...input,operatorSourcePrefixes:['172.16.0.0/15']}),/invalid/);
});
