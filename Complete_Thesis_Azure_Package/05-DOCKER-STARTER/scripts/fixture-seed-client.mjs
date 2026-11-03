/** Controller-side client for a separately protected fixture-owner service. */
import {sessionSeedRequestId} from './azure-session-seed.mjs';
export function createFixtureSeedClient({endpoint,requestKey,timeoutMs=15000}) {
  const url=new URL(endpoint);
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/session-seed' ||
    typeof requestKey!=='string' || requestKey.length<32 || requestKey.length>512 || /[\r\n]/.test(requestKey) ||
    !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid fixture service endpoint or configuration');
  return async function seed({runId,kind,marker}) {
    const expected=sessionSeedRequestId(runId,kind);
    if(typeof marker!=='string' || !/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(marker)) throw new Error('invalid synthetic marker');
    const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
      headers:{'content-type':'application/json','x-fixture-key':requestKey},body:JSON.stringify({runId,kind,marker})});
    if(!response.ok) throw new Error(`fixture service HTTP ${response.status}`);
    const result=await response.json(),serialized=JSON.stringify(result);
    if(serialized?.includes(requestKey) || serialized?.includes(marker) || result?.scope!=='fixture_session_seed_observation' ||
      result.runId!==runId || result.kind!==kind || result.requestId!==expected || result.status!==201 ||
      typeof result.serviceRequestId!=='string' || !/^[A-Za-z0-9-]{1,100}$/.test(result.serviceRequestId) ||
      !/^[a-f0-9]{64}$/.test(result.sessionFingerprint || '')) throw new Error('invalid fixture service response');
    return result;
  };
}
