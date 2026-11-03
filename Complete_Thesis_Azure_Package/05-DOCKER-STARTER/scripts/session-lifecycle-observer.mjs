/** Candidate custom-session lifecycle observer. No live Azure validation yet. */
import {createHash} from 'node:crypto';
import {validateCustomSessionEndpoint} from './session-endpoint.mjs';
import {validateSessionControlToken} from './azure-delegated-token.mjs';

export function createSessionLifecycleObserver({managementEndpoint,poolName,region,getAccessToken,expectedPrincipalId,sessionRegistry,timeoutMs=30000}) {
  const endpoint=validateCustomSessionEndpoint(managementEndpoint,{poolName,region});
  if(typeof getAccessToken!=='function' || !sessionRegistry || typeof sessionRegistry.read!=='function' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedPrincipalId || '') ||
    !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid session observer configuration');
  async function lookup(runId) {
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId || '')) throw new Error('invalid run ID');
    const mapping=await sessionRegistry.read(runId);
    if(mapping?.runId!==runId || !['restricted_session_mapping','restricted_diagnostic_session_mapping'].includes(mapping.scope) ||
      !/^[a-f0-9]{48}$/.test(mapping.sessionId || '')) throw new Error('invalid restricted session mapping');
    return mapping.sessionId;
  }
  async function call(action,sessionId) {
    const token=await getAccessToken();
    validateSessionControlToken({token,expectedPrincipalId});
    const url=new URL(`${endpoint.origin}/.management/${action}`);
    url.searchParams.set('identifier',sessionId);
    url.searchParams.set('api-version','2025-02-02-preview');
    return fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  }
  return {
    async observe(runId) {
      const sessionId=await lookup(runId);
      const response=await call('getSession',sessionId);
      const fingerprint=createHash('sha256').update(sessionId).digest('hex');
      if(!response.ok) {
        let error; try {error=await response.json();} catch {throw new Error(`session observation HTTP ${response.status}`);}
        if(response.status===400 && error?.error?.code==='SessionWithIdentifierNotFound')
          return {scope:'candidate_lifecycle_observation',runId,sessionFingerprint:fingerprint,state:'not_found',observedAt:new Date().toISOString()};
        throw new Error(`session observation HTTP ${response.status}`);
      }
      const data=await response.json();
      if(data?.identifier!==sessionId || typeof data.etag!=='string' || !Number.isFinite(Date.parse(data.expiresAt)) ||
        (data.createdAt!==undefined && !Number.isFinite(Date.parse(data.createdAt))) ||
        (data.lastAccessedAt!==undefined && !Number.isFinite(Date.parse(data.lastAccessedAt)))) throw new Error('invalid session observation');
      return {scope:'candidate_lifecycle_observation',runId,sessionFingerprint:fingerprint,state:'present',observedAt:new Date().toISOString(),
        expiresAt:data.expiresAt,...(data.createdAt?{createdAt:data.createdAt}:{}),...(data.lastAccessedAt?{lastAccessedAt:data.lastAccessedAt}:{})};
    },
    async requestStop(runId,{evidenceCollected}={}) {
      if(evidenceCollected!==true) throw new Error('session evidence collection must be complete before stop');
      const sessionId=await lookup(runId);
      const response=await call('stopSession',sessionId);
      if(!response.ok) throw new Error(`session stop HTTP ${response.status}`);
      // The service response may echo the secret session ID; do not read or log it.
      await response.body?.cancel();
      return {scope:'stop_requested_not_confirmed',runId};
    }
  };
}
