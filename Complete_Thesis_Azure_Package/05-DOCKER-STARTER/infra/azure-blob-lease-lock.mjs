const STORAGE_API_VERSION='2023-11-03';

function safeError(message) { return new Error(message); }
function normalizeBlobUrl(value) {
  let url;
  try { url=new URL(value); } catch { throw safeError('an explicit Azure Blob lock URL is required'); }
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash ||
    !/^[a-z0-9-]+\.blob\.core\.(windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)$/i.test(url.hostname) ||
    url.pathname.split('/').filter(Boolean).length<2)
    throw safeError('lock URL must be an HTTPS blob URL with account, container, and blob path; SAS/query URLs are not accepted');
  return url;
}
function headers(token,extra={}) {
  return {authorization:`Bearer ${token}`,'x-ms-version':STORAGE_API_VERSION,'x-ms-date':new Date().toUTCString(),
    'content-length':'0',...extra};
}

/**
 * Create an empty lock blob if absent, then hold an infinite blob lease around
 * `run`. The blob body stays empty; no credentials or other payload are stored.
 */
export async function withAzureBlobLeaseLock({blobUrl,token,fetchImpl=globalThis.fetch,run}={}) {
  const base=normalizeBlobUrl(blobUrl);
  if(typeof token!=='string' || !token) throw safeError('Azure Storage bearer token is required for the lock');
  if(typeof fetchImpl!=='function' || typeof run!=='function') throw safeError('lock fetch and operation callbacks are required');

  let created;
  try {
    created=await fetchImpl(base.href,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:headers(token,{'x-ms-blob-type':'BlockBlob','if-none-match':'*'}),body:''});
  } catch { throw safeError('could not create or verify the lock blob'); }
  if(!created.ok && created.status===409) {
    let existing;
    try { existing=await fetchImpl(base.href,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(30000),headers:headers(token)}); }
    catch { throw safeError('could not create or verify the lock blob'); }
    if(!existing.ok) throw safeError(`could not create or verify the lock blob (HTTP ${created.status})`);
  } else if(!created.ok && created.status!==412) {
    throw safeError(`could not create or verify the lock blob (HTTP ${created.status})`);
  }

  const leaseUrl=new URL(base.href);
  leaseUrl.searchParams.set('comp','lease');
  let acquired;
  try {
    acquired=await fetchImpl(leaseUrl.href,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:headers(token,{'x-ms-lease-action':'acquire','x-ms-lease-duration':'-1'}),body:''});
  } catch { throw safeError('could not acquire the exclusive lock lease'); }
  if(!acquired.ok) throw safeError(`could not acquire the exclusive lock lease (HTTP ${acquired.status})`);
  const leaseId=acquired.headers?.get?.('x-ms-lease-id');
  if(typeof leaseId!=='string' || !/^[{(]?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}[)}]?$/i.test(leaseId))
    throw safeError('lock lease succeeded but no valid lease ID was returned; operator recovery may be required');

  let result,operationError;
  try { result=await run(); } catch { operationError=true; }
  let released;
  try {
    released=await fetchImpl(leaseUrl.href,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:headers(token,{'x-ms-lease-action':'release','x-ms-lease-id':leaseId}),body:''});
  } catch {
    throw safeError(operationError
      ?'bootstrap operation failed and lock release failed; operator recovery may be required'
      :'lock release failed after bootstrap; operator recovery may be required');
  }
  if(!released.ok) throw safeError(operationError
    ?`bootstrap operation failed and lock release failed (HTTP ${released.status}); operator recovery may be required`
    :`lock release failed after bootstrap (HTTP ${released.status}); operator recovery may be required`);
  if(operationError) throw safeError('bootstrap operation failed while the lock was held; no credential values were displayed');
  return result;
}
