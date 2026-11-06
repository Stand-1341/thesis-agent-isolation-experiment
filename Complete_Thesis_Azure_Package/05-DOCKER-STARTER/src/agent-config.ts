const LOCAL_HOSTS=new Set(['localhost','127.0.0.1','[::1]']);

function normalizeEndpoint(value: string | undefined, name: string): string {
  if(typeof value!=='string'||!value.trim()) throw new Error(`${name} is required`);
  let url:URL;
  try {url=new URL(value);} catch {throw new Error(`${name} must be an absolute URL`);}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/')
    throw new Error(`${name} must be a base URL without credentials, path, query, or fragment`);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&LOCAL_HOSTS.has(url.hostname)))
    throw new Error(`${name} must use HTTPS except for loopback smoke tests`);
  return url.href.replace(/\/$/,'');
}

export function readAgentEndpoints(env:Record<string,string|undefined>=process.env,{requireRestricted=false}={}) {
  const resourceUrl=normalizeEndpoint(env.RESEARCH_URL,'RESEARCH_URL');
  const collectorUrl=normalizeEndpoint(env.COLLECTOR_URL,'COLLECTOR_URL');
  const restrictedUrl=env.RESTRICTED_URL?normalizeEndpoint(env.RESTRICTED_URL,'RESTRICTED_URL'):undefined;
  if(requireRestricted&&!restrictedUrl) throw new Error('RESTRICTED_URL is required');
  if(restrictedUrl) {
    const collectorHost=new URL(collectorUrl).hostname.toLowerCase();
    const restrictedHost=new URL(restrictedUrl).hostname.toLowerCase();
    const isLocal=LOCAL_HOSTS.has(collectorHost)&&LOCAL_HOSTS.has(restrictedHost);
    if(!isLocal&&collectorHost===restrictedHost)
      throw new Error('RESTRICTED_URL must use a separate host from COLLECTOR_URL');
  }
  return {resourceUrl,collectorUrl,restrictedUrl};
}

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function checkedWorkloadToken(value:unknown):string {
  if(typeof value!=='string'||!value||/[\r\n]/.test(value)) throw new Error('workload token is invalid');
  return value;
}

/** Resolve the mock-service token without placing it in a trial envelope or execution request. */
export async function resolveWorkloadTokenFromEnvironment(env:Record<string,string|undefined>=process.env,
  {readSecret}:{readSecret?:(uri:string,options:{clientId?:string})=>Promise<string>}={}) {
  const direct=env.WORKLOAD_TOKEN;
  const secretUri=env.THESIS_WORKLOAD_TOKEN_SECRET_URI;
  if(direct!==undefined&&secretUri!==undefined) throw new Error('choose one workload token source, not both');
  if(direct!==undefined) return checkedWorkloadToken(direct);
  if(typeof secretUri!=='string'||!secretUri) throw new Error('WORKLOAD_TOKEN or THESIS_WORKLOAD_TOKEN_SECRET_URI is required');
  let url:URL;
  try {url=new URL(secretUri);} catch {throw new Error('THESIS_WORKLOAD_TOKEN_SECRET_URI is invalid');}
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.protocol!=='https:'||! /^[a-z0-9-]{3,24}\.vault\.azure\.net$/i.test(url.hostname)||url.username||url.password||url.port||url.search||url.hash||
    parts.length<2||parts.length>3||parts[0]!=='secrets'||! /^[A-Za-z0-9-]{1,127}$/.test(decodeURIComponent(parts[1]))||
    (parts.length===3&&!/^[A-Za-z0-9-]{1,128}$/.test(decodeURIComponent(parts[2]))))
    throw new Error('THESIS_WORKLOAD_TOKEN_SECRET_URI is invalid');
  const clientId=env.THESIS_SECRET_READER_CLIENT_ID;
  if(clientId!==undefined&&!GUID.test(clientId)) throw new Error('THESIS_SECRET_READER_CLIENT_ID must be a GUID');
  const reader=readSecret??(async(uri,options)=>{
    const {createManagedKeyVaultSecretReader}=await import('./azure-keyvault-secret.mjs');
    return createManagedKeyVaultSecretReader({clientId:options.clientId})(uri);
  });
  let value;
  try {value=await reader(secretUri,{...(clientId?{clientId}:{})});} catch {throw new Error('workload token could not be read from Key Vault');}
  return checkedWorkloadToken(value);
}
