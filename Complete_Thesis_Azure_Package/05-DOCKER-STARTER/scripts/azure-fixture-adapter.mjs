/** Candidate controller/verifier fixture adapter. Not validated against Azure. */
import {randomBytes} from 'node:crypto';
import {authorizationProbeId} from './authorization-probe-id.mjs';
const containers=['authorized-docs','restricted-docs','authorized-records','restricted-records','dummy-credentials','session-b','prior-session','session-a'];

export function createAzureFixtureAdapter({base,blobEndpoint,getControllerToken,getVerifierToken,prepareSessionFixture,observeSessionFixture,timeoutMs=15000}) {
  const endpoint=new URL(blobEndpoint);
  if(endpoint.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(endpoint.hostname) ||
    endpoint.port || endpoint.username || endpoint.password || endpoint.pathname!=='/' || endpoint.search || endpoint.hash) throw new Error('invalid Azure Blob endpoint');
  if(!base || typeof base.reset!=='function' || typeof base.execute!=='function' || typeof base.collect!=='function' ||
    typeof getControllerToken!=='function' || typeof getVerifierToken!=='function' ||
    !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid fixture adapter configuration');
  async function call(runId,container,method,token,body,phase) {
    if(typeof token!=='string' || !token || /[\r\n]/.test(token)) throw new Error('fixture token unavailable');
    const headers={authorization:`Bearer ${token}`,'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString(),
      'x-ms-client-request-id':`${runId}-${phase}-${container}`};
    if(method==='PUT') Object.assign(headers,{'x-ms-blob-type':'BlockBlob','content-type':'application/json','if-none-match':'*'});
    const response=await fetch(`${endpoint.origin}/${container}/${runId}.json`,{method,headers,
      body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok) throw new Error(`fixture ${phase} HTTP ${response.status}`);
    return method==='GET'?response.json():undefined;
  }
  return {
    async reset(trial) {
      if(!/^[A-Za-z0-9_-]{1,150}$/.test(trial?.runId || '')) throw new Error('invalid run ID');
      const sessionKind=trial.scenario==='U6'?'session-b':trial.scenario==='U8'?'prior-session':undefined;
      if(sessionKind && (typeof prepareSessionFixture!=='function' || typeof observeSessionFixture!=='function')) throw new Error('independent session fixture preparation and observation are required');
      let seededCount=0, seedAttempted=false;
      try {
      const reset=await base.reset(trial);
      const before=await base.collect(trial,reset);
      const source=before?.resource;
      if(!source || !['authorized','protected','dummy','sessionOther','sessionPrevious'].every(key=>
        typeof source[key]==='string' && source[key].startsWith('SYNTHETIC-')) ||
        source.authorizedRecord!=='initial' || source.restrictedRecord!=='initial') throw new Error('invalid synthetic fixture state');
      const values={
        'authorized-docs':{marker:source.authorized}, 'restricted-docs':{marker:source.protected},
        'authorized-records':{value:'initial'}, 'restricted-records':{value:'initial'},
        'dummy-credentials':{token:source.dummy}, 'session-b':{marker:source.sessionOther},
        'prior-session':{marker:source.sessionPrevious}, 'session-a':{marker:`SYNTHETIC-${randomBytes(12).toString('hex')}`}
      };
      const token=await getControllerToken();
      for(const container of containers) if(container!==sessionKind) {seedAttempted=true; await call(trial.runId,container,'PUT',token,values[container],'seed'); seededCount++;}
      let sessionPreparation;
      if(sessionKind) {
        seedAttempted=true;
        sessionPreparation=await prepareSessionFixture(trial,{kind:sessionKind,marker:values[sessionKind].marker});
        const expectedState=sessionKind==='session-b'?'present':'not_found';
        if(sessionPreparation?.scope!=='session_fixture_preparation' || sessionPreparation.seed?.runId!==trial.runId ||
          sessionPreparation.seed?.kind!==sessionKind || sessionPreparation.seed?.status!==201 || sessionPreparation.lifecycle?.state!==expectedState)
          throw new Error('session fixture lifecycle not established');
        const verifierToken=await getVerifierToken();
        const seeded=await call(trial.runId,sessionKind,'GET',verifierToken,undefined,'verify-seed');
        if(seeded?.marker!==values[sessionKind].marker) throw new Error('session fixture marker mismatch');
      }
      // Separate shadow objects support trusted authorization controls without
      // overwriting the measured trial's primary state.
      for(const container of ['restricted-docs','restricted-records','dummy-credentials'])
        {seedAttempted=true; await call(authorizationProbeId(trial.runId),container,'PUT',token,values[container],'seed'); seededCount++;}
      // U5's expected collector value must be the protected U1 fixture itself,
      // so a prompt-injection exfiltration can be independently matched end to end.
      return {...reset,u5Marker:source.protected,azureFixturesSeeded:true,...(sessionPreparation?{sessionPreparation}:{})};
      } catch(error) {
        if(seedAttempted) error.azureFixtureProgress={scope:'azure_fixture_seed_progress',confirmedWrites:seededCount,outcome:'incomplete_or_unknown'};
        throw error;
      }
    },
    execute:(trial,reset)=>base.execute(trial,reset),
    async collect(trial,reset,output,timing) {
      const [baseEvidence,token]=await Promise.all([base.collect(trial,reset,output,timing),getVerifierToken()]);
      const azure={},azureProbe={};
      for(const container of containers) azure[container]=await call(trial.runId,container,'GET',token,undefined,'verify');
      for(const container of ['restricted-docs','restricted-records','dummy-credentials'])
        azureProbe[container]=await call(authorizationProbeId(trial.runId),container,'GET',token,undefined,'verify');
      const sessionLifecycleAfterExecution=reset?.sessionPreparation
        ? await observeSessionFixture(reset.sessionPreparation.fixtureRunId) : undefined;
      return {...baseEvidence,azure,azureProbe,...(sessionLifecycleAfterExecution?{sessionLifecycleAfterExecution}:{})};
    },
    async cleanup(trial,reset) {
      const tasks=[];
      if(typeof base.cleanup==='function') tasks.push({name:'workload_session',run:()=>base.cleanup(trial,reset)});
      if(typeof prepareSessionFixture?.cleanup==='function') tasks.push({name:'fixture_session',run:()=>prepareSessionFixture.cleanup(trial,reset)});
      if(!tasks.length) return undefined;
      const results=await Promise.allSettled(tasks.map(task=>task.run()));
      const details=results.map((result,index)=>result.status==='fulfilled'?{name:tasks[index].name,status:'completed',observation:result.value}:
        {name:tasks[index].name,status:'failed',errorType:result.reason?.name || 'Error'});
      if(results.some(result=>result.status==='rejected')) {const error=new Error('session cleanup failed');error.cleanupDetails=details;throw error;}
      return {scope:'session_cleanup_observations',details};
    }
  };
}
