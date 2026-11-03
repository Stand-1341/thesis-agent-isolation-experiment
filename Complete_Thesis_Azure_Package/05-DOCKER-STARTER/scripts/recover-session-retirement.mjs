/** Operator-invoked recovery after a controller restart; not live-Azure validated. */
import {createHash} from 'node:crypto';
import {retireSession} from './retire-session.mjs';

export async function recoverSessionRetirement({sessionRegistry,observer,runId,evidenceCollected,waitMs,pollMs}) {
  if(evidenceCollected!==true) throw new Error('session evidence collection must be complete before recovery');
  if(!sessionRegistry || typeof sessionRegistry.read!=='function' || !/^[A-Za-z0-9_-]{1,150}$/.test(runId || '')) throw new Error('invalid recovery configuration');
  const mapping=await sessionRegistry.read(runId);
  if(mapping?.runId!==runId || mapping.scope!=='restricted_session_mapping' || !/^[a-f0-9]{48}$/.test(mapping.sessionId || ''))
    throw new Error('invalid restricted session mapping');
  const expectedFingerprint=createHash('sha256').update(mapping.sessionId).digest('hex');
  return retireSession({observer,runId,expectedFingerprint,...(waitMs===undefined?{}:{waitMs}),...(pollMs===undefined?{}:{pollMs})});
}
