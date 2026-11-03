/** Restricted candidate mapping store. Azure network and RBAC isolation must be verified separately. */
import {createAzureBlobEvidenceStore} from './azure-blob-evidence.mjs';

const idPattern=/^[A-Za-z0-9_-]{1,150}$/;
const sessionPattern=/^[a-f0-9]{48}$/;
const scopes=new Set(['restricted_session_mapping','restricted_diagnostic_session_mapping']);
function checked(record,expectedRunId) {
  if(!record || !idPattern.test(record.runId || '') || (expectedRunId!==undefined && record.runId!==expectedRunId) ||
    !sessionPattern.test(record.sessionId || '') || !scopes.has(record.scope)) throw new Error('invalid restricted session mapping');
  // Copy only the intended fields, avoiding accidental storage of credentials.
  return {runId:record.runId,sessionId:record.sessionId,scope:record.scope};
}
export function createAzureSessionRegistry({containerUrl,getToken,timeoutMs}) {
  const url=new URL(containerUrl);
  if(url.pathname!=='/session-mappings') throw new Error('dedicated session-mappings container required');
  const store=createAzureBlobEvidenceStore({containerUrl,getToken,timeoutMs});
  return {
    async save(record) {await store.save(checked(record));},
    async read(runId) {
      if(!idPattern.test(runId || '')) throw new Error('invalid run ID');
      return checked(await store.read(runId),runId);
    }
  };
}
