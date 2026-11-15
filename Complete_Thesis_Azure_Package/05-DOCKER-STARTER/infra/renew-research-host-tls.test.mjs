import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile, chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scriptPath = fileURLToPath(new URL('./renew-research-host-tls.sh', import.meta.url));
const scriptBytes = await readFile(scriptPath, 'utf8');
const bashExe = process.platform === 'win32' ? 'C:\\Windows\\System32\\bash.exe' : 'bash';
function posixPath(value) {
  const normalized = value.replaceAll('\\', '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2]}` : normalized;
}
const shellQuote=value=>`'${value.replaceAll("'","'\\''")}'`;

async function runRenew({failNginx = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'research-tls-renew-'));
  const tlsDir = join(root, 'tls');
  const fakeBin = join(root, 'bin');
  await mkdir(tlsDir);
  await mkdir(fakeBin);
  const openssl = `#!/usr/bin/env bash
set -eu
if [[ \$1 == pkey ]]; then printf 'matching-public-key\\n'; exit 0; fi
if [[ \$1 == verify ]]; then exit 0; fi
if [[ \$1 == x509 && " \$* " == *' -pubkey '* ]]; then printf 'matching-public-key\\n'; exit 0; fi
if [[ \$1 == x509 && " \$* " == *' -fingerprint '* ]]; then echo certificate-details; exit 0; fi
if [[ \$1 == x509 && \${*: -1} == -noout ]]; then echo certificate-details; exit 0; fi
out=''
for ((i=1;i<=\$#;i++)); do if [[ \${!i} == -out ]]; then j=\$((i+1)); out=\${!j}; fi; done
if [[ -n \$out ]]; then printf 'generated:%s\\n' "$(basename "\$out")" > "\$out"; fi
if [[ \$1 == x509 && " \$* " == *' -pubkey '* ]]; then
  input=''
  for ((i=1;i<=\$#;i++)); do if [[ \${!i} == -in ]]; then j=\$((i+1)); input=\${!j}; fi; done
  [[ -f \$input ]] || exit 2
  printf 'matching-public-key\\n'
fi
`;
  const nginx = `#!/usr/bin/env bash
[[ \${NGINX_FAIL:-0} == 0 ]]
`;
  const systemctl = `#!/usr/bin/env bash\nprintf "%s\\n" "\$*" >> "${posixPath(root)}/systemctl.log"\n`;
  for (const [name, body] of [['openssl', openssl], ['nginx', nginx], ['systemctl', systemctl]]) {
    const file = join(fakeBin, name);
    await writeFile(file, body, 'utf8');
    await chmod(file, 0o755);
  }
  for (const name of ['ca.key','ca.crt','research.crt','collector.crt','restricted.crt','research.csr','collector.csr','restricted.csr','research.ext','collector.ext','restricted.ext'])
    await writeFile(join(tlsDir, name), `prior:${name}`, 'utf8');
  const normalized = join(root, 'renew.sh');
  await writeFile(normalized, scriptBytes.replace(/\r\n/g, '\n'), 'utf8');
  const fakeBinPosix = posixPath(fakeBin);
  const tlsDirPosix = posixPath(tlsDir);
  const normalizedPosix = posixPath(normalized);
  const driver=join(root,'run.sh');
  await writeFile(driver,`set -x\nexport TLS_DIR=${shellQuote(tlsDirPosix)}\nexport PATH=${shellQuote(`${fakeBinPosix}:/usr/bin:/bin`)}\nexport NGINX_FAIL=${failNginx?'1':'0'}\nsource ${shellQuote(normalizedPosix)}\n`,'utf8');
  const driverPosix=posixPath(driver);
  const priorRestricted = await readFile(join(tlsDir, 'restricted.crt'), 'utf8');
  const priorCa = await readFile(join(tlsDir, 'ca.crt'), 'utf8');
  const result = spawnSync(bashExe, [driverPosix], {encoding: 'utf8'});
  return {root, tlsDir, priorRestricted, priorCa, result};
}

test('renewal installs the new restricted receiver certificate and reloads nginx', async () => {
  const run = await runRenew();
  try {
    assert.equal(run.result.status, 0, `${run.result.error ?? ''} ${run.result.stderr ?? ''} ${run.result.stdout ?? ''}`);
    const restricted = await readFile(join(run.tlsDir, 'restricted.crt'), 'utf8');
    assert.notEqual(restricted, run.priorRestricted);
    assert.match(restricted, /generated:restricted\.crt/);
    assert.equal(await readFile(join(run.tlsDir, 'ca.crt'), 'utf8'),run.priorCa,'renewal must preserve the exact CA bundled into client images');
    assert.equal((run.result.stdout.match(/certificate-details/g)??[]).length,3);
    assert.match(await readFile(join(run.root, 'systemctl.log'), 'utf8'), /reload nginx/);
  } finally { await rm(run.root, {recursive: true, force: true}); }
});

test('nginx validation failure restores the prior restricted receiver certificate', async () => {
  const run = await runRenew({failNginx: true});
  try {
    assert.notEqual(run.result.status, 0, `${run.result.error ?? ''} ${run.result.stderr ?? ''}`);
    assert.equal(await readFile(join(run.tlsDir, 'restricted.crt'), 'utf8'), run.priorRestricted);
    assert.equal(await readFile(join(run.tlsDir, 'ca.crt'), 'utf8'),run.priorCa);
    assert.doesNotMatch(run.result.stdout ?? '', /SHA256 Fingerprint/);
  } finally { await rm(run.root, {recursive: true, force: true}); }
});
