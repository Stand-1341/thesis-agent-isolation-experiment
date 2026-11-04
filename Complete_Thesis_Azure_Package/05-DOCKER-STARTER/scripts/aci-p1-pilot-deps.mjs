/**
 * Azure Container Instances P1 pilot dependencies.
 *
 * This factory is deliberately stricter than the generic live dependency
 * factory: it accepts only the ACI/P1 schedule, uses managed identities only,
 * retrieves application keys from Key Vault at runtime, separates fixture
 * writer and verifier identities, and requires the measured-evidence store's
 * locked retention check. It does not establish readiness; the runner's
 * evidence-referenced gates remain authoritative.
 */
import {ManagedIdentityCredential} from '@azure/identity';
import {createManagedStorageTokenProvider} from './azure-managed-token.mjs';
import {createManagedLogsTokenProvider} from './azure-managed-logs-token.mjs';
import {createStorageAuditReader} from './azure-storage-audit-reader.mjs';
import {createAzureBlobVerifier} from './azure-blob-verifier.mjs';
import {createCollectorVerifier} from './collector-verifier.mjs';
import {createResourceVerifier,createResourceEvidenceReader} from './resource-verifier.mjs';
import {createCollectorEvidenceReader} from './collector-evidence-reader.mjs';
import {createAzureFixtureAdapter} from './azure-fixture-adapter.mjs';
import {createHttpPilotAdapter} from './http-pilot-adapter.mjs';
import {createAciContainerGroupClient,createAciTrialAdapter,buildAciContainerGroupBody} from './aci-container-group-runtime.mjs';
import {createVerifierRouter} from './verifier-router.mjs';
import {createMeasuredEvidenceStoreFromEnvironment} from './azure-measured-evidence-store.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARM_ID=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.(?:ManagedIdentity\/userAssignedIdentities|Network\/virtualNetworks)\//i;
const ACCEPTED=new Set(['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2']);
const REQUIRED=[
  'THESIS_ACI_SUBSCRIPTION_ID','THESIS_ACI_RESOURCE_GROUP','THESIS_ACI_LOCATION',
  'THESIS_ACI_IMAGE_DIGEST_REFERENCE','THESIS_ACI_REGISTRY_SERVER',
  'THESIS_ACI_PULL_IDENTITY_RESOURCE_ID','THESIS_ACI_P1_IDENTITY_RESOURCE_ID',
  'THESIS_ACI_P1_IDENTITY_CLIENT_ID','THESIS_ACI_SUBNET_ID',
  'THESIS_ACI_RESEARCH_URL','THESIS_ACI_COLLECTOR_URL',
  'THESIS_FIXTURE_BLOB_ENDPOINT','THESIS_BLOB_RESOURCE_ID','THESIS_LOG_ANALYTICS_WORKSPACE_ID',
  'THESIS_ACI_P1_PRINCIPAL_OBJECT_ID','THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID',
  'THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID','THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID',
  'THESIS_ACI_CONTROLLER_PRINCIPAL_OBJECT_ID','THESIS_ACI_FIXTURE_VERIFIER_PRINCIPAL_OBJECT_ID',
  'THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID','THESIS_KEY_VAULT_URI','THESIS_EVIDENCE_IDENTITY_CLIENT_ID',
  'THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID',
  'THESIS_EVIDENCE_RETENTION_APPROVED','THESIS_EVIDENCE_RETENTION_DAYS',
  'THESIS_EVIDENCE_BLOB_CONTAINER_URL','THESIS_EVIDENCE_CONTAINER_RESOURCE_ID'
];
const SECRET_NAMES={
  resourceAdmin:'THESIS_ACI_RESOURCE_ADMIN_SECRET_NAME',
  collectorAdmin:'THESIS_ACI_COLLECTOR_ADMIN_SECRET_NAME',
  controllerKey:'THESIS_ACI_CONTROLLER_KEY_SECRET_NAME',
  workloadToken:'THESIS_ACI_WORKLOAD_TOKEN_SECRET_NAME',
  collectorVerifier:'THESIS_ACI_COLLECTOR_VERIFIER_SECRET_NAME',
  resourceVerifier:'THESIS_ACI_RESOURCE_VERIFIER_SECRET_NAME'
};

function read(env,name,missing) {
  const value=env[name];
  if(typeof value!=='string'||!value.trim()) {missing.push(name);return undefined;}
  return value.trim();
}
function safeUrl(value,name,{blob=false}={}) {
  let url; try {url=new URL(value);} catch {throw new Error(`${name} must be an absolute URL`);}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port)
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  if(blob&&(!/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/i.test(url.hostname)||url.pathname!=='/'))
    throw new Error(`${name} must be an Azure Blob service endpoint`);
  return url.href.replace(/\/$/,'');
}
function validateRows(rows,{sessionAnalog,sessionAnalogVerifier,methodDecision,verifyMethodApproval}={}) {
  if(!Array.isArray(rows)||rows.length===0) throw new Error('ACI pilot rows are required for dependency validation');
  const unsupported=[...new Set(rows.map(row=>row?.scenario_id??row?.scenario).filter(s=>s==='U6'||s==='U8'))];
  if(unsupported.length) {
    if(typeof sessionAnalog!=='function'||typeof sessionAnalogVerifier!=='function'||sessionAnalog===sessionAnalogVerifier)
      throw new Error(`ACI U6/U8 rows require separate sessionAnalog and independent sessionAnalogVerifier callbacks: ${unsupported.join(', ')}`);
    if(methodDecision?.status!=='approved'||typeof methodDecision.reference!=='string'||
      !/^(https:\/\/|urn:|file:)[^\r\n]{1,290}$/i.test(methodDecision.reference)||
      methodDecision.unauthorizedOperations?.U6!=='read_other_active_group_blob_marker'||
      methodDecision.unauthorizedOperations?.U8!=='read_retired_group_blob_marker')
      throw new Error('ACI U6/U8 rows require an explicit approved method-decision record with both prohibited-operation definitions');
    if(typeof verifyMethodApproval!=='function')
      throw new Error('ACI U6/U8 rows require an independent method-decision verifier callback');
  }
  for(const [index,row] of rows.entries()) {
    const scenario=row?.scenario_id??row?.scenario,profile=row?.permission_profile??row?.profile;
    if(row?.deployment!=='azure_container_instances'||profile!=='P1'||!ACCEPTED.has(scenario))
      throw new Error(`ACI dependency row ${index+1} is outside the supported ACI P1 scenario set`);
  }
  return true;
}

function makeIdentity(clientId,Credential=ManagedIdentityCredential) {
  if(!GUID.test(clientId||'')) throw new Error('invalid managed identity client ID');
  const credential=new Credential({clientId});
  if(typeof credential?.getToken!=='function') throw new Error('invalid managed identity credential');
  return credential;
}
function tokenFor(credential,scope,label) {
  return async()=>{
    let result;try {result=await credential.getToken(scope);} catch {throw new Error(`${label} managed identity unavailable`);}
    if(typeof result?.token!=='string'||!result.token||/[\r\n]/.test(result.token)) throw new Error(`${label} managed identity returned no token`);
    return result.token;
  };
}
function validateConfig(env) {
  const missing=[]; const values={};
  for(const name of REQUIRED) values[name]=read(env,name,missing);
  for(const [key,name] of Object.entries(SECRET_NAMES)) values[name]=read(env,name,missing);
  if(missing.length) throw new Error(`missing ACI pilot dependency configuration: ${[...new Set(missing)].sort().join(', ')}`);
  for(const name of ['THESIS_ACI_SUBSCRIPTION_ID','THESIS_ACI_P1_IDENTITY_CLIENT_ID','THESIS_ACI_P1_PRINCIPAL_OBJECT_ID',
    'THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID','THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID','THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID',
    'THESIS_ACI_CONTROLLER_PRINCIPAL_OBJECT_ID','THESIS_ACI_FIXTURE_VERIFIER_PRINCIPAL_OBJECT_ID',
    'THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID','THESIS_LOG_ANALYTICS_WORKSPACE_ID','THESIS_EVIDENCE_IDENTITY_CLIENT_ID',
    'THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID'])
    if(!GUID.test(values[name])) throw new Error(`${name} must be a GUID`);
  const clientIds=['THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID','THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID',
    'THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID','THESIS_EVIDENCE_IDENTITY_CLIENT_ID','THESIS_ACI_P1_IDENTITY_CLIENT_ID']
    .map(name=>values[name].toLowerCase());
  if(new Set(clientIds).size!==clientIds.length)
    throw new Error('controller, fixture verifier, audit, evidence writer, and P1 workload managed identities must be distinct');
  const principalIds=['THESIS_ACI_CONTROLLER_PRINCIPAL_OBJECT_ID','THESIS_ACI_FIXTURE_VERIFIER_PRINCIPAL_OBJECT_ID',
    'THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID','THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID','THESIS_ACI_P1_PRINCIPAL_OBJECT_ID']
    .map(name=>values[name].toLowerCase());
  if(new Set(principalIds).size!==principalIds.length)
    throw new Error('controller, fixture verifier, audit, evidence writer, and P1 workload principals must be distinct');
  if(!ARM_ID.test(values.THESIS_ACI_PULL_IDENTITY_RESOURCE_ID)||!ARM_ID.test(values.THESIS_ACI_P1_IDENTITY_RESOURCE_ID)||
    values.THESIS_ACI_PULL_IDENTITY_RESOURCE_ID.toLowerCase()===values.THESIS_ACI_P1_IDENTITY_RESOURCE_ID.toLowerCase())
    throw new Error('ACI pull and workload identity ARM IDs must be valid and distinct');
  if(!/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/i.test(values.THESIS_ACI_SUBNET_ID))
    throw new Error('THESIS_ACI_SUBNET_ID must be a subnet ARM ID');
  if(!/@sha256:[a-f0-9]{64}$/i.test(values.THESIS_ACI_IMAGE_DIGEST_REFERENCE)) throw new Error('ACI image reference must be pinned by digest');
  if(!/^[a-z0-9-]+\.azurecr\.io$/i.test(values.THESIS_ACI_REGISTRY_SERVER)) throw new Error('invalid ACI registry server');
  if(!/^[A-Za-z0-9_.()\-]{1,90}$/.test(values.THESIS_ACI_RESOURCE_GROUP)) throw new Error('invalid ACI resource group');
  for(const name of ['THESIS_ACI_RESEARCH_URL','THESIS_ACI_COLLECTOR_URL']) values[name]=safeUrl(values[name],name);
  values.THESIS_FIXTURE_BLOB_ENDPOINT=safeUrl(values.THESIS_FIXTURE_BLOB_ENDPOINT,'THESIS_FIXTURE_BLOB_ENDPOINT',{blob:true});
  if(!/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/[a-z0-9]{3,24}\/blobServices\/default$/i.test(values.THESIS_BLOB_RESOURCE_ID))
    throw new Error('THESIS_BLOB_RESOURCE_ID must be a storage Blob service ARM ID');
  if(new URL(values.THESIS_FIXTURE_BLOB_ENDPOINT).hostname!==`${values.THESIS_BLOB_RESOURCE_ID.split('/')[8]}.blob.core.windows.net`)
    throw new Error('fixture Blob endpoint does not match THESIS_BLOB_RESOURCE_ID');
  if(values.THESIS_EVIDENCE_RETENTION_APPROVED!=='true') throw new Error('institution-approved evidence retention is not asserted');
  if(!/^[1-9]\d*$/.test(values.THESIS_EVIDENCE_RETENTION_DAYS)) throw new Error('THESIS_EVIDENCE_RETENTION_DAYS must be a positive integer');
  const evidenceUrl=safeUrl(values.THESIS_EVIDENCE_BLOB_CONTAINER_URL,'THESIS_EVIDENCE_BLOB_CONTAINER_URL');
  if(!/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/[a-z0-9]{3,24}\/blobServices\/default\/containers\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/i.test(values.THESIS_EVIDENCE_CONTAINER_RESOURCE_ID))
    throw new Error('THESIS_EVIDENCE_CONTAINER_RESOURCE_ID must be a container ARM ID');
  const evidenceParts=values.THESIS_EVIDENCE_CONTAINER_RESOURCE_ID.split('/');
  if(new URL(evidenceUrl).hostname!==`${evidenceParts[8]}.blob.core.windows.net`||new URL(evidenceUrl).pathname!==`/${evidenceParts[12]}`)
    throw new Error('evidence container URL does not match its Azure resource ID');
  values.THESIS_EVIDENCE_BLOB_CONTAINER_URL=evidenceUrl;
  let vault;try {vault=new URL(values.THESIS_KEY_VAULT_URI);} catch {throw new Error('THESIS_KEY_VAULT_URI must be a Key Vault URL');}
  if(vault.protocol!=='https:'||!/^[-a-z0-9]+\.vault\.azure\.net$/i.test(vault.hostname)||vault.pathname!=='/'||vault.search||vault.hash||vault.username||vault.password)
    throw new Error('THESIS_KEY_VAULT_URI must be a credential-free Azure Key Vault URL');
  values.THESIS_KEY_VAULT_URI=vault.origin;
  return values;
}

async function readVaultSecret({vaultUri,name,getToken,fetchImpl}) {
  if(!/^[A-Za-z0-9-]{1,127}$/.test(name||'')) throw new Error('invalid Key Vault secret name');
  const token=await getToken();
  let response;try {response=await fetchImpl(`${vaultUri}/secrets/${encodeURIComponent(name)}?api-version=7.4`,{
    headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});} catch {throw new Error(`Key Vault secret ${name} could not be retrieved`);}
  if(!response.ok) throw new Error(`Key Vault secret ${name} could not be retrieved (HTTP ${response.status})`);
  let body;try {body=await response.json();} catch {throw new Error(`Key Vault secret ${name} response was invalid`);}
  if(typeof body?.value!=='string'||body.value.length<8||/[\r\n]/.test(body.value)) throw new Error(`Key Vault secret ${name} is empty or invalid`);
  return body.value;
}

/**
 * @param {{rows:Array, env?:NodeJS.ProcessEnv, fetchImpl?:typeof fetch, components?:object}} options
 * components is a test seam for local wiring tests. Production defaults always
 * use Azure SDK managed identities and existing fail-closed Azure adapters.
 */
export default async function createAciP1PilotDependencies({rows,env=process.env,fetchImpl=fetch,components={}}={}) {
  validateRows(rows,components);
  const c={
    identity:makeIdentity,
    storageProvider:createManagedStorageTokenProvider,
    logsProvider:createManagedLogsTokenProvider,
    fixtureAdapter:createAzureFixtureAdapter,
    httpAdapter:createHttpPilotAdapter,
    groupClient:createAciContainerGroupClient,
    trialAdapter:createAciTrialAdapter,
    groupBody:buildAciContainerGroupBody,
    auditReader:createStorageAuditReader,
    blobVerifier:createAzureBlobVerifier,
    collectorVerifier:createCollectorVerifier,
    resourceVerifier:createResourceVerifier,
    collectorReader:createCollectorEvidenceReader,
    resourceReader:createResourceEvidenceReader,
    verifierRouter:createVerifierRouter,
    evidenceStore:createMeasuredEvidenceStoreFromEnvironment,
    readSecret:readVaultSecret,
    ...components
  };
  const hasLifecycle=rows.some(row=>['U6','U8'].includes(row?.scenario_id??row?.scenario));
  const cfg=validateConfig(env);
  if(hasLifecycle) {
    let approval=false;
    try {approval=await c.verifyMethodApproval(c.methodDecision);} catch {approval=false;}
    if(approval!==true) throw new Error('ACI U6/U8 method decision was not independently verified');
  }
  const controllerIdentity=c.identity(cfg.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID);
  const fixtureReaderIdentity=c.identity(cfg.THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID);
  const auditIdentity=c.identity(cfg.THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID);
  const getControllerStorageToken=c.storageProvider({clientId:cfg.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID,createCredential:()=>controllerIdentity});
  const getFixtureVerifierStorageToken=c.storageProvider({clientId:cfg.THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID,createCredential:()=>fixtureReaderIdentity});
  const getAuditToken=c.logsProvider({clientId:cfg.THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID,createCredential:()=>auditIdentity});
  const secret=async key=>c.readSecret({vaultUri:cfg.THESIS_KEY_VAULT_URI,name:cfg[SECRET_NAMES[key]],
    getToken:tokenFor(controllerIdentity,'https://vault.azure.net/.default','Key Vault'),fetchImpl});
  const [resourceAdmin,collectorAdmin,controllerKey,workloadToken,collectorVerifierKey,resourceVerifierKey]=await Promise.all([
    secret('resourceAdmin'),secret('collectorAdmin'),secret('controllerKey'),secret('workloadToken'),secret('collectorVerifier'),secret('resourceVerifier')]);

  const base=c.httpAdapter({resourceUrl:cfg.THESIS_ACI_RESEARCH_URL,collectorUrl:cfg.THESIS_ACI_COLLECTOR_URL,
    // The trial-specific agent URL is the private IP returned by ACI at runtime;
    // this base adapter is used only for fixture reset/collection.
    agentUrl:cfg.THESIS_ACI_RESEARCH_URL,resourceAdminToken:resourceAdmin,collectorAdminToken:collectorAdmin,controllerToken:controllerKey});
  const fixtureAdapter=c.fixtureAdapter({base,blobEndpoint:cfg.THESIS_FIXTURE_BLOB_ENDPOINT,
    getControllerToken:getControllerStorageToken,getVerifierToken:getFixtureVerifierStorageToken});
  const getManagementToken=tokenFor(controllerIdentity,'https://management.azure.com/.default','ACI controller');
  const groupClient=c.groupClient({subscriptionId:cfg.THESIS_ACI_SUBSCRIPTION_ID,resourceGroup:cfg.THESIS_ACI_RESOURCE_GROUP,
    getManagementToken,fetchImpl});
  const aciAdapter=c.trialAdapter({fixtureAdapter,groupClient,controllerToken:controllerKey,fetchImpl,
    ...(hasLifecycle?{sessionAnalog:c.sessionAnalog}:{}),
    groupBodyForTrial:async()=>c.groupBody({location:cfg.THESIS_ACI_LOCATION,
      imageDigestReference:cfg.THESIS_ACI_IMAGE_DIGEST_REFERENCE,registryServer:cfg.THESIS_ACI_REGISTRY_SERVER,
      pullIdentityId:cfg.THESIS_ACI_PULL_IDENTITY_RESOURCE_ID,workloadIdentityId:cfg.THESIS_ACI_P1_IDENTITY_RESOURCE_ID,
      workloadIdentityClientId:cfg.THESIS_ACI_P1_IDENTITY_CLIENT_ID,workloadPrincipalObjectId:cfg.THESIS_ACI_P1_PRINCIPAL_OBJECT_ID,
      blobResourceId:cfg.THESIS_BLOB_RESOURCE_ID,subnetId:cfg.THESIS_ACI_SUBNET_ID,
      researchUrl:cfg.THESIS_ACI_RESEARCH_URL,collectorUrl:cfg.THESIS_ACI_COLLECTOR_URL,
      blobEndpoint:cfg.THESIS_FIXTURE_BLOB_ENDPOINT,workloadToken,trialRequestKey:controllerKey})});
  const adapter=aciAdapter;

  const readAudit=c.auditReader({workspaceId:cfg.THESIS_LOG_ANALYTICS_WORKSPACE_ID,getToken:getAuditToken});
  const blobVerifier=c.blobVerifier({readAudit,principalForTrial:()=>cfg.THESIS_ACI_P1_PRINCIPAL_OBJECT_ID,
    blobEndpoint:cfg.THESIS_FIXTURE_BLOB_ENDPOINT,blobResourceId:env.THESIS_BLOB_RESOURCE_ID,
    workspaceId:cfg.THESIS_LOG_ANALYTICS_WORKSPACE_ID,pilotMode:true,
    auditPipelineValidated:false,authorizationValidated:false,clockSyncValidated:false});
  const collectorVerifier=c.collectorVerifier({readCollector:async trial=>c.collectorReader({
    collectorUrl:cfg.THESIS_ACI_COLLECTOR_URL,verifierKey:collectorVerifierKey})(trial.runId),pilotMode:true});
  const resourceVerifier=c.resourceVerifier({readResource:async trial=>c.resourceReader({
    resourceUrl:cfg.THESIS_ACI_RESEARCH_URL,verifierKey:resourceVerifierKey})(trial.runId),pilotMode:true});
  const verifier=c.verifierRouter({blobVerifier,collectorVerifier,resourceVerifier,
    ...(hasLifecycle?{sessionAnalogVerifier:c.sessionAnalogVerifier}:{})});
  const evidenceStore=await c.evidenceStore({env:{...env,THESIS_TOKEN_PROVIDER_MODE:'managed_identity'},fetchImpl});
  return {adapter,verifier,evidenceStore};
}

export {validateRows as validateAciP1DependencyRows,validateConfig as validateAciP1DependencyConfig,readVaultSecret};
