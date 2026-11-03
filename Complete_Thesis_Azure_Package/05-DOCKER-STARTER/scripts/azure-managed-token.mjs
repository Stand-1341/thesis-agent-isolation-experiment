import {ManagedIdentityCredential} from '@azure/identity';
const storageScope='https://storage.azure.com/.default';
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Managed identity only. It never falls back to Azure CLI or developer credentials. */
export function createManagedStorageTokenProvider({clientId,createCredential}={}) {
  if(clientId!==undefined && !guid.test(clientId)) throw new Error('invalid managed identity client ID');
  const credential=createCredential ? createCredential(clientId) : new ManagedIdentityCredential(clientId ? {clientId} : undefined);
  if(!credential || typeof credential.getToken!=='function') throw new Error('invalid managed identity credential');
  return async function getToken() {
    let result;
    try {result=await credential.getToken(storageScope);} catch {throw new Error('managed storage identity unavailable');}
    if(typeof result?.token!=='string' || !result.token || /[\r\n]/.test(result.token)) throw new Error('managed storage identity returned no token');
    return result.token;
  };
}
