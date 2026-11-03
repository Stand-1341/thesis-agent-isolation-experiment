import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const DEFAULT_VAULT='thesisexpkv20261103';
const KEYVAULT_IDENTITY_CLIENT_ID='011128da-854a-43e6-ba75-461be5958b1b';
const WORKSPACE_ID='e5bd1dbf-98ea-4a32-985a-caa6e0f5965e';
const FIXTURE_BLOB_ENDPOINT='https://thesisfixture20261103.blob.core.windows.net';
const FIXTURE_BLOB_RESOURCE_ID='/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/RG-THESIS-RESEARCH-PILOT-EUS/providers/Microsoft.Storage/storageAccounts/thesisfixture20261103/blobServices/default';
const STORAGE_IDENTITY_CLIENT_ID='011128da-854a-43e6-ba75-461be5958b1b';
const LOGS_IDENTITY_CLIENT_ID='85b40cb2-af3c-4fe5-b2e0-464abafeb9ea';

export const PILOT_SECRET_MAP=Object.freeze([
  ['functions-p1-controller-key','THESIS_FN_P1_CONTROLLER_KEY'],
  ['functions-p1-function-key','THESIS_FN_P1_FUNCTION_KEY'],
  ['resource-admin-key','THESIS_RESOURCE_ADMIN_KEY'],
  ['collector-admin-key','THESIS_COLLECTOR_ADMIN_KEY'],
  ['functions-p1-resource-verifier-key','THESIS_AZURE_FUNCTIONS_FLEX_RESOURCE_VERIFIER_KEY'],
  ['functions-p1-collector-verifier-key','THESIS_AZURE_FUNCTIONS_FLEX_COLLECTOR_VERIFIER_KEY']
]);

function safeError(message) { return new Error(message); }

export async function loadPilotEnvironment({env=process.env,fetchImpl=globalThis.fetch}={}) {
  if(typeof fetchImpl!=='function') throw safeError('fetch implementation is required');
  const vaultName=env.THESIS_KEYVAULT_NAME||DEFAULT_VAULT;
  if(!/^[a-zA-Z0-9-]{3,24}$/.test(vaultName)) throw safeError('invalid Key Vault name');
  const identityClientId=env.THESIS_KEYVAULT_IDENTITY_CLIENT_ID||KEYVAULT_IDENTITY_CLIENT_ID;
  const imds=new URL('http://169.254.169.254/metadata/identity/oauth2/token');
  imds.searchParams.set('api-version','2018-02-01');
  imds.searchParams.set('resource','https://vault.azure.net');
  imds.searchParams.set('client_id',identityClientId);
  let tokenResponse;
  try {
    tokenResponse=await fetchImpl(imds,{headers:{Metadata:'true'},redirect:'error',signal:AbortSignal.timeout(15000)});
  } catch { throw safeError('managed identity token request failed'); }
  if(!tokenResponse.ok) throw safeError(`managed identity token request failed (HTTP ${tokenResponse.status})`);
  let tokenBody;
  try { tokenBody=await tokenResponse.json(); } catch { throw safeError('managed identity returned invalid token data'); }
  if(typeof tokenBody?.access_token!=='string' || !tokenBody.access_token) throw safeError('managed identity returned no access token');

  const values={};
  for(const [secretName,environmentName] of PILOT_SECRET_MAP) {
    const url=`https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(secretName)}?api-version=7.4`;
    let response;
    try {
      response=await fetchImpl(url,{headers:{authorization:`Bearer ${tokenBody.access_token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
    } catch { throw safeError(`Key Vault request failed for ${secretName}`); }
    if(!response.ok) throw safeError(`required Key Vault secret unavailable: ${secretName} (HTTP ${response.status})`);
    let body;
    try { body=await response.json(); } catch { throw safeError(`invalid Key Vault response for ${secretName}`); }
    if(typeof body?.value!=='string' || !body.value || /[\r\n]/.test(body.value))
      throw safeError(`required Key Vault secret is empty or invalid: ${secretName}`);
    values[environmentName]=body.value;
  }

  return {
    ...env,
    ...values,
    THESIS_TOKEN_PROVIDER_MODE:'managed_identity',
    THESIS_STORAGE_IDENTITY_CLIENT_ID:STORAGE_IDENTITY_CLIENT_ID,
    THESIS_LOGS_IDENTITY_CLIENT_ID:LOGS_IDENTITY_CLIENT_ID,
    THESIS_LOG_ANALYTICS_WORKSPACE_ID:WORKSPACE_ID,
    THESIS_FIXTURE_BLOB_ENDPOINT:FIXTURE_BLOB_ENDPOINT,
    THESIS_BLOB_RESOURCE_ID:FIXTURE_BLOB_RESOURCE_ID,
    THESIS_AUDIT_WAIT_MS:env.THESIS_AUDIT_WAIT_MS||'300000',
    THESIS_AUDIT_POLL_MS:env.THESIS_AUDIT_POLL_MS||'5000'
  };
}

export function buildPilotArgs(extraArgs=[]) {
  const args=[...extraArgs];
  if(args.some(arg=>['--gates','--config','--deployment','--profile','--pilot','--deps'].includes(arg)))
    throw safeError('pilot scope and config are fixed by this launcher');
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--limit') {
      const count=Number(args[i+1]);
      if(!Number.isInteger(count)||count<1||count>10) throw safeError('--limit must be between 1 and 10');
      i++;
    } else throw safeError(`unsupported pilot launcher option: ${args[i]}`);
  }
  return ['scripts/run-experiment-cli.mjs','--config','config/experiment.pilot.functions-p1.example.json',
    '--pilot','--deployment','azure_functions_flex','--profile','P1','--concurrency','1',
    '--deps','scripts/deps-live.mjs',...args];
}

export async function runPilot({env=process.env,argv=process.argv.slice(2),fetchImpl=globalThis.fetch,spawnImpl=spawn}={}) {
  const args=buildPilotArgs(argv);
  const childEnv=await loadPilotEnvironment({env,fetchImpl});
  const child=spawnImpl(process.execPath,args,{env:childEnv,stdio:'inherit'});
  return await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(signal) return reject(safeError(`pilot runner stopped by signal ${signal}`));
      resolve(Number.isInteger(code)?code:1);
    });
  });
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  runPilot().then(code=>{process.exitCode=code;}).catch(error=>{
    console.error(error?.message||'Key Vault pilot setup failed');
    process.exitCode=2;
  });
}
