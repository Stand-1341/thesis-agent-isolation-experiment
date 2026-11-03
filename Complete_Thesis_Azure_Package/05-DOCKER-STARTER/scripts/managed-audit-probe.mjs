/** Setup-only probe: a matching log is not proof of independent administration. */
import {createManagedLogsTokenProvider} from './azure-managed-logs-token.mjs';
import {createStorageAuditReader} from './azure-storage-audit-reader.mjs';
import {findBlobAuditCandidates} from './blob-audit-observations.mjs';

async function main() {
  const {AUDIT_CLIENT_ID:clientId,AUDIT_WORKSPACE_ID:workspaceId,AUDIT_RUN_ID:runId,
    AUDIT_PRINCIPAL_ID:principalId,AUDIT_RESOURCE_ID:resourceId,AUDIT_BLOB_ENDPOINT:blobEndpoint,
    AUDIT_START:start,AUDIT_END:end,AUDIT_CONTAINER:container='audit-pilot'}=process.env;
  const startMs=Date.parse(start),endMs=Date.parse(end);
  const endpoint=new URL(blobEndpoint);
  if(endpoint.protocol!=='https:' || endpoint.pathname!=='/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password || endpoint.port ||
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(container) || container.includes('--'))
    throw new Error('invalid endpoint');
  const readAudit=createStorageAuditReader({workspaceId,getToken:createManagedLogsTokenProvider({clientId})});
  const rows=await readAudit({runId,startMs,endMs});
  const result=findBlobAuditCandidates(rows,{resourceId,principalId,runId,operation:'GetBlob',startMs,endMs,
    expectedUrl:`${endpoint.origin}/${container}/${runId}.json`});
  const matched=result.matches.length===1 && result.matches[0].statusCode===403 && result.matches[0].statusText==='AuthorizationPermissionMismatch';
  console.log(JSON.stringify({scope:'setup_only_audit_probe',status:matched?'matched':'indeterminate',matchCount:result.matches.length}));
  if(!matched) process.exitCode=2;
}
main().catch(()=>{console.error('Audit probe failed; inspect identity and network configuration.');process.exitCode=1;});
