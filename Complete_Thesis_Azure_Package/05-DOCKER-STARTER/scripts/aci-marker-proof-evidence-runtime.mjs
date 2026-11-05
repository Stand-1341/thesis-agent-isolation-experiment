/** Compose the versioned marker-proof store using the configured distinct MIs. */
import {ManagedIdentityCredential} from '@azure/identity';
import {createAzureVersionedProtectedEvidenceAdapter} from './azure-versioned-protected-evidence.mjs';
import {createAciBlobMarkerContentProofPersister} from './aci-blob-marker-content-proof.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_DIRECTIVE_REFERENCE='file:docs/ACI-400-OWNER-DIRECTED-RETENTION.md';
function config(env,retentionAuthority) {
  const names=['THESIS_EVIDENCE_BLOB_CONTAINER_URL','THESIS_EVIDENCE_CONTAINER_RESOURCE_ID',
    'THESIS_EVIDENCE_IDENTITY_CLIENT_ID','THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID',
    'THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID','THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID',
    'THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID','THESIS_EVIDENCE_RETENTION_DAYS'];
  const missing=names.filter(name=>typeof env?.[name]!=='string'||!env[name].trim());
  if(missing.length) throw new Error(`missing marker-proof evidence configuration: ${missing.join(', ')}`);
  const ownerDirected=env.THESIS_EVIDENCE_RETENTION_APPROVED!=='true'&&retentionAuthority?.basis==='owner_directed'&&
    retentionAuthority?.scope==='aci_400_study_evidence_only'&&retentionAuthority?.reference===OWNER_DIRECTIVE_REFERENCE;
  if(env.THESIS_EVIDENCE_RETENTION_APPROVED!=='true'&&!ownerDirected)
    throw new Error('institutional retention approval or the exact owner-directed 400-study retention basis is required');
  const retention=Number(env.THESIS_EVIDENCE_RETENTION_DAYS);
  if(!/^[1-9]\d*$/.test(env.THESIS_EVIDENCE_RETENTION_DAYS)||!Number.isSafeInteger(retention))
    throw new Error('THESIS_EVIDENCE_RETENTION_DAYS must be an explicit positive integer');
  if(ownerDirected&&retention!==146000)
    throw new Error('owner-directed 400-study retention requires the configured locked 146000-day period');
  for(const name of ['THESIS_EVIDENCE_IDENTITY_CLIENT_ID','THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID',
    'THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID','THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID','THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID'])
    if(!GUID.test(env[name])) throw new Error(`${name} must be a GUID`);
  const clients=['THESIS_EVIDENCE_IDENTITY_CLIENT_ID','THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID','THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID']
    .map(name=>env[name].toLowerCase());
  const principals=['THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID','THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID']
    .map(name=>env[name].toLowerCase());
  if(new Set(clients).size!==clients.length||new Set(principals).size!==principals.length)
    throw new Error('evidence writer, evidence reader/auditor, and controller identities must be distinct');
  return {containerUrl:env.THESIS_EVIDENCE_BLOB_CONTAINER_URL,containerResourceId:env.THESIS_EVIDENCE_CONTAINER_RESOURCE_ID,
    writerClientId:env.THESIS_EVIDENCE_IDENTITY_CLIENT_ID,writerPrincipalId:env.THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID,
    readerClientId:env.THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID,readerPrincipalId:env.THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID,
    managementClientId:env.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID,minimumRetentionDays:retention,
    retentionBasis:env.THESIS_EVIDENCE_RETENTION_APPROVED==='true'?'institutional_approval_asserted_by_configuration':'owner_directed',
    retentionAuthorityReference:ownerDirected?OWNER_DIRECTIVE_REFERENCE:undefined};
}
function managedCredential(clientId,Credential) {
  const credential=new Credential({clientId});
  if(typeof credential?.getToken!=='function') throw new Error('invalid managed identity credential');
  return credential;
}

/** Construction is local-only; policy and storage calls occur only on save/load. */
export function createAciMarkerProofEvidenceRuntime({env=process.env,Credential=ManagedIdentityCredential,fetchImpl=fetch,retentionAuthority}={}) {
  const cfg=config(env,retentionAuthority);
  const writer=managedCredential(cfg.writerClientId,Credential);
  const reader=managedCredential(cfg.readerClientId,Credential);
  const management=managedCredential(cfg.managementClientId,Credential);
  const token=(credential,scope)=>async()=>{
    let result;try {result=await credential.getToken(scope);} catch {throw new Error('marker-proof managed identity token request failed');}
    if(typeof result?.token!=='string'||!result.token||/[\r\n]/.test(result.token)) throw new Error('marker-proof managed identity returned no token');
    return result.token;
  };
  const adapter=createAzureVersionedProtectedEvidenceAdapter({containerUrl:cfg.containerUrl,containerResourceId:cfg.containerResourceId,
    writerPrincipalId:cfg.writerPrincipalId,readerPrincipalId:cfg.readerPrincipalId,minimumRetentionDays:cfg.minimumRetentionDays,
    getWriterToken:token(writer,'https://storage.azure.com/.default'),getReaderToken:token(reader,'https://storage.azure.com/.default'),
    getManagementToken:token(management,'https://management.azure.com/.default'),fetchImpl});
  const persistMarkerContentProof=createAciBlobMarkerContentProofPersister({observerPrincipalId:cfg.readerPrincipalId,
    requiredRetentionDays:cfg.minimumRetentionDays,writeProtectedEvidence:adapter.writeProtectedEvidence,
    loadProtectedEvidence:adapter.loadProtectedEvidence});
  return Object.freeze({persistMarkerContentProof,loadProtectedEvidence:adapter.loadProtectedEvidence,
    writeProtectedSnapshot:adapter.writeProtectedSnapshot,observerPrincipalId:cfg.readerPrincipalId,
    requiredRetentionDays:cfg.minimumRetentionDays,retentionBasis:cfg.retentionBasis,
    ...(cfg.retentionAuthorityReference?{retentionAuthorityReference:cfg.retentionAuthorityReference}:{})});
}

export {config as validateAciMarkerProofEvidenceConfig,OWNER_DIRECTIVE_REFERENCE as ACI_400_OWNER_RETENTION_REFERENCE};
