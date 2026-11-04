/** Measured-run evidence must be stored in a locked Azure Blob container. */
import {createAzureBlobEvidenceStore} from './azure-blob-evidence.mjs';
import {createAzureCliManagementTokenProvider,createAzureCliStorageTokenProvider} from './azure-cli-token.mjs';
import {ManagedIdentityCredential} from '@azure/identity';

const CONTAINER_ID=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/[a-z0-9]{3,24}\/blobServices\/default\/containers\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/i;
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanResourceId(value) {
  if(typeof value!=='string' || !CONTAINER_ID.test(value)) throw new Error('invalid evidence container resource ID');
  return value.replace(/\/$/,'');
}

function retentionDays(value) {
  if(!/^[1-9]\d*$/.test(String(value??''))) throw new Error('approved evidence retention days are required');
  const days=Number(value);
  if(!Number.isSafeInteger(days)) throw new Error('invalid evidence retention days');
  return days;
}

export function assertLockedEvidencePolicy(policy,minimumDays) {
  const properties=policy?.properties??policy;
  const state=properties?.state;
  const days=properties?.immutabilityPeriodSinceCreationInDays;
  if(typeof state!=='string' || state.toLowerCase()!=='locked') throw new Error('evidence immutability policy is not locked');
  if(!Number.isInteger(days) || days<minimumDays) throw new Error('evidence retention is shorter than approved minimum');
  return {state:'Locked',retentionDays:days};
}

function tokenProviders(env) {
  const mode=env.THESIS_TOKEN_PROVIDER_MODE??'azure_cli';
  if(!['azure_cli','managed_identity'].includes(mode)) throw new Error('invalid evidence token provider mode');
  if(mode==='azure_cli') return {getStorageToken:createAzureCliStorageTokenProvider(),getManagementToken:createAzureCliManagementTokenProvider()};
  const clientId=env.THESIS_EVIDENCE_IDENTITY_CLIENT_ID;
  if(!GUID.test(clientId??'')) throw new Error('managed evidence identity client ID is required');
  const credential=new ManagedIdentityCredential({clientId});
  const getToken=async scope=>{
    let result;
    try {result=await credential.getToken(scope);} catch {throw new Error('managed evidence identity token unavailable');}
    if(typeof result?.token!=='string' || !result.token || /[\r\n]/.test(result.token)) throw new Error('managed evidence identity returned no token');
    return result.token;
  };
  return {getStorageToken:()=>getToken('https://storage.azure.com/.default'),getManagementToken:()=>getToken('https://management.azure.com/.default')};
}

export async function createMeasuredEvidenceStoreFromEnvironment({env=process.env,fetchImpl=fetch,providers}={}) {
  if(env.THESIS_EVIDENCE_RETENTION_APPROVED!=='true') throw new Error('institution-approved evidence retention is not asserted');
  const minimumDays=retentionDays(env.THESIS_EVIDENCE_RETENTION_DAYS);
  const containerUrl=env.THESIS_EVIDENCE_BLOB_CONTAINER_URL;
  const resourceId=cleanResourceId(env.THESIS_EVIDENCE_CONTAINER_RESOURCE_ID);
  let parsedContainer;
  try {parsedContainer=new URL(containerUrl);} catch {throw new Error('invalid evidence container URL');}
  const idParts=resourceId.split('/');
  if(parsedContainer.protocol!=='https:' || parsedContainer.hostname!==`${idParts[8]}.blob.core.windows.net` ||
    parsedContainer.pathname!==`/${idParts[12]}` || parsedContainer.port || parsedContainer.username || parsedContainer.password ||
    parsedContainer.search || parsedContainer.hash) throw new Error('evidence container URL does not match its Azure resource ID');
  const tokens=providers??tokenProviders(env);
  if(typeof tokens?.getManagementToken!=='function' || typeof tokens?.getStorageToken!=='function') throw new Error('invalid evidence token providers');
  const managementToken=await tokens.getManagementToken();
  if(typeof managementToken!=='string' || !managementToken || /[\r\n]/.test(managementToken)) throw new Error('Azure management token unavailable');
  const url=`https://management.azure.com${resourceId}/immutabilityPolicies/default?api-version=2025-08-01`;
  let response;
  try {response=await fetchImpl(url,{headers:{authorization:`Bearer ${managementToken}`},redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch {throw new Error('evidence immutability policy could not be read');}
  if(!response.ok) throw new Error('evidence immutability policy could not be read');
  let policy;
  try {policy=await response.json();} catch {throw new Error('evidence immutability policy response is invalid');}
  const verified=assertLockedEvidencePolicy(policy,minimumDays);
  const store=createAzureBlobEvidenceStore({containerUrl,getToken:tokens.getStorageToken});
  return Object.assign(store,{policy:verified});
}

export {cleanResourceId,retentionDays};
