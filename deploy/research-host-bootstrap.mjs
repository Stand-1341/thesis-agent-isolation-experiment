import {createHash, createPrivateKey, createPublicKey, X509Certificate} from 'node:crypto';
import {chmod, lstat, link, mkdir, mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {execCommand, readAzdEnv, readInfraOutputs} from './common.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STARTER=path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER');
const SECRET_SEEDER=path.join(STARTER,'infra','provision-three-arm-secrets.mjs');

function fail(message) { throw new Error(message); }

/** Validate the public CA and its private key before any Azure deployment. */
export async function validateResearchHostCa({caCertificatePath,caPrivateKeyPath,
  repositoryRoot=path.resolve('.'),read=readFile,stat=lstat,resolve=realpath,now=Date.now(),
  exec=execCommand,platform=process.platform}={}) {
  if(typeof caCertificatePath!=='string'||!caCertificatePath||typeof caPrivateKeyPath!=='string'||!caPrivateKeyPath)
    fail('THESIS_RESEARCH_CA_CERT and THESIS_RESEARCH_CA_KEY must name the public CA certificate and matching private key');
  const root=await resolve(repositoryRoot);
  const paths=[];
  for(const value of [caCertificatePath,caPrivateKeyPath]) {
    const absolute=path.resolve(value),actual=await resolve(absolute);
    const relative=path.relative(root,actual);
    if(relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative))) fail('research CA files must remain outside the repository');
    const info=await stat(absolute);
    if(info.isSymbolicLink?.()||!info.isFile?.()||actual!==absolute) fail('research CA inputs must be regular non-symlink files');
    paths.push(absolute);
  }
  if(platform==='win32') await secureWindowsPrivateFile(paths[1],{exec,stat});
  else {
    const keyInfo=await stat(paths[1]);
    if((keyInfo.mode&0o077)!==0) fail('research CA private key must have owner-only file permissions');
  }
  const [certificatePem,privateKeyPem]=await Promise.all(paths.map(file=>read(file)));
  if(/PRIVATE KEY/.test(certificatePem.toString('utf8'))) fail('THESIS_RESEARCH_CA_CERT must contain public certificate PEM only');
  let certificate,key;
  try { certificate=new X509Certificate(certificatePem); key=createPrivateKey(privateKeyPem); }
  catch { fail('research CA certificate or private key is invalid'); }
  if(!certificate.ca||key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<3072||
    !Number.isFinite(Date.parse(certificate.validFrom))||Date.parse(certificate.validFrom)>now||
    !Number.isFinite(Date.parse(certificate.validTo))||Date.parse(certificate.validTo)<=now+30*24*60*60*1000)
    fail('research CA must be an active RSA-3072-or-stronger CA with at least 30 days of validity');
  const keyPublic=createPublicKey(key).export({type:'spki',format:'der'});
  const certPublic=certificate.publicKey.export({type:'spki',format:'der'});
  if(!keyPublic.equals(certPublic)) fail('research CA private key does not match the public certificate');
  return {caCertificatePath:paths[0],caPrivateKeyPath:paths[1],certificateSha256:createHash('sha256').update(certificatePem).digest('hex')};
}

const WINDOWS_FULL_CONTROL=0x1f01ff;
const WINDOWS_SYSTEM_SID='S-1-5-18';
const WINDOWS_OWNER_RIGHTS_SID='S-1-3-4';

async function currentWindowsUserSid({exec=execCommand}={}) {
  let who;
  try { who=await exec(['whoami.exe','/user','/fo','csv','/nh'],{timeoutMs:15000}); }
  catch { fail('could not determine the current Windows user SID to secure the research CA private key'); }
  const userSid=/S-1-(?:\d+-)+\d+/i.exec(String(who.stdout??''))?.[0];
  const userName=/^\s*"((?:[^"]|"")+)"/.exec(String(who.stdout??''))?.[1]?.replaceAll('""','"');
  if(!userSid||!userName) fail('could not determine the current Windows user SID to secure the research CA private key');
  return {userSid,userName};
}

function windowsPrincipalAllowed(value,{userSid,userName}) {
  const normalized=String(value??'').toLowerCase();
  return normalized===userSid.toLowerCase()||normalized===userName.toLowerCase()||
    normalized===WINDOWS_SYSTEM_SID.toLowerCase()||normalized==='nt authority\\system'||
    normalized==='sy'||normalized==='system'||normalized===WINDOWS_OWNER_RIGHTS_SID.toLowerCase()||normalized==='owner rights';
}
function windowsPrincipalIsSystem(value) {
  const normalized=String(value??'').toLowerCase();
  return [WINDOWS_SYSTEM_SID.toLowerCase(),'nt authority\\system','sy','system'].includes(normalized);
}
function windowsPrincipalIsCurrentUser(value,{userSid,userName}) {
  const normalized=String(value??'').toLowerCase();
  return normalized===userSid.toLowerCase()||normalized===userName.toLowerCase()||
    normalized===WINDOWS_OWNER_RIGHTS_SID.toLowerCase()||normalized==='owner rights';
}

async function verifySavedWindowsAcl(filePath,{userSid,userName,exec=execCommand,fs={mkdtemp,readFile,rm}}={}) {
  const scratch=await fs.mkdtemp(path.join(tmpdir(),'research-ca-acl-'));
  const aclFile=path.join(scratch,'acl.txt');
  try {
    try { await exec(['icacls.exe',filePath,'/save',aclFile],{timeoutMs:15000}); }
    catch { fail('could not verify the research CA private-key Windows ACL'); }
    let saved;
    try {
      const bytes=await fs.readFile(aclFile);
      saved=bytes[0]===0xff&&bytes[1]===0xfe?bytes.toString('utf16le').slice(1):
        bytes.includes(0)?bytes.toString('utf16le'):bytes.toString('utf8');
    }
    catch { fail('Windows did not return a saved DACL for the research CA private key'); }
    const entries=[...saved.matchAll(/\(([^()]*)\)/g)].map(match=>match[1].split(';'));
    const isAllowedEntry=parts=>parts.length===6&&parts[0]==='A'&&!/ID/i.test(parts[1])&&
      (parts[2]==='FA'||Number.parseInt(parts[2],16)===WINDOWS_FULL_CONTROL)&&
      windowsPrincipalAllowed(parts[5],{userSid,userName});
    const valid=entries.filter(parts=>parts.length===6&&parts[0]==='A'&&!/ID/i.test(parts[1])&&
      (parts[2]==='FA'||Number.parseInt(parts[2],16)===WINDOWS_FULL_CONTROL)&&windowsPrincipalAllowed(parts[5],{userSid,userName}));
    const hasUser=entries.some(parts=>windowsPrincipalIsCurrentUser(parts[5],{userSid,userName}));
    const hasSystem=entries.some(parts=>windowsPrincipalIsSystem(parts[5]));
    if(entries.length!==2||valid.length!==2||!entries.every(isAllowedEntry)||!hasUser||!hasSystem)
      fail('research CA private-key Windows ACL is broader than the current user and SYSTEM');
    return true;
  } finally { await fs.rm(scratch,{recursive:true,force:true}); }
}

export async function secureWindowsPrivateFile(filePath,{exec=execCommand,stat=lstat}={}) {
  const fileInfo=await stat(filePath);
  if(fileInfo.isSymbolicLink?.()||!fileInfo.isFile?.()) fail('research CA private key must be a regular non-symlink file');
  const {userSid,userName}=await currentWindowsUserSid({exec});
  try {
    await exec(['icacls.exe',filePath,'/setowner',`*${userSid}`],{timeoutMs:15000});
    await exec(['icacls.exe',filePath,'/inheritance:r'],{timeoutMs:15000});
    await exec(['icacls.exe',filePath,'/grant:r',`*${userSid}:(F)`],{timeoutMs:15000});
    await exec(['icacls.exe',filePath,'/grant:r',`*${WINDOWS_SYSTEM_SID}:(F)`],{timeoutMs:15000});
  } catch { fail('could not restrict the research CA private key to the current Windows user and SYSTEM'); }
  await verifySavedWindowsAcl(filePath,{userSid,userName,exec,fs:{mkdtemp,readFile,rm}});
}

export async function secureWindowsPrivateDirectory(directory,{exec=execCommand,stat=lstat}={}) {
  const info=await stat(directory);
  if(info.isSymbolicLink?.()||!info.isDirectory?.()) fail('research CA staging directory must be a real directory');
  const {userSid,userName}=await currentWindowsUserSid({exec});
  try {
    await exec(['icacls.exe',directory,'/setowner',`*${userSid}`],{timeoutMs:15000});
    await exec(['icacls.exe',directory,'/inheritance:r'],{timeoutMs:15000});
    await exec(['icacls.exe',directory,'/grant:r',`*${userSid}:(OI)(CI)F`],{timeoutMs:15000});
    await exec(['icacls.exe',directory,'/grant:r',`*${WINDOWS_SYSTEM_SID}:(OI)(CI)F`],{timeoutMs:15000});
  } catch { fail('could not restrict the research CA staging directory before key generation'); }
  await verifySavedWindowsAcl(directory,{userSid,userName,exec,fs:{mkdtemp,readFile,rm}});
}

export async function resolveOpenSslExecutable({platform=process.platform,env=process.env,accessFile=async file=>{const info=await lstat(file);if(!info.isFile())throw new Error('not a file');return true;},
  run=execCommand}={}) {
  const candidates=[];
  if(typeof env.OPENSSL_BIN==='string'&&env.OPENSSL_BIN.trim()) candidates.push(env.OPENSSL_BIN.trim());
  if(platform==='win32') {
    try {
      const found=await run(['where.exe','openssl.exe'],{timeoutMs:10000});
      candidates.push(...String(found.stdout??'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean));
    } catch {}
    const programFiles=env.ProgramFiles??'C:\\Program Files';
    candidates.push(path.join(programFiles,'Git','usr','bin','openssl.exe'),path.join(programFiles,'Git','mingw64','bin','openssl.exe'));
  } else candidates.push('openssl');
  const seen=new Set();
  for(const candidate of candidates) {
    if(seen.has(candidate)) continue; seen.add(candidate);
    try { if(candidate==='openssl'&&platform!=='win32'&&(!env.OPENSSL_BIN||candidate!==env.OPENSSL_BIN.trim())) return candidate;
      await accessFile(candidate); return candidate; } catch {}
  }
  fail('OpenSSL is required to create the local research CA; install OpenSSL or set OPENSSL_BIN and rerun preflight');
}

/** Create a matching local CA pair before deployment when neither output exists.
 * OpenSSL is invoked without a shell; files are created exclusively outside the
 * repository and never printed. Existing complete pairs are validated/reused. */
export async function ensureResearchHostCa({caCertificatePath,caPrivateKeyPath,repositoryRoot=path.resolve('.'),
  home=homedir(),exec=execCommand,validate=validateResearchHostCa,fs={mkdir,mkdtemp,link,chmod,rm},
  resolve=realpath,stat=lstat,platform=process.platform,env=process.env,openSslResolver=resolveOpenSslExecutable}={}) {
  if(Boolean(caCertificatePath)!==Boolean(caPrivateKeyPath)) fail('set both THESIS_RESEARCH_CA_CERT and THESIS_RESEARCH_CA_KEY, or set neither to use the safe per-user default');
  const defaultDir=path.join(home,'.thesis-agent-isolation-experiment','research-ca');
  const certificate=path.resolve(caCertificatePath||path.join(defaultDir,'ca.crt'));
  const privateKey=path.resolve(caPrivateKeyPath||path.join(defaultDir,'ca.key'));
  const root=await resolve(repositoryRoot);
  await fs.mkdir(path.dirname(certificate),{recursive:true,mode:0o700});
  await fs.mkdir(path.dirname(privateKey),{recursive:true,mode:0o700});
  const [certificateParent,keyParent]=await Promise.all([resolve(path.dirname(certificate)),resolve(path.dirname(privateKey))]);
  if(path.resolve(certificateParent)!==path.resolve(keyParent)) fail('research CA certificate and private key outputs must share one directory');
  for(const parent of [certificateParent,keyParent]) {
    const relative=path.relative(root,parent);
    if(relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative))) fail('research CA output directories must remain outside the repository');
  }
  const exists=async file=>{try{return await stat(file);}catch(error){if(error?.code==='ENOENT')return undefined;throw error;}};
  const certStat=await exists(certificate),keyStat=await exists(privateKey);
  if(certStat||keyStat) {
    if(!certStat||!keyStat) fail('only one research CA output exists; refusing to replace or regenerate either file');
    const checked=await validate({caCertificatePath:certificate,caPrivateKeyPath:privateKey,repositoryRoot:root,exec,platform});
    return {...checked,created:false};
  }
  if(certificate===privateKey) fail('research CA certificate and private key need separate output files');
  const staging=await fs.mkdtemp(path.join(path.dirname(privateKey),'.research-ca-'));
  const stagedKey=path.join(staging,'ca.key'),stagedCertificate=path.join(staging,'ca.crt');
  let keyLinked=false,certificateLinked=false;
  try {
    if(platform==='win32') await secureWindowsPrivateDirectory(staging,{exec,stat});
    else await fs.chmod(staging,0o700);
    const openssl=await openSslResolver({platform,env,run:exec});
    await exec([openssl,'genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:3072','-out',stagedKey],{timeoutMs:120000});
    await exec([openssl,'req','-x509','-new','-key',stagedKey,'-sha256','-days','3650','-subj','/CN=Thesis pilot CA',
      '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-out',stagedCertificate],{timeoutMs:120000});
    await exec([openssl,'x509','-in',stagedCertificate,'-noout','-checkend','2592000'],{timeoutMs:30000});
    await exec([openssl,'verify','-CAfile',stagedCertificate,stagedCertificate],{timeoutMs:30000});
    await fs.chmod(stagedKey,0o600);
    await fs.chmod(stagedCertificate,0o644);
    await fs.link(stagedKey,privateKey); keyLinked=true;
    await fs.link(stagedCertificate,certificate); certificateLinked=true;
    const checked=await validate({caCertificatePath:certificate,caPrivateKeyPath:privateKey,repositoryRoot:root,exec,platform});
    return {...checked,created:true};
  } catch(error) {
    if(certificateLinked) await fs.rm(certificate,{force:true}).catch(()=>{});
    if(keyLinked) await fs.rm(privateKey,{force:true}).catch(()=>{});
    throw error;
  } finally { await fs.rm(staging,{recursive:true,force:true}); }
}

export function buildResearchHostBootstrapCommand({values,outputs,scriptPath=SECRET_SEEDER}={}) {
  const vaultName=outputs?.workloadTokenVaultName?.value??outputs?.workloadTokenVaultName;
  const lockBlobUrl=outputs?.bootstrapLockBlobUrl?.value??outputs?.bootstrapLockBlobUrl;
  const namePrefix=values?.AZURE_NAME_PREFIX;
  const keyPath=values?.THESIS_RESEARCH_CA_KEY;
  const certificatePath=values?.THESIS_RESEARCH_CA_CERT;
  if(typeof vaultName!=='string'||! /^[a-zA-Z0-9-]{3,24}$/.test(vaultName)) fail('foundation output did not provide a valid workload token Key Vault name');
  if(typeof lockBlobUrl!=='string'||!/^https:\/\//.test(lockBlobUrl)) fail('foundation output did not provide the bootstrap lock Blob URL');
  if(typeof namePrefix!=='string'||! /^[a-z0-9]{3,12}$/.test(namePrefix)) fail('AZURE_NAME_PREFIX is required for the secret bootstrap');
  if(!keyPath||!certificatePath) fail('research CA certificate and private-key paths must be configured before provisioning');
  return [process.execPath,scriptPath,'--vault',vaultName,'--prefix',namePrefix,'--lock-blob-url',lockBlobUrl,
    '--host-tls-ca-key-file',keyPath,'--ca-cert-file',certificatePath];
}

/** Seed the foundation vault under the foundation-created distributed lock.
 * The seeder prints counts only; retries are limited to role propagation 403s. */
export async function runResearchHostBootstrap({env=process.env,outputs,run=execCommand,
  validateCa=validateResearchHostCa,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  maxAttempts=5,scriptPath=SECRET_SEEDER,cwd=STARTER}={}) {
  const values=await readAzdEnv(env);
  const ca=await validateCa({caCertificatePath:values.THESIS_RESEARCH_CA_CERT,caPrivateKeyPath:values.THESIS_RESEARCH_CA_KEY});
  const command=buildResearchHostBootstrapCommand({values:{...values,THESIS_RESEARCH_CA_CERT:ca.caCertificatePath,
    THESIS_RESEARCH_CA_KEY:ca.caPrivateKeyPath},outputs,scriptPath});
  if(path.resolve(values.THESIS_RESEARCH_CA_KEY)!==ca.caPrivateKeyPath||path.resolve(values.THESIS_RESEARCH_CA_CERT)!==ca.caCertificatePath)
    fail('research CA file paths failed canonical validation');
  for(let attempt=1;attempt<=maxAttempts;attempt++) {
    try {
      await run(command,{cwd,timeoutMs:5*60*1000});
      return {certificateSha256:ca.certificateSha256};
    } catch(error) {
      const status=`${error?.stderr??''} ${error?.message??''}`;
      if(attempt===maxAttempts||!/(?:HTTP\s+403|Forbidden)/i.test(status))
        fail('Key Vault/lock bootstrap failed; full-stage deployment was not started and no secret value was displayed');
      await sleep(2000*attempt);
    }
  }
  return fail('Key Vault/lock bootstrap failed; full-stage deployment was not started');
}

export async function defaultResearchHostBootstrap({env=process.env,run=execCommand,readOutputs=readInfraOutputs}={}) {
  const values=await readAzdEnv(env);
  const outputs=await readOutputs({env:values});
  return runResearchHostBootstrap({env:values,outputs,run});
}

