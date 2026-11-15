import {createPrivateKey,randomBytes, timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {withAzureBlobLeaseLock} from './azure-blob-lease-lock.mjs';
import {validateHostCaPair} from './install-research-host-ca-key.mjs';

const PROFILE_NAMES=Object.freeze(['P1','P2','P3']);
const ROUTE_NAMES=Object.freeze(['vm','job','sbx']);
// These names match the established host service credential names used by the
// existing Functions pilot. Route workload names match azure-supported-three-arm.bicep.
const HOST_SECRETS=Object.freeze([
  'resource-admin-key','collector-admin-key',
  'functions-p1-resource-verifier-key','functions-p1-collector-verifier-key',
  'vm-p1-controller-key','vm-p2-controller-key','vm-p3-controller-key',
  'functions-p1-controller-key','functions-p2-controller-key','functions-p3-controller-key'
]);
export const THREE_ARM_HOST_SECRETS=HOST_SECRETS;

function safeError(message) { return new Error(message); }
function validCredential(value) {
  return typeof value==='string' && value.length>=32 && value.length<=512 && !/[\r\n]/.test(value);
}
export function threeArmSecretNames(namePrefix) {
  if(typeof namePrefix!=='string' || !/^[a-zA-Z0-9-]{1,20}$/.test(namePrefix)) throw safeError('invalid route secret name prefix');
  return Object.fromEntries(PROFILE_NAMES.map(profile=>[profile,
    ROUTE_NAMES.map(route=>`${namePrefix}-${route}-${profile.toLowerCase()}-workload-token`)]));
}
function equalSecret(a,b) {
  const left=Buffer.from(a,'utf8'),right=Buffer.from(b,'utf8');
  return left.length===right.length && timingSafeEqual(left,right);
}
function generatedCredential() { return randomBytes(32).toString('base64url'); }

/**
 * Create missing selected three-arm credentials using an injected Key Vault API.
 * One token is shared by each profile across VM, ACA Jobs, and ACA Sandboxes,
 * matching the research service's P1_TOKEN/P2_TOKEN/P3_TOKEN authorization.
 * Existing values are never replaced. A caller must supply a distributed lock
 * adapter that holds an exclusive lease across the complete read/write pass;
 * Key Vault Set Secret has no documented create-only conditional operation.
 * No credential is returned or logged.
 */
export async function provisionThreeArmSecrets({vaultName,namePrefix,token,fetchImpl=globalThis.fetch,
  generateCredential=generatedCredential,withExclusiveLock,hostTlsCaPrivateKey}={}) {
  if(typeof vaultName!=='string' || !/^[a-zA-Z0-9-]{3,24}$/.test(vaultName)) throw safeError('invalid Key Vault name');
  if(typeof namePrefix!=='string' || !/^[a-zA-Z0-9-]{1,20}$/.test(namePrefix)) throw safeError('invalid route secret name prefix');
  if(typeof token!=='string' || !token) throw safeError('Key Vault token is required');
  if(typeof fetchImpl!=='function' || typeof generateCredential!=='function') throw safeError('Key Vault and credential providers are required');
  if(typeof withExclusiveLock!=='function') throw safeError('an exclusive distributed lock adapter is required; refusing secret writes');

  return withExclusiveLock(async()=>{
  const grouped=threeArmSecretNames(namePrefix);
  const groups=[...PROFILE_NAMES.map(profile=>({id:profile,names:grouped[profile]})),
    ...HOST_SECRETS.map(name=>({id:name,names:[name]}))];
  const hostTlsCaSecret=`${namePrefix}-host-tls-ca-private-key`;
  if(hostTlsCaPrivateKey!==undefined) {
    let key;
    try { key=createPrivateKey(hostTlsCaPrivateKey); } catch { throw safeError('host TLS CA key file is invalid; no value was displayed'); }
    if(key.asymmetricKeyType!=='rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0)<3072)
      throw safeError('host TLS CA private key must be RSA 3072-bit or stronger; no value was displayed');
    groups.push({id:'host-tls-ca-private-key',names:[hostTlsCaSecret]});
  }
  const observed=new Map(),missing=[];
  const urlFor=name=>`https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(name)}?api-version=7.4`;
  for(const group of groups) for(const name of group.names) {
    let response;
    try { response=await fetchImpl(urlFor(name),{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token}`}}); }
    catch { throw safeError(`could not check ${name}; no secret value was displayed`); }
    if(response.status===404) { missing.push({group:group.id,name}); continue; }
    if(!response.ok) throw safeError(`could not check ${name} (HTTP ${response.status}); no secret value was displayed`);
    let body;
    try { body=await response.json(); } catch { throw safeError(`could not validate ${name}; no secret value was displayed`); }
    const validValue=name===hostTlsCaSecret
      ?typeof body?.value==='string' && /^base64:[A-Za-z0-9+/]+=*$/.test(body.value)
      :validCredential(body?.value);
    if(!validValue) throw safeError(`existing ${name} is invalid; refusing to replace it`);
    observed.set(name,body.value);
  }

  const values=new Map();
  for(const group of groups) {
    if(group.id==='host-tls-ca-private-key') {
      const encoded=`base64:${Buffer.from(hostTlsCaPrivateKey,'utf8').toString('base64')}`;
      const existing=observed.get(group.names[0]);
      if(existing!==undefined && existing!==encoded)
        throw safeError('existing host TLS CA key differs from the supplied key; refusing to overwrite');
      values.set(group.id,existing ?? encoded);
      continue;
    }
    const existing=group.names.map(name=>observed.get(name)).filter(value=>value!==undefined);
    if(existing.some(value=>!equalSecret(value,existing[0])))
      throw safeError(`existing values for credential group ${group.id} differ; refusing to overwrite`);
    values.set(group.id,existing[0] ?? undefined);
  }

  // Every service credential must be distinct; otherwise the configured
  // research/collector services would reject startup or weaken service separation.
  const used=[];
  for(const group of groups) {
    let value=values.get(group.id);
    if(value===undefined) {
      value=generateCredential();
      if(!validCredential(value)) throw safeError(`credential generator returned an invalid value for ${group.id}`);
      values.set(group.id,value);
    }
    if(used.some(previous=>equalSecret(previous,value)))
      throw safeError(`existing credentials are shared across groups; refusing to overwrite`);
    used.push(value);
  }

  const saved=[];
  for(const {group,name} of missing) {
    const value=values.get(group);
    let response;
    try {
      response=await fetchImpl(urlFor(name),{method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({value})});
    } catch { throw safeError(`could not save ${name}; earlier values, if any, may already be stored`); }
    if(!response.ok) throw safeError(`could not save ${name} (HTTP ${response.status}); earlier values, if any, may already be stored`);
    saved.push(name);
  }

  // The blob lease serializes only clients that honor this exact lock URL.
  // Re-read all names to detect independent Key Vault writers that raced this
  // pass; this is detection, not a guarantee against later external changes.
  for(const group of groups) for(const name of group.names) {
    let response;
    try { response=await fetchImpl(urlFor(name),{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token}`}}); }
    catch { throw safeError(`could not verify ${name} after provisioning; inspect Key Vault before retrying`); }
    if(!response.ok) throw safeError(`could not verify ${name} after provisioning (HTTP ${response.status}); inspect Key Vault before retrying`);
    let body;
    try { body=await response.json(); } catch { throw safeError(`could not verify ${name} after provisioning; inspect Key Vault before retrying`); }
    const validValue=group.id==='host-tls-ca-private-key'
      ?typeof body?.value==='string' && /^base64:[A-Za-z0-9+/]+=*$/.test(body.value)
      :validCredential(body?.value);
    if(!validValue || !equalSecret(body.value,values.get(group.id)))
      throw safeError(`${name} changed during provisioning; an independent writer may have interfered; inspect Key Vault before retrying`);
  }
  return {saved,alreadyPresent:[...observed.keys()],routeSecretNames:grouped,hostSecretNames:[...HOST_SECRETS],
    ...(hostTlsCaPrivateKey!==undefined?{hostTlsCaSecretName:hostTlsCaSecret}:{})};
  });
}

function getAzureToken(resource) {
  const args=['account','get-access-token','--resource',resource,'--query','accessToken','-o','tsv'];
  try {
    const output=process.platform==='win32'
      ?execFileSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`az ${args.join(' ')}`],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']})
      :execFileSync('az',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']});
    const token=output.trim();
    if(!token) throw new Error('empty token');
    return token;
  } catch { throw safeError(`Azure CLI could not obtain a token for ${resource}. Sign in with az login and retry.`); }
}

function parseArgs(args) {
  const options={},keys={'--vault':'vaultName','--prefix':'namePrefix','--lock-blob-url':'lockBlobUrl','--host-tls-ca-key-file':'hostTlsCaKeyFile','--ca-cert-file':'caCertificateFile'};
  for(let i=0;i<args.length;i++) {
    const key=keys[args[i]];
    if(!key || !args[i+1] || options[key])
      throw safeError('usage: node infra/provision-three-arm-secrets.mjs --vault <vault-name> --prefix <name-prefix> --lock-blob-url <https-blob-url> --host-tls-ca-key-file <protected-file-outside-repository> --ca-cert-file <public-cert-outside-repository>');
    options[key]=args[++i];
  }
  const configuredLockUrl=process.env.THESIS_THREE_ARM_SECRET_LOCK_BLOB_URL;
  if(options.lockBlobUrl && configuredLockUrl && options.lockBlobUrl!==configuredLockUrl)
    throw safeError('lock URL does not match THESIS_THREE_ARM_SECRET_LOCK_BLOB_URL');
  options.lockBlobUrl=options.lockBlobUrl||configuredLockUrl;
  if(!options.vaultName || !options.namePrefix || !options.lockBlobUrl || !options.hostTlsCaKeyFile || !options.caCertificateFile)
    throw safeError('usage: node infra/provision-three-arm-secrets.mjs --vault <vault-name> --prefix <name-prefix> --lock-blob-url <https-blob-url> --host-tls-ca-key-file <protected-file-outside-repository> --ca-cert-file <public-cert-outside-repository>');
  const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..','..');
  const privatePath=path.resolve(options.hostTlsCaKeyFile);
  if(privatePath===repoRoot || privatePath.startsWith(`${repoRoot}${path.sep}`))
    throw safeError('host TLS CA private key file must be outside the repository');
  const certificatePath=path.resolve(options.caCertificateFile);
  if(certificatePath===repoRoot || certificatePath.startsWith(`${repoRoot}${path.sep}`))
    throw safeError('host TLS CA public certificate source file must be outside the repository');
  return options;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const {vaultName,namePrefix,lockBlobUrl,hostTlsCaKeyFile,caCertificateFile}=parseArgs(process.argv.slice(2));
    const keyStat=await lstat(hostTlsCaKeyFile);
    if(keyStat.isSymbolicLink() || !keyStat.isFile() || process.platform!=='win32' && (keyStat.mode&0o077)!==0)
      throw safeError('host TLS CA private key must be a regular, non-symlink file with owner-only permissions');
    const certStat=await lstat(caCertificateFile);
    if(certStat.isSymbolicLink() || !certStat.isFile()) throw safeError('host TLS CA certificate must be a regular, non-symlink public file');
    const hostTlsCaPrivateKey=await readFile(hostTlsCaKeyFile,'utf8');
    const caCertificatePem=await readFile(caCertificateFile);
    validateHostCaPair(`base64:${Buffer.from(hostTlsCaPrivateKey,'utf8').toString('base64')}`,caCertificatePem);
    const token=getAzureToken('https://vault.azure.net');
    const storageToken=getAzureToken('https://storage.azure.com/');
    const result=await provisionThreeArmSecrets({vaultName,namePrefix,token,hostTlsCaPrivateKey,
      withExclusiveLock:run=>withAzureBlobLeaseLock({blobUrl:lockBlobUrl,token:storageToken,run})});
    process.stdout.write(`Three-arm credentials are ready. Created ${result.saved.length} secret entries; ${result.alreadyPresent.length} entries were already present. No credential values were displayed.\n`);
  } catch(error) {
    process.stderr.write(`${error?.message||'secret provisioning failed'}\n`);
    process.exitCode=1;
  }
}
