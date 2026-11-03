import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findVnetFlowDenials} from './vnet-flow-observations.mjs';

test('matches only an outbound TCP denial by the expected rule, addresses, port, and time',()=>{
  const target='/subscriptions/example/virtualNetworks/pilot',acl='/subscriptions/example/networkSecurityGroups/p3';
  const query={targetResourceId:target,aclId:acl,ruleName:'deny-other-outbound',sourceIp:'10.48.2.10',destinationIp:'1.1.1.1',destinationPort:443,startMs:1000,endMs:2000};
  const doc={records:[{targetResourceID:target,flowRecords:{flows:[{aclID:acl,flowGroups:[{rule:'deny-other-outbound',flowTuples:[
    '1500,10.48.2.10,1.1.1.1,45000,443,6,O,D,NX',
    '1500,10.48.2.10,1.1.1.1,45000,443,6,O,B,NX',
    '1500,10.48.2.10,1.1.1.1,45000,443,6,I,D,NX',
    '1500,10.48.2.11,1.1.1.1,45000,443,6,O,D,NX',
    '2500,10.48.2.10,1.1.1.1,45000,443,6,O,D,NX'
  ]}]}]}}]};
  const result=findVnetFlowDenials([doc],query);
  assert.equal(result.matches.length,1);
  assert.equal(result.matches[0].state,'Deny');
  assert.match(result.scope,/not_trial_attribution/);
  assert.equal(findVnetFlowDenials([doc],{...query,ruleName:'other'}).matches.length,0);
  assert.equal(findVnetFlowDenials([doc],{...query,aclId:'/other'}).matches.length,0);
  assert.equal(findVnetFlowDenials([doc],{...query,targetResourceId:'/other'}).matches.length,0);
  assert.throws(()=>findVnetFlowDenials([{records:[{targetResourceID:target,flowRecords:{flows:[{aclID:acl,flowGroups:[{rule:query.ruleName,flowTuples:['broken']}]}]}}]}],query),/invalid VNet flow tuple/);
});
