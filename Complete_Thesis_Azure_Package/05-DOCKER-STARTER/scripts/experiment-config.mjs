/**
 * Deployment configuration for the measured experiment.
 *
 * The config file never contains a secret. Every credential field names the
 * environment variable that holds the value, so the file can be committed,
 * reviewed and diffed while the values stay in the operator's environment.
 */
import {readFile} from 'node:fs/promises';
import {validateCustomSessionEndpoint} from './session-endpoint.mjs';

export const DEPLOYMENTS=['azure_vm','azure_functions_flex','azure_custom_sessions_hyperv'];
export const PROFILES=['P1','P2','P3'];
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME=/^[A-Z][A-Z0-9_]{2,80}$/;
const KINDS=['http','session'];
const LOCAL_HOSTS=['127.0.0.1','localhost','[::1]'];
const CREDENTIAL_KEYS={http:['controller','resourceAdmin','collectorAdmin'],session:['controller']};

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
export function validateExperimentConfig(raw) {
  const config=requireObject(raw,'config');
  if(typeof config.evidenceDirectory!=='string' || !config.evidenceDirectory.trim())
    throw new Error('evidenceDirectory is required');
  const auditWindowSeconds=config.auditWindowSeconds ?? 300;
  if(!Number.isInteger(auditWindowSeconds) || auditWindowSeconds<1 || auditWindowSeconds>600)
    throw new Error('auditWindowSeconds must be an integer between 1 and 600');
  if(!Array.isArray(config.routes)) throw new Error('routes must be an array');
  if(config.routes.length!==DEPLOYMENTS.length*PROFILES.length)
    throw new Error(`exactly ${DEPLOYMENTS.length*PROFILES.length} routes are required, got ${config.routes.length}`);

  const deployments={};
  for(const name of DEPLOYMENTS) {
    const entry=requireObject(config.deployments?.[name],`deployments.${name}`);
    if(!KINDS.includes(entry.kind)) throw new Error(`deployments.${name}.kind must be one of ${KINDS.join(', ')}`);
    if(entry.kind==='http') {
      deployments[name]={kind:'http',
        agentUrl:httpsUrl(entry.agentUrl,`deployments.${name}.agentUrl`),
        resourceUrl:httpsUrl(entry.resourceUrl,`deployments.${name}.resourceUrl`),
        collectorUrl:httpsUrl(entry.collectorUrl,`deployments.${name}.collectorUrl`),
        ...(Number.isInteger(entry.timeoutMs)?{timeoutMs:entry.timeoutMs}:{})};
    } else {
      if(typeof entry.poolName!=='string' || !entry.poolName) throw new Error(`deployments.${name}.poolName is required`);
      if(typeof entry.region!=='string' || !entry.region) throw new Error(`deployments.${name}.region is required`);
      // The pool hostname is <pool>.<environment-id>.<region>.azurecontainerapps.io.
      // A two-label guess such as <pool>.<region>... is not a real endpoint, and
      // validating it here means the mistake surfaces at config load, not at trial 1.
      const managementEndpoint=(()=>{
        const url=httpsUrl(entry.managementEndpoint,`deployments.${name}.managementEndpoint`);
        try {return validateCustomSessionEndpoint(`${url}/`,{poolName:entry.poolName,region:entry.region}).href.replace(/\/$/,'');}
        catch (error) {throw new Error(`deployments.${name}.managementEndpoint ${error.message}`);}
      })();
      deployments[name]={kind:'session',
        managementEndpoint,
        poolName:entry.poolName, region:entry.region,
        sessionRegistryUrl:httpsUrl(entry.sessionRegistryUrl,`deployments.${name}.sessionRegistryUrl`),
        fixtureBlobEndpoint:httpsUrl(entry.fixtureBlobEndpoint,`deployments.${name}.fixtureBlobEndpoint`),
        headerIsolationVerified:entry.headerIsolationVerified===true,
        ...(Number.isInteger(entry.timeoutMs)?{timeoutMs:entry.timeoutMs}:{})};
    }
  }

  const seen=new Set();
  const principals=new Set();
  const routes=[];
  for(const [index,raw_] of config.routes.entries()) {
    const route=requireObject(raw_,`routes[${index}]`);
    if(!DEPLOYMENTS.includes(route.deployment)) throw new Error(`routes[${index}].deployment is not a known deployment`);
    if(!PROFILES.includes(route.profile)) throw new Error(`routes[${index}].profile must be one of ${PROFILES.join(', ')}`);
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
    const credentials=requireObject(route.credentials,`routes[${index}].credentials`);
    const resolved={};
    for(const name of CREDENTIAL_KEYS[kind]) resolved[name]=credentialRef(credentials[name],`routes[${index}].credentials.${name}`);
    if(kind==='http' && credentials.functionKey!==undefined)
      resolved.functionKey=credentialRef(credentials.functionKey,`routes[${index}].credentials.functionKey`);
    routes.push({deployment:route.deployment,profile:route.profile,principalObjectId:route.principalObjectId,credentials:resolved});
  }
  for(const deployment of DEPLOYMENTS) for(const profile of PROFILES)
    if(!seen.has(`${deployment}:${profile}`)) throw new Error(`missing route ${deployment}:${profile}`);

  return {evidenceDirectory:config.evidenceDirectory,auditWindowSeconds,deployments,routes};
}

/**
 * Replace credential references with their values from `env`. The returned object
 * is the only place a secret exists in memory; it is never written to disk and the
 * error message lists missing variable names only.
 */
export function resolveCredentials(config, env=process.env) {
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
    const credentials={};
    for(const [name,ref] of Object.entries(route.credentials)) credentials[name]=read(ref);
    return {...route,credentials};
  });
  if(missing.size) throw new Error(`missing credential environment variables: ${[...missing].sort().join(', ')}`);
  return {...config,routes};
}

export async function loadExperimentConfig(path, env=process.env) {
  const text=await readFile(path,'utf8');
  let raw;
  try {raw=JSON.parse(text);} catch (error) {throw new Error(`config is not valid JSON: ${error.message}`);}
  return resolveCredentials(validateExperimentConfig(raw),env);
}
