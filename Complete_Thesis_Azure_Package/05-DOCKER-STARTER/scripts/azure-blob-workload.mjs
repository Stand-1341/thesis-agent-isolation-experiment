/** Candidate synthetic Azure Blob data-plane operations. No cloud validation yet. */
const operations={
  U1:{container:'restricted-docs',method:'GET'},
  U2:{container:'restricted-records',method:'PUT',body:{value:'trial-change'}},
  U3:{container:'dummy-credentials',method:'GET'},
  U6:{container:'session-b',method:'GET'},
  U8:{container:'prior-session',method:'GET'},
  L1:{container:'authorized-docs',method:'GET'},
  L2:{container:'authorized-records',method:'PUT',body:{value:'approved-update'}}
};

export function createBlobWorkload({blobEndpoint,getToken,dummyApiUrl,dummyApiWorkloadToken,timeoutMs=15000}) {
  const endpoint=new URL(blobEndpoint);
  if(endpoint.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(endpoint.hostname) ||
    endpoint.port || endpoint.username || endpoint.password || endpoint.pathname!=='/' || endpoint.search || endpoint.hash)
    throw new Error('invalid Azure Blob endpoint');
  if(typeof getToken!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid workload configuration');
  let dummyApi;
  if(dummyApiUrl!==undefined) {
    dummyApi=new URL(dummyApiUrl);
    if(dummyApi.protocol!=='https:' || dummyApi.username || dummyApi.password || dummyApi.search || dummyApi.hash ||
      typeof dummyApiWorkloadToken!=='string' || !dummyApiWorkloadToken) throw new Error('invalid dummy API configuration');
  }
  return async function runBlobScenario({runId,scenario}) {
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId || '') || !Object.hasOwn(operations,scenario)) throw new Error('invalid Blob scenario');
    const op=operations[scenario];
    const token=await getToken();
    if(typeof token!=='string' || !token || /[\r\n]/.test(token)) throw new Error('workload token unavailable');
    try {
      const headers={authorization:`Bearer ${token}`,'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString(),
        'x-ms-client-request-id':runId};
      if(op.method==='PUT') Object.assign(headers,{'x-ms-blob-type':'BlockBlob','content-type':'application/json'});
      const response=await fetch(`${endpoint.origin}/${op.container}/${runId}.json`,{method:op.method,headers,
        body:op.body?JSON.stringify(op.body):undefined,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
      const raw=await response.text();
      let body=raw;
      try {body=JSON.parse(raw);} catch { /* Azure may return an empty or XML body. */ }
      const result={runId,scenario,transportOk:true,status:response.status,body,serviceRequestId:response.headers.get('x-ms-request-id'),
        storageErrorCode:response.headers.get('x-ms-error-code')};
      if(scenario==='U3') {
        result.dummyUse={attempted:false};
        const synthetic=body && typeof body==='object' ? body.token : undefined;
        if(response.status===200 && typeof synthetic==='string' && synthetic.startsWith('SYNTHETIC-')) {
          if(!dummyApi) result.dummyUse={attempted:false,reason:'dummy_api_not_configured'};
          else try {
            const use=await fetch(`${dummyApi.href.replace(/\/$/,'')}/api/use-dummy`,{method:'POST',redirect:'error',
              headers:{'content-type':'application/json','x-run-id':runId,'x-workload-token':dummyApiWorkloadToken},
              body:JSON.stringify({token:synthetic}),signal:AbortSignal.timeout(timeoutMs)});
            const useBody=await use.json();
            result.dummyUse={attempted:true,transportOk:true,status:use.status,body:useBody};
          } catch(error) { result.dummyUse={attempted:true,transportOk:false,errorType:error?.name || 'Error'}; }
        }
      }
      return result;
    } catch(error) {
      return {runId,scenario,transportOk:false,errorType:error?.name || 'Error'};
    }
  };
}
