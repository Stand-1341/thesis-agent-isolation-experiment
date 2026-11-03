import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const DEFAULT_VAULT='thesisexpkv20261103';
const SECRET_SOURCES=Object.freeze([
  ['functions-p1-controller-key','Function App setting TRIAL_REQUEST_KEY'],
  ['functions-p1-function-key','HTTP function key for thesisRun'],
  ['resource-admin-key','Research host ADMIN_TOKEN in /etc/thesis-research/resource.env'],
  ['collector-admin-key','Collector host ADMIN_TOKEN in /etc/thesis-research/collector.env'],
  ['functions-p1-resource-verifier-key','Research host VERIFIER_TOKEN in /etc/thesis-research/resource.env'],
  ['functions-p1-collector-verifier-key','Collector host VERIFIER_TOKEN in /etc/thesis-research/collector.env']
]);

function safeError(message) { return new Error(message); }

export function readHidden(prompt,{input=process.stdin,output=process.stdout}={}) {
  if(!input.isTTY || typeof input.setRawMode!=='function')
    return Promise.reject(safeError('Run this helper in an interactive terminal.'));
  return new Promise((resolve,reject)=>{
    let value='';
    const previousRaw=input.isRaw;
    const finish=(error)=>{
      input.off('data',onData);
      try { input.setRawMode(Boolean(previousRaw)); } catch {}
      output.write('\n');
      if(error) reject(error); else resolve(value);
      value='';
    };
    const onData=chunk=>{
      for(const character of chunk.toString('utf8')) {
        if(character==='\r' || character==='\n') return finish();
        if(character==='\u0003' || character==='\u0004') return finish(safeError('Input cancelled.'));
        if(character==='\u007f' || character==='\b') value=value.slice(0,-1);
        else if(character>=' ' && character!=='\u001b') value+=character;
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data',onData);
  });
}

export function getAzureKeyVaultToken() {
  const cliArgs=['account','get-access-token','--resource','https://vault.azure.net','--query','accessToken','-o','tsv'];
  try {
    const output=process.platform==='win32'
      ?execFileSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`az ${cliArgs.join(' ')}`],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']})
      :execFileSync('az',cliArgs,{encoding:'utf8',stdio:['ignore','pipe','ignore']});
    const token=output.trim();
    if(!token) throw new Error('empty token');
    return token;
  } catch {
    throw safeError('Azure CLI could not obtain a Key Vault token. Sign in with az login and retry.');
  }
}

function validCredential(value) {
  return typeof value==='string' && value.length>=32 && value.length<=512 && !/[\r\n]/.test(value);
}

export async function provisionPilotSecrets({vaultName=process.env.THESIS_KEYVAULT_NAME||DEFAULT_VAULT,
  token=getAzureKeyVaultToken(),fetchImpl=globalThis.fetch,readSecret=readHidden}={}) {
  if(!/^[a-zA-Z0-9-]{3,24}$/.test(vaultName)) throw safeError('invalid Key Vault name');
  if(typeof token!=='string' || !token) throw safeError('Key Vault token is required');
  if(typeof fetchImpl!=='function') throw safeError('fetch implementation is required');
  const saved=[],alreadyValid=[];
  for(const [name,source] of SECRET_SOURCES) {
    const url=`https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(name)}?api-version=7.4`;
    let current;
    try {
      current=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{authorization:`Bearer ${token}`}});
    } catch { throw safeError(`could not check ${name}; no secret value was displayed`); }
    if(current.ok) {
      let body;
      try { body=await current.json(); } catch { throw safeError(`could not validate ${name}; no secret value was displayed`); }
      if(validCredential(body?.value)) { alreadyValid.push(name); continue; }
    } else if(current.status!==404) {
      throw safeError(`could not check ${name} (HTTP ${current.status}); no secret value was displayed`);
    }

    const value=await readSecret(`Enter ${name} (${source}; 32 to 512 characters): `);
    if(!validCredential(value))
      throw safeError(`invalid credential length or format for ${name}; enter the full value (32 to 512 characters); no trial was started`);
    let response;
    try {
      response=await fetchImpl(url,{method:'PUT',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        body:JSON.stringify({value})});
    } catch { throw safeError(`could not save ${name}; earlier values, if any, may already be stored`); }
    if(!response.ok) throw safeError(`could not save ${name} (HTTP ${response.status}); earlier values, if any, may already be stored`);
    saved.push(name);
  }
  return {saved,alreadyValid};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const {saved,alreadyValid}=await provisionPilotSecrets();
    for(const name of alreadyValid) process.stdout.write(`Already valid: ${name}\n`);
    for(const name of saved) process.stdout.write(`Saved secret: ${name}\n`);
    process.stdout.write('All six pilot secrets are valid; no values were displayed.\n');
  } catch(error) {
    process.stderr.write(`${error?.message||'secret provisioning failed'}\n`);
    process.exitCode=1;
  }
}
