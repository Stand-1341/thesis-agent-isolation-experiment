#!/usr/bin/env node
/**
 * Secure controller-side dependency preflight for the full 400-row VM/Functions candidate.
 * This launcher is fixed to `--dry-run`; it never starts or claims trials and never
 * supplies readiness flags. It retrieves only confirmed secret names from Key Vault.
 */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const VAULT='thesisexpkv20261103';
const KEYVAULT_IDENTITY_CLIENT_ID='011128da-854a-43e6-ba75-461be5958b1b';
const STORAGE_IDENTITY_CLIENT_ID='011128da-854a-43e6-ba75-461be5958b1b';
const LOGS_IDENTITY_CLIENT_ID='85b40cb2-af3c-4fe5-b2e0-464abafeb9ea';
const EVIDENCE_WRITER_IDENTITY_CLIENT_ID='89c2d92e-9290-4178-a410-87018a136866';
const EVIDENCE_POLICY_READER_IDENTITY_CLIENT_ID='f6ddc11b-c227-4d97-935c-341997c5d6a8';
const WORKSPACE_ID='e5bd1dbf-98ea-4a32-985a-caa6e0f5965e';
const FIXTURE_BLOB_ENDPOINT='https://thesisfixture20261103.blob.core.windows.net';
const FIXTURE_BLOB_RESOURCE_ID='/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/RG-THESIS-RESEARCH-PILOT-EUS/providers/Microsoft.Storage/storageAccounts/thesisfixture20261103/blobServices/default';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SECRET_MAP=Object.freeze([
  ['vm-p1-controller-key','THESIS_VM_P1_CONTROLLER_KEY'],
  ['vm-p2-controller-key','THESIS_VM_P2_CONTROLLER_KEY'],
  ['vm-p3-centralus-trial-request-key','THESIS_VM_P3_CONTROLLER_KEY'],
  ['functions-p1-controller-key','THESIS_FN_P1_CONTROLLER_KEY'],
  ['functions-p1-function-key','THESIS_FN_P1_FUNCTION_KEY'],
  ['functions-p2-controller-key','THESIS_FN_P2_CONTROLLER_KEY'],
  ['functions-p2-function-key','THESIS_FN_P2_FUNCTION_KEY'],
  ['functions-p3-controller-key','THESIS_FN_P3_CONTROLLER_KEY'],
  ['functions-p3-function-key','THESIS_FN_P3_FUNCTION_KEY'],
  ['resource-admin-key','THESIS_RESOURCE_ADMIN_KEY'],
  ['collector-admin-key','THESIS_COLLECTOR_ADMIN_KEY'],
  ['vm-resource-verifier-key','THESIS_AZURE_VM_RESOURCE_VERIFIER_KEY'],
  ['vm-collector-verifier-key','THESIS_AZURE_VM_COLLECTOR_VERIFIER_KEY'],
  ['functions-p1-resource-verifier-key','THESIS_AZURE_FUNCTIONS_FLEX_RESOURCE_VERIFIER_KEY'],
  ['functions-p1-collector-verifier-key','THESIS_AZURE_FUNCTIONS_FLEX_COLLECTOR_VERIFIER_KEY']
]);

function fail(message) { throw new Error(message); }

async function getJson(fetchImpl,url,options,label) {
  let response;
  try { response=await fetchImpl(url,options); }
  catch { fail(`${label} request failed`); }
  if(!response.ok) fail(`${label} request failed (HTTP ${response.status})`);
  try { return await response.json(); }
  catch { fail(`${label} returned invalid JSON`); }
}

export async function loadVmFunctionsPreflightEnvironment({env=process.env,fetchImpl=globalThis.fetch}={}) {
  if(typeof fetchImpl!=='function') fail('fetch implementation is required');
  const vaultName=env.THESIS_KEYVAULT_NAME||VAULT;
  if(!/^[A-Za-z0-9-]{3,24}$/.test(vaultName)) fail('invalid Key Vault name');
  const imds=new URL('http://169.254.169.254/metadata/identity/oauth2/token');
  imds.searchParams.set('api-version','2018-02-01');
  imds.searchParams.set('resource','https://vault.azure.net');
  imds.searchParams.set('client_id',env.THESIS_KEYVAULT_IDENTITY_CLIENT_ID||KEYVAULT_IDENTITY_CLIENT_ID);
  const identity=await getJson(fetchImpl,imds,{headers:{Metadata:'true'},redirect:'error',signal:AbortSignal.timeout(15000)},'managed identity token');
  const accessToken=identity?.access_token;
  if(typeof accessToken!=='string'||!accessToken) fail('managed identity returned no access token');
  const values={};
  for(const [secretName,environmentName] of SECRET_MAP) {
    const url=`https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(secretName)}?api-version=7.4`;
    const body=await getJson(fetchImpl,url,{headers:{authorization:`Bearer ${accessToken}`},redirect:'error',signal:AbortSignal.timeout(15000)},`Key Vault secret ${secretName}`);
    if(typeof body?.value!=='string'||body.value.length<32||body.value.length>512||/[\r\n]/.test(body.value))
      fail(`Key Vault secret is empty or invalid: ${secretName}`);
    values[environmentName]=body.value;
  }
  const ca=env.THESIS_NODE_EXTRA_CA_CERTS||'/opt/thesis-aci-runner-20261104/certs/thesis-pilot-ca.pem';
  return {...env,...values,
    THESIS_TOKEN_PROVIDER_MODE:'managed_identity',
    THESIS_STORAGE_IDENTITY_CLIENT_ID:STORAGE_IDENTITY_CLIENT_ID,
    THESIS_LOGS_IDENTITY_CLIENT_ID:LOGS_IDENTITY_CLIENT_ID,
    THESIS_LOG_ANALYTICS_WORKSPACE_ID:WORKSPACE_ID,
    THESIS_FIXTURE_BLOB_ENDPOINT:FIXTURE_BLOB_ENDPOINT,
    THESIS_BLOB_RESOURCE_ID:FIXTURE_BLOB_RESOURCE_ID,
    THESIS_EVIDENCE_IDENTITY_CLIENT_ID:EVIDENCE_WRITER_IDENTITY_CLIENT_ID,
    THESIS_EVIDENCE_POLICY_READER_IDENTITY_CLIENT_ID:EVIDENCE_POLICY_READER_IDENTITY_CLIENT_ID,
    THESIS_EVIDENCE_BLOB_CONTAINER_URL:'https://thesispilotblob20261102.blob.core.windows.net/trial-evidence',
    THESIS_EVIDENCE_CONTAINER_RESOURCE_ID:'/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/RG-THESIS-RESEARCH-PILOT-EUS/providers/Microsoft.Storage/storageAccounts/thesispilotblob20261102/blobServices/default/containers/trial-evidence',
    THESIS_EVIDENCE_RETENTION_DAYS:'146000',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVED:'true',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE:'rev4_owner_directed_measured_study',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE:'file:docs/400-REV4-OWNER-DIRECTED-RETENTION.md',
    THESIS_VM_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',
    THESIS_VM_P3_FIREWALL_SOURCE_IP:'10.49.8.4',
    THESIS_DENIAL_DESTINATION_IP:'10.48.9.5',
    THESIS_VM_P3_FIREWALL_DESTINATION_PORT:'8443',
    THESIS_VM_P3_FIREWALL_DENY_RULE:'deny-centralus-p3-collector',
    THESIS_FLEX_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',
    THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR:'10.48.6.0/24',
    THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT:'8443',
    THESIS_FLEX_P3_FIREWALL_DENY_RULE:'functions-p3-deny-collector',
    NODE_EXTRA_CA_CERTS:ca,
    THESIS_AUDIT_WAIT_MS:env.THESIS_AUDIT_WAIT_MS||'3600000',
    THESIS_AUDIT_POLL_MS:env.THESIS_AUDIT_POLL_MS||'10000'};
}

export function buildVmFunctionsPreflightArgs() {
  return [resolve(ROOT,'scripts/run-experiment-cli.mjs'),
    '--config',resolve(ROOT,'config/experiment.azure-live.json'),
    '--protocol',resolve(ROOT,'config/protocol-400-rev4-vm-functions-draft.json'),
    '--deps',resolve(ROOT,'scripts/deps-live.mjs'),
    '--dry-run','--json'];
}

export async function runVmFunctionsPreflight({env=process.env,fetchImpl=globalThis.fetch,spawnImpl=spawn}={}) {
  if(typeof spawnImpl!=='function') fail('spawn implementation is required');
  const childEnv=await loadVmFunctionsPreflightEnvironment({env,fetchImpl});
  const child=spawnImpl(process.execPath,buildVmFunctionsPreflightArgs(),{cwd:ROOT,env:childEnv,stdio:'inherit'});
  return await new Promise((resolvePromise,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(signal) return reject(new Error(`preflight stopped by signal ${signal}`));
      resolvePromise(Number.isInteger(code)?code:1);
    });
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(!existsSync(resolve(ROOT,'config/protocol-400-rev4-vm-functions-draft.json'))) fail('VM/Functions rev4 candidate is missing');
    process.exitCode=await runVmFunctionsPreflight();
  } catch(error) {
    console.error(error?.message||'VM/Functions live dependency preflight failed');
    process.exitCode=2;
  }
}
