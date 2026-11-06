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
export const SUPPORTED_DEPLOYMENTS=[...DEPLOYMENTS,'azure_container_instances','azure_custom_sessions_hyperv'];
export const PROFILES=['P1','P2','P3'];
// Revision 3 removes all ACA session arms; the measured 300-row plan has six routes.
export const EXPERIMENT_ROUTES=DEPLOYMENTS.flatMap(deployment=>PROFILES.map(profile=>`${deployment}:${profile}`));
export const REVISION_3_ROUTES=['azure_vm','azure_functions_flex'].flatMap(deployment=>PROFILES.map(profile=>`${deployment}:${profile}`));
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME=/^[A-Z][A-Z0-9_]{2,80}$/;
const KINDS=['http','session','aci'];
const LOCAL_HOSTS=['127.0.0.1','localhost','[::1]'];
const CREDENTIAL_KEYS={http:['controller','resourceAdmin','collectorAdmin'],session:['controller','resourceAdmin','collectorAdmin'],aci:['controller','resourceAdmin','collectorAdmin']};

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

/**
 * Validate the shape of a deployment document. Throws on the first problem and
 * names the field, because a misconfigured route is discovered mid-experiment
 * otherwise — after spend has already happened.
 */
export function validateExperimentConfig(raw,{requiredRoutes=REVISION_3_ROUTES}={}) {
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
  const aciProtocol=requiredRoutes.some(key=>key.startsWith('azure_container_instances:'));
  const sessionProtocol=requiredRoutes.some(key=>key.startsWith('azure_custom_sessions_hyperv:'));
  if(config.routes.length<requiredRoutes.length || (aciProtocol&&config.routes.length!==requiredRoutes.length))
    throw new Error(requiredRoutes.length===REVISION_3_ROUTES.length&&requiredRoutes.every((key,index)=>key===REVISION_3_ROUTES[index])
      ?`exactly ${REVISION_3_ROUTES.length} revision-3 routes are required, got ${config.routes.length}`
      :aciProtocol?`exactly ${requiredRoutes.length} ACI draft routes are required, got ${config.routes.length}`
      :`at least ${requiredRoutes.length} scheduled deployment/profile routes are required, got ${config.routes.length}`);
  if(!aciProtocol&&config.routes.some(route=>!REVISION_3_ROUTES.includes(`${route?.deployment}:${route?.profile}`) &&
    !(sessionProtocol && requiredRoutes.includes(`${route?.deployment}:${route?.profile}`))))
    throw new Error(`exactly ${REVISION_3_ROUTES.length} revision-3 routes are required, got ${config.routes.length}`);

  const deployments={};
  const configuredDeploymentNames=[...new Set(config.routes.map(route=>route?.deployment).filter(name=>typeof name==='string'))];
  for(const name of configuredDeploymentNames) {
    const entry=requireObject(config.deployments?.[name],`deployments.${name}`);
    if(!KINDS.includes(entry.kind)) throw new Error(`deployments.${name}.kind must be one of ${KINDS.join(', ')}`);
    if(entry.kind==='http') {
      const agentUrl=entry.agentUrl===undefined?undefined:httpsUrl(entry.agentUrl,`deployments.${name}.agentUrl`);
      if(name==='azure_vm' && !agentUrl) throw new Error(`deployments.${name}.agentUrl is required`);
      deployments[name]={kind:'http',
        ...(agentUrl?{agentUrl}:{}),
        resourceUrl:httpsUrl(entry.resourceUrl,`deployments.${name}.resourceUrl`),
        collectorUrl:httpsUrl(entry.collectorUrl,`deployments.${name}.collectorUrl`),
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
      deployments[name]={kind:'session',
        profilePools,
        resourceUrl:httpsUrl(entry.resourceUrl,`deployments.${name}.resourceUrl`),
        collectorUrl:httpsUrl(entry.collectorUrl,`deployments.${name}.collectorUrl`),
        sessionRegistryUrl,
        fixtureBlobEndpoint:httpsUrl(entry.fixtureBlobEndpoint,`deployments.${name}.fixtureBlobEndpoint`),
        headerIsolationVerified:entry.headerIsolationVerified===true,
        ...(Number.isInteger(entry.timeoutMs)?{timeoutMs:entry.timeoutMs}:{})};
    } else {
      if(name!=='azure_container_instances') throw new Error(`deployments.${name}.kind aci is only valid for azure_container_instances`);
      const region=typeof entry.region==='string'&&entry.region.trim()?entry.region.trim():undefined;
      const resourceGroup=typeof entry.resourceGroup==='string'&&entry.resourceGroup.trim()?entry.resourceGroup.trim():undefined;
      const subnetResourceId=typeof entry.subnetResourceId==='string'&&entry.subnetResourceId.trim()?entry.subnetResourceId.trim():undefined;
      const agentImage=typeof entry.agentImage==='string'&&entry.agentImage.trim()?entry.agentImage.trim():undefined;
      for(const [field,value] of Object.entries({region,resourceGroup,subnetResourceId,agentImage}))
        if(!value) throw new Error(`deployments.${name}.${field} is required`);
      deployments[name]={kind:'aci',resourceUrl:httpsUrl(entry.resourceUrl,`deployments.${name}.resourceUrl`),
        collectorUrl:httpsUrl(entry.collectorUrl,`deployments.${name}.collectorUrl`),region,resourceGroup,subnetResourceId,agentImage,
        ...(Number.isInteger(entry.timeoutMs)?{timeoutMs:entry.timeoutMs}:{})};
    }
  }

  const seen=new Set();
  const principals=new Set();
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
    const kind=deployments[route.deployment].kind;
    let agentUrl;
    if(kind==='http') {
      if(route.deployment==='azure_functions_flex' && route.agentUrl===undefined)
        throw new Error(`routes[${index}].agentUrl is required for ${route.deployment}`);
      agentUrl=route.agentUrl===undefined?deployments[route.deployment].agentUrl:httpsUrl(route.agentUrl,`routes[${index}].agentUrl`);
      if(!agentUrl) throw new Error(`routes[${index}].agentUrl is required for ${route.deployment}`);
    } else if(route.agentUrl!==undefined) throw new Error(`routes[${index}].agentUrl is only valid for HTTP deployments`);
    const credentials=requireObject(route.credentials,`routes[${index}].credentials`);
    const resolved={};
    for(const name of CREDENTIAL_KEYS[kind]) resolved[name]=credentialRef(credentials[name],`routes[${index}].credentials.${name}`);
    if(kind==='http' && credentials.functionKey!==undefined)
      resolved.functionKey=credentialRef(credentials.functionKey,`routes[${index}].credentials.functionKey`);
    routes.push({deployment:route.deployment,profile:route.profile,principalObjectId:route.principalObjectId,
      ...(kind==='http'?{agentUrl}:{}),credentials:resolved});
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
