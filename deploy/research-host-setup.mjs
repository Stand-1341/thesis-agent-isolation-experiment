#!/usr/bin/env node
/** Build and install the private research/collector host over Azure VM Run Command. */
import {createHash,X509Certificate} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execCommand,makeAzRunner,makeStepLogger,readAzdEnv,readInfraOutputs} from './common.mjs';

const STARTER=path.resolve('Complete_Thesis_Azure_Package/05-DOCKER-STARTER');
const NODE_VERSION='22.23.4';
const NODE_ARCHIVE=`node-v${NODE_VERSION}-linux-x64.tar.xz`;
const NODE_ARCHIVE_URL=`https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;
const NODE_ARCHIVE_SHA256='1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce';
const REQUIRED_FILES=[
  'dist/resource.js','dist/collector.js','dist/resource-journal.js','dist/collector-journal.js',
  'dist/service-config.js','dist/helpers.js','infra/install-three-arm-service-secrets.mjs',
  'infra/install-research-host-ca-key.mjs','infra/bootstrap-research-host-tls.sh','infra/renew-research-host-tls.sh',
  'infra/stage-research-host.sh','certs/thesis-pilot-ca.pem','research-service.service','collector-service.service',
  'research-proxy.nginx.template','check-research-data-disk.sh','package.json'
];
const SOURCE_OVERRIDES=new Set(['research-service.service','collector-service.service','research-proxy.nginx.template','check-research-data-disk.sh']);
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function parseHostResourceId(value) {
  const match=/^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Compute\/virtualMachines\/([^/]+)$/i.exec(value??'');
  return match?{subscriptionId:match[1],resourceGroup:match[2],vmName:match[3]}:undefined;
}

function requireBundleInputs(values,outputs) {
  const host=parseHostResourceId(outputs?.researchHostResourceId);
  if(!host) throw new Error('research-host: full-stage output researchHostResourceId is missing or invalid');
  const clientId=outputs?.researchHostSecretReaderClientId;
  if(typeof clientId!=='string'||!GUID.test(clientId)) throw new Error('research-host: host secret-reader client ID is missing');
  const vaultName=outputs?.workloadTokenVaultName;
  if(typeof vaultName!=='string'||!/^[a-zA-Z0-9-]{3,24}$/.test(vaultName)) throw new Error('research-host: workload token Key Vault name is missing');
  const prefix=values.AZURE_NAME_PREFIX;
  if(typeof prefix!=='string'||!/^[a-z0-9][a-z0-9-]{1,19}$/.test(prefix)) throw new Error('research-host: AZURE_NAME_PREFIX is invalid');
  const ips=[outputs.researchServicePrivateIp,outputs.collectorPrivateIp,outputs.restrictedServicePrivateIp];
  if(ips.some(ip=>typeof ip!=='string'||!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip))) throw new Error('research-host: listener IP outputs are missing');
  return {...host,clientId,vaultName,prefix,ips};
}

export async function buildResearchPackage({values,work=mkdtemp(path.join(tmpdir(),'thesis-research-package-')),exec=execCommand}={}) {
  const scratch=await work;
  const packageDir=path.join(scratch,'package');
  const tarball=path.join(scratch,'research-host-package.tar.gz');
  try {
    const certPath=values.THESIS_RESEARCH_CA_CERT;
    if(typeof certPath!=='string'||!certPath) throw new Error('research-host: THESIS_RESEARCH_CA_CERT is missing');
    const certificate=await readFile(certPath);
    const text=certificate.toString('utf8');
    if(!/BEGIN CERTIFICATE/.test(text)||/PRIVATE KEY/.test(text)) throw new Error('research-host: CA certificate input is not public PEM');
    try { new X509Certificate(certificate); } catch { throw new Error('research-host: CA certificate input is invalid'); }
    const tsc=path.join(STARTER,'node_modules','typescript','bin','tsc');
    await exec([process.execPath,tsc,'-p',path.join(STARTER,'tsconfig.json')],{cwd:STARTER,timeoutMs:180000});
    await mkdir(packageDir,{recursive:true});
    for(const relative of REQUIRED_FILES) {
      const source=relative==='certs/thesis-pilot-ca.pem'?certPath:
        SOURCE_OVERRIDES.has(relative)?path.join(STARTER,'infra',relative):path.join(STARTER,...relative.split('/'));
      const destination=path.join(packageDir,...relative.split('/'));
      await mkdir(path.dirname(destination),{recursive:true});
      await copyFile(source,destination);
    }
    const hashes={};
    for(const relative of REQUIRED_FILES) {
      const destination=path.join(packageDir,...relative.split('/'));
      if(/\.(sh|service|template)$/i.test(relative)) {
        const normalized=(await readFile(destination,'utf8')).replace(/\r\n/g,'\n');
        await writeFile(destination,normalized,'utf8');
      }
      hashes[relative]=sha256(await readFile(destination));
    }
    const manifest=JSON.stringify({scope:'research-service-package-only',files:hashes,
      note:'Includes root-only host TLS bootstrap/renewal and secret-delivery code; no credentials, TLS keys, runtime, deployment, identity attachment or Azure role assignments included.'});
    const manifestBytes=Buffer.from(`${manifest}\n`,'utf8');
    await writeFile(path.join(packageDir,'manifest.json'),manifestBytes);
    const tar=process.platform==='win32'?'tar.exe':'tar';
    await exec([tar,'-czf',tarball,'-C',packageDir,'.'],{timeoutMs:120000});
    const verifierPath=path.join(STARTER,'scripts','verify-research-package.mjs');
    const verifierBytes=await readFile(verifierPath);
    return {scratch,tarball,manifestSha256:sha256(manifestBytes),verifierSha256:sha256(verifierBytes),
      verifierBase64:verifierBytes.toString('base64'),packageBase64:(await readFile(tarball)).toString('base64')};
  } catch(error) {
    await rm(scratch,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
}

export function buildRemoteSetupScript({host,packageBase64,manifestSha256,verifierBase64,verifierSha256,caCertificatePath}) {
  if(!GUID.test(host?.clientId??'')||typeof manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(manifestSha256)||
    typeof verifierSha256!=='string'||!/^[a-f0-9]{64}$/.test(verifierSha256))
    throw new Error('research-host: remote setup inputs are invalid');
  const q=value=>`'${String(value).replaceAll("'","'\\''")}'`;
  return `#!/bin/bash
set -euo pipefail
umask 077
export DEBIAN_FRONTEND=noninteractive
NODE_VERSION=${q(NODE_VERSION)}
NODE_ARCHIVE=${q(NODE_ARCHIVE)}
NODE_URL=${q(NODE_ARCHIVE_URL)}
NODE_SHA=${q(NODE_ARCHIVE_SHA256)}
MANIFEST_SHA=${q(manifestSha256)}
VERIFIER_SHA=${q(verifierSha256)}
HOST_CLIENT_ID=${q(host.clientId)}
VAULT_URL=${q(`https://${host.vaultName}.vault.azure.net/`)}
PREFIX=${q(host.prefix)}
RESEARCH_IP=${q(host.ips[0])}
COLLECTOR_IP=${q(host.ips[1])}
RESTRICTED_IP=${q(host.ips[2])}
CA_CERT=${q(caCertificatePath)}
PACKAGE_B64=${q(packageBase64)}
VERIFIER_B64=${q(verifierBase64)}
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl openssl nginx xz-utils
for i in $(seq 1 30); do
  [ -b /dev/disk/azure/scsi1/lun0 ] && break
  [ -b /dev/disk/azure/data/by-lun/0 ] && break
  sleep 2
done
DEVICE=/dev/disk/azure/scsi1/lun0
[ -b "$DEVICE" ] || DEVICE=/dev/disk/azure/data/by-lun/0
[ -b "$DEVICE" ] || { echo 'research-host: data disk is absent' >&2; exit 1; }
if ! blkid "$DEVICE" >/dev/null 2>&1; then mkfs.ext4 -L thesis-data "$DEVICE" >/dev/null; fi
[ "$(blkid -s TYPE -o value "$DEVICE")" = ext4 ] || { echo 'research-host: data disk is not ext4' >&2; exit 1; }
install -d -m 0755 /srv/thesis-data
if ! mountpoint -q /srv/thesis-data; then mount "$DEVICE" /srv/thesis-data; fi
UUID=$(blkid -s UUID -o value "$DEVICE")
grep -qE "^[[:space:]]*UUID=$UUID[[:space:]]+/srv/thesis-data[[:space:]]+ext4" /etc/fstab ||
  echo "UUID=$UUID /srv/thesis-data ext4 defaults,nofail 0 2" >> /etc/fstab
mkdir -p /tmp/thesis-host
if [ ! -x /opt/thesis-runtime/node/bin/node ]; then
  rm -rf /tmp/node-host
  mkdir -p /tmp/node-host
  curl --fail --silent --show-error --location "$NODE_URL" -o "/tmp/$NODE_ARCHIVE"
  echo "$NODE_SHA  /tmp/$NODE_ARCHIVE" | sha256sum -c -
  tar -xJf "/tmp/$NODE_ARCHIVE" -C /tmp/node-host "node-v$NODE_VERSION-linux-x64/bin/node"
  install -d -m 0755 /opt/thesis-runtime/node/bin
  install -m 0755 "/tmp/node-host/node-v$NODE_VERSION-linux-x64/bin/node" /opt/thesis-runtime/node/bin/node
  rm -rf /tmp/node-host "/tmp/$NODE_ARCHIVE"
fi
if [ ! -f /opt/thesis-research/.package-manifest-sha256 ]; then
  rm -rf /tmp/thesis-host/package
  mkdir -p /tmp/thesis-host/package
  printf '%s' "$PACKAGE_B64" | base64 -d > /tmp/thesis-host/package.tar.gz
  tar -xzf /tmp/thesis-host/package.tar.gz -C /tmp/thesis-host/package
  printf '%s' "$VERIFIER_B64" | base64 -d > /tmp/thesis-host/verify-research-package.mjs
  [ "$(sha256sum /tmp/thesis-host/verify-research-package.mjs | cut -d ' ' -f 1)" = "$VERIFIER_SHA" ] || { echo 'research-host: verifier checksum mismatch' >&2; exit 1; }
  /opt/thesis-runtime/node/bin/node /tmp/thesis-host/verify-research-package.mjs /tmp/thesis-host/package "$MANIFEST_SHA"
  bash /tmp/thesis-host/package/infra/stage-research-host.sh /tmp/thesis-host/package /opt/thesis-runtime/node/bin/node "$MANIFEST_SHA" /tmp/thesis-host/verify-research-package.mjs "$VERIFIER_SHA"
  printf '%s' "$MANIFEST_SHA" > /opt/thesis-research/.package-manifest-sha256
else
  [ "$(cat /opt/thesis-research/.package-manifest-sha256)" = "$MANIFEST_SHA" ] || { echo 'research-host: installed package differs; operator reconciliation required' >&2; exit 1; }
fi
install -d -m 0750 -o thesis-research -g thesis-research /srv/thesis-data/resource
install -d -m 0750 -o thesis-collector -g thesis-collector /srv/thesis-data/collector
/opt/thesis-runtime/node/bin/node /opt/thesis-research/infra/install-research-host-ca-key.mjs --vault-url "$VAULT_URL" --identity-client-id "$HOST_CLIENT_ID" --prefix "$PREFIX" --ca-cert-file "$CA_CERT"
if [ ! -f /etc/thesis-research/tls/research.crt ]; then
  /opt/thesis-research/infra/bootstrap-research-host-tls.sh "$RESEARCH_IP" "$COLLECTOR_IP" "$RESTRICTED_IP"
fi
/opt/thesis-runtime/node/bin/node /opt/thesis-research/infra/install-three-arm-service-secrets.mjs --vault-url "$VAULT_URL" --identity-client-id "$HOST_CLIENT_ID" --prefix "$PREFIX"
systemctl daemon-reload
systemctl enable nginx
systemctl enable thesis-research thesis-collector
systemctl restart nginx thesis-research thesis-collector
for target in "https://$RESEARCH_IP:443/health" "https://$COLLECTOR_IP:8443/health" "https://$RESTRICTED_IP:9443/health"; do
  for i in $(seq 1 30); do
    if curl --cacert /etc/thesis-research/tls/ca.crt --fail --silent --show-error --max-time 5 "$target" >/dev/null; then break; fi
    [ "$i" -lt 30 ] || { echo "research-host: health check failed for $target" >&2; exit 1; }
    sleep 2
  done
done
echo 'research-host: package, data mount, TLS, credentials, services, and health checks are ready'
echo 'RESEARCH_HOST_SETUP_OK'
`;
}

export async function setupResearchHost({env=process.env,az=makeAzRunner(),stdout=process.stdout,stderr=process.stderr,
  outputs,build=buildResearchPackage,runCommand,stateDir,exec=execCommand}={}) {
  const log=makeStepLogger({stream:stdout});
  const values=await readAzdEnv(env);
  const armOutputs=outputs??await readInfraOutputs().catch(()=>undefined);
  if(!armOutputs?.researchHostResourceId) {
    log('research-host','skipped',{note:'no research-host output in selected deployment'});
    return 0;
  }
  let host;
  try { host=requireBundleInputs(values,armOutputs); }
  catch(error) { stderr.write(`${error.message}\n`); return 5; }
  const directory=stateDir??path.join(process.cwd(),'.azure',values.AZURE_ENV_NAME??'default');
  const statePath=path.join(directory,'research-host-setup.json');
  let state;
  try { state=JSON.parse(await readFile(statePath,'utf8')); } catch { state={schemaVersion:1}; }
  let artifact;
  try { artifact=await build({values,exec}); }
  catch(error) { stderr.write(`research-host: package build failed: ${String(error?.message??error).slice(0,300)}\n`); return 4; }
  const run=runCommand??(async script=>{
    const result=await az(['vm','run-command','invoke','--ids',armOutputs.researchHostResourceId,
      '--command-id','RunShellScript','--scripts',`@${script}`],{json:true,timeoutMs:60*60*1000});
    if(!JSON.stringify(result??{}).includes('RESEARCH_HOST_SETUP_OK')) {
      const message=(result?.value??[]).map(item=>String(item?.message??'')).join('\n')
        .replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(-1600);
      throw new Error(`remote setup did not return its success marker${message?`: ${message}`:''}`);
    }
    return result;
  });
  try {
    if(state.packageSha256===artifact.manifestSha256&&state.hostResourceId===armOutputs.researchHostResourceId&&state.verifiedAt) {
      log('research-host','ready',{note:`already verified ${state.verifiedAt}`});
      return 0;
    }
    const script=buildRemoteSetupScript({host,packageBase64:artifact.packageBase64,manifestSha256:artifact.manifestSha256,
      verifierBase64:artifact.verifierBase64,verifierSha256:artifact.verifierSha256,caCertificatePath:'/opt/thesis-research/certs/thesis-pilot-ca.pem'});
    const scriptPath=path.join(artifact.scratch,'setup.sh');
    await writeFile(scriptPath,script);
    await run(scriptPath);
    await mkdir(directory,{recursive:true});
    state={schemaVersion:1,hostResourceId:armOutputs.researchHostResourceId,packageSha256:artifact.manifestSha256,
      verifiedAt:new Date().toISOString()};
    await writeFile(statePath,`${JSON.stringify(state,null,2)}\n`);
    log('research-host','ready',{note:'data mount, TLS, credentials, services, and health checks verified'});
    return 0;
  } catch(error) {
    stderr.write(`research-host: setup failed: ${String(error?.message??error).replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,1600)}\n`);
    return 4;
  } finally {
    await rm(artifact.scratch,{recursive:true,force:true}).catch(()=>{});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exitCode=await setupResearchHost();
