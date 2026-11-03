/** Candidate VM/Functions fixture preparation. Lifecycle provider and audit provenance require Azure pilot validation. */
import {createHash} from 'node:crypto';
import {sessionSeedRequestId} from './azure-session-seed.mjs';
import {findBlobAuditCandidates} from './blob-audit-observations.mjs';
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function createHostedSessionFixturePreparer({deployment,seed,observe,retire,readAudit,ownerPrincipalId,blobEndpoint,blobResourceId,
  waitMs=300000,pollMs=10000,clock=Date.now,wait=pause}) {
  if(!['azure_vm','azure_functions_flex'].includes(deployment) || ![seed,observe,retire,readAudit,clock,wait].every(f=>typeof f==='function') ||
    !guid.test(ownerPrincipalId || '') || typeof blobResourceId!=='string' || !blobResourceId.startsWith('/') ||
    !Number.isInteger(waitMs) || waitMs<0 || waitMs>600000 || !Number.isInteger(pollMs) || pollMs<1 || pollMs>60000) throw new Error('invalid hosted fixture configuration');
  const blob=new URL(blobEndpoint);
  if(blob.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(blob.hostname) || blob.port || blob.username || blob.password || blob.pathname!=='/' || blob.search || blob.hash) throw new Error('invalid Blob endpoint');
  async function prepare(trial,{kind,marker}) {
    if(trial?.deployment!==deployment || !((trial.scenario==='U6' && kind==='session-b') || (trial.scenario==='U8' && kind==='prior-session')) ||
      typeof marker!=='string' || !/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(marker)) throw new Error('invalid hosted fixture request');
    const requestId=sessionSeedRequestId(trial.runId,kind),fixtureRunId=`fixture-${createHash('sha256').update(`${deployment}:${trial.runId}:${kind}`).digest('hex')}`;
    const initial=await observe({deployment,fixtureRunId});
    if(initial?.scope!=='candidate_hosted_lifecycle' || initial.deployment!==deployment || initial.runId!==fixtureRunId || initial.state!=='present' ||
      !/^[a-f0-9]{64}$/.test(initial.sessionFingerprint || '') || !Number.isFinite(Date.parse(initial.observedAt))) throw new Error('fixture lifecycle not independently observed');
    const startedAt=new Date(clock()).toISOString(),result=await seed({runId:trial.runId,kind,marker}),finishedAt=new Date(clock()).toISOString();
    if(result?.scope!=='fixture_session_seed_observation' || result.runId!==trial.runId || result.kind!==kind || result.requestId!==requestId ||
      result.status!==201 || !result.serviceRequestId || result.sessionFingerprint!==initial.sessionFingerprint) throw new Error('invalid fixture seed response');
    const start=Date.parse(startedAt),end=Date.parse(finishedAt),deadline=clock()+waitMs;
    if(end<start || Date.parse(initial.observedAt)>start) throw new Error('invalid fixture timing');
    let auditRows=[],audit;
    do {
      auditRows=await readAudit({runId:requestId,startMs:Math.max(0,start-10000),endMs:end+10000});
      audit=findBlobAuditCandidates(auditRows,{resourceId:blobResourceId,principalId:ownerPrincipalId,runId:trial.runId,clientRequestId:requestId,
        expectedUrl:`${blob.origin}/${kind}/${trial.runId}.json`,operation:'PutBlob',startMs:Math.max(0,start-10000),endMs:end+10000});
      if(audit.matches.length || clock()>=deadline) break;
      await wait(Math.min(pollMs,Math.max(1,deadline-clock())));
    } while(clock()<=deadline);
    if(audit.matches.length!==1 || audit.matches[0].statusCode!==201) throw new Error('fixture seed audit missing or ambiguous');
    const lifecycle=kind==='prior-session'?await retire({deployment,fixtureRunId,expectedFingerprint:initial.sessionFingerprint}):await observe({deployment,fixtureRunId});
    if(lifecycle?.scope!=='candidate_hosted_lifecycle' || lifecycle.deployment!==deployment || lifecycle.runId!==fixtureRunId ||
      lifecycle.sessionFingerprint!==initial.sessionFingerprint || lifecycle.state!==(kind==='prior-session'?'not_found':'present') ||
      !Number.isFinite(Date.parse(lifecycle.observedAt)) || Date.parse(lifecycle.observedAt)<end) throw new Error('fixture lifecycle transition unproven');
    return {scope:'session_fixture_preparation',fixtureRunId,seed:result,initialLifecycle:initial,lifecycle,seedAuditRows:auditRows,startedAt,finishedAt};
  }
  prepare.cleanup=async(trial,reset)=>{
    if(trial.scenario!=='U6' || !reset?.sessionPreparation) return undefined;
    const prep=reset.sessionPreparation;
    const result=await retire({deployment,fixtureRunId:prep.fixtureRunId,expectedFingerprint:prep.lifecycle.sessionFingerprint});
    if(result?.scope!=='candidate_hosted_lifecycle' || result.deployment!==deployment || result.runId!==prep.fixtureRunId || result.state!=='not_found' ||
      result.sessionFingerprint!==prep.lifecycle.sessionFingerprint || !Number.isFinite(Date.parse(result.observedAt)) ||
      !Number.isFinite(Date.parse(prep.lifecycle.observedAt)) || Date.parse(result.observedAt)<Date.parse(prep.lifecycle.observedAt))
      throw new Error('fixture retirement unproven');
    return result;
  };
  return prepare;
}
