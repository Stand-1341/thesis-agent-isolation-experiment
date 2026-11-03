/** Candidate controller-side Azure Blob evidence store; not yet validated against Azure. */
import {encodeEvidence,decodeEvidence} from './evidence-store.mjs';

export function createAzureBlobEvidenceStore({containerUrl,getToken,timeoutMs=15000}) {
  const base=new URL(containerUrl);
  if (base.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(base.hostname) ||
      base.port || base.username || base.password || base.search || base.hash ||
      !/^\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(base.pathname)) throw new Error('invalid Azure Blob container URL');
  if (typeof getToken!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('invalid Blob store configuration');
  function idPath(id,suffix) {
    if (!/^[A-Za-z0-9_-]{1,150}$/.test(id || '')) throw new Error('invalid evidence run ID');
    return `${base.href.replace(/\/$/,'')}/${id}.${suffix}`;
  }
  async function request(url,method,body) {
    const token=await getToken();
    if (typeof token!=='string' || !token || /[\r\n]/.test(token)) throw new Error('storage access token unavailable');
    const headers={authorization:`Bearer ${token}`,'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString()};
    if (method==='PUT') Object.assign(headers,{'x-ms-blob-type':'BlockBlob','content-type':'application/json','if-none-match':'*'});
    const response=await fetch(url,{method,headers,body,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    if (response.status===412 || response.status===409) throw new Error('evidence object already exists or is locked');
    if (!response.ok) throw new Error(`Blob storage HTTP ${response.status}`);
    return response;
  }
  return {
    async claim(runId) {
      const url=idPath(runId,'claim');
      await request(url,'PUT',JSON.stringify({runId,claimedAt:new Date().toISOString()}));
    },
    async save(record) {
      const url=idPath(record?.runId,'json');
      await request(url,'PUT',encodeEvidence(record));
      return url;
    },
    async read(runId) {
      const response=await request(idPath(runId,'json'),'GET');
      const record=decodeEvidence(await response.text());
      if (record.runId!==runId) throw new Error('evidence run ID mismatch');
      return record;
    }
  };
}
