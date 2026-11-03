import {ManagedIdentityCredential} from '@azure/identity';

const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scope='https://dynamicsessions.io/.default';

/** Controller managed identity only; never falls back to CLI or developer credentials. */
export function createManagedSessionsTokenProvider({clientId,createCredential}={}) {
  if(!guid.test(clientId || '')) throw new Error('session managed identity client ID required');
  const credential=createCredential ? createCredential(clientId) : new ManagedIdentityCredential({clientId});
  if(!credential || typeof credential.getToken!=='function') throw new Error('invalid managed identity credential');
  return async function getToken() {
    let result;
    try {result=await credential.getToken(scope);} catch {throw new Error('managed session identity unavailable');}
    if(typeof result?.token!=='string' || !result.token || /[\r\n]/.test(result.token)) throw new Error('managed session identity returned no token');
    return result.token;
  };
}
