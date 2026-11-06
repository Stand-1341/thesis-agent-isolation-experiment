/** Candidate custom-session HTTP routing; no Azure session lifecycle validation yet. */
import {createHash,randomBytes} from 'node:crypto';
import {createDelegatedStorageTokenProvider,validateSessionControlToken} from './azure-delegated-token.mjs';
import {validateCustomSessionEndpoint} from './session-endpoint.mjs';
import {retireSession} from './retire-session.mjs';
const blobScenarios=new Set(['U1','U2','U3','U6','U8','L1','L2']);
export function createSessionPilotAdapter({fixtureAdapter, managementEndpoint, poolName, region, getAccessToken, expectedControllerPrincipalId, controllerToken, sessionRegistry, lifecycleObserver, delegatedCredentials, headerIsolationVerified=false, timeoutMs=30000}) {
  const endpoint=validateCustomSessionEndpoint(managementEndpoint,{poolName,region});
  if (!fixtureAdapter || typeof fixtureAdapter.reset!=='function' || typeof fixtureAdapter.collect!=='function' || typeof getAccessToken!=='function' || !controllerToken || !sessionRegistry || typeof sessionRegistry.save!=='function' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedControllerPrincipalId || '')) throw new Error('missing session adapter configuration');
  // Do not use a privileged token until an independent pilot establishes whether
  // the management proxy strips authorization before forwarding to the workload.
  if (headerIsolationVerified!==true) throw new Error('session authorization header isolation is unverified');
  if(delegatedCredentials && (typeof delegatedCredentials.getStorageToken!=='function' || typeof delegatedCredentials.getMockToken!=='function' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(delegatedCredentials.expectedPrincipalId || ''))) throw new Error('invalid delegated credential configuration');
  if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid timeout');
  const claimed=new Set();
  const fingerprints=new Map();
  return {
    reset:trial=>fixtureAdapter.reset(trial),
    async collect(trial,fixture,output,timing) {
      if(!lifecycleObserver || typeof lifecycleObserver.observe!=='function' || !fingerprints.has(trial.runId)) throw new Error('session lifecycle observer unavailable');
      const evidence=await fixtureAdapter.collect(trial,fixture,output,timing);
      const observation=await lifecycleObserver.observe(trial.runId);
      if(observation?.sessionFingerprint!==fingerprints.get(trial.runId)) throw new Error('workload session observation mismatch');
      return {...evidence,workloadSessionLifecycleAfterExecution:observation};
    },
    async execute(trial,fixture) {
      if (!/^[A-Za-z0-9_-]{1,150}$/.test(trial.runId || '')) throw new Error('invalid session identifier');
      if(claimed.has(trial.runId)) throw new Error('session already assigned to run');
      claimed.add(trial.runId);
      // Session identifiers are sensitive routing values; ACA forwards the query
      // value to the session. Do not derive them from the public plan or include
      // them in routine evidence. Restrict the registry separately from workloads.
      const sessionId=randomBytes(24).toString('hex');
      await sessionRegistry.save({runId:trial.runId,sessionId,scope:'restricted_session_mapping'});
      fingerprints.set(trial.runId,createHash('sha256').update(sessionId).digest('hex'));
      const token=await getAccessToken();
      validateSessionControlToken({token,expectedPrincipalId:expectedControllerPrincipalId});
      // U5 is verified by correlating the collector's request ID with the
      // workload observation. Use the same stable, run-scoped ID as the VM
      // and Functions adapters; without it the collector evidence cannot be
      // attributed to this attempt even when the request succeeds.
      const requestId=trial.scenario==='U5'?`u5-${createHash('sha256').update(trial.runId).digest('hex')}`:undefined;
      const payload={runId:trial.runId,scenario:trial.scenario,...(trial.scenario==='U5'?{u5Marker:fixture.u5Marker,requestId}:{})};
      let delegatedToken,mockToken;
      if(delegatedCredentials) {
        mockToken=await delegatedCredentials.getMockToken(trial);
        if(typeof mockToken!=='string' || mockToken.length<32 || mockToken.length>512 || /[\r\n]/.test(mockToken)) throw new Error('invalid mock workload credential');
        payload.mockWorkloadToken=mockToken;
        if(blobScenarios.has(trial.scenario)) {
          delegatedToken=await delegatedCredentials.getStorageToken(trial);
          createDelegatedStorageTokenProvider({token:delegatedToken,expectedPrincipalId:delegatedCredentials.expectedPrincipalId});
          payload.azureAccessToken=delegatedToken;
          payload.expectedPrincipalId=delegatedCredentials.expectedPrincipalId;
        }
      }
      const url=new URL(`${endpoint.href.replace(/\/$/,'')}/run`);
      url.searchParams.set('identifier',sessionId);
      const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        headers:{authorization:`Bearer ${token}`,'x-trial-key':controllerToken,'content-type':'application/json'},
        body:JSON.stringify(payload)});
      if (!response.ok) throw new Error(`session endpoint HTTP ${response.status}`);
      const result=await response.json();
      const serialized=JSON.stringify(result);
      // Never propagate these values into ordinary evidence. Such a response is
      // a security observation requiring investigation, not a trial outcome.
      if(serialized?.includes(token)) return {runId:trial.runId,scenario:trial.scenario,transportOk:false,errorType:'ControlTokenExposed'};
      if(serialized?.includes(sessionId)) return {runId:trial.runId,scenario:trial.scenario,transportOk:false,errorType:'SessionIdentifierExposed'};
      if(serialized?.includes(controllerToken)) return {runId:trial.runId,scenario:trial.scenario,transportOk:false,errorType:'RequestKeyExposed'};
      if((delegatedToken && serialized?.includes(delegatedToken)) || (mockToken && serialized?.includes(mockToken))) return {runId:trial.runId,scenario:trial.scenario,transportOk:false,errorType:'WorkloadCredentialExposed'};
      return result;
    },
    async cleanup(trial) {
      const expectedFingerprint=fingerprints.get(trial.runId);
      if(!lifecycleObserver || !expectedFingerprint) throw new Error('session cleanup observer or mapping unavailable');
      return retireSession({observer:lifecycleObserver,runId:trial.runId,expectedFingerprint});
    }
  };
}
