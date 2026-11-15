import {createPrivateKey,createPublicKey,X509Certificate} from 'node:crypto';
import {open,lstat,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const DEFAULT_TLS_DIRECTORY='/etc/thesis-research/tls';
const DEFAULT_CA_CERTIFICATE='/opt/thesis-research/certs/thesis-pilot-ca.pem';
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_SECRET=/^base64:([A-Za-z0-9+/]+={0,2})$/;
function safeError(message) { return new Error(message); }
function isRoot() { return typeof process.getuid==='function' && process.getuid()===0; }

function validateVaultUrl(value) {
  let url;
  try { url=new URL(value); } catch { throw safeError('an explicit Key Vault URL is required'); }
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/' ||
    !/^[a-z0-9-]+\.vault\.(azure\.net|usgovcloudapi\.net|azure\.cn)$/i.test(url.hostname))
    throw safeError('vault URL must be an HTTPS Azure Key Vault endpoint without credentials, path, or query');
  return url.origin;
}

export function validateHostCaPair(encodedValue,caCertificatePem) {
  const match=typeof encodedValue==='string' && PRIVATE_SECRET.exec(encodedValue);
  if(!match) throw safeError('host TLS CA Key Vault secret is invalid; no value was displayed');
  let key,pem,certificate;
  try {
    pem=Buffer.from(match[1],'base64');
    key=createPrivateKey(pem);
    certificate=new X509Certificate(caCertificatePem);
  } catch { throw safeError('host TLS CA material is invalid; no value was displayed'); }
  if(key.asymmetricKeyType!=='rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0)<3072 || !certificate.ca ||
    Date.parse(certificate.validTo)<=Date.now()+30*24*60*60*1000)
    throw safeError('host TLS CA key or public certificate is not an unexpired RSA-3072 CA pair');
  const keyPublic=createPublicKey(key).export({type:'spki',format:'der'});
  const certPublic=certificate.publicKey.export({type:'spki',format:'der'});
  if(!keyPublic.equals(certPublic)) throw safeError('host TLS CA key does not match the image trust certificate');
  return pem;
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

async function ensureProtectedDirectory(directory,fsImpl) {
  try { await fsImpl.mkdir(directory,{recursive:false,mode:0o700}); }
  catch(error) { if(error?.code!=='EEXIST') throw safeError('could not create root-only TLS directory'); }
  const stat=await fsImpl.lstat(directory);
  if(stat.isSymbolicLink?.() || !stat.isDirectory?.() || stat.uid!==0 || stat.gid!==0 || (stat.mode&0o777)!==0o700)
    throw safeError('TLS directory must be root-owned, non-symlink, and mode 0700');
}

async function installKey({pem,keyPath,fsImpl}) {
  try {
    const existingStat=await fsImpl.lstat(keyPath);
    if(existingStat.isSymbolicLink?.() || !existingStat.isFile?.() || existingStat.uid!==0 || existingStat.gid!==0 || (existingStat.mode&0o777)!==0o600)
      throw safeError('existing host CA key file is not root-only and protected');
    if(!(await fsImpl.readFile(keyPath)).equals(pem)) throw safeError('existing host CA key differs from Key Vault; refusing to replace it');
    return false;
  } catch(error) { if(error?.code!=='ENOENT') throw error; }
  let handle;
  try {
    handle=await fsImpl.open(keyPath,'wx',0o600);
    await handle.writeFile(pem);
    await handle.sync();
    await handle.close();
    return true;
  } catch {
    try { await handle?.close(); } catch {}
    throw safeError('could not install host CA key with exclusive root-only permissions');
  }
}

async function installPublicCertificate({pem,certificatePath,fsImpl}) {
  try {
    const stat=await fsImpl.lstat(certificatePath);
    if(stat.isSymbolicLink?.() || !stat.isFile?.() || stat.uid!==0 || stat.gid!==0 || (stat.mode&0o777)!==0o644)
      throw safeError('existing host CA certificate is not root-owned and public-readable');
    if(!(await fsImpl.readFile(certificatePath)).equals(pem)) throw safeError('existing host CA certificate differs from the image trust certificate');
    return false;
  } catch(error) { if(error?.code!=='ENOENT') throw error; }
  let handle;
  try {
    handle=await fsImpl.open(certificatePath,'wx',0o644);
    await handle.writeFile(pem);
    await handle.sync();
    await handle.close();
    return true;
  } catch {
    try { await handle?.close(); } catch {}
    throw safeError('could not install the public CA certificate');
  }
}

export async function installResearchHostCaKey({vaultUrl,identityClientId,namePrefix,
  caCertificatePath=DEFAULT_CA_CERTIFICATE,tlsDirectory=DEFAULT_TLS_DIRECTORY,
  fetchImpl=globalThis.fetch,fsImpl={open,lstat,mkdir,readFile},rootCheck=isRoot}={}) {
  if(!rootCheck()) throw safeError('host CA key installation must run as root');
  const origin=validateVaultUrl(vaultUrl);
  if(typeof identityClientId!=='string' || !GUID.test(identityClientId)) throw safeError('an explicit attached host secret-reader identity client ID is required');
  if(typeof namePrefix!=='string' || !/^[a-zA-Z0-9-]{1,20}$/.test(namePrefix)) throw safeError('invalid Key Vault secret name prefix');
  const certificatePem=await fsImpl.readFile(caCertificatePath);
  const token=await acquireMetadataToken({identityClientId,fetchImpl});
  const secretName=`${namePrefix}-host-tls-ca-private-key`;
  let response;
  try { response=await fetchImpl(`${origin}/secrets/${secretName}?api-version=7.4`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{authorization:`Bearer ${token}`}}); }
  catch { throw safeError('could not retrieve the host CA key from Key Vault; no value was displayed'); }
  if(!response.ok) throw safeError(`could not retrieve the host CA key from Key Vault (HTTP ${response.status}); no value was displayed`);
  let body;
  try { body=await response.json(); } catch { throw safeError('Key Vault returned an invalid host CA key response; no value was displayed'); }
  const pem=validateHostCaPair(body?.value,certificatePem);
  await ensureProtectedDirectory(tlsDirectory,fsImpl);
  const written=await installKey({pem,keyPath:path.join(tlsDirectory,'ca.key'),fsImpl});
  const certWritten=await installPublicCertificate({pem:certificatePem,certificatePath:path.join(tlsDirectory,'ca.crt'),fsImpl});
  return {written:written||certWritten,secretName};
}

function parseArgs(args) {
  const options={},keys={'--vault-url':'vaultUrl','--identity-client-id':'identityClientId','--prefix':'namePrefix','--ca-cert-file':'caCertificatePath'};
  for(let i=0;i<args.length;i++) {
    const key=keys[args[i]];
    if(!key || !args[i+1] || options[key]) throw safeError('usage: node infra/install-research-host-ca-key.mjs --vault-url <vault-url> --identity-client-id <client-id> --prefix <name-prefix> [--ca-cert-file <public-ca-path>]');
    options[key]=args[++i];
  }
  if(!options.vaultUrl || !options.identityClientId || !options.namePrefix)
    throw safeError('usage: node infra/install-research-host-ca-key.mjs --vault-url <vault-url> --identity-client-id <client-id> --prefix <name-prefix> [--ca-cert-file <public-ca-path>]');
  return options;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const result=await installResearchHostCaKey(parseArgs(process.argv.slice(2)));
    process.stdout.write(`Host TLS CA key is ${result.written?'installed':'already current'}; no secret value was displayed.\n`);
  } catch(error) {
    process.stderr.write(`${error?.message||'host CA key installation failed'}\n`);
    process.exitCode=1;
  }
}
