/** Trusted disposable-container diagnostic; only for a narrowly scoped pilot identity. */
import {createHash,randomBytes} from 'node:crypto';
import {validateSessionControlToken} from './azure-delegated-token.mjs';
import {validateCustomSessionEndpoint} from './session-endpoint.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function createSessionHeaderDiagnostic({managementEndpoint,poolName,region,getDiagnosticToken,diagnosticPrincipalId,sessionRegistry,timeoutMs=30000,onStage=()=>{},probeNetwork=false}) {
  const endpoint=validateCustomSessionEndpoint(managementEndpoint,{poolName,region});
  if(typeof getDiagnosticToken!=='function' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(diagnosticPrincipalId || '') || !sessionRegistry || typeof sessionRegistry.save!=='function' ||
    !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid diagnostic configuration');
  return async function inspect(runId) {
    onStage('validate_run_id');
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId || '')) throw new Error('invalid diagnostic run ID');
    const sessionId=randomBytes(24).toString('hex');
    onStage('save_restricted_session_mapping');
    await sessionRegistry.save({runId,sessionId,scope:'restricted_diagnostic_session_mapping'});
    onStage('acquire_managed_identity_token');
    const token=await getDiagnosticToken();
    onStage('validate_token_claims');
    validateSessionControlToken({token,expectedPrincipalId:diagnosticPrincipalId});
    const url=new URL(`${endpoint.href.replace(/\/$/,'')}/${probeNetwork?'probe':'inspect'}`);
    url.searchParams.set('identifier',sessionId);
    onStage('send_request_to_session');
    const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
      headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({tokenSha256:hash(token),sessionIdSha256:hash(sessionId)})});
    onStage('validate_session_response');
    if(!response.ok) throw new Error(`session diagnostic HTTP ${response.status}`);
    const result=await response.json();
    const serialized=JSON.stringify(result);
    if(serialized?.includes(token) || serialized?.includes(sessionId)) throw new Error('diagnostic returned sensitive values');
    if(probeNetwork) {
      const results=result?.results;
      const expectedNames=['research','collector','blob','publicIp'];
      if(result?.scope!=='fixed_pilot_network_probe' || !Array.isArray(results) || results.length!==expectedNames.length ||
        !results.every((item,index)=>item?.name===expectedNames[index] && typeof item.connected==='boolean' &&
          (item.status===null || Number.isInteger(item.status)))) throw new Error('invalid network probe response');
      return {scope:'diagnostic_network_observation_only',results};
    }
    const names=result?.credentialLikeHeaderNames;
    if(typeof result?.authorizationHeaderPresent!=='boolean' || typeof result?.proxyAuthorizationHeaderPresent!=='boolean' ||
      typeof result?.controlTokenValuePresent!=='boolean' || typeof result?.sessionIdentifierValuePresent!=='boolean' ||
      !Array.isArray(names) || names.length>128 || !names.every(name=>typeof name==='string' && /^[a-z0-9-]{1,128}$/.test(name))) throw new Error('invalid diagnostic response');
    return {scope:'diagnostic_observation_only',authorizationHeaderPresent:result.authorizationHeaderPresent,
      proxyAuthorizationHeaderPresent:result.proxyAuthorizationHeaderPresent,credentialLikeHeaderNames:names,
      controlTokenValuePresent:result.controlTokenValuePresent,sessionIdentifierValuePresent:result.sessionIdentifierValuePresent};
  };
}
