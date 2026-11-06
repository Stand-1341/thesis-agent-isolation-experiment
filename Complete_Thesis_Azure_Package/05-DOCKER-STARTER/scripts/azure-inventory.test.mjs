import assert from 'node:assert/strict';
import test from 'node:test';
import {AuthenticationError,ChainedTokenCredential,CredentialUnavailableError} from '@azure/identity';

import {collectAzureInventory,createAzureRestTokenProvider,INVENTORY_RESOURCE_PROVIDERS,main,parseInventoryArgs} from './azure-inventory.mjs';

const SUBSCRIPTION='01234567-89ab-cdef-0123-456789abcdef';
const token=async()=> 'synthetic-arm-token';

function fakeClientFetch(url) {
  const parsed=new URL(url);
  if(parsed.pathname==='/subscriptions') return {value:[{subscriptionId:SUBSCRIPTION,displayName:'Research',state:'Enabled'}]};
  if(parsed.pathname===`/subscriptions/${SUBSCRIPTION}/resources`) return {value:[
    {id:`/subscriptions/${SUBSCRIPTION}/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a`,name:'vm-a',type:'Microsoft.Compute/virtualMachines',location:'eastus'}
  ]};
  if(parsed.pathname.endsWith('/usages')) return {value:[{name:{value:'QuotaA',localizedValue:'Quota A'},currentValue:2,limit:15,unit:'Count'}]};
  const provider=parsed.pathname.match(new RegExp(`^/subscriptions/${SUBSCRIPTION}/providers/([^/]+)$`));
  if(provider) return {namespace:provider[1],registrationState:provider[1]==='Microsoft.App'?'Registered':'NotRegistered'};
  throw new Error(`unexpected test URL: ${parsed.pathname}`);
}
function fakeFetch(bodyFor) {
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),options});
    const body=bodyFor(url,options);
    return {status:200,ok:true,json:async()=>body};
  };
  return {calls,fetchImpl};
}

test('without a selected subscription, inventories only the subscriptions visible to the identity',async()=>{
  const {calls,fetchImpl}=fakeFetch(fakeClientFetch);
  const result=await collectAzureInventory({region:'eastus',getToken:token,fetchImpl});
  assert.equal(result.status,'subscription_selection_required');
  assert.equal(result.azureCliUsed,false);
  assert.deepEqual(result.subscriptions,[{subscriptionId:SUBSCRIPTION,displayName:'Research',state:'Enabled'}]);
  assert.equal(calls.length,1);
});

test('with a subscription and region, returns relevant resources and raw quota values from ARM',async()=>{
  const {calls,fetchImpl}=fakeFetch(fakeClientFetch);
  const result=await collectAzureInventory({subscriptionId:SUBSCRIPTION,region:'eastus',getToken:token,fetchImpl,now:()=>new Date('2026-11-05T12:00:00Z')});
  assert.equal(result.status,'complete');
  assert.equal(result.source,'Azure Resource Manager GET');
  assert.equal(result.azureCliUsed,false);
  assert.equal(result.observedAt,'2026-11-05T12:00:00.000Z');
  assert.equal(result.resources.length,1);
  assert.equal(result.providerRegistration['Microsoft.App'],'Registered');
  assert.equal(result.providerRegistration['Microsoft.Compute'],'NotRegistered');
  assert.equal(Object.keys(result.providerRegistration).length,INVENTORY_RESOURCE_PROVIDERS.length);
  assert.deepEqual(result.regionalUsage['Microsoft.App'],[{name:{value:'QuotaA',localizedValue:'Quota A'},currentValue:2,limit:15,unit:'Count'}]);
  assert.deepEqual(result.regionalUsage['Microsoft.Compute'],result.regionalUsage['Microsoft.App']);
  assert.equal(calls.length,3+INVENTORY_RESOURCE_PROVIDERS.length);
});

test('provider-registration authorization failures remain partial/unknown, never NotRegistered',async()=>{
  const fetchImpl=async url=>{
    const parsed=new URL(url);
    if(parsed.pathname===`/subscriptions/${SUBSCRIPTION}/providers/Microsoft.App`)
      return {status:403,json:async()=>({error:{code:'AuthorizationFailed',message:'synthetic-private-detail'}})};
    return {status:200,json:async()=>fakeClientFetch(url)};
  };
  const result=await collectAzureInventory({subscriptionId:SUBSCRIPTION,region:'eastus',getToken:token,fetchImpl});
  assert.equal(result.status,'partial');
  assert.equal(Object.hasOwn(result.providerRegistration,'Microsoft.App'),false);
  assert.deepEqual(result.providerRegistrationErrors['Microsoft.App'],
    {status:'unavailable',httpStatus:403,code:'AuthorizationFailed'});
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private-detail/);
});

test('without a region, returns resources and marks quota as not queried',async()=>{
  const {fetchImpl}=fakeFetch(fakeClientFetch);
  const result=await collectAzureInventory({subscriptionId:SUBSCRIPTION,getToken:token,fetchImpl});
  assert.equal(result.status,'partial');
  assert.equal(result.regionalUsage,null);
  assert.equal(result.region,'not_supplied');
  assert.equal(Object.keys(result.providerRegistration).length,INVENTORY_RESOURCE_PROVIDERS.length);
});

test('identity failures are redacted and report only safe credential-source diagnostics',async()=>{
  let out='';let err='';
  const result=await main({argv:['--subscription',SUBSCRIPTION],env:{AZURE_CLIENT_SECRET:'synthetic-secret'},
    getToken:async()=>{const error=new Error('secret=synthetic-secret');error.name='CredentialUnavailableError';throw error;},
    stdout:{write:text=>{out+=text;}},stderr:{write:text=>{err+=text;}}});
  assert.equal(result,4);
  assert.match(out,/identity_unavailable/);
  assert.doesNotMatch(out+err,/synthetic-secret/);
  const payload=JSON.parse(out);
  assert.equal(payload.azureCliUsed,false);
  assert.deepEqual(payload.identityDiagnostics,{
    environmentCredentialConfigured:false,
    workloadIdentityConfigured:false,
    azureClientIdEnvironmentPresent:false,
    deviceCodeAuthRequested:false,
    managedIdentityEndpointEnvironmentPresent:false,
    credentialErrorName:'CredentialUnavailableError',
    azureCliUsed:false,
    nextStep:'Provide a complete Entra environment/workload identity, set AZURE_DEVICE_CODE_AUTH=1 to sign in interactively as yourself, or run on a host with managed identity. Azure CLI is not used; source flags are presence-only.'
  });
});

test('unrecognized Azure Identity error names and codes are omitted from diagnostics',async()=>{
  const sensitiveName='SyntheticSecretError';
  const sensitiveCode='SyntheticSecret123';
  let out='';let err='';
  const result=await main({argv:['--subscription',SUBSCRIPTION],env:{},
    getToken:async()=>{const error=new Error(sensitiveCode);error.name=sensitiveName;error.code=sensitiveCode;throw error;},
    stdout:{write:text=>{out+=text;}},stderr:{write:text=>{err+=text;}}});
  assert.equal(result,4);
  assert.doesNotMatch(out+err,/SyntheticSecret/);
  const diagnostics=JSON.parse(out).identityDiagnostics;
  assert.equal(Object.hasOwn(diagnostics,'credentialErrorName'),false);
  assert.equal(Object.hasOwn(diagnostics,'credentialErrorCode'),false);
});

test('invalid regions are rejected before token acquisition or any ARM inventory GET',async()=>{
  const {calls,fetchImpl}=fakeFetch(fakeClientFetch);
  let tokenCalls=0;let out='';let err='';
  const result=await main({argv:['--subscription',SUBSCRIPTION,'--region','../eastus'],env:{},
    getToken:async()=>{tokenCalls++;return 'synthetic-arm-token';},fetchImpl,
    stdout:{write:text=>{out+=text;}},stderr:{write:text=>{err+=text;}}});
  assert.equal(result,5);
  assert.equal(tokenCalls,0);
  assert.equal(calls.length,0);
  assert.match(err,/region must be a lowercase Azure region name/);
  assert.doesNotMatch(out+err,/\.\.\/eastus/);
  const second=fakeFetch(fakeClientFetch);
  await assert.rejects(collectAzureInventory({subscriptionId:SUBSCRIPTION,region:'../eastus',getToken:token,fetchImpl:second.fetchImpl}),
    /region must be a lowercase Azure region name/);
  assert.equal(second.calls.length,0);
});

test('unknown argument errors identify the flag without echoing supplied values',async()=>{
  const supplied='synthetic-sensitive-value-123456789';
  let out='';let err='';let tokenCalls=0;
  const result=await main({argv:[`--access-token=${supplied}`],env:{},
    getToken:async()=>{tokenCalls++;return 'synthetic-arm-token';},
    stdout:{write:text=>{out+=text;}},stderr:{write:text=>{err+=text;}}});
  assert.equal(result,5);
  assert.equal(tokenCalls,0);
  assert.match(err,/unknown argument: --access-token/);
  assert.doesNotMatch(out+err,/synthetic-sensitive-value-123456789/);
});

test('an ARM error code that echoes the bearer token is redacted from output JSON',async()=>{
  const bearer='synthetic-inventory-bearer-token';
  let out='';let err='';
  const result=await main({argv:[],env:{},getToken:async()=>bearer,
    fetchImpl:async()=>({status:403,json:async()=>({error:{code:bearer,message:`private ${bearer}`}})}),
    stdout:{write:text=>{out+=text;}},stderr:{write:text=>{err+=text;}}});
  assert.equal(result,4);
  assert.doesNotMatch(out+err,new RegExp(bearer));
  assert.equal(JSON.parse(out).code,'Unknown');
});

test('token provider uses managed identity without requiring Azure CLI or unconfigured workload identity',async()=>{
  const constructed=[];
  class EnvironmentCredential {constructor(){constructed.push('environment');}}
  class WorkloadIdentityCredential {constructor(){constructed.push('workload');}}
  class ManagedIdentityCredential {
    constructor(options){constructed.push(options?.clientId?'managed-user-assigned':'managed-system-assigned');}
    async getToken(scope){return {token:`token-for:${scope}`};}
  }
  class ChainedTokenCredential {
    constructor(...credentials){constructed.push('chain');this.credentials=credentials;}
    async getToken(scope){return await this.credentials[0].getToken(scope);}
  }
  const getToken=await createAzureRestTokenProvider({env:{},credentialModules:{
    EnvironmentCredential,WorkloadIdentityCredential,ManagedIdentityCredential,ChainedTokenCredential
  }});
  assert.deepEqual(constructed,['managed-system-assigned']);
  assert.equal(await getToken('https://management.azure.com/.default'),'token-for:https://management.azure.com/.default');
});

test('token provider adds workload identity only when its required environment is complete',async()=>{
  const constructed=[];
  class EnvironmentCredential {constructor(){constructed.push('environment');}}
  class WorkloadIdentityCredential {
    constructor(options){constructed.push(options?.tokenFilePath==='federated-token'?'workload':'workload-invalid');}
    async getToken(scope){return {token:`workload:${scope}`};}
  }
  class ManagedIdentityCredential {
    constructor(options){constructed.push(options?.clientId?'managed-user-assigned':'managed-system-assigned');}
    async getToken(scope){return {token:`managed:${scope}`};}
  }
  class ChainedTokenCredential {
    constructor(...credentials){constructed.push('chain');this.credentials=credentials;}
    async getToken(scope){return await this.credentials[0].getToken(scope);}
  }
  const getToken=await createAzureRestTokenProvider({env:{AZURE_TENANT_ID:'tenant-id',AZURE_CLIENT_ID:'client-id',
    AZURE_FEDERATED_TOKEN_FILE:'federated-token'},credentialModules:{
    EnvironmentCredential,WorkloadIdentityCredential,ManagedIdentityCredential,ChainedTokenCredential
  }});
  assert.deepEqual(constructed,['workload','managed-user-assigned','chain']);
  assert.equal(await getToken('scope'),'workload:scope');
});

test('token provider constructs and uses EnvironmentCredential when complete environment auth is supplied',async()=>{
  const calls=[];
  class EnvironmentCredential {
    async getToken(scope){calls.push('environment:getToken');return {token:`environment:${scope}`,expiresOnTimestamp:Date.now()+60000};}
  }
  class WorkloadIdentityCredential {async getToken(){throw new Error('workload credential should not be selected');}}
  class ManagedIdentityCredential {
    async getToken(scope){calls.push('managedIdentity:getToken');return {token:`managed:${scope}`,expiresOnTimestamp:Date.now()+60000};}
  }
  const getToken=await createAzureRestTokenProvider({env:{AZURE_TENANT_ID:'synthetic-tenant',AZURE_CLIENT_ID:'synthetic-client',
    AZURE_CLIENT_SECRET:'synthetic-client-secret'},credentialModules:{
    EnvironmentCredential,WorkloadIdentityCredential,ManagedIdentityCredential,ChainedTokenCredential
  }});
  assert.equal(await getToken('scope'),'environment:scope');
  assert.deepEqual(calls,['environment:getToken']);
});

test('terminal environment credential failure may skip managed identity and diagnostics do not claim an attempt',async()=>{
  const attempts=[];
  class EnvironmentCredential {
    async getToken(){attempts.push('environment');throw new AuthenticationError('synthetic-private-detail');}
  }
  class WorkloadIdentityCredential {async getToken(){attempts.push('workload');throw new Error('workload credential should not be selected');}}
  class ManagedIdentityCredential {
    async getToken(scope){attempts.push('managed-identity');return {token:`managed:${scope}`,expiresOnTimestamp:Date.now()+60000};}
  }
  const env={AZURE_TENANT_ID:'synthetic-tenant',AZURE_CLIENT_ID:'synthetic-client',AZURE_CLIENT_SECRET:'synthetic-client-secret'};
  const getToken=await createAzureRestTokenProvider({env,credentialModules:{
    EnvironmentCredential,WorkloadIdentityCredential,ManagedIdentityCredential,ChainedTokenCredential
  }});
  let out='';let err='';
  const result=await main({argv:[],env,getToken,
    stdout:{write:text=>{out+=text;}},stderr:{write:text=>{err+=text;}}});
  assert.equal(result,4);
  assert.deepEqual(attempts,['environment']);
  assert.doesNotMatch(out+err,/synthetic-private-detail|synthetic-client-secret/);
  const diagnostics=JSON.parse(out).identityDiagnostics;
  assert.equal(diagnostics.environmentCredentialConfigured,true);
  assert.equal(diagnostics.azureClientIdEnvironmentPresent,true);
  assert.equal(Object.hasOwn(diagnostics,'managedIdentityCredentialInChain'),false);
  assert.equal(Object.hasOwn(diagnostics,'managedIdentityAttempted'),false);
  assert.equal(diagnostics.credentialErrorName,'AuthenticationError');
});

test('null getToken uses the default identity chain and reports its managed identity membership',async()=>{
  let managedIdentityCalls=0;let armCalls=0;let out='';let err='';
  class ManagedIdentityCredential {
    async getToken(){managedIdentityCalls++;throw new CredentialUnavailableError('synthetic no identity');}
  }
  const result=await main({argv:['--subscription',SUBSCRIPTION],env:{},getToken:null,
    credentialModules:{EnvironmentCredential:class {},WorkloadIdentityCredential:class {},ManagedIdentityCredential},
    fetchImpl:async()=>{armCalls++;throw new Error('ARM must not be queried without a token');},
    stdout:{write:text=>{out+=text;}},stderr:{write:text=>{err+=text;}}});
  assert.equal(result,4);
  assert.equal(managedIdentityCalls,1);
  assert.equal(armCalls,0);
  assert.equal(JSON.parse(out).identityDiagnostics.managedIdentityCredentialInChain,true);
  assert.doesNotMatch(out+err,/synthetic no identity/);
});

test('argument parser keeps subscription and region explicit and rejects unknown switches',()=>{
  assert.deepEqual(parseInventoryArgs(['--subscription',SUBSCRIPTION,'--region','eastus']),
    {subscriptionId:SUBSCRIPTION,region:'eastus',help:false});
  assert.equal(parseInventoryArgs(['--help']).help,true);
  assert.throws(()=>parseInventoryArgs(['--deploy']),/unknown argument/);
});

test('device code sign-in is never constructed unless it is explicitly requested',async()=>{
  const constructed=[];
  class EnvironmentCredential {async getToken(scope){return {token:`environment:${scope}`};}}
  class WorkloadIdentityCredential {async getToken(scope){return {token:`workload:${scope}`};}}
  class ManagedIdentityCredential {
    constructor(){constructed.push('managed');}
    async getToken(scope){return {token:`managed:${scope}`};}
  }
  class DeviceCodeCredential {
    constructor(){constructed.push('device-code');}
    async getToken(scope){return {token:`device:${scope}`};}
  }
  class ChainedTokenCredential {
    constructor(...credentials){this.credentials=credentials;}
    async getToken(scope){return await this.credentials[0].getToken(scope);}
  }
  const modules={EnvironmentCredential,WorkloadIdentityCredential,ManagedIdentityCredential,DeviceCodeCredential,ChainedTokenCredential};
  const bare=await createAzureRestTokenProvider({env:{},credentialModules:modules});
  assert.equal(await bare('scope'),'managed:scope');
  assert.deepEqual(constructed,['managed']);
  const withSecret=await createAzureRestTokenProvider({env:{AZURE_TENANT_ID:'t',AZURE_CLIENT_ID:'c',
    AZURE_CLIENT_SECRET:'synthetic-secret'},credentialModules:modules});
  assert.equal(await withSecret('scope'),'environment:scope');
  assert.deepEqual(constructed,['managed','managed']);
});

test('device code sign-in requires an explicit opt-in and routes its notice to stderr only',async()=>{
  const {fetchImpl}=fakeFetch(fakeClientFetch);
  const prompted=[];let out='';let err='';
  class DeviceCodeCredential {
    constructor(options){this.userPromptCallback=options.userPromptCallback;}
    async getToken(scope){
      this.userPromptCallback({userCode:'ABCD-EFGH',verificationUri:'https://microsoft.com/devicelogin'});
      return {token:`device:${scope}`,expiresOnTimestamp:Date.now()+60000};
    }
  }
  class ManagedIdentityCredential {async getToken(){throw new CredentialUnavailableError('no managed identity');}}
  class ChainedTokenCredential {
    constructor(...credentials){this.credentials=credentials;}
    async getToken(scope){return await this.credentials[0].getToken(scope);}
  }
  const result=await main({argv:[],env:{AZURE_DEVICE_CODE_AUTH:'1'},getToken:null,
    credentialModules:{EnvironmentCredential:class {},WorkloadIdentityCredential:class {},
      ManagedIdentityCredential,DeviceCodeCredential,ChainedTokenCredential},
    fetchImpl,
    stdout:{write:text=>{out+=text;}},stderr:{write:text=>{err+=text;}}});
  assert.equal(result,2);
  assert.equal(JSON.parse(out).status,'subscription_selection_required');
  assert.match(err,/https:\/\/microsoft\.com\/devicelogin/);
  assert.match(err,/ABCD-EFGH/);
  assert.doesNotMatch(out,/microsoft\.com\/devicelogin|ABCD-EFGH/);
  prompted.push(...err.split('\n'));
});

test('device code diagnostics report the request without claiming a token was acquired',async()=>{
  let out='';
  class ManagedIdentityCredential {async getToken(){throw new CredentialUnavailableError('no managed identity');}}
  class DeviceCodeCredential {async getToken(){throw new AuthenticationError('user did not complete sign-in');}}
  class ChainedTokenCredential {
    constructor(...credentials){this.credentials=credentials;}
    async getToken(scope){return await this.credentials[0].getToken(scope);}
  }
  const result=await main({argv:['--subscription',SUBSCRIPTION],env:{AZURE_DEVICE_CODE_AUTH:'1'},getToken:null,
    credentialModules:{EnvironmentCredential:class {},WorkloadIdentityCredential:class {},
      ManagedIdentityCredential,DeviceCodeCredential,ChainedTokenCredential},
    fetchImpl:async()=>{throw new Error('ARM must not be queried without a token');},
    stdout:{write:text=>{out+=text;}},stderr:{write:()=>{}}});
  assert.equal(result,4);
  const payload=JSON.parse(out);
  assert.equal(payload.reason,'identity_unavailable');
  assert.equal(payload.identityDiagnostics.deviceCodeAuthRequested,true);
  assert.equal(payload.identityDiagnostics.environmentCredentialConfigured,false);
  assert.doesNotMatch(out,/user did not complete sign-in/);
});
