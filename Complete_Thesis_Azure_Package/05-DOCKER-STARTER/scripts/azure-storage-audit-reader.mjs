/** Candidate read-only Azure Monitor query. Cloud behavior and completeness remain unverified. */
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const columns=['TimeGenerated','_ResourceId','AuthenticationType','RequesterObjectId','ClientRequestId','OperationName','Uri','StatusCode','StatusText'];
export function createStorageAuditReader({workspaceId,getToken,timeoutMs=30000}) {
  if(!guid.test(workspaceId || '') || typeof getToken!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid audit reader configuration');
  return async function readAudit({runId,startMs,endMs}) {
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId || '') || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs<startMs || endMs-startMs>86400000) throw new Error('invalid audit time window');
    let start,end; try {start=new Date(startMs).toISOString();end=new Date(endMs).toISOString();} catch {throw new Error('invalid audit time window');}
    const token=await getToken();
    if(typeof token!=='string' || !token || /[\r\n]/.test(token)) throw new Error('audit access token unavailable');
    const query=`StorageBlobLogs | where TimeGenerated between (datetime(${start}) .. datetime(${end})) | where ClientRequestId == '${runId}' | project ${columns.join(', ')} | take 1001`;
    const response=await fetch(`https://api.loganalytics.azure.com/v1/workspaces/${workspaceId}/query`,{
      method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      body:JSON.stringify({query}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok) throw new Error(`Azure Monitor HTTP ${response.status}`);
    const body=await response.json();
    if(body.error || !Array.isArray(body.tables) || body.tables.length!==1) throw new Error('incomplete Azure Monitor response');
    const table=body.tables[0];
    if(!Array.isArray(table.columns) || !Array.isArray(table.rows) || table.rows.length>1000 ||
      JSON.stringify(table.columns.map(column=>column.name))!==JSON.stringify(columns)) throw new Error('unexpected or truncated audit response');
    return table.rows.map(row=>{
      if(!Array.isArray(row) || row.length!==columns.length) throw new Error('invalid audit row');
      const record=Object.fromEntries(columns.map((name,index)=>[name,row[index]]));
      if(typeof record.Uri==='string') {
        try {const url=new URL(record.Uri); url.search=''; url.hash=''; record.Uri=url.href;} catch {record.Uri='';}
      }
      return record;
    });
  };
}
