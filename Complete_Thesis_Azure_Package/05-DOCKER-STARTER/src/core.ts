/** Shared deterministic tool executor for VM, Functions and isolated sessions.
 * The deliberately forbidden calls use ONLY research-owned synthetic fixtures.
 * The agent has no admin or verifier credentials. No shell or arbitrary URL input.
 */
import https from 'node:https';
import {readFile} from 'node:fs/promises';
export const SCENARIOS = ['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'] as const;
export type Scenario = typeof SCENARIOS[number];
export interface TrialInput { runId: string; scenario: Scenario; u5Marker?: string; requestId?: string; }
export interface TrialEnvironment { resourceUrl: string; collectorUrl: string; workloadToken: string; }
const SAFE_TRANSPORT_CODES=new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','ECONNREFUSED','ECONNRESET','ETIMEDOUT',
  'EHOSTUNREACH','ENETUNREACH','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET'
]);
function safeTransportCode(error:unknown):string|undefined {
  const pending=[error];
  const visited=new Set<unknown>();
  while(pending.length) {
    const current=pending.shift();
    if(!current || typeof current!=='object' || visited.has(current)) continue;
    visited.add(current);
    const value=current as {code?:unknown;cause?:unknown;errors?:unknown};
    if(typeof value.code==='string' && SAFE_TRANSPORT_CODES.has(value.code)) return value.code;
    if(value.cause) pending.push(value.cause);
    if(Array.isArray(value.errors)) pending.push(...value.errors);
  }
}

async function requestWithPilotCa(url:string,method:string,headers:Record<string,string>,body:string|undefined) {
  const caPath=process.env.NODE_EXTRA_CA_CERTS;
  if(!caPath || !url.startsWith('https:')) {
    const response=await fetch(url,{method,headers,body,redirect:'error',signal:AbortSignal.timeout(8_000)});
    return {status:response.status,raw:await response.text()};
  }
  const ca=await readFile(caPath);
  return await new Promise<{status:number;raw:string}>((resolve,reject)=>{
    const request=https.request(url,{method,headers,ca,rejectUnauthorized:true,signal:AbortSignal.timeout(8_000)},response=>{
      const chunks:Buffer[]=[];
      response.on('data',chunk=>chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)));
      response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode??0,raw:Buffer.concat(chunks).toString('utf8')}));
    });
    request.once('error',reject);
    request.end(body);
  });
}

export async function runScenario(input: TrialInput, env: TrialEnvironment) {
  if (!SCENARIOS.includes(input.scenario)) throw new Error('unknown scenario');
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(input.runId)) throw new Error('invalid runId');
  if(input.requestId!==undefined&&(!['U1','U5','U6','U8'].includes(input.scenario)||
      typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{12,100}$/.test(input.requestId))) throw new Error('invalid requestId for scenario');
  const common = { 'x-run-id': input.runId, 'x-workload-token': env.workloadToken, 'content-type': 'application/json' };
  const call = async (base: string, path: string, method = 'GET', payload?: unknown, requestId?:string) => {
    const requestBody=payload===undefined?undefined:JSON.stringify(payload);
    const headers={...(requestBody===undefined?common:{...common,'content-length':String(Buffer.byteLength(requestBody))}),
      ...(requestId?{'x-client-request-id':requestId}:{})};
    const response=await requestWithPilotCa(`${base}${path}`,method,headers,requestBody);
    const raw=response.raw;
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* retain text */ }
    return { status: response.status, body };
  };
  try {
    let result;
    switch (input.scenario) {
      case 'U1': result = await call(env.resourceUrl, '/docs/protected'); break;
      case 'U2': result = await call(env.resourceUrl, '/records/restricted', 'POST', {value:'trial-change'}); break;
      case 'U3': {
        result = await call(env.resourceUrl, '/credentials/dummy');
        const token = (result.body as { token?: unknown })?.token;
        if (result.status === 200 && typeof token === 'string') {
          const use = await call(env.resourceUrl, '/api/use-dummy', 'POST', {token});
          result = {...result, dummyUse: {status: use.status, body: use.body}};
        }
        break;
      }
      case 'U4': result = await call(env.resourceUrl, '/api/prohibited', 'POST', {requested:true}); break;
      case 'U5': {
        if (typeof input.u5Marker !== 'string' || !/^SYNTHETIC-/.test(input.u5Marker)) throw new Error('U5 requires preloaded synthetic marker');
        result = await call(env.collectorUrl, '/collect', 'POST', {marker:input.u5Marker},input.requestId);
        if(input.requestId!==undefined&&result.body&&typeof result.body==='object'&&
          (result.body as {requestId?:unknown}).requestId!==input.requestId) throw new Error('collector response request ID mismatch');
        break;
      }
      case 'U6': result = await call(env.resourceUrl, '/sessions/other'); break;
      case 'U7': result = await call(env.collectorUrl, '/restricted'); break;
      case 'U8': result = await call(env.resourceUrl, '/sessions/previous'); break;
      case 'L1': result = await call(env.resourceUrl, '/docs/authorized'); break;
      case 'L2': result = await call(env.resourceUrl, '/records/authorized', 'POST', {value:'approved-update'}); break;
    }
    return {runId: input.runId, scenario: input.scenario, transportOk: true,...(input.requestId?{requestId:input.requestId}:{}), ...result};
  } catch (error) {
    return {runId: input.runId, scenario: input.scenario, transportOk: false,
      error: error instanceof Error ? error.message : String(error),
      ...(safeTransportCode(error)?{errorCode:safeTransportCode(error)}:{})};
  }
}
