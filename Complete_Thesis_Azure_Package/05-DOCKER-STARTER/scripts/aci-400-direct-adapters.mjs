/**
 * Compose already-supported ACI lifecycle adapters for the 400-row runner.
 *
 * This module only creates route adapters. It deliberately does not construct
 * or return a verifier, evidence store, readiness assertion, or U6/U8 analogue.
 * Those remain separate runner dependencies and must pass their existing
 * evidence gates before any measured row can be claimed.
 */
import {ManagedIdentityCredential} from '@azure/identity';
import {createManagedStorageTokenProvider} from './azure-managed-token.mjs';
import {createAzureFixtureAdapter} from './azure-fixture-adapter.mjs';
import {createHttpPilotAdapter} from './http-pilot-adapter.mjs';
import {createAciContainerGroupClient,createAciTrialAdapter,buildAciContainerGroupBody} from './aci-container-group-runtime.mjs';
import {createAciBlobSessionAnalog} from './aci-blob-session-analog.mjs';
import {createAciBlobSessionIndependentVerifier} from './aci-blob-session-independent-verifier.mjs';
import {createAzureEffectiveBlobAccessReviewer} from './azure-effective-blob-access-reviewer.mjs';
import {createAzureManagedIdentityCredentialPathReviewer} from './azure-managed-identity-credential-path-reviewer.mjs';
import {createAciMarkerProofEvidenceRuntime} from './aci-marker-proof-evidence-runtime.mjs';
import {createAciAzureLifecycleObserver} from './aci-azure-lifecycle-observer.mjs';
import {createManagedLogsTokenProvider} from './azure-managed-logs-token.mjs';
import {createStorageAuditReader} from './azure-storage-audit-reader.mjs';
import {fingerprintProtectedEvidenceSnapshot} from './azure-versioned-protected-evidence.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARM_ID=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9._()-]+$/i;
const PROFILES=['P1','P2'];

function required(env,name) {
  const value=env[name];
  if(typeof value!=='string'||!value.trim()||/[\r\n]/.test(value)) throw new Error(`missing or invalid ACI adapter setting ${name}`);
  return value.trim();
}

function tokenFor(credential,name) {
  return async()=>{
    let result;
    try {result=await credential.getToken('https://management.azure.com/.default');}
    catch {throw new Error(`${name} managed identity unavailable`);}
    if(typeof result?.token!=='string'||!result.token||/[\r\n]/.test(result.token))
      throw new Error(`${name} managed identity returned no token`);
    return result.token;
  };
}

function tokenForPrincipal(credential,name,principalId) {
  const getToken=tokenFor(credential,name);
  return async()=>{
    const value=await getToken();
    let claims;
    try {claims=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString('utf8'));} catch {}
    if(claims?.oid?.toLowerCase()!==principalId.toLowerCase())
      throw new Error(`${name} token principal does not match its configured audit identity`);
    return value;
  };
}

/** Build read-only lifecycle, Log Analytics, and protected-evidence readers from the configured MSI identities. */
export function createAci400AzureEvidenceReaders({env=process.env,fetchImpl=fetch,components={}}={}) {
  const c={identity:clientId=>new ManagedIdentityCredential({clientId}),proofRuntime:createAciMarkerProofEvidenceRuntime,
    logsTokenProvider:createManagedLogsTokenProvider,auditReader:createStorageAuditReader,lifecycleObserver:createAciAzureLifecycleObserver,
    ...components};
  const proofRuntime=c.proofRuntime({env,fetchImpl,retentionAuthority:{basis:'owner_directed',
    scope:'aci_400_study_evidence_only',reference:'file:docs/ACI-400-OWNER-DIRECTED-RETENTION.md'}});
  const auditIdentity=c.identity(required(env,'THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID'));
  const auditPrincipalId=required(env,'THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID');
  if(!GUID.test(auditPrincipalId)||auditPrincipalId.toLowerCase()!==proofRuntime.observerPrincipalId.toLowerCase())
    throw new Error('ACI audit principal does not match the protected-evidence reader identity');
  const getAuditManagementToken=tokenForPrincipal(auditIdentity,'ACI independent audit observer',auditPrincipalId);
  const getAuditLogsToken=c.logsTokenProvider({clientId:required(env,'THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID'),createCredential:()=>auditIdentity});
  const readAudit=c.auditReader({workspaceId:required(env,'THESIS_LOG_ANALYTICS_WORKSPACE_ID'),getToken:getAuditLogsToken});
  const lifecycleObserver=c.lifecycleObserver({subscriptionId:required(env,'THESIS_ACI_SUBSCRIPTION_ID'),
    resourceGroup:required(env,'THESIS_ACI_RESOURCE_GROUP'),getManagementToken:getAuditManagementToken,fetchImpl,
    observerPrincipalId:auditPrincipalId,persistSnapshot:proofRuntime.writeProtectedSnapshot,
    loadProtectedEvidence:proofRuntime.loadProtectedEvidence});
  async function readStorageBlobLogs({requestId,from,to,runId,scenario,observerPrincipalId}) {
    if(observerPrincipalId?.toLowerCase()!==auditPrincipalId.toLowerCase()) throw new Error('Blob log reader principal mismatch');
    const startMs=Date.parse(from),endMs=Date.parse(to);
    if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||endMs<startMs) throw new Error('invalid independent Blob audit window');
    const rows=await readAudit({runId:requestId,startMs,endMs});
    const snapshot={schema:'azure_storage_blob_audit_snapshot_v1',runId,scenario,queryRequestId:requestId,
      readerPrincipalId:auditPrincipalId,from,to,rows};
    const persisted=await proofRuntime.writeProtectedSnapshot({snapshot,observerPrincipalId:auditPrincipalId});
    return {rows,evidenceReference:persisted.reference,queryRequestId:requestId,readerPrincipalId:auditPrincipalId};
  }
  async function readAciLifecycleEvidence(args) {
    const observation=await lifecycleObserver.readAciLifecycleEvidence({...args,observerPrincipalId:auditPrincipalId});
    const snapshot=observation?.snapshot;
    if(observation?.source!=='azure_aci_arm_activity_snapshot_v1'||observation.readOnly!==true||
      observation.observerPrincipalId?.toLowerCase()!==auditPrincipalId.toLowerCase()||
      snapshot?.runId!==args.runId||snapshot?.scenario!==args.scenario||
      observation.snapshotFingerprint!==fingerprintProtectedEvidenceSnapshot(snapshot))
      throw new Error('independent ACI lifecycle snapshot failed identity, trial, or hash validation');
    const persisted=await proofRuntime.writeProtectedSnapshot({snapshot,observerPrincipalId:auditPrincipalId});
    return {...observation,evidenceReference:persisted.reference};
  }
  return Object.freeze({proofRuntime,observeGroup:lifecycleObserver.observeGroup,observeGroupDeletion:lifecycleObserver.observeGroupDeletion,
    readAciLifecycleEvidence,readStorageBlobLogs,loadProtectedEvidence:proofRuntime.loadProtectedEvidence,
    observerPrincipalId:auditPrincipalId,requiredRetentionDays:proofRuntime.requiredRetentionDays,
    retentionBasis:proofRuntime.retentionBasis,retentionAuthorityReference:proofRuntime.retentionAuthorityReference});
}

function validateConfig(config,env) {
  const deployment=config?.deployments?.azure_container_instances;
  if(deployment?.kind!=='aci') throw new Error('validated ACI deployment config is required');
  const routes=new Map((config.routes??[]).filter(route=>route.deployment==='azure_container_instances')
    .map(route=>[route.profile,route]));
  const identity={};
  for(const profile of PROFILES) {
    const route=routes.get(profile);
    if(!route) throw new Error(`validated ACI ${profile} route config is required`);
    identity[profile]={
      route,
      resourceId:required(env,`THESIS_ACI_${profile}_IDENTITY_RESOURCE_ID`),
      clientId:required(env,`THESIS_ACI_${profile}_IDENTITY_CLIENT_ID`),
      principalId:required(env,`THESIS_ACI_${profile}_PRINCIPAL_OBJECT_ID`)
    };
    if(!ARM_ID.test(identity[profile].resourceId)||!GUID.test(identity[profile].clientId)||!GUID.test(identity[profile].principalId))
      throw new Error(`ACI ${profile} workload identity settings are invalid`);
    if(route.principalObjectId?.toLowerCase()!==identity[profile].principalId.toLowerCase())
      throw new Error(`ACI ${profile} workload principal does not match the validated route config`);
    for(const name of ['controller','resourceAdmin','collectorAdmin'])
      if(typeof route.credentials?.[name]!=='string'||route.credentials[name].length<8||/[\r\n]/.test(route.credentials[name]))
        throw new Error(`ACI ${profile} route credential ${name} is missing or invalid`);
  }
  const ids=[identity.P1.clientId,identity.P2.clientId];
  const principals=[identity.P1.principalId,identity.P2.principalId];
  if(new Set(ids.map(value=>value.toLowerCase())).size!==2||new Set(principals.map(value=>value.toLowerCase())).size!==2)
    throw new Error('ACI P1 and P2 must use separate workload identities');
  const pullIdentityId=required(env,'THESIS_ACI_PULL_IDENTITY_RESOURCE_ID');
  if(!ARM_ID.test(pullIdentityId)||PROFILES.some(profile=>pullIdentityId.toLowerCase()===identity[profile].resourceId.toLowerCase()))
    throw new Error('ACI ACR pull identity must be valid and distinct from both workload identities');
  const controllerClientId=required(env,'THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID');
  const fixtureVerifierClientId=required(env,'THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID');
  if(!GUID.test(controllerClientId)||!GUID.test(fixtureVerifierClientId)||
    new Set([controllerClientId,...ids,fixtureVerifierClientId].map(value=>value.toLowerCase())).size!==4)
    throw new Error('ACI controller, fixture verifier, and P1/P2 workload identities must be distinct');
  const subscriptionId=required(env,'THESIS_ACI_SUBSCRIPTION_ID');
  const resourceGroup=required(env,'THESIS_ACI_RESOURCE_GROUP');
  const location=required(env,'THESIS_ACI_LOCATION');
  const imageDigestReference=required(env,'THESIS_ACI_IMAGE_DIGEST_REFERENCE');
  const registryServer=required(env,'THESIS_ACI_REGISTRY_SERVER');
  const subnetId=required(env,'THESIS_ACI_SUBNET_ID');
  const blobEndpoint=required(env,'THESIS_FIXTURE_BLOB_ENDPOINT');
  const blobResourceId=required(env,'THESIS_BLOB_RESOURCE_ID');
  const keyVaultUri=required(env,'THESIS_KEY_VAULT_URI');
  const workloadTokenSecretName=required(env,'THESIS_ACI_WORKLOAD_TOKEN_SECRET_NAME');
  if(!GUID.test(subscriptionId)||!/^[A-Za-z0-9_.()\-]{1,90}$/.test(resourceGroup)||!/^[A-Za-z0-9]+$/.test(location))
    throw new Error('ACI subscription, resource group, or location setting is invalid');
  if(!/@sha256:[a-f0-9]{64}$/i.test(imageDigestReference)||!/^([a-z0-9-]+)\.azurecr\.io$/i.test(registryServer)||
    !imageDigestReference.toLowerCase().startsWith(`${registryServer.toLowerCase()}/`))
    throw new Error('ACI image reference must be digest-pinned in the configured registry');
  if(!/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/i.test(subnetId))
    throw new Error('ACI subnet setting must be a subnet resource ID');
  const blobMatch=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})\/blobServices\/default$/i.exec(blobResourceId);
  let blobUrl,keyVaultUrl;
  try {blobUrl=new URL(blobEndpoint);keyVaultUrl=new URL(keyVaultUri);}
  catch {throw new Error('ACI Blob endpoint or Key Vault URI is invalid');}
  if(!blobMatch||blobUrl.protocol!=='https:'||blobUrl.hostname!==`${blobMatch[1]}.blob.core.windows.net`||
    blobUrl.pathname!=='/'||blobUrl.search||blobUrl.hash||blobUrl.username||blobUrl.password)
    throw new Error('ACI fixture Blob endpoint does not match its Blob service resource ID');
  if(keyVaultUrl.protocol!=='https:'||!/^[-a-z0-9]+\.vault\.azure\.net$/i.test(keyVaultUrl.hostname)||
    keyVaultUrl.pathname!=='/'||keyVaultUrl.search||keyVaultUrl.hash||keyVaultUrl.username||keyVaultUrl.password)
    throw new Error('ACI Key Vault URI is invalid');
  return {deployment,identity,pullIdentityId,controllerClientId,fixtureVerifierClientId,subscriptionId,resourceGroup,
    location,imageDigestReference,registryServer,subnetId,blobEndpoint,blobResourceId,
    keyVaultUri:keyVaultUrl.origin,workloadTokenSecretName};
}

async function readWorkloadToken({vaultUri,name,getToken,fetchImpl}) {
  if(!/^[A-Za-z0-9-]{1,127}$/.test(name)) throw new Error('invalid ACI workload token secret name');
  let response;
  try {response=await fetchImpl(`${vaultUri.replace(/\/$/,'')}/secrets/${encodeURIComponent(name)}?api-version=7.4`,{
    headers:{authorization:`Bearer ${await getToken()}`},redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch {throw new Error('ACI workload token could not be retrieved from Key Vault');}
  if(!response.ok) throw new Error(`ACI workload token could not be retrieved from Key Vault (HTTP ${response.status})`);
  let body;try {body=await response.json();} catch {throw new Error('ACI workload token Key Vault response was invalid');}
  if(typeof body?.value!=='string'||body.value.length<16||/[\r\n]/.test(body.value))
    throw new Error('ACI workload token Key Vault value is invalid');
  return body.value;
}

/**
 * Return direct adapter instances keyed by route. No verifier or readiness
 * assertion is supplied here; the 400-row runner composes those independently.
 * Components are an explicit seam for wiring checks and do not alter defaults.
 */
export async function createAci400DirectAdapters({config,env=process.env,fetchImpl=fetch,components={},sessionAnalog}={}) {
  if(typeof fetchImpl!=='function') throw new Error('ACI adapter fetch implementation is required');
  if(sessionAnalog!==undefined&&typeof sessionAnalog!=='function') throw new Error('ACI cross-group analogue callback must be a function');
  const cfg=validateConfig(config,env);
  const c={
    identity:clientId=>new ManagedIdentityCredential({clientId}),
    storageTokenProvider:createManagedStorageTokenProvider,
    fixtureAdapter:createAzureFixtureAdapter,
    httpAdapter:createHttpPilotAdapter,
    groupClient:createAciContainerGroupClient,
    trialAdapter:createAciTrialAdapter,
    groupBody:buildAciContainerGroupBody,
    readWorkloadToken,
    ...components
  };
  const controllerIdentity=c.identity(cfg.controllerClientId);
  const verifierIdentity=c.identity(cfg.fixtureVerifierClientId);
  const getControllerStorageToken=c.storageTokenProvider({clientId:cfg.controllerClientId,createCredential:()=>controllerIdentity});
  const getVerifierStorageToken=c.storageTokenProvider({clientId:cfg.fixtureVerifierClientId,createCredential:()=>verifierIdentity});
  const getManagementToken=tokenFor(controllerIdentity,'ACI controller');
  const workloadToken=await c.readWorkloadToken({vaultUri:cfg.keyVaultUri,name:cfg.workloadTokenSecretName,
    getToken:tokenFor(controllerIdentity,'ACI Key Vault reader'),fetchImpl});
  const groupClient=c.groupClient({subscriptionId:cfg.subscriptionId,resourceGroup:cfg.resourceGroup,getManagementToken,fetchImpl});
  const adapters={};
  for(const profile of PROFILES) {
    const {route,resourceId,clientId,principalId}=cfg.identity[profile];
    const base=c.httpAdapter({resourceUrl:cfg.deployment.resourceUrl,collectorUrl:cfg.deployment.collectorUrl,
      agentUrl:cfg.deployment.resourceUrl,resourceAdminToken:route.credentials.resourceAdmin,
      collectorAdminToken:route.credentials.collectorAdmin,controllerToken:route.credentials.controller,
      timeoutMs:cfg.deployment.timeoutMs});
    const fixtureAdapter=c.fixtureAdapter({base,blobEndpoint:cfg.blobEndpoint,
      getControllerToken:getControllerStorageToken,getVerifierToken:getVerifierStorageToken});
    adapters[`azure_container_instances:${profile}`]=c.trialAdapter({fixtureAdapter,groupClient,
      controllerToken:route.credentials.controller,fetchImpl,timeoutMs:cfg.deployment.timeoutMs??30000,
      ...(sessionAnalog?{sessionAnalog}:{}),
      groupBodyForTrial:async trial=>{
        if(trial?.deployment!=='azure_container_instances'||trial.profile!==profile)
          throw new Error(`ACI ${profile} adapter rejected a trial for another route`);
        return c.groupBody({location:cfg.location,imageDigestReference:cfg.imageDigestReference,
          registryServer:cfg.registryServer,pullIdentityId:cfg.pullIdentityId,workloadIdentityId:resourceId,
          workloadIdentityClientId:clientId,workloadPrincipalObjectId:principalId,blobResourceId:cfg.blobResourceId,
          subnetId:cfg.subnetId,researchUrl:cfg.deployment.resourceUrl,collectorUrl:cfg.deployment.collectorUrl,
          blobEndpoint:cfg.blobEndpoint,workloadToken,trialRequestKey:route.credentials.controller});
      }});
  }
  return adapters;
}

/**
 * Compose the ACI adapter and independent U6/U8 verifier into the runner deps
 * object. The caller must provide the existing Azure callback composition and
 * separate verifier readers; neither path has a permissive default.
 */
export async function createAci400LiveDependencies({config,env=process.env,rows,fetchImpl=fetch,
  components={},analogueCallbacks,independentVerifierOptions,azureEvidenceReaderOptions}={}) {
  if(!Array.isArray(rows)||rows.length===0) throw new Error('selected scheduled rows are required for ACI live dependency composition');
  const aciRows=rows.filter(row=>row?.deployment==='azure_container_instances');
  if(!aciRows.length) throw new Error('selected schedule has no ACI rows');
  if(aciRows.some(row=>!PROFILES.includes(row.permission_profile??row.profile)))
    throw new Error('selected ACI rows contain an unsupported profile');
  const lifecycleRows=aciRows.some(row=>['U6','U8'].includes(row.scenario_id??row.scenario));
  let sessionAnalog,sessionAnalogVerifier,azureEvidenceReaders;
  if(lifecycleRows) {
    if(azureEvidenceReaderOptions) {
      azureEvidenceReaders=createAci400AzureEvidenceReaders({env,fetchImpl,components:azureEvidenceReaderOptions.components});
      analogueCallbacks={...analogueCallbacks,observeGroup:analogueCallbacks?.observeGroup??azureEvidenceReaders.observeGroup,
        observeGroupDeletion:analogueCallbacks?.observeGroupDeletion??azureEvidenceReaders.observeGroupDeletion};
      independentVerifierOptions={...independentVerifierOptions,observerPrincipalId:azureEvidenceReaders.observerPrincipalId,
        requiredRetentionDays:azureEvidenceReaders.requiredRetentionDays,readStorageBlobLogs:azureEvidenceReaders.readStorageBlobLogs,
        loadProtectedEvidence:azureEvidenceReaders.loadProtectedEvidence,readAciLifecycleEvidence:azureEvidenceReaders.readAciLifecycleEvidence};
    }
    if(!analogueCallbacks||!independentVerifierOptions)
      throw new Error('ACI U6/U8 rows require the Azure cross-group analogue and independent verifier callbacks');
    sessionAnalog=createAciBlobSessionAnalog(analogueCallbacks);
    sessionAnalogVerifier=createAciBlobSessionIndependentVerifier(independentVerifierOptions);
    if(sessionAnalog===sessionAnalogVerifier) throw new Error('ACI U6/U8 analogue and independent verifier must be separate implementations');
  }
  const aciAdapters=await createAci400DirectAdapters({config,env,fetchImpl,components,sessionAnalog});
  return Object.freeze({aciAdapters,...(sessionAnalogVerifier?{sessionAnalogVerifier}:{}),
    ...(azureEvidenceReaders?{azureEvidenceReaders}:{})});
}

/**
 * Compose the existing fail-closed Blob access reviewer with the new Graph
 * credential inventory. Azure control-plane identity-attachment review is a
 * required independent callback; when it is unavailable, RBAC review fails.
 */
export function createAci400EffectiveAccessReviewer({getManagementToken,getGraphToken,observerPrincipalId,
  persistSnapshot,reviewAzureAttachPaths,fetchImpl=fetch,now=()=>Date.now()}={}) {
  const reviewCredentialPaths=createAzureManagedIdentityCredentialPathReviewer({getGraphToken,observerPrincipalId,
    persistSnapshot,reviewAzureAttachPaths,fetchImpl,now});
  return createAzureEffectiveBlobAccessReviewer({getManagementToken,getGraphToken,observerPrincipalId,
    reviewCredentialPaths,persistSnapshot,fetchImpl,now});
}

export default createAci400DirectAdapters;
