const ARM_ORIGIN='https://management.azure.com';
const ARM_SCOPE='https://management.azure.com/.default';
const API_VERSIONS={
  subscriptions:'2022-12-01',
  resources:'2021-04-01',
  providers:'2021-04-01',
  'Microsoft.App':'2024-03-01',
  'Microsoft.Compute':'2024-07-01'
};
const REGIONAL_USAGE_API_VERSIONS=new Map([
  ['Microsoft.App',API_VERSIONS['Microsoft.App']],
  ['Microsoft.Compute',API_VERSIONS['Microsoft.Compute']]
]);
export const RESOURCE_PROVIDER_NAMESPACES=Object.freeze([
  'Microsoft.App','Microsoft.Compute','Microsoft.Network','Microsoft.Storage',
  'Microsoft.ManagedIdentity','Microsoft.OperationalInsights','Microsoft.ContainerRegistry',
  'Microsoft.Authorization','Microsoft.KeyVault','Microsoft.Insights'
]);
const SUBSCRIPTION_GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGION=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RELEVANT_TYPES=new Set([
  'microsoft.app/sandboxgroups','microsoft.app/managedenvironments','microsoft.app/jobs','microsoft.app/containerapps',
  'microsoft.compute/virtualmachines','microsoft.network/virtualnetworks','microsoft.network/azurefirewalls',
  'microsoft.network/routetables','microsoft.network/natgateways','microsoft.network/privateendpoints',
  'microsoft.storage/storageaccounts','microsoft.managedidentity/userassignedidentities',
  'microsoft.operationalinsights/workspaces','microsoft.insights/components',
  'microsoft.containerregistry/registries'
]);
const SAFE_IDENTITY_ERROR_NAMES=new Set(['CredentialUnavailableError','AuthenticationRequiredError','AuthenticationError']);
const SAFE_IDENTITY_ERROR_CODES=new Set(['CredentialUnavailable','AuthenticationRequired','AuthenticationFailed',
  'ETIMEDOUT','ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH']);
export const safeIdentityErrorName=value=>typeof value==='string'&&SAFE_IDENTITY_ERROR_NAMES.has(value)?value:undefined;
export const safeIdentityErrorCode=value=>typeof value==='string'&&SAFE_IDENTITY_ERROR_CODES.has(value)?value:undefined;
const safeCode=(value,token)=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) return 'Unknown';
  if(typeof token==='string'&&(value===token||(token.length>=8&&(value.includes(token)||token.includes(value))))) return 'Unknown';
  return value;
};

function validateSubscriptionId(value) {
  if(typeof value!=='string'||!SUBSCRIPTION_GUID.test(value)) throw new TypeError('subscriptionId must be a GUID');
  return value;
}
/** Validate lowercase region-slug shape only; ARM remains the authority on region availability. */
export function validateRegion(value) {
  if(typeof value!=='string'||value.length>64||!REGION.test(value)) throw new TypeError('region must be a lowercase Azure region name');
  return value;
}
function validateNextLink(value,prefix) {
  let url;
  try {url=new URL(value);} catch {throw new Error('Azure ARM returned an invalid continuation link');}
    if(url.origin!==ARM_ORIGIN||url.pathname!==prefix)
    throw new Error('Azure ARM returned an untrusted continuation link');
  return url.toString();
}
function resourceGroupFromId(id) {
  const match=/\/resourceGroups\/([^/]+)\//i.exec(id);
  return match?decodeURIComponent(match[1]):undefined;
}
function sanitizeResource(item,subscriptionId) {
  if(!item||typeof item!=='object'||typeof item.id!=='string'||typeof item.type!=='string'||typeof item.name!=='string') return undefined;
  const id=item.id;
  if(!id.toLowerCase().startsWith(`/subscriptions/${subscriptionId.toLowerCase()}/`)) return undefined;
  if(!RELEVANT_TYPES.has(item.type.toLowerCase())) return undefined;
  const skuName=typeof item.sku?.name==='string'?item.sku.name:undefined;
  return {id,name:item.name,type:item.type,location:typeof item.location==='string'?item.location:undefined,
    resourceGroup:resourceGroupFromId(id),...(skuName?{skuName}:{})};
}
function sanitizeUsage(item) {
  if(!item||typeof item!=='object') return undefined;
  const name=item.name&&typeof item.name==='object'?{
    ...(typeof item.name.value==='string'?{value:item.name.value}:{}),
    ...(typeof item.name.localizedValue==='string'?{localizedValue:item.name.localizedValue}:{})
  }:undefined;
  return { ...(name?{name}:{}),
    ...(typeof item.currentValue==='number'?{currentValue:item.currentValue}:{}),
    ...(typeof item.limit==='number'?{limit:item.limit}:{}),
    ...(typeof item.unit==='string'?{unit:item.unit}:{})
  };
}

/** Read-only Azure Resource Manager inventory client. It never invokes Azure CLI. */
export function createAzureInventoryClient({getToken,fetchImpl=fetch,requestTimeoutMs=30000}={}) {
  if(typeof getToken!=='function') throw new TypeError('getToken must be a function');
  if(typeof fetchImpl!=='function') throw new TypeError('fetchImpl must be a function');
  if(!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>120000)
    throw new TypeError('requestTimeoutMs must be an integer from 1 to 120000');

  async function getJson(url) {
    let token;
    try {token=await getToken(ARM_SCOPE);} catch(error) {
      const unavailable=new Error('Azure ARM authentication unavailable');
      const identityErrorName=safeIdentityErrorName(error?.name);
      const identityErrorCode=safeIdentityErrorCode(error?.code);
      if(identityErrorName) unavailable.identityErrorName=identityErrorName;
      if(identityErrorCode) unavailable.identityErrorCode=identityErrorCode;
      throw unavailable;
    }
    if(typeof token!=='string'||!token||/[\r\n]/.test(token)) throw new Error('Azure ARM authentication unavailable');
    let response;
    try {
      response=await fetchImpl(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(requestTimeoutMs),
        headers:{Accept:'application/json',Authorization:`Bearer ${token}`}});
    } catch {throw new Error('Azure ARM read failed (network or timeout error)');}
    if(response.status<200||response.status>=300) {
      let code='Unknown';
      try {const body=await response.json();code=safeCode(body?.error?.code??body?.code,token);} catch {}
      const error=new Error(`Azure ARM HTTP ${response.status} (${code})`);
      error.status=response.status;error.code=code;throw error;
    }
    try {return await response.json();} catch {throw new Error('Azure ARM response was not valid JSON');}
  }

  async function listCollection(initialUrl,prefix,project) {
    let url=initialUrl;const items=[];const seen=new Set();
    for(let page=0;page<100;page++) {
      if(seen.has(url)) throw new Error('Azure ARM repeated a continuation link');
      seen.add(url);
      const body=await getJson(url);
      if(!body||typeof body!=='object'||!Array.isArray(body.value))
        throw new Error('Azure ARM list response is missing a value array');
      items.push(...body.value.map(project).filter(Boolean));
      if(typeof body?.nextLink!=='string'||!body.nextLink) return items;
      url=validateNextLink(body.nextLink,prefix);
    }
    throw new Error('Azure ARM inventory exceeded 100 pages');
  }

  async function listSubscriptions() {
    const url=`${ARM_ORIGIN}/subscriptions?api-version=${API_VERSIONS.subscriptions}`;
    const values=await listCollection(url,'/subscriptions',item=>{
      if(typeof item?.subscriptionId!=='string'||!SUBSCRIPTION_GUID.test(item.subscriptionId)) return undefined;
      return {subscriptionId:item.subscriptionId,
        ...(typeof item.displayName==='string'?{displayName:item.displayName}:{}),
        ...(typeof item.state==='string'?{state:item.state}:{})};
    });
    return values;
  }

  async function listRelevantResources(subscriptionId) {
    const id=validateSubscriptionId(subscriptionId);
    const prefix=`/subscriptions/${id}/resources`;
    const url=`${ARM_ORIGIN}${prefix}?api-version=${API_VERSIONS.resources}`;
    return await listCollection(url,prefix,item=>sanitizeResource(item,id));
  }

  async function getProviderRegistration(subscriptionId,provider) {
    const id=validateSubscriptionId(subscriptionId);
    if(!RESOURCE_PROVIDER_NAMESPACES.includes(provider)) throw new TypeError('provider is not in the inventory allowlist');
    const url=`${ARM_ORIGIN}/subscriptions/${id}/providers/${provider}?api-version=${API_VERSIONS.providers}`;
    const body=await getJson(url);
    const registrationState=safeCode(body?.registrationState);
    if(!body||typeof body!=='object'||registrationState==='Unknown')
      throw new Error('Azure ARM provider registration response is malformed');
    return {namespace:provider,registrationState};
  }

  async function listRegionalUsages(subscriptionId,region,provider) {
    const id=validateSubscriptionId(subscriptionId);
    const location=validateRegion(region);
    const apiVersion=REGIONAL_USAGE_API_VERSIONS.get(provider);
    if(!apiVersion) throw new TypeError('provider must be Microsoft.App or Microsoft.Compute');
    const prefix=`/subscriptions/${id}/providers/${provider}/locations/${location}/usages`;
    const url=`${ARM_ORIGIN}${prefix}?api-version=${apiVersion}`;
    return await listCollection(url,prefix,sanitizeUsage);
  }

  return {listSubscriptions,listRelevantResources,getProviderRegistration,listRegionalUsages};
}

export {ARM_SCOPE,API_VERSIONS,RELEVANT_TYPES};
