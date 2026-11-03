/** Candidate trusted fixture session preparation; all cloud behavior needs pilot validation. */
import {createHash,randomBytes} from 'node:crypto';
import {validateCustomSessionEndpoint} from './session-endpoint.mjs';
import {validateSessionControlToken,createDelegatedStorageTokenProvider} from './azure-delegated-token.mjs';
import {sessionSeedRequestId} from './azure-session-seed.mjs';
import {findBlobAuditCandidates} from './blob-audit-observations.mjs';
import {retireSession} from './retire-session.mjs';
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function createSessionFixturePreparer({managementEndpoint,poolName,region,blobEndpoint,blobResourceId,
  controllerToken,getControlToken,controlPrincipalId,getOwnerToken,ownerPrincipalId,sessionRegistry,lifecycleObserver,readAudit,
  waitMs=300000,pollMs=10000,clock=Date.now,wait=pause,timeoutMs=30000}) {
  const endpoint=validateCustomSessionEndpoint(managementEndpoint,{poolName,region});
  const blob=new URL(blobEndpoint);
  if(blob.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(blob.hostname) ||
    blob.port || blob.username || blob.password || blob.pathname!=='/' || blob.search || blob.hash) throw new Error('invalid Blob endpoint');
  if(!guid.test(controlPrincipalId || '') || !guid.test(ownerPrincipalId || '') || controlPrincipalId.toLowerCase()===ownerPrincipalId.toLowerCase() ||
    typeof blobResourceId!=='string' || !blobResourceId.startsWith('/') || typeof controllerToken!=='string' || controllerToken.length<32 ||
    typeof getControlToken!=='function' || typeof getOwnerToken!=='function' || typeof readAudit!=='function' ||
    !sessionRegistry || typeof sessionRegistry.save!=='function' || !lifecycleObserver ||
    typeof lifecycleObserver.observe!=='function' || typeof lifecycleObserver.requestStop!=='function' ||
    !Number.isInteger(waitMs) || waitMs<0 || waitMs>600000 || !Number.isInteger(pollMs) || pollMs<1 || pollMs>60000 ||
    !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid session fixture configuration');
  async function prepare(trial,{kind,marker}) {
    if(trial?.deployment!=='azure_custom_sessions_hyperv') throw new Error('custom-pool fixture cannot establish a session for another deployment');
    const requestId=sessionSeedRequestId(trial?.runId,kind);
    if((trial.scenario==='U6' && kind!=='session-b') || (trial.scenario==='U8' && kind!=='prior-session') ||
      !['U6','U8'].includes(trial.scenario) || typeof marker!=='string' || !/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(marker)) throw new Error('invalid session fixture request');
    const fixtureRunId=`fixture-${createHash('sha256').update(`${trial.runId}:${kind}`).digest('hex')}`;
    const sessionId=randomBytes(24).toString('hex');
    await sessionRegistry.save({runId:fixtureRunId,sessionId,scope:'restricted_session_mapping'});
    const controlToken=await getControlToken(),ownerToken=await getOwnerToken();
    validateSessionControlToken({token:controlToken,expectedPrincipalId:controlPrincipalId});
    createDelegatedStorageTokenProvider({token:ownerToken,expectedPrincipalId:ownerPrincipalId});
    const url=new URL(`${endpoint.origin}/session-seed`);url.searchParams.set('identifier',sessionId);
    const startedAt=new Date(clock()).toISOString();
    const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
      headers:{authorization:`Bearer ${controlToken}`,'x-trial-key':controllerToken,'content-type':'application/json'},
      body:JSON.stringify({runId:trial.runId,kind,marker,azureAccessToken:ownerToken,expectedPrincipalId:ownerPrincipalId})});
    if(!response.ok) throw new Error(`session fixture HTTP ${response.status}`);
    const seed=await response.json(),finishedAt=new Date(clock()).toISOString(),serialized=JSON.stringify(seed);
    if(serialized?.includes(controlToken) || serialized?.includes(ownerToken) || serialized?.includes(sessionId) || serialized?.includes(marker) || serialized?.includes(controllerToken)) throw new Error('session fixture response exposed sensitive content');
    if(seed?.scope!=='fixture_session_seed_observation' || seed.runId!==trial.runId || seed.kind!==kind || seed.requestId!==requestId || seed.status!==201 || !seed.serviceRequestId) throw new Error('invalid session fixture response');
    const start=Date.parse(startedAt),end=Date.parse(finishedAt),deadline=clock()+waitMs;
    let auditRows=[],audit;
    do {
      auditRows=await readAudit({runId:requestId,startMs:Math.max(0,start-10000),endMs:end+10000});
      audit=findBlobAuditCandidates(auditRows,{resourceId:blobResourceId,principalId:ownerPrincipalId,runId:trial.runId,clientRequestId:requestId,
        expectedUrl:`${blob.origin}/${kind}/${trial.runId}.json`,operation:'PutBlob',startMs:Math.max(0,start-10000),endMs:end+10000});
      if(audit.matches.length || clock()>=deadline) break;
      await wait(Math.min(pollMs,Math.max(1,deadline-clock())));
    } while(clock()<=deadline);
    if(audit.matches.length!==1 || audit.matches[0].statusCode!==201) throw new Error('session seed audit missing or ambiguous');
    let lifecycle=await lifecycleObserver.observe(fixtureRunId);
    const fingerprint=createHash('sha256').update(sessionId).digest('hex');
    if(lifecycle?.state!=='present' || lifecycle.sessionFingerprint!==fingerprint) throw new Error('fixture session not independently observed');
    const initialLifecycle=lifecycle;
    let stop;
    if(kind==='prior-session') {
      stop=await retireSession({observer:lifecycleObserver,runId:fixtureRunId,expectedFingerprint:fingerprint,waitMs,pollMs,clock,wait});
      lifecycle=stop.observation;
    }
    return {scope:'session_fixture_preparation',fixtureRunId,seed,initialLifecycle,lifecycle,seedAuditRows:auditRows,...(stop?{stop}:{}),startedAt,finishedAt};
  }
  prepare.cleanup=async(trial,reset)=>{
    if(trial.scenario!=='U6' || !reset?.sessionPreparation) return undefined;
    const preparation=reset.sessionPreparation;
    return retireSession({observer:lifecycleObserver,runId:preparation.fixtureRunId,
      expectedFingerprint:preparation.lifecycle?.sessionFingerprint,waitMs,pollMs,clock,wait});
  };
  return prepare;
}
