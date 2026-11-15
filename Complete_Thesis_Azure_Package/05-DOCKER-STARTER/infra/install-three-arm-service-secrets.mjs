import {randomBytes} from 'node:crypto';
import {open, lstat, readFile, link, unlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateResearchServiceConfig} from '../dist/service-config.js';

const DEFAULT_ENV_DIRECTORY='/etc/thesis-research';
const RESOURCE_ENV='resource.env';
const COLLECTOR_ENV='collector.env';
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THREE_ARM_HOST_SECRETS=Object.freeze(['resource-admin-key','collector-admin-key',
  'functions-p1-resource-verifier-key','functions-p1-collector-verifier-key']);
const SECRET_VALID=/^[\s\S]{32,512}$/;
function threeArmSecretNames(namePrefix) {
  if(typeof namePrefix!=='string' || !/^[a-zA-Z0-9-]{1,20}$/.test(namePrefix)) throw safeError('invalid route secret name prefix');
  return Object.fromEntries(['P1','P2','P3'].map(profile=>[profile,
    ['vm','job','sbx'].map(route=>`${namePrefix}-${route}-${profile.toLowerCase()}-workload-token`)]));
}

function safeError(message) { return new Error(message); }
function equal(a,b) { return a===b; }
function validateVaultUrl(value) {
  let url;
  try { url=new URL(value); } catch { throw safeError('an explicit Key Vault URL is required'); }
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/' ||
    !/^[a-z0-9-]+\.vault\.(azure\.net|usgovcloudapi\.net|azure\.cn)$/i.test(url.hostname))
    throw safeError('vault URL must be an HTTPS Azure Key Vault endpoint without credentials, path, or query');
  return url.origin;
}
function validCredential(value) { return typeof value==='string' && SECRET_VALID.test(value) && !/[\r\n]/.test(value); }
function quoteEnvironmentValue(value) { return `"${value.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`; }
function renderEnvironment(entries) { return entries.map(([key,value])=>`${key}=${quoteEnvironmentValue(value)}`).join('\n')+'\n'; }
function defaultIsRoot() { return typeof process.getuid==='function' && process.getuid()===0; }

export function validateProtectedPathStat(stat,{kind,expectedUid=0,expectedGid=0}={}) {
  if(kind==='directory') {
    if(stat.isSymbolicLink?.() || !stat.isDirectory?.() || stat.uid!==expectedUid || stat.gid!==expectedGid || (stat.mode&0o777)!==0o700)
      throw safeError('service environment directory must be a root-owned, non-symlink directory with mode 0700');
    return;
  }
  if(stat.isSymbolicLink?.() || !stat.isFile?.() || stat.uid!==expectedUid || stat.gid!==expectedGid || (stat.mode&0o777)!==0o600)
    throw safeError('existing service environment file must be a root-owned, non-symlink regular file with mode 0600');
}

async function acquireMetadataToken({identityClientId,fetchImpl}) {
  const endpoint=new URL('http://169.254.169.254/metadata/identity/oauth2/token');
  endpoint.searchParams.set('api-version','2018-02-01');
  endpoint.searchParams.set('resource','https://vault.azure.net');
  endpoint.searchParams.set('client_id',identityClientId);
  let response;
  try { response=await fetchImpl(endpoint.href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Metadata:'true'}}); }
  catch { throw safeError('host managed identity token request failed; verify the specified identity is attached and available'); }
  if(!response.ok) throw safeError(`host managed identity token request failed (HTTP ${response.status}); verify identity attachment`);
  let body;
  try { body=await response.json(); } catch { throw safeError('host managed identity returned an invalid token response'); }
  if(typeof body?.access_token!=='string' || !body.access_token) throw safeError('host managed identity returned no Key Vault token');
  return body.access_token;
}

async function readNamedSecret({vaultOrigin,name,token,fetchImpl}) {
  const url=`${vaultOrigin}/secrets/${encodeURIComponent(name)}?api-version=7.4`;
  let response;
  try { response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token}`}}); }
  catch { throw safeError(`could not retrieve ${name} from Key Vault; no value was displayed`); }
  if(!response.ok) throw safeError(`could not retrieve ${name} from Key Vault (HTTP ${response.status}); check secret and identity access`);
  let body;
  try { body=await response.json(); } catch { throw safeError(`Key Vault returned an invalid response for ${name}; no value was displayed`); }
  if(!validCredential(body?.value)) throw safeError(`Key Vault value for ${name} is invalid; no service file was changed`);
  return body.value;
}

function buildServiceEnvironments({routeNames,hostValues}) {
  const profileValues={};
  for(const profile of ['P1','P2','P3']) {
    const values=routeNames[profile].map(name=>hostValues.get(name));
    if(values.some(value=>typeof value!=='string' || !equal(value,values[0])))
      throw safeError(`route secrets for ${profile} do not match; no service file was changed`);
    profileValues[profile]=values[0];
  }
  const allValues=[...Object.values(profileValues),...THREE_ARM_HOST_SECRETS.map(name=>hostValues.get(name))];
  if(allValues.some(value=>!validCredential(value)) || new Set(allValues).size!==allValues.length)
    throw safeError('profile, admin, and verifier credentials are invalid or shared; no service file was changed');
  const [resourceAdmin,collectorAdmin,resourceVerifier,collectorVerifier]=THREE_ARM_HOST_SECRETS.map(name=>hostValues.get(name));
  const resource={RESEARCH_SERVICE_MODE:'azure-pilot',ADMIN_TOKEN:resourceAdmin,VERIFIER_TOKEN:resourceVerifier,
    P1_TOKEN:profileValues.P1,P2_TOKEN:profileValues.P2,P3_TOKEN:profileValues.P3,
    RESOURCE_JOURNAL_PATH:'/srv/thesis-data/resource/events.jsonl'};
  const collector={RESEARCH_SERVICE_MODE:'azure-pilot',ADMIN_TOKEN:collectorAdmin,VERIFIER_TOKEN:collectorVerifier,
    COLLECTOR_JOURNAL_PATH:'/srv/thesis-data/collector/events.jsonl'};
  try {
    validateResearchServiceConfig('resource',resource);
    validateResearchServiceConfig('collector',collector);
  } catch { throw safeError('research service configuration validation failed; no service file was changed'); }
  return {
    [RESOURCE_ENV]:renderEnvironment(Object.entries(resource)),
    [COLLECTOR_ENV]:renderEnvironment(Object.entries(collector))
  };
}

async function ensureServiceDirectory({directory,fsImpl,validateDirectory=validateProtectedPathStat}) {
  let stat;
  try { stat=await fsImpl.lstat(directory); } catch { throw safeError('service environment directory is missing; stage the research host first'); }
  validateDirectory(stat,{kind:'directory'});
}

async function installFiles({directory,contents,fsImpl,validateFile=validateProtectedPathStat}) {
  const lockPath=path.join(directory,'.three-arm-secret-delivery.lock');
  let lockHandle;
  try { lockHandle=await fsImpl.open(lockPath,'wx',0o600); }
  catch { throw safeError('host credential delivery is already running or a stale local lock needs operator review'); }
  const created=[];
  const temporary=[];
  try {
    const existing=new Map(),missing=[];
    for(const [name,expected] of Object.entries(contents)) {
      const filePath=path.join(directory,name);
      let stat;
      try { stat=await fsImpl.lstat(filePath); }
      catch(error) { if(error?.code==='ENOENT') { missing.push([name,filePath,expected]); continue; } throw safeError(`could not inspect ${name}`); }
      validateFile(stat,{kind:'file'});
      let current;
      try { current=await fsImpl.readFile(filePath,'utf8'); } catch { throw safeError(`could not read ${name}; no service files were changed`); }
      if(current!==expected) throw safeError(`existing ${name} differs from the retrieved credentials; refusing to replace it`);
      existing.set(name,true);
    }
    for(const [name,filePath,expected] of missing) {
      const tempPath=path.join(directory,`.${name}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
      temporary.push(tempPath);
      let handle;
      try {
        handle=await fsImpl.open(tempPath,'wx',0o600);
        await handle.writeFile(expected,{encoding:'utf8'});
        await handle.sync();
        await handle.close();
        handle=undefined;
        await fsImpl.link(tempPath,filePath); // EEXIST fails closed; never replaces a concurrent file.
        created.push(filePath);
        await fsImpl.unlink(tempPath);
        temporary.pop();
      } catch {
        try { await handle?.close(); } catch {}
        for(const item of created.reverse()) try { await fsImpl.unlink(item); } catch {}
        throw safeError(`could not create protected ${name}; no existing service file was replaced`);
      }
    }
    try {
      const dirHandle=await fsImpl.open(directory,'r');
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch { throw safeError('could not confirm service environment directory update'); }
    return {written:missing.map(([name])=>name),alreadyCurrent:[...existing.keys()]};
  } finally {
    for(const tempPath of temporary) try { await fsImpl.unlink(tempPath); } catch {}
    try { await lockHandle.close(); } catch {}
    try { await fsImpl.unlink(lockPath); } catch {}
  }
}

export async function installThreeArmServiceCredentials({vaultUrl,identityClientId,namePrefix,
  envDirectory=DEFAULT_ENV_DIRECTORY,fetchImpl=globalThis.fetch,fsImpl={open,lstat,readFile,link,unlink},
  isRoot=defaultIsRoot,validateDirectory,validateFile}={}) {
  if(!isRoot()) throw safeError('host credential delivery must run as root');
  const vaultOrigin=validateVaultUrl(vaultUrl);
  if(typeof identityClientId!=='string' || !GUID.test(identityClientId)) throw safeError('an explicit attached managed identity client ID is required');
  if(typeof fetchImpl!=='function') throw safeError('fetch implementation is required');
  const routeNames=threeArmSecretNames(namePrefix);
  await ensureServiceDirectory({directory:envDirectory,fsImpl,...(validateDirectory?{validateDirectory}:{})});
  const token=await acquireMetadataToken({identityClientId,fetchImpl});
  const secretNames=[...Object.values(routeNames).flat(),...THREE_ARM_HOST_SECRETS];
  const hostValues=new Map();
  for(const name of secretNames)
    hostValues.set(name,await readNamedSecret({vaultOrigin,name,token,fetchImpl}));
  const contents=buildServiceEnvironments({routeNames,hostValues});
  return installFiles({directory:envDirectory,contents,fsImpl,...(validateFile?{validateFile}:{})});
}

function parseArgs(args) {
  const keys={'--vault-url':'vaultUrl','--identity-client-id':'identityClientId','--prefix':'namePrefix'},result={};
  for(let i=0;i<args.length;i++) {
    const key=keys[args[i]];
    if(!key || !args[i+1] || result[key]) throw safeError('usage: node infra/install-three-arm-service-secrets.mjs --vault-url <https-vault-url> --identity-client-id <attached-uai-client-id> --prefix <name-prefix>');
    result[key]=args[++i];
  }
  if(!result.vaultUrl || !result.identityClientId || !result.namePrefix)
    throw safeError('usage: node infra/install-three-arm-service-secrets.mjs --vault-url <https-vault-url> --identity-client-id <attached-uai-client-id> --prefix <name-prefix>');
  return result;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const result=await installThreeArmServiceCredentials(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Research service credentials are ${result.written.length?'installed':'already current'}; no credential values were displayed.\n`);
  } catch(error) {
    process.stderr.write(`${error?.message||'host credential delivery failed'}\n`);
    process.exitCode=1;
  }
}
