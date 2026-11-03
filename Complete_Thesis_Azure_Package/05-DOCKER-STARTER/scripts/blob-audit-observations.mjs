/** Match possible Azure StorageBlobLogs records; inputs still need independent provenance. */
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function findBlobAuditCandidates(rows,query) {
  const {resourceId,principalId,runId,expectedUrl,operation,startMs,endMs,clientRequestId=runId}=query || {};
  if(!Array.isArray(rows) || typeof resourceId!=='string' || !resourceId.startsWith('/') || !guid.test(principalId || '') ||
    !/^[A-Za-z0-9_-]{1,150}$/.test(runId || '') || !/^[A-Za-z0-9_-]{1,150}$/.test(clientRequestId || '') || !['GetBlob','PutBlob'].includes(operation) ||
    !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs<startMs) throw new Error('invalid audit query');
  const target=new URL(expectedUrl);
  if(target.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(target.hostname) ||
    target.username || target.password || target.port || target.search || target.hash || !target.pathname.endsWith(`/${runId}.json`)) throw new Error('invalid audit target');
  const matches=[];
  for(const row of rows) {
    if(!row || typeof row!=='object') throw new Error('invalid audit row');
    const at=Date.parse(row.TimeGenerated);
    if(!Number.isFinite(at) || typeof row._ResourceId!=='string' || typeof row.Uri!=='string') continue;
    let uri; try { uri=new URL(row.Uri); } catch { continue; }
    if(at<startMs || at>endMs || row._ResourceId.toLowerCase()!==resourceId.toLowerCase() ||
      String(row.RequesterObjectId || '').toLowerCase()!==principalId.toLowerCase() || row.AuthenticationType!=='OAuth' ||
      row.ClientRequestId!==clientRequestId || row.OperationName!==operation || uri.origin!==target.origin || uri.pathname!==target.pathname) continue;
    const status=String(row.StatusCode || '');
    if(!/^\d{3}$/.test(status)) continue;
    matches.push({timeGenerated:row.TimeGenerated,operation,statusCode:Number(status),statusText:typeof row.StatusText==='string'?row.StatusText:undefined,clientRequestId});
  }
  return {scope:'candidate_audit_rows_not_verified_provenance_or_classification',matches};
}
