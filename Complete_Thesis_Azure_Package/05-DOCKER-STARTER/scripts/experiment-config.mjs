/**
 * Deployment configuration for the measured experiment.
 *
 * The config file never contains a secret. Every credential field names the
 * environment variable that holds the value, so the file can be committed,
 * reviewed and diffed while the values stay in the operator's environment.
 */
import {readFile} from 'node:fs/promises';
import {validateCustomSessionEndpoint} from './session-endpoint.mjs';

export const DEPLOYMENTS=['azure_vm','azure_functions_flex'];
export const SUPPORTED_DEPLOYMENTS=[...DEPLOYMENTS,'azure_container_instances','azure_custom_sessions_hyperv',
  'azure_container_apps_jobs','azure_container_apps_sandboxes'];
export const PROFILES=['P1','P2','P3'];
// The selected revision-3 plan remains VM+Functions; alternate plans are explicit config inputs.
export const EXPERIMENT_ROUTES=DEPLOYMENTS.flatMap(deployment=>PROFILES.map(profile=>`${deployment}:${profile}`));
export const REVISION_3_ROUTES=['azure_vm','azure_functions_flex'].flatMap(deployment=>PROFILES.map(profile=>`${deployment}:${profile}`));
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME=/^[A-Z][A-Z0-9_]{2,80}$/;
const KINDS=['http','session','aci','aca_job','aca_sandbox'];
const LOCAL_HOSTS=['127.0.0.1','localhost','[::1]'];
const CREDENTIAL_KEYS={http:['controller','resourceAdmin','collectorAdmin'],session:['controller','resourceAdmin','collectorAdmin'],
  aci:['controller','resourceAdmin','collectorAdmin'],aca_job:['resourceAdmin','collectorAdmin'],aca_sandbox:['resourceAdmin','collectorAdmin']};

function httpsUrl(value,name,{optional=false}={}) {
  if(optional && (value===undefined || value===null)) return undefined;
  let url;
  try {url=new URL(value);} catch {throw new Error(`${name} must be an absolute URL`);}
  if(url.username || url.password) throw new Error(`${name} must not embed credentials`);
  if(url.search || url.hash) throw new Error(`${name} must not carry a query or fragment`);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && LOCAL_HOSTS.includes(url.hostname)))
    throw new Error(`${name} must use HTTPS (plain HTTP is accepted only for loopback)`);
  return url.href.replace(/\/$/,'');
}

function restrictedServiceUrl(entry,name,collectorUrl,required) {
  const value=entry.restrictedUrl;
  if(value===undefined) {
    if(required) throw new Error(`deployments.${name}.restrictedUrl is required when U7 is scheduled`);
    return undefined;
  }
  const url=httpsUrl(value,`deployments.${name}.restrictedUrl`);
  const parsed=new URL(url);
  if(parsed.pathname!=='/') throw new Error(`deployments.${name}.restrictedUrl must be a base URL`);
  const collectorHost=new URL(collectorUrl).hostname.toLowerCase();
  const restrictedHost=parsed.hostname.toLowerCase();
  const localTargets=LOCAL_HOSTS.includes(restrictedHost)&&LOCAL_HOSTS.includes(collectorHost);
  if(!localTargets&&restrictedHost===collectorHost)
    throw new Error(`deployments.${name}.restrictedUrl must use a separate host from collectorUrl`);
  return url;
}

/** A credential value must be the NAME of an environment variable, never the secret. */
function credentialRef(value,where) {
  if(typeof value!=='string' || !ENV_NAME.test(value))
    throw new Error(`${where} must name an environment variable in UPPER_SNAKE_CASE, not hold the secret`);
  return value;
}

function requireObject(value,where) {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value;
}

const SAFE_SEGMENT=/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
function safeSegment(value,where) {
  if(typeof value!=='string'||!SAFE_SEGMENT.test(value)||value.includes('..')) throw new Error(`${where} must be a safe resource name`);
  return value;
}
function resourceGroupName(value,where) {
  if(typeof value!=='string'||value.length<1||value.length>90||! /^[A-Za-z0-9._()-]+$/.test(value)||value.includes('..'))
    throw new Error(`${where} must be a safe resource group name`);
  return value;
}
function uaiResourceId(value,where) {
  if(typeof value!=='string') throw new Error(`${where} must be a full user-assigned identity resource ID`);
  const parts=value.split('/');
  if(parts.length!==9||parts[0]!==''||parts[1].toLowerCase()!=='subscriptions'||!GUID.test(parts[2])||
    parts[3].toLowerCase()!=='resourcegroups'||parts[5].toLowerCase()!=='providers'||
    parts[6].toLowerCase()!=='microsoft.managedidentity'||parts[7].toLowerCase()!=='userassignedidentities')
    throw new Error(`${where} must be a full user-assigned identity resource ID`);
  resourceGroupName(parts[4],`${where}.resourceGroup`);safeSegment(parts[8],`${where}.name`);
  return value;
}
function pinnedImage(value,where) {
  if(typeof value!=='string'||value.length>512||value.includes('://')||!/@sha256:[a-f0-9]{64}$/i.test(value)||
    /\s/.test(value)||value.includes('?')||value.includes('#'))
    throw new Error(`${where} must be a pinned OCI image digest`);
  return value;
}
function profileNames(value,where) {
  const input=requireObject(value,where),result={};
  const names=new Set();
  for(const profile of PROFILES) {
    const name=safeSegment(input[profile],`${where}.${profile}`);
    if(names.has(name)) throw new Error(`${where} values must be distinct across profiles`);
    names.add(name);result[profile]=name;
  }
  return result;
}
function sessionDataStore(entry,where,required) {
  if(entry.sessionDataStore===undefined) {
    if(required) throw new Error(`${where}.sessionDataStore must be azure_blob_external_namespace when U6/U8 is scheduled`);
    return undefined;
  }
  if(entry.sessionDataStore!=='azure_blob_external_namespace')
    throw new Error(`${where}.sessionDataStore must be azure_blob_external_namespace`);
  return entry.sessionDataStore;
}
function keyVaultSecretUri(value,where) {
  let url;
  try {url=new URL(value);} catch {throw new Error(`${where} must be an HTTPS Azure Key Vault secret URI`);}
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.protocol!=='https:'||! /^[a-z0-9-]{3,24}\.vault\.azure\.net$/i.test(url.hostname)||url.username||url.password||url.port||
    url.search||url.hash||parts.length<2||parts.length>3||parts[0]!=='secrets'||
    !/^[A-Za-z0-9-]{1,127}$/.test(decodeURIComponent(parts[1]))||
    (parts.length===3&&!/^[A-Za-z0-9-]{1,128}$/.test(decodeURIComponent(parts[2]))))
    throw new Error(`${where} must be an HTTPS Azure Key Vault secret URI`);
  return url.href.replace(/\/$/,'');
}
function jobResources(value,where) {
  const resource=requireObject(value,where);
  if(typeof resource.cpu!=='number'||!Number.isFinite(resource.cpu)||resource.cpu<=0||resource.cpu>16||
    typeof resource.memory!=='string'||!/^\d+(?:\.\d+)?(?:Mi|Gi)$/.test(resource.memory))
    throw new Error(`${where} must include valid ACA Jobs cpu and memory`);
  return {cpu:resource.cpu,memory:resource.memory};
}
function sandboxResources(value,where) {
  const resource=requireObject(value,where);
  if(typeof resource.cpu!=='string'||!/^\d+(?:m|vCPU)$/.test(resource.cpu)||
    typeof resource.memory!=='string'||!/^\d+(?:Mi|Gi)$/.test(resource.memory)||
    typeof resource.disk!=='string'||!/^\d+(?:Mi|Gi)$/.test(resource.disk))
    throw new Error(`${where} must include valid Sandbox cpu, memory, and disk`);
  return {cpu:resource.cpu,memory:resource.memory,disk:resource.disk};
}

/**
 * Validate the shape of a deployment document. Throws on the first problem and
 * names the field, because a misconfigured route is discovered mid-experiment
 * otherwise — after spend has already happened.
 */
export function validateExperimentConfig(raw,{requiredRoutes=REVISION_3_ROUTES,requiredScenarios=[]}={}) {
  const config=requireObject(raw,'config');
  if(typeof config.evidenceDirectory!=='string' || !config.evidenceDirectory.trim())
    throw new Error('evidenceDirectory is required');
  // Traffic analytics processes flow logs on a 60-minute default interval and Microsoft
  // states ingestion "can take up to 1 hour", so a window under an hour cannot see the
  // record it is looking for. The default matches that documented latency.
  const auditWindowSeconds=config.auditWindowSeconds ?? 3600;
  if(!Number.isInteger(auditWindowSeconds) || auditWindowSeconds<60 || auditWindowSeconds>7200)
    throw new Error('auditWindowSeconds must be an integer between 60 and 7200 (ingestion can take up to 1 hour)');
  if(!Array.isArray(config.routes)) throw new Error('routes must be an array');
  if(!Array.isArray(requiredRoutes) || !requiredRoutes.length || new Set(requiredRoutes).size!==requiredRoutes.length)
    throw new Error('requiredRoutes must be a non-empty list of unique deployment/profile keys');
  const knownScenarios=['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'];
  if(!Array.isArray(requiredScenarios)||new Set(requiredScenarios).size!==requiredScenarios.length||
    requiredScenarios.some(scenario=>!knownScenarios.includes(scenario)))
    throw new Error('requiredScenarios must be a list of unique known scenario IDs');
  const restrictedServiceRequired=requiredScenarios.includes('U7');
  const externalNamespaceRequired=requiredScenarios.some(scenario=>scenario==='U6'||scenario==='U8');
  const aciProtocol=requiredRoutes.some(key=>key.startsWith('azure_container_instances:'));
  const sessionProtocol=requiredRoutes.some(key=>key.startsWith('azure_custom_sessions_hyperv:'));
  const azureThreeArmProtocol=requiredRoutes.some(key=>key.startsWith('azure_container_apps_jobs:')||key.startsWith('azure_container_apps_sandboxes:'));
  if(config.routes.length<requiredRoutes.length || (aciProtocol&&config.routes.length!==requiredRoutes.length))
    throw new Error(requiredRoutes.length===REVISION_3_ROUTES.length&&requiredRoutes.every((key,index)=>key===REVISION_3_ROUTES[index])
      ?`exactly ${REVISION_3_ROUTES.length} revision-3 routes are required, got ${config.routes.length}`
      :aciProtocol?`exactly ${requiredRoutes.length} ACI draft routes are required, got ${config.routes.length}`
      :`at least ${requiredRoutes.length} scheduled deployment/profile routes are required, got ${config.routes.length}`);
  const allowedConfigRouteKeys=new Set([...REVISION_3_ROUTES,...requiredRoutes]);
  if(config.routes.some(route=>!allowedConfigRouteKeys.has(`${route?.deployment}:${route?.profile}`))) {
    const revision3Default=requiredRoutes.length===REVISION_3_ROUTES.length&&requiredRoutes.every((key,index)=>key===REVISION_3_ROUTES[index]);
    if(revision3Default) throw new Error(`exactly ${REVISION_3_ROUTES.length} revision-3 routes are required, got ${config.routes.length}`);
    throw new Error('config contains a deployment/profile route not selected by the protocol');
  }

  const deployments={};
  const configuredDeploymentNames=[...new Set(config.routes.map(route=>route?.deployment).filter(name=>typeof name==='string'))];
  for(const name of configuredDeploymentNames) {
    const entry=requireObject(config.deployments?.[name],`deployments.${name}`);
    if(!KINDS.includes(entry.kind)) throw new Error(`deployments.${name}.kind must be one of ${KINDS.join(', ')}`);
    if(entry.kind==='http') {
      const agentUrl=entry.agentUrl===undefined?undefined:httpsUrl(entry.agentUrl,`deployments.${name}.agentUrl`);
      if(name==='azure_vm' && !agentUrl) throw new Error(`deployments.${name}.agentUrl is required`);
      const resourceUrl=httpsUrl(entry.resourceUrl,`deployments.${name}.resourceUrl`);
      const collectorUrl=httpsUrl(entry.collectorUrl,`deployments.${name}.collectorUrl`);
      const restrictedUrl=restrictedServiceUrl(entry,name,collectorUrl,restrictedServiceRequired);
      const dataStore=sessionDataStore(entry,`deployments.${name}`,externalNamespaceRequired);
      deployments[name]={kind:'http',...(agentUrl?{agentUrl}:{}),resourceUrl,collectorUrl,
        ...(restrictedUrl?{restrictedUrl}:{}),...(dataStore?{sessionDataStore:dataStore}:{}),
        ...(Number.isInteger(entry.timeoutMs)?{timeoutMs:entry.timeoutMs}:{})};
    } else if(entry.kind==='session') {
      if(name!=='azure_custom_sessions_hyperv' || !sessionProtocol) throw new Error(`deployments.${name}.kind session requires an explicitly selected session route`);
      const pools=requireObject(entry.profilePools,`deployments.${name}.profilePools`);
      const profilePools={};
      const endpoints=new Set();
      for(const profile of config.routes.filter(r=>r?.deployment===name).map(r=>r.profile)) {
        if(!PROFILES.includes(profile)) throw new Error(`invalid session profile`);
        const pool=requireObject(pools[profile],`deployments.${name}.profilePools.${profile}`);
        const url=httpsUrl(pool.managementEndpoint,`deployments.${name}.profilePools.${profile}.managementEndpoint`);
        let managementEndpoint;
        try {managementEndpoint=validateCustomSessionEndpoint(`${url}/`,{poolName:pool.poolName,region:pool.region}).href.replace(/\/$/,'');}
        catch (error) {throw new Error(`deployments.${name}.profilePools.${profile} ${error.message}`);}
        if(endpoints.has(managementEndpoint.toLowerCase())) throw new Error('session profiles must use distinct pool endpoints');
        endpoints.add(managementEndpoint.toLowerCase());
        profilePools[profile]={poolName:pool.poolName,region:pool.region,managementEndpoint};
      }
      const sessionRegistryUrl=httpsUrl(entry.sessionRegistryUrl,`deployments.${name}.sessionRegistryUrl`);
      if(new URL(sessionRegistryUrl).pathname!=='/session-mappings')
        throw new Error(`deployments.${name}.sessionRegistryUrl must target the dedicated /session-mappings container`);
      const resourceUrl=httpsUrl(entry.resourceUrl,`deployments.${name}.resourceUrl`);
      const collectorUrl=httpsUrl(entry.collectorUrl,`deployments.${name}.collectorUrl`);
      const restrictedUrl=restrictedServiceUrl(entry,name,collectorUrl,restrictedServiceRequired);
      deployments[name]={kind:'session',profilePools,resourceUrl,collectorUrl,
        ...(restrictedUrl?{restrictedUrl}:{}),sessionRegistryUrl,
        fixtureBlobEndpoint:httpsUrl(entry.fixtureBlobEndpoint,`deployments.${name}.fixtureBlobEndpoint`),
        headerIsolationVerified:entry.headerIsolationVerified===true,
        ...(Number.isInteger(entry.timeoutMs)?{timeoutMs:entry.timeoutMs}:{})};
    } else if(entry.kind==='aci') {
      if(name!=='azure_container_instances') throw new Error(`deployments.${name}.kind aci is only valid for azure_container_instances`);
      const region=typeof entry.region==='string'&&entry.region.trim()?entry.region.trim():undefined;
      const resourceGroup=typeof entry.resourceGroup==='string'&&entry.resourceGroup.trim()?entry.resourceGroup.trim():undefined;
      const subnetResourceId=typeof entry.subnetResourceId==='string'&&entry.subnetResourceId.trim()?entry.subnetResourceId.trim():undefined;
      const agentImage=typeof entry.agentImage==='string'&&entry.agentImage.trim()?entry.agentImage.trim():undefined;
      for(const [field,value] of Object.entries({region,resourceGroup,subnetResourceId,agentImage}))
        if(!value) throw new Error(`deployments.${name}.${field} is required`);
      const resourceUrl=httpsUrl(entry.resourceUrl,`deployments.${name}.resourceUrl`);
      const collectorUrl=httpsUrl(entry.collectorUrl,`deployments.${name}.collectorUrl`);
      const restrictedUrl=restrictedServiceUrl(entry,name,collectorUrl,restrictedServiceRequired);
      deployments[name]={kind:'aci',resourceUrl,collectorUrl,...(restrictedUrl?{restrictedUrl}:{}),
        region,resourceGroup,subnetResourceId,agentImage,
        ...(Number.isInteger(entry.timeoutMs)?{timeoutMs:entry.timeoutMs}:{})};
    } else if(entry.kind==='aca_job') {
      if(name!=='azure_container_apps_jobs') throw new Error(`deployments.${name}.kind aca_job is only valid for azure_container_apps_jobs`);
      if(!GUID.test(entry.subscriptionId||'')) throw new Error(`deployments.${name}.subscriptionId must be a GUID`);
      if(entry.workloadProfileName!=='Consumption') throw new Error(`deployments.${name}.workloadProfileName must be Consumption`);
      const resourceGroup=resourceGroupName(entry.resourceGroup,`deployments.${name}.resourceGroup`);
      const jobNames=profileNames(entry.jobNames,`deployments.${name}.jobNames`);
      const agentImage=pinnedImage(entry.agentImage,`deployments.${name}.agentImage`);
      const imagePullIdentityResourceId=uaiResourceId(entry.imagePullIdentityResourceId,`deployments.${name}.imagePullIdentityResourceId`);
      const resources=jobResources(entry.resources,`deployments.${name}.resources`);
      const resourceUrl=httpsUrl(entry.resourceUrl,`deployments.${name}.resourceUrl`);
      const collectorUrl=httpsUrl(entry.collectorUrl,`deployments.${name}.collectorUrl`);
      const restrictedUrl=restrictedServiceUrl(entry,name,collectorUrl,restrictedServiceRequired);
      const dataStore=sessionDataStore(entry,`deployments.${name}`,externalNamespaceRequired);
      const apiVersion=entry.apiVersion??'2026-07-01';
      if(typeof apiVersion!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(apiVersion))
        throw new Error(`deployments.${name}.apiVersion must be a stable YYYY-MM-DD version`);
      const executionTimeoutMs=entry.executionTimeoutMs??120000,logWaitMs=entry.logWaitMs??600000;
      if(!Number.isInteger(executionTimeoutMs)||executionTimeoutMs<1000||executionTimeoutMs>3600000)
        throw new Error(`deployments.${name}.executionTimeoutMs must be 1000..3600000`);
      if(!Number.isInteger(logWaitMs)||logWaitMs<1000||logWaitMs>3600000)
        throw new Error(`deployments.${name}.logWaitMs must be 1000..3600000`);
      deployments[name]={kind:'aca_job',subscriptionId:entry.subscriptionId,resourceGroup,workloadProfileName:'Consumption',
        jobNames,agentImage,imagePullIdentityResourceId,resources,resourceUrl,collectorUrl,
        ...(restrictedUrl?{restrictedUrl}:{}),...(dataStore?{sessionDataStore:dataStore}:{}),apiVersion,executionTimeoutMs,logWaitMs};
    } else if(entry.kind==='aca_sandbox') {
      if(name!=='azure_container_apps_sandboxes') throw new Error(`deployments.${name}.kind aca_sandbox is only valid for azure_container_apps_sandboxes`);
      if(!GUID.test(entry.subscriptionId||'')) throw new Error(`deployments.${name}.subscriptionId must be a GUID`);
      const resourceGroup=resourceGroupName(entry.resourceGroup,`deployments.${name}.resourceGroup`);
      if(typeof entry.region!=='string'||! /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.region))
        throw new Error(`deployments.${name}.region must be an Azure region name`);
      const sandboxGroups=profileNames(entry.sandboxGroups,`deployments.${name}.sandboxGroups`);
      const diskImageIds=profileNames(entry.diskImageIds,`deployments.${name}.diskImageIds`);
      const agentImage=pinnedImage(entry.agentImage,`deployments.${name}.agentImage`);
      const imagePullIdentityResourceId=uaiResourceId(entry.imagePullIdentityResourceId,`deployments.${name}.imagePullIdentityResourceId`);
      const resources=sandboxResources(entry.resources,`deployments.${name}.resources`);
      const resourceUrl=httpsUrl(entry.resourceUrl,`deployments.${name}.resourceUrl`);
      const collectorUrl=httpsUrl(entry.collectorUrl,`deployments.${name}.collectorUrl`);
      const restrictedUrl=restrictedServiceUrl(entry,name,collectorUrl,restrictedServiceRequired);
      const dataStore=sessionDataStore(entry,`deployments.${name}`,externalNamespaceRequired);
      const apiVersion=entry.apiVersion??'2026-02-01-preview';
      if(typeof apiVersion!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}-preview$/.test(apiVersion))
        throw new Error(`deployments.${name}.apiVersion must be a preview YYYY-MM-DD-preview version`);
      const timeoutMs=entry.timeoutMs??300000;
      if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>3600000)
        throw new Error(`deployments.${name}.timeoutMs must be 1000..3600000`);
      deployments[name]={kind:'aca_sandbox',subscriptionId:entry.subscriptionId,resourceGroup,region:entry.region,
        sandboxGroups,diskImageIds,agentImage,imagePullIdentityResourceId,resources,resourceUrl,collectorUrl,
        ...(restrictedUrl?{restrictedUrl}:{}),...(dataStore?{sessionDataStore:dataStore}:{}),apiVersion,timeoutMs};
    }
  }

  const seen=new Set();
  const principals=new Set();
  const azureClientIds=new Set();
  const azureIdentityResources=new Set();
  const routes=[];
  for(const [index,raw_] of config.routes.entries()) {
    const route=requireObject(raw_,`routes[${index}]`);
    if(!SUPPORTED_DEPLOYMENTS.includes(route.deployment) || !configuredDeploymentNames.includes(route.deployment)) throw new Error(`routes[${index}].deployment is not a scheduled deployment`);
    if(!PROFILES.includes(route.profile)) throw new Error(`routes[${index}].profile must be one of ${PROFILES.join(', ')}`);
    if(route.deployment==='azure_container_instances'&&!['P1','P2'].includes(route.profile))
      throw new Error(`routes[${index}].profile for azure_container_instances must be P1 or P2`);
    const key=`${route.deployment}:${route.profile}`;
    if(seen.has(key)) throw new Error(`duplicate route ${key}`);
    seen.add(key);
    if(!GUID.test(route.principalObjectId || '')) throw new Error(`routes[${index}].principalObjectId must be a GUID`);
    const principal=route.principalObjectId.toLowerCase();
    // The experiment compares behaviour across separate workload identities; a reused
    // principal makes one arm's data indistinguishable from another's.
    if(principals.has(principal)) throw new Error(`routes[${index}].principalObjectId is reused across routes`);
    principals.add(principal);
    const mustHaveAzureIdentity=azureThreeArmProtocol&&requiredRoutes.includes(key);
    let workloadClientId,secretReaderClientId,workloadIdentityResourceId,secretReaderIdentityResourceId,workloadTokenSecretUri;
    if(mustHaveAzureIdentity) {
      workloadClientId=route.workloadClientId;
      secretReaderClientId=route.secretReaderClientId;
      if(!GUID.test(workloadClientId||'')) throw new Error(`routes[${index}].workloadClientId must be a GUID`);
      if(!GUID.test(secretReaderClientId||'')) throw new Error(`routes[${index}].secretReaderClientId must be a GUID`);
      if(workloadClientId.toLowerCase()===secretReaderClientId.toLowerCase())
        throw new Error(`routes[${index}] workload and secret-reader identities must be different identities`);
      for(const [field,value] of [['workloadClientId',workloadClientId],['secretReaderClientId',secretReaderClientId]]) {
        const id=value.toLowerCase();
        if(azureClientIds.has(id)) throw new Error(`routes[${index}].${field} is reused across routes`);
        azureClientIds.add(id);
      }
      workloadIdentityResourceId=uaiResourceId(route.workloadIdentityResourceId,`routes[${index}].workloadIdentityResourceId`);
      secretReaderIdentityResourceId=uaiResourceId(route.secretReaderIdentityResourceId,`routes[${index}].secretReaderIdentityResourceId`);
      for(const [field,value] of [['workloadIdentityResourceId',workloadIdentityResourceId],['secretReaderIdentityResourceId',secretReaderIdentityResourceId]]) {
        const id=value.toLowerCase();
        if(azureIdentityResources.has(id)) throw new Error(`routes[${index}].${field} is reused across routes`);
        azureIdentityResources.add(id);
      }
      if(workloadIdentityResourceId.toLowerCase()===secretReaderIdentityResourceId.toLowerCase())
        throw new Error(`routes[${index}] workload and secret-reader identities must be different identities`);
      workloadTokenSecretUri=keyVaultSecretUri(route.workloadTokenSecretUri,`routes[${index}].workloadTokenSecretUri`);
    }
    const kind=deployments[route.deployment].kind;
    let agentUrl;
    if(kind==='http') {
      if(route.deployment==='azure_functions_flex' && route.agentUrl===undefined)
        throw new Error(`routes[${index}].agentUrl is required for ${route.deployment}`);
      agentUrl=route.agentUrl===undefined?deployments[route.deployment].agentUrl:httpsUrl(route.agentUrl,`routes[${index}].agentUrl`);
      if(!agentUrl) throw new Error(`routes[${index}].agentUrl is required for ${route.deployment}`);
    } else if(route.agentUrl!==undefined) throw new Error(`routes[${index}].agentUrl is only valid for HTTP deployments`);
    const credentials=requireObject(route.credentials,`routes[${index}].credentials`);
    const allowedCredentials=new Set([...CREDENTIAL_KEYS[kind],...(kind==='http'&&route.deployment==='azure_functions_flex'?['functionKey']:[])]);
    if(Object.keys(credentials).some(name=>!allowedCredentials.has(name)))
      throw new Error(`routes[${index}].credentials contains an unsupported credential field`);
    const resolved={};
    for(const name of CREDENTIAL_KEYS[kind]) resolved[name]=credentialRef(credentials[name],`routes[${index}].credentials.${name}`);
    if(kind==='http'&&route.deployment==='azure_functions_flex'&&credentials.functionKey!==undefined)
      resolved.functionKey=credentialRef(credentials.functionKey,`routes[${index}].credentials.functionKey`);
    const deployment=deployments[route.deployment];
    routes.push({deployment:route.deployment,profile:route.profile,principalObjectId:route.principalObjectId,
      ...(kind==='http'?{agentUrl}:{}),
      ...(mustHaveAzureIdentity?{workloadClientId,workloadIdentityResourceId,secretReaderClientId,secretReaderIdentityResourceId,workloadTokenSecretUri}:{}),
      ...(kind==='aca_job'?{jobName:deployment.jobNames[route.profile]}:{}),
      ...(kind==='aca_sandbox'?{sandboxGroup:deployment.sandboxGroups[route.profile],diskImageId:deployment.diskImageIds[route.profile]}:{}),
      ...(deployment.sessionDataStore?{sessionDataStore:deployment.sessionDataStore}:{}),credentials:resolved});
  }
  for(const key of requiredRoutes)
    if(!seen.has(key)) throw new Error(`missing route ${key}`);

  return {evidenceDirectory:config.evidenceDirectory,auditWindowSeconds,deployments,routes};
}

/**
 * Replace credential references with their values from `env`. The returned object
 * is the only place a secret exists in memory; it is never written to disk and the
 * error message lists missing variable names only.
 */
export function missingCredentialVariables(config,env=process.env,routeKeys) {
  const selected=routeKeys?new Set(routeKeys):null;
  const missing=new Set();
  for(const route of config.routes) {
    if(selected && !selected.has(`${route.deployment}:${route.profile}`)) continue;
    for(const ref of Object.values(route.credentials)) {
      const value=env[ref];
      if(typeof value!=='string' || !value) missing.add(ref);
    }
  }
  return [...missing].sort();
}

export function resolveCredentials(config, env=process.env, routeKeys) {
  const selected=routeKeys?new Set(routeKeys):null;
  const missing=new Set();
  const read=name=>{
    const value=env[name];
    if(typeof value!=='string' || !value) {missing.add(name);return undefined;}
    if(/[\r\n]/.test(value)) throw new Error(`environment variable ${name} contains a line break`);
    // A value this short is a placeholder that was never filled in.
    if(value.length<8) throw new Error(`environment variable ${name} is too short to be a credential`);
    return value;
  };
  const routes=config.routes.map(route=>{
    if(selected && !selected.has(`${route.deployment}:${route.profile}`)) return route;
    const credentials={};
    for(const [name,ref] of Object.entries(route.credentials)) credentials[name]=read(ref);
    return {...route,credentials};
  });
  if(missing.size) throw new Error(`missing credential environment variables: ${[...missing].sort().join(', ')}`);
  return {...config,routes};
}

export async function loadExperimentConfig(path, env=process.env,options={}) {
  return resolveCredentials(await loadExperimentConfigShape(path,options),env);
}

export async function loadExperimentConfigShape(path,options={}) {
  const text=await readFile(path,'utf8');
  let raw;
  try {raw=JSON.parse(text);} catch (error) {throw new Error(`config is not valid JSON: ${error.message}`);}
  return validateExperimentConfig(raw,options);
}
