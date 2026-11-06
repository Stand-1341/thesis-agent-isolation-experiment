import {pathToFileURL} from 'node:url';
import {createAzureInventoryClient,RESOURCE_PROVIDER_NAMESPACES,safeIdentityErrorCode,safeIdentityErrorName,validateRegion} from './azure-inventory-client.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INVENTORY_USAGE_PROVIDERS=['Microsoft.App','Microsoft.Compute'];
export const INVENTORY_RESOURCE_PROVIDERS=RESOURCE_PROVIDER_NAMESPACES;

export function parseInventoryArgs(argv=[]) {
  const result={subscriptionId:undefined,region:undefined,help:false};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--help'||arg==='-h') {result.help=true;continue;}
    if(arg==='--subscription'||arg==='--region') {
      const value=argv[++i];
      if(typeof value!=='string'||!value||value.startsWith('--')) throw new Error(`${arg} requires a value`);
      const key=arg==='--subscription'?'subscriptionId':'region';
      if(result[key]!==undefined) throw new Error(`${arg} may only be supplied once`);
      result[key]=value;
      continue;
    }
    const safeArgument=typeof arg==='string'&&arg.startsWith('--')?arg.split('=',1)[0]:'positional argument';
    const label=/^--[A-Za-z0-9-]+$/.test(safeArgument)?safeArgument:'positional argument';
    throw new Error(`unknown argument: ${label}`);
  }
  if(result.subscriptionId!==undefined&&!GUID.test(result.subscriptionId)) throw new Error('--subscription must be a GUID');
  if(result.region!==undefined) validateRegion(result.region);
  return result;
}

/** Human-readable device-code instructions. Neither the user code nor the URL is secret. */
export function formatDeviceCodeNotice(info) {
  const verificationUri=typeof info?.verificationUri==='string'&&info.verificationUri
    ?info.verificationUri
    :'https://microsoft.com/devicelogin';
  const userCode=typeof info?.userCode==='string'?info.userCode:'(see prompt)';
  return 'Azure device code sign-in required.\n'+
    `  Open: ${verificationUri}\n`+
    `  Enter code: ${userCode}\n`;
}

/** Build an Entra token provider from environment, workload identity, or managed identity only.
 *  Device code sign-in is opt-in (AZURE_DEVICE_CODE_AUTH=1) because it requires a human at a browser. */
export async function createAzureRestTokenProvider({env=process.env,credentialModules,onDeviceCode}={}) {
  const modules=credentialModules??await import('@azure/identity');
  const {ChainedTokenCredential,EnvironmentCredential,WorkloadIdentityCredential,ManagedIdentityCredential,DeviceCodeCredential}=modules;
  const credentials=[];
  const tenantId=env.AZURE_TENANT_ID,clientId=env.AZURE_CLIENT_ID;
  const wantsDeviceCode=env.AZURE_DEVICE_CODE_AUTH==='1';
  if(wantsDeviceCode) {
    if(typeof DeviceCodeCredential!=='function')
      throw new Error('Azure device code authentication is unavailable in this credential set');
    credentials.push(new DeviceCodeCredential({
      userPromptCallback:info=>{(onDeviceCode??(()=>{}))(info);}
    }));
  }
  if(tenantId&&clientId&&env.AZURE_FEDERATED_TOKEN_FILE)
    credentials.push(new WorkloadIdentityCredential({tenantId,clientId,tokenFilePath:env.AZURE_FEDERATED_TOKEN_FILE}));
  if(tenantId&&clientId&&(env.AZURE_CLIENT_SECRET||env.AZURE_CLIENT_CERTIFICATE_PATH))
    credentials.push(new EnvironmentCredential());
  credentials.push(new ManagedIdentityCredential(clientId?{clientId}:undefined));
  const credential=credentials.length===1?credentials[0]:new ChainedTokenCredential(...credentials);
  if(!credential||typeof credential.getToken!=='function') throw new Error('Azure identity provider construction failed');
  return async scope=>{
    const result=await credential.getToken(scope,{abortSignal:AbortSignal.timeout(8000)});
    return result?.token;
  };
}

function sanitizedQuotaFailure(error) {
  return {status:'unavailable',...(Number.isInteger(error?.status)?{httpStatus:error.status}:{}),
    ...(typeof error?.code==='string'?{code:error.code}:{reason:'read_failed'})};
}

function identityDiagnostics(env,error,{managedIdentityCredentialInChain}={}) {
  const present=value=>typeof value==='string'&&value.trim().length>0;
  const tenantAndClient=present(env?.AZURE_TENANT_ID)&&present(env?.AZURE_CLIENT_ID);
  const diagnostics={
    environmentCredentialConfigured:tenantAndClient&&
      (present(env?.AZURE_CLIENT_SECRET)||present(env?.AZURE_CLIENT_CERTIFICATE_PATH)),
    workloadIdentityConfigured:tenantAndClient&&present(env?.AZURE_FEDERATED_TOKEN_FILE),
    ...(typeof managedIdentityCredentialInChain==='boolean'?{managedIdentityCredentialInChain}:{}),
    azureClientIdEnvironmentPresent:present(env?.AZURE_CLIENT_ID),
    deviceCodeAuthRequested:env?.AZURE_DEVICE_CODE_AUTH==='1',
    managedIdentityEndpointEnvironmentPresent:present(env?.IDENTITY_ENDPOINT)||
      present(env?.MSI_ENDPOINT)||present(env?.IMDS_ENDPOINT),
    azureCliUsed:false,
    nextStep:'Provide a complete Entra environment/workload identity, set AZURE_DEVICE_CODE_AUTH=1 to sign in interactively as yourself, or run on a host with managed identity. Azure CLI is not used; source flags are presence-only.'
  };
  for(const [field,value,sanitize] of [
    ['credentialErrorName',error?.identityErrorName,safeIdentityErrorName],
    ['credentialErrorCode',error?.identityErrorCode,safeIdentityErrorCode]
  ]) {
    const safeValue=sanitize(value);
    if(safeValue) diagnostics[field]=safeValue;
  }
  return diagnostics;
}

export async function collectAzureInventory({subscriptionId,region,getToken,fetchImpl=fetch,now=()=>new Date()}={}) {
  if(region!==undefined&&region!==null&&region!=='') validateRegion(region);
  const client=createAzureInventoryClient({getToken,fetchImpl});
  const observedAt=now().toISOString();
  if(!subscriptionId) {
    const subscriptions=await client.listSubscriptions();
    return {status:'subscription_selection_required',source:'Azure Resource Manager GET',azureCliUsed:false,
      observedAt,subscriptions,note:'Select a visible subscription ID; no resources or quotas were queried.'};
  }
  if(!GUID.test(subscriptionId)) throw new TypeError('subscriptionId must be a GUID');
  const resources=await client.listRelevantResources(subscriptionId);
  const providerRegistration={},providerRegistrationErrors={};
  const providerResults=await Promise.allSettled(INVENTORY_RESOURCE_PROVIDERS.map(async provider=>[
    provider,await client.getProviderRegistration(subscriptionId,provider)
  ]));
  for(let index=0;index<providerResults.length;index++) {
    const result=providerResults[index],provider=INVENTORY_RESOURCE_PROVIDERS[index];
    if(result.status==='fulfilled') providerRegistration[provider]=result.value[1].registrationState;
    else providerRegistrationErrors[provider]=sanitizedQuotaFailure(result.reason);
  }
  if(!region) return {status:'partial',source:'Azure Resource Manager GET',azureCliUsed:false,observedAt,
    subscriptionId,region:'not_supplied',resources,providerRegistration,
    ...(Object.keys(providerRegistrationErrors).length?{providerRegistrationErrors}:{}),regionalUsage:null,
    note:'Resource metadata and provider registration were read; regional quota usage was not queried because no region was supplied.'};
  const regionalUsage={},quotaErrors={};
  const results=await Promise.allSettled(INVENTORY_USAGE_PROVIDERS.map(async provider=>[
    provider,await client.listRegionalUsages(subscriptionId,region,provider)
  ]));
  for(let index=0;index<results.length;index++) {
    const result=results[index],provider=INVENTORY_USAGE_PROVIDERS[index];
    if(result.status==='fulfilled') regionalUsage[provider]=result.value[1];
    else quotaErrors[provider]=sanitizedQuotaFailure(result.reason);
  }
  const partial=Object.keys(quotaErrors).length||Object.keys(providerRegistrationErrors).length;
  return {status:partial?'partial':'complete',source:'Azure Resource Manager GET',azureCliUsed:false,
    observedAt,subscriptionId,region,resources,providerRegistration,
    ...(Object.keys(providerRegistrationErrors).length?{providerRegistrationErrors}:{}),
    regionalUsage,...(Object.keys(quotaErrors).length?{quotaErrors}:{})};
}

const USAGE='Read-only Azure inventory using Entra identity and direct ARM GET requests (no Azure CLI).\n'+
  'Usage: node scripts/azure-inventory.mjs [--subscription <GUID>] [--region <azure-region>]\n'+
  'Credentials: EnvironmentCredential, WorkloadIdentityCredential, or ManagedIdentityCredential.\n'+
  'Set AZURE_DEVICE_CODE_AUTH=1 to sign in interactively as yourself; no secret or app registration is used.\n'+
  'If no subscription is supplied, the script lists visible subscriptions only.\n'+
  'With a subscription, it reads resource metadata, provider registration states, and (when a region is supplied) regional usage quotas.\n';

export async function main({argv=process.argv.slice(2),env=process.env,getToken,credentialModules,fetchImpl=fetch,now=()=>new Date(),stdout=process.stdout,stderr=process.stderr}={}) {
  let args;
  try {args=parseInventoryArgs(argv);} catch(error) {
    stderr.write(`${error.message}\n${USAGE}`);
    return 5;
  }
  if(args.help) {stdout.write(USAGE);return 0;}
  const selectedSubscription=args.subscriptionId??env.AZURE_SUBSCRIPTION_ID;
  const selectedRegion=args.region??env.AZURE_REGION;
  if(selectedRegion!==undefined&&selectedRegion!==null&&selectedRegion!=='') {
    try {validateRegion(selectedRegion);} catch(error) {
      stderr.write(`${error.message}`+String.fromCharCode(10)+USAGE);
      return 5;
    }
  }
  const usesDefaultCredentialChain=getToken===undefined||getToken===null;
  try {
    const tokenProvider=getToken??await createAzureRestTokenProvider({env,credentialModules,
      onDeviceCode:info=>{stderr.write(formatDeviceCodeNotice(info));}});
    const result=await collectAzureInventory({subscriptionId:selectedSubscription,region:selectedRegion,
      getToken:tokenProvider,fetchImpl,now});
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.status==='complete'?0:result.status==='partial'||result.status==='subscription_selection_required'?2:4;
  } catch(error) {
    const identityUnavailable=error?.message==='Azure ARM authentication unavailable';
    const payload={status:'unavailable',source:'Azure Resource Manager GET',azureCliUsed:false,
      reason:identityUnavailable?'identity_unavailable':'inventory_read_failed',
      ...(Number.isInteger(error?.status)?{httpStatus:error.status}:{}),
      ...(typeof error?.code==='string'?{code:error.code}:{}),
      ...(identityUnavailable?{identityDiagnostics:identityDiagnostics(env,error,{managedIdentityCredentialInChain:usesDefaultCredentialChain?true:undefined})}:{})};
    stdout.write(`${JSON.stringify(payload)}\n`);
    return 4;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) process.exitCode=await main();
