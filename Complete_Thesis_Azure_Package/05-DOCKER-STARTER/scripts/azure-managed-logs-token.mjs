import {ManagedIdentityCredential} from '@azure/identity';

const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scope='https://api.loganalytics.io/.default';

/** Audit-host managed identity only; never fall back to controller credentials. */
export function createManagedLogsTokenProvider({clientId,createCredential}={}) {
  if(!guid.test(clientId || '')) throw new Error('audit managed identity client ID required');
  const credential=createCredential ? createCredential(clientId) : new ManagedIdentityCredential({clientId});
  if(!credential || typeof credential.getToken!=='function') throw new Error('invalid managed identity credential');
  return async function getToken() {
    let result;
    try { result=await credential.getToken(scope); } catch { throw new Error('managed audit identity unavailable'); }
    if(typeof result?.token!=='string' || !result.token || /[\r\n]/.test(result.token)) throw new Error('managed audit identity returned no token');
    return result.token;
  };
}
