/** Read a protected research collector; does not prove its logs are independent or durable. */
export function createCollectorEvidenceReader({collectorUrl,verifierKey,timeoutMs=15000}) {
  const url=new URL(collectorUrl);
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash ||
    typeof verifierKey!=='string' || !verifierKey || /[\r\n]/.test(verifierKey) ||
    !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid collector reader configuration');
  const base=url.href.replace(/\/$/,'');
  return async function readCollector(runId) {
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId || '')) throw new Error('invalid run ID');
    const response=await fetch(`${base}/admin/evidence?runId=${encodeURIComponent(runId)}`,{method:'GET',redirect:'error',
      headers:{'x-verifier-token':verifierKey},signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok) throw new Error(`collector evidence HTTP ${response.status}`);
    const body=await response.json();
    if(!body || typeof body!=='object' || !Array.isArray(body.events) || body.events.length>10000) throw new Error('invalid collector evidence');
    return body;
  };
}
