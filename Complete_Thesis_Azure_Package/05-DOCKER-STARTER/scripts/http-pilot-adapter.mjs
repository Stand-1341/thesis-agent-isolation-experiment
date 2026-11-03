/** Candidate HTTP adapter for the research fixtures. Not validated for cloud use. */
function baseUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('invalid endpoint');
  if (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('nonlocal endpoints require HTTPS');
  return url.href.replace(/\/$/, '');
}

export function createHttpPilotAdapter({resourceUrl, collectorUrl, agentUrl, resourceAdminToken, collectorAdminToken, controllerToken, functionKey, timeoutMs=15000, readinessTimeoutMs=30000, readinessPollMs=500}) {
  const resource=baseUrl(resourceUrl), collector=baseUrl(collectorUrl), agent=baseUrl(agentUrl);
  if (![resourceAdminToken,collectorAdminToken,controllerToken].every(x => typeof x === 'string' && x.length > 0)) throw new Error('missing credentials');
  if (functionKey!==undefined && (typeof functionKey!=='string' || !functionKey || /[\r\n]/.test(functionKey))) throw new Error('invalid function key');
  if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid timeout');
  if (!Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs<1 || readinessTimeoutMs>60000 || !Number.isInteger(readinessPollMs) || readinessPollMs<1 || readinessPollMs>5000) throw new Error('invalid readiness timing');
  async function waitForHealth(base) {
    const deadline=Date.now()+readinessTimeoutMs;
    while(Date.now()<deadline) {
      try {
        const response=await fetch(`${base}/health`,{redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(3000,deadline-Date.now())))});
        if(response.ok) {
          const body=await response.json();
          if(body?.ready===true) return;
          throw new Error('pilot endpoint returned invalid health');
        }
        if(![502,503,504].includes(response.status)) throw new Error(`pilot health HTTP ${response.status}`);
      } catch(error) {
        if(error?.message?.startsWith('pilot ')) throw error;
      }
      const remaining=deadline-Date.now();
      if(remaining>0) await new Promise(resolve=>setTimeout(resolve,Math.min(readinessPollMs,remaining)));
    }
    throw new Error('pilot endpoint readiness timed out');
  }
  async function call(url, {method='GET', token, header, body, agentRequest=false}={}) {
    const response=await fetch(url,{method,redirect:'error',headers:{'content-type':'application/json',[header]:token,
      ...(agentRequest && functionKey ? {'x-functions-key':functionKey} : {})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
    if (!response.ok) throw new Error(`pilot endpoint HTTP ${response.status}`);
    return response.json();
  }
  return {
    async reset(trial) {
      // Readiness retries are limited to unauthenticated GETs. Never retry the
      // non-idempotent reset requests after they have been sent.
      await Promise.all([waitForHealth(resource),waitForHealth(collector)]);
      const fixture=await call(`${resource}/admin/reset`,{method:'POST',token:resourceAdminToken,header:'x-admin-token',body:{runId:trial.runId}});
      try {
        await call(`${collector}/admin/reset`,{method:'POST',token:collectorAdminToken,header:'x-admin-token',body:{runId:trial.runId}});
      } catch(error) {
        // The collector outcome may be ambiguous after a transport failure.
        // Retain only known state; never repeat either reset automatically.
        const failure=new Error('collector reset failed after resource reset');
        failure.partialReset={scope:'fixture_reset_progress',resourceResetCompleted:true,collectorResetConfirmed:false,collectorOutcome:'unknown'};
        throw failure;
      }
      return fixture;
    },
    async execute(trial, fixture) {
      return call(`${agent}/run`,{method:'POST',token:controllerToken,header:'x-trial-key',agentRequest:true,body:{runId:trial.runId,scenario:trial.scenario,
        ...(trial.scenario==='U5'?{u5Marker:fixture.u5Marker}:{})}});
    },
    async collect(trial) {
      const id=encodeURIComponent(trial.runId);
      const [resourceEvidence,collectorEvidence]=await Promise.all([
        call(`${resource}/admin/evidence?runId=${id}`,{token:resourceAdminToken,header:'x-admin-token'}),
        call(`${collector}/admin/evidence?runId=${id}`,{token:collectorAdminToken,header:'x-admin-token'})]);
      return {resource:resourceEvidence,collector:collectorEvidence};
    }
  };
}
