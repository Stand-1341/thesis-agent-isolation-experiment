#!/bin/sh
# Stage the VM workload only. Run as root on the disposable VM after reviewing
# the package and environment file. This script does not enable or start it.
set -eu
if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 3 ]; then
  echo 'Usage (as root): install-vm-agent.sh PACKAGE_DIR NODE22_DIST_DIR ROOT_OWNED_ENV_FILE' >&2
  exit 2
fi
package=$1
node_dist=$2
node_binary="$node_dist/bin/node"
environment_file=$3
test -f "$node_binary" && test -x "$node_binary"
node_sha256='94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90'
actual_sha256=$(sha256sum "$node_binary" | cut -d ' ' -f 1)
if [ "$actual_sha256" != "$node_sha256" ]; then echo 'Node binary checksum mismatch' >&2; exit 1; fi
case "$("$node_binary" --version)" in v22.*) ;; *) echo 'Node 22 is required' >&2; exit 1 ;; esac
if [ ! -f "$environment_file" ] || [ "$(stat -c '%u:%a' "$environment_file")" != '0:600' ]; then
  echo 'Environment file must be a root-owned regular file with mode 600' >&2
  exit 1
fi
# Hashes detect mistakes, not malicious replacement of both package and manifest.
"$node_binary" - "$package" "$environment_file" <<'NODE'
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const root=fs.realpathSync(process.argv[2]);
const required=['dist/agent.js','dist/core.js','dist/helpers.js','dist/network-probe.mjs','dist/azure-blob-workload.mjs','dist/azure-managed-token.mjs','dist/azure-delegated-token.mjs','dist/azure-session-seed.mjs','certs/thesis-pilot-ca.pem','vm-agent.service','install-vm-agent.sh','vm-agent-nginx.template','create-vm-agent-csr.sh','install-vm-agent-tls.sh','package.json','package-lock.json'];
const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
const expected=Object.keys(manifest.files || {});
if(manifest.scope!=='vm-workload-package-only' || !required.every(name=>expected.includes(name)) ||
   expected.some(name=>!required.includes(name)) ||
   expected.some(name=>name.split('/').some(part=>part==='..' || part==='.' || !part))) throw new Error('Invalid package manifest');
const actual=[];
function walk(dir,prefix='') {
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const relative=prefix ? `${prefix}/${entry.name}` : entry.name;
    if(entry.isSymbolicLink()) throw new Error('Symlinks are not permitted in the package');
    if(entry.isDirectory()) walk(path.join(dir,entry.name),relative);
    else if(entry.isFile() && relative!=='manifest.json') actual.push(relative);
    else if(!entry.isFile()) throw new Error('Invalid package entry');
  }
}
walk(root);
if(JSON.stringify(actual.sort())!==JSON.stringify([...expected].sort())) throw new Error('Package files do not match manifest');
for(const relative of expected) {
  const file=path.join(root,relative), stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid package file');
  if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==manifest.files[relative]) throw new Error('Package integrity check failed');
}
const allowed=new Set(['RESEARCH_URL','COLLECTOR_URL','WORKLOAD_TOKEN','TRIAL_REQUEST_KEY','PORT','PROBE_RESTRICTED_IP','PROBE_REDIRECT_URL','AZURE_BLOB_ENDPOINT','AZURE_CLIENT_ID','AZURE_TOKEN_MODE']);
const values={};
for(const line of fs.readFileSync(process.argv[3],'utf8').split(/\r?\n/)) {
  if(!line.trim() || line.trimStart().startsWith('#')) continue;
  const match=/^([A-Z][A-Z0-9_]*)=([^\s"']+)$/.exec(line);
  if(!match || !allowed.has(match[1]) || Object.hasOwn(values,match[1]) || match[2].includes('REPLACE-WITH')) throw new Error('Invalid workload environment file');
  values[match[1]]=match[2];
}
for(const key of ['RESEARCH_URL','COLLECTOR_URL','TRIAL_REQUEST_KEY']) if(!values[key]) throw new Error('Missing workload environment setting');
const authMode=values.AZURE_TOKEN_MODE || 'managed';
if(!['managed','delegated'].includes(authMode) || (authMode==='delegated' && (!values.AZURE_BLOB_ENDPOINT || values.WORKLOAD_TOKEN || values.AZURE_CLIENT_ID)) ||
   (authMode==='managed' && !values.WORKLOAD_TOKEN)) throw new Error('Invalid workload token mode');
if(values.TRIAL_REQUEST_KEY.length<32 || (values.WORKLOAD_TOKEN && (values.WORKLOAD_TOKEN.length<32 || values.WORKLOAD_TOKEN===values.TRIAL_REQUEST_KEY))) throw new Error('Workload and controller credentials must be distinct and at least 32 characters');
for(const key of ['RESEARCH_URL','COLLECTOR_URL']) {
  let url; try {url=new URL(values[key]);} catch {throw new Error('Invalid workload endpoint');}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash) throw new Error('Workload endpoints must be HTTPS without embedded credentials');
}
if(values.AZURE_BLOB_ENDPOINT) {
  let url; try {url=new URL(values.AZURE_BLOB_ENDPOINT);} catch {throw new Error('Invalid Azure Blob endpoint');}
  if(url.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) || url.pathname!=='/' || url.username || url.password || url.port || url.search || url.hash) throw new Error('Invalid Azure Blob endpoint');
}
if(values.AZURE_CLIENT_ID && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.AZURE_CLIENT_ID)) throw new Error('Invalid managed identity client ID');
NODE
if [ -e /opt/thesis-agent ] || [ -e /opt/thesis-runtime/node ] || [ -e /etc/thesis-agent ]; then
  echo 'Existing installation requires manual reconciliation' >&2
  exit 1
fi
if getent passwd thesis-agent >/dev/null; then
  if [ "$(id -u thesis-agent)" -eq 0 ]; then echo 'Invalid workload account' >&2; exit 1; fi
else
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin thesis-agent
fi
install -d -o root -g root -m 0755 /opt/thesis-agent/dist /opt/thesis-agent/certs /opt/thesis-runtime/node
install -d -o root -g root -m 0700 /etc/thesis-agent
cp -a "$node_dist"/. /opt/thesis-runtime/node/
for name in agent.js core.js helpers.js network-probe.mjs azure-blob-workload.mjs azure-managed-token.mjs azure-delegated-token.mjs azure-session-seed.mjs; do
  install -o root -g root -m 0644 "$package/dist/$name" "/opt/thesis-agent/dist/$name"
done
install -o root -g root -m 0644 "$package/certs/thesis-pilot-ca.pem" /opt/thesis-agent/certs/thesis-pilot-ca.pem
install -o root -g root -m 0644 "$package/package.json" /opt/thesis-agent/package.json
install -o root -g root -m 0644 "$package/package-lock.json" /opt/thesis-agent/package-lock.json
install -o root -g root -m 0644 "$package/vm-agent-nginx.template" /opt/thesis-agent/vm-agent-nginx.template
install -o root -g root -m 0755 "$package/create-vm-agent-csr.sh" /usr/local/sbin/create-vm-agent-csr.sh
install -o root -g root -m 0755 "$package/install-vm-agent-tls.sh" /usr/local/sbin/install-vm-agent-tls.sh
PATH="/opt/thesis-runtime/node/bin:$PATH" /opt/thesis-runtime/node/bin/npm --prefix /opt/thesis-agent ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R root:root /opt/thesis-agent/node_modules
chmod -R a-w /opt/thesis-agent/node_modules
install -o root -g root -m 0600 "$environment_file" /etc/thesis-agent/agent.env
install -o root -g root -m 0644 "$package/vm-agent.service" /etc/systemd/system/thesis-agent.service
systemctl daemon-reload
echo 'VM workload staged. Service has not been enabled or started.'
