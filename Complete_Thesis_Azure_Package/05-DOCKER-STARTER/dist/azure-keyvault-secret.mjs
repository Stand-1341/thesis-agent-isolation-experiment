import {ManagedIdentityCredential} from '@azure/identity';

const KEY_VAULT_SCOPE='https://vault.azure.net/.default';
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_NAME=/^[A-Za-z0-9-]{1,127}$/;
const SECRET_VERSION=/^[A-Za-z0-9-]{1,128}$/;
const VAULT_HOST=/^[a-z0-9-]{3,24}\.vault\.azure\.net$/i;

function validateSecretUri(value) {
  let url;
  try {url=new URL(value);} catch {throw new Error('workload-token secret URI is invalid');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||!VAULT_HOST.test(url.hostname))
    throw new Error('workload-token secret URI must be an HTTPS Azure Key Vault secret URL without query or fragment');
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length<2||parts.length>3||parts[0]!=='secrets'||!SECRET_NAME.test(decodeURIComponent(parts[1]))||
    (parts.length===3&&!SECRET_VERSION.test(decodeURIComponent(parts[2]))))
    throw new Error('workload-token secret URI must identify a Key Vault secret');
  return url;
}

/** Read one named/versioned Key Vault secret using managed identity only; never Azure CLI or developer credentials. */
export function createManagedKeyVaultSecretReader({clientId,createCredential,fetchImpl=fetch,apiVersion='7.4',timeoutMs=15000}={}) {
  if(clientId!==undefined&&(!GUID.test(clientId)||/[\r\n]/.test(clientId))) throw new Error('invalid Key Vault identity client ID');
  if(typeof fetchImpl!=='function') throw new Error('fetch implementation is required');
  if(typeof apiVersion!=='string'||!/^[0-9]{1,2}\.[0-9]{1,2}$/.test(apiVersion)) throw new Error('invalid Key Vault API version');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000) throw new Error('invalid Key Vault request timeout');
  let credential;
  try {credential=createCredential?createCredential(clientId):new ManagedIdentityCredential(clientId?{clientId}:undefined);} catch {
    throw new Error('managed Key Vault identity unavailable');
  }
  if(!credential||typeof credential.getToken!=='function') throw new Error('invalid managed Key Vault credential');

  return async function readSecret(secretUri) {
    const url=validateSecretUri(secretUri);
    let token;
    try {
      const result=await credential.getToken(KEY_VAULT_SCOPE);
      token=result?.token;
    } catch {throw new Error('managed Key Vault token unavailable');}
    if(typeof token!=='string'||!token||/[\r\n]/.test(token)) throw new Error('managed Key Vault token unavailable');
    url.searchParams.set('api-version',apiVersion);
    let response;
    try {
      response=await fetchImpl(url.toString(),{method:'GET',redirect:'error',
        headers:{authorization:`Bearer ${token}`,accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)});
    } catch {throw new Error('managed Key Vault request failed');}
    if(!response||!Number.isInteger(response.status)||response.status<200||response.status>=300)
      throw new Error(`managed Key Vault secret read failed: HTTP ${Number.isInteger(response?.status)?response.status:0}`);
    let body;
    try {body=await response.json();} catch {throw new Error('managed Key Vault secret response was invalid');}
    if(typeof body?.value!=='string'||!body.value||/[\r\n]/.test(body.value))
      throw new Error('managed Key Vault returned an invalid secret value');
    return body.value;
  };
}
