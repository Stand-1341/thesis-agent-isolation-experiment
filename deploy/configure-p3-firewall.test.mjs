import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFunctionsFirewallRuleGroups,configureP3Firewall} from './configure-p3-firewall.mjs';

const base={namePrefix:'study',vaultName:'study-vault',storageSuffix:'core.windows.net',
  collectorPrivateIp:'10.48.9.5',restrictedServicePrivateIp:'10.48.9.6'};

test('Functions P3 firewall groups contain exact platform allows and named receiver denies',()=>{
  const groups=buildFunctionsFirewallRuleGroups(base);
  assert.deepEqual(groups.map(group=>[group.name,group.priority]),[
    ['required-functions-p3-egress',150],['functions-p3-denied-receivers',180]
  ]);
  assert.deepEqual(groups[0].properties.ruleCollections[0].rules[0].targetFqdns,[
    'studyfnp3.blob.core.windows.net','studyfnp3.queue.core.windows.net','studyfnp3.table.core.windows.net',
    'login.microsoftonline.com','login.microsoft.com','study-vault.vault.azure.net'
  ]);
  assert.deepEqual(groups[1].properties.ruleCollections[0].rules.map(rule=>[rule.name,rule.destinationAddresses]),
    [['functions-p3-deny-collector',['10.48.9.5']],['functions-p3-deny-restricted-service',['10.48.9.6']]]);
});

test('Functions P3 firewall skips when the deployment has no Functions P3 route',async()=>{
  let called=false;
  const code=await configureP3Firewall({env:{AZURE_ENV_NAME:'test'},outputs:{experimentConfigRoutes:{}},az:async()=>{called=true;},stdout:{write:()=>{}},stderr:{write:()=>{}}});
  assert.equal(code,0);
  assert.equal(called,false);
});

test('Functions P3 firewall PUTs both idempotent rule groups',async()=>{
  const calls=[];
  const outputs={experimentConfigRoutes:{azure_functions_flex:{P3:{resourceId:'/fn-p3'}}},workloadTokenVaultName:'study-vault',
    fixtureBlobEndpoint:'https://studyfx.blob.core.windows.net',collectorPrivateIp:'10.48.9.5',restrictedServicePrivateIp:'10.48.9.6'};
  const code=await configureP3Firewall({env:{AZURE_ENV_NAME:'firewall-test',AZURE_SUBSCRIPTION_ID:'11111111-1111-4111-8111-111111111111',
    AZURE_NAME_PREFIX:'study',AZURE_RESOURCE_GROUP:'rg'},outputs,stdout:{write:()=>{}},stderr:{write:()=>{}},
    az:async args=>{calls.push(args);return {};}});
  assert.equal(code,0);
  assert.equal(calls.length,2);
  assert.ok(calls.every(args=>args.includes('rest')&&args.includes('put')));
  assert.match(calls[0].join(' '),/required-functions-p3-egress/);
  assert.match(calls[1].join(' '),/functions-p3-denied-receivers/);
});
