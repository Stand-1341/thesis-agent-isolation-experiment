function validBase(value) {
  let url;
  try {url=new URL(value);} catch {throw new Error('invalid collector monitor URL');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash)
    throw new Error('invalid collector monitor URL');
  return url.href.replace(/\/$/,'');
}

/** Read the receiver's verifier-only health signal without changing its public /health contract. */
export function createCollectorMonitorReader({collectorUrl,verifierKey,timeoutMs=15000,fetchImpl=fetch}={}) {
  const base=validBase(collectorUrl);
  if(typeof verifierKey!=='string'||!verifierKey||/[\r\n]/.test(verifierKey)) throw new Error('invalid collector monitor credential');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||typeof fetchImpl!=='function')
    throw new Error('invalid collector monitor reader configuration');
  return async function readCollectorMonitor() {
    let response;
    try {response=await fetchImpl(`${base}/admin/monitor`,{method:'GET',redirect:'error',
      headers:{'x-verifier-token':verifierKey},signal:AbortSignal.timeout(timeoutMs)});} catch {
      throw new Error('collector monitor request failed');
    }
    if(!response?.ok) throw new Error(`collector monitor HTTP ${Number.isInteger(response?.status)?response.status:0}`);
    let body;
    try {body=await response.json();} catch {throw new Error('invalid collector monitor response');}
    if(typeof body?.ready!=='boolean'||typeof body?.journalEnabled!=='boolean'||typeof body?.journalHealthy!=='boolean'||
      typeof body?.observedAt!=='string'||!Number.isFinite(Date.parse(body.observedAt)))
      throw new Error('invalid collector monitor response');
    return {ready:body.ready,journalEnabled:body.journalEnabled,journalHealthy:body.journalHealthy,observedAt:body.observedAt};
  };
}
