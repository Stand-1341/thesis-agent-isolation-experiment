import assert from 'node:assert/strict';
import test from 'node:test';

import {createAzureInventoryClient} from './azure-inventory-client.mjs';

const SUBSCRIPTION='01234567-89ab-cdef-0123-456789abcdef';
const TOKEN='synthetic-inventory-bearer-token';
const SCOPE='https://management.azure.com/.default';

function response(status,body,headers={}) {
  return {status,ok:status>=200&&status<300,headers:{get:name=>headers[name]??null},json:async()=>body};
}
function clientWith(fetchImpl) {
  const calls=[],scopes=[];
  const client=createAzureInventoryClient({
    getToken:async scope=>{scopes.push(scope);return TOKEN;},
    fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return fetchImpl(url,options);},
    requestTimeoutMs:5000
  });
  return {client,calls,scopes};
}

test('lists visible subscriptions through ARM and returns only inventory-safe fields',async()=>{
  const {client,calls,scopes}=clientWith(async()=>response(200,{value:[
    {subscriptionId:SUBSCRIPTION,displayName:'Research subscription',state:'Enabled',tenantId:'hidden',authorizationSource:'RoleBased'},
    {subscriptionId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',displayName:'Disabled',state:'Disabled',secret:'do not copy'}
  ]}));
  const result=await client.listSubscriptions();
  assert.equal(new URL(calls[0].url).origin,'https://management.azure.com');
  assert.equal(new URL(calls[0].url).pathname,'/subscriptions');
  assert.equal(new URL(calls[0].url).searchParams.get('api-version'),'2022-12-01');
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.headers.Authorization,`Bearer ${TOKEN}`);
  assert.deepEqual(scopes,[SCOPE]);
  assert.deepEqual(result,[
    {subscriptionId:SUBSCRIPTION,displayName:'Research subscription',state:'Enabled'},
    {subscriptionId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',displayName:'Disabled',state:'Disabled'}
  ]);
});

test('lists only relevant resource metadata and follows a trusted ARM continuation link',async()=>{
  const {client,calls}=clientWith(async url=>{
    if(new URL(url).searchParams.has('$skiptoken')) return response(200,{value:[{
      id:`/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-b/providers/Microsoft.Network/azureFirewalls/fw-a`,name:'fw-a',type:'Microsoft.Network/azureFirewalls',location:'eastus',properties:{secret:'omit'}}]
    });
    return response(200,{
      value:[
        {id:`/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a`,name:'vm-a',type:'Microsoft.Compute/virtualMachines',location:'eastus',tags:{secret:'omit'},properties:{adminPassword:'omit'}},
        {id:`/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-a/providers/Microsoft.App/sandboxGroups/sbx-a`,name:'sbx-a',type:'Microsoft.App/sandboxGroups',location:'eastus',properties:{provisioningState:'Succeeded'}},
        {id:`/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-a/providers/Microsoft.KeyVault/vaults/kv-a`,name:'kv-a',type:'Microsoft.KeyVault/vaults',location:'eastus',properties:{secret:'omit'}},
        {id:`/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-a/providers/Microsoft.Web/sites/site-a`,name:'site-a',type:'Microsoft.Web/sites',location:'eastus',properties:{state:'Stopped'}}
      ],nextLink:'https://management.azure.com/subscriptions/'+SUBSCRIPTION+'/resources?$skiptoken=next'
    });
  });
  const resources=await client.listRelevantResources(SUBSCRIPTION);
  assert.equal(calls.length,2);
  assert.deepEqual(resources.map(x=>x.type),[
    'Microsoft.Compute/virtualMachines','Microsoft.App/sandboxGroups','Microsoft.Network/azureFirewalls'
  ]);
  assert.equal(resources[0].resourceGroup,'rg-a');
  assert.equal(Object.hasOwn(resources[0],'properties'),false);
  assert.equal(Object.hasOwn(resources[0],'tags'),false);
});

test('rejects an untrusted ARM continuation link before forwarding a bearer token',async()=>{
  const {client,calls}=clientWith(async()=>response(200,{value:[],nextLink:'https://attacker.invalid/steal'}));
  await assert.rejects(client.listRelevantResources(SUBSCRIPTION),/untrusted continuation link/);
  assert.equal(calls.length,1);
});

test('reads Microsoft.App and Microsoft.Compute regional usage without assuming a quota value',async()=>{
  const {client,calls}=clientWith(async()=>response(200,{value:[
    {name:{value:'SandboxCores',localizedValue:'Sandbox cores'},currentValue:4,limit:300,unit:'Count',extra:'omit'}
  ]}));
  const app=await client.listRegionalUsages(SUBSCRIPTION,'eastus','Microsoft.App');
  const compute=await client.listRegionalUsages(SUBSCRIPTION,'eastus','Microsoft.Compute');
  const urls=calls.map(call=>new URL(call.url));
  assert.equal(urls[0].pathname,`/subscriptions/${SUBSCRIPTION}/providers/Microsoft.App/locations/eastus/usages`);
  assert.equal(urls[0].searchParams.get('api-version'),'2024-03-01');
  assert.equal(urls[1].pathname,`/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Compute/locations/eastus/usages`);
  assert.equal(urls[1].searchParams.get('api-version'),'2024-07-01');
  assert.deepEqual(app,[{name:{value:'SandboxCores',localizedValue:'Sandbox cores'},currentValue:4,limit:300,unit:'Count'}]);
  assert.deepEqual(compute,app);
});

test('sanitizes ARM errors and never includes response text or bearer material',async()=>{
  const {client}=clientWith(async()=>response(403,{error:{code:'AuthorizationFailed',message:`Bearer ${TOKEN} private text`}}));
  await assert.rejects(client.listSubscriptions(),error=>{
    assert.equal(error.status,403);
    assert.match(error.message,/403.*AuthorizationFailed/);
    assert.doesNotMatch(error.message,new RegExp(TOKEN));
    assert.doesNotMatch(error.message,/private text/);
    return true;
  });
});

test('refuses malformed ARM list responses rather than claiming an empty inventory',async()=>{
  const {client}=clientWith(async()=>response(200,{notAList:[]}));
  await assert.rejects(client.listSubscriptions(),/list response is missing a value array/);
});

test('reads allowlisted provider registration state through ARM GET and omits provider metadata',async()=>{
  const {client,calls}=clientWith(async()=>response(200,{namespace:'Microsoft.App',registrationState:'Registered',
    resourceTypes:[{resourceType:'jobs'}],authorizationConsentState:'Consented'}));
  const result=await client.getProviderRegistration(SUBSCRIPTION,'Microsoft.App');
  const url=new URL(calls[0].url);
  assert.equal(url.pathname,`/subscriptions/${SUBSCRIPTION}/providers/Microsoft.App`);
  assert.equal(url.searchParams.get('api-version'),'2021-04-01');
  assert.equal(calls[0].options.method,'GET');
  assert.deepEqual(result,{namespace:'Microsoft.App',registrationState:'Registered'});
  await assert.rejects(client.getProviderRegistration(SUBSCRIPTION,'Microsoft.Untrusted'),{name:'TypeError'});
  assert.equal(calls.length,1,'unknown namespaces must be rejected before a request');
});

test('rejects invalid subscription, region, and inherited provider names before a request or token',async()=>{
  const {client,calls,scopes}=clientWith(async()=>response(200,{value:[]}));
  await assert.rejects(client.listRelevantResources('not-a-guid'),{name:'TypeError'});
  await assert.rejects(client.listRegionalUsages(SUBSCRIPTION,'../eastus','Microsoft.App'),{name:'TypeError'});
  for(const provider of ['Microsoft.KeyVault','constructor','toString','__proto__'])
    await assert.rejects(client.listRegionalUsages(SUBSCRIPTION,'eastus',provider),{name:'TypeError'});
  assert.equal(calls.length,0);
  assert.equal(scopes.length,0);
});
