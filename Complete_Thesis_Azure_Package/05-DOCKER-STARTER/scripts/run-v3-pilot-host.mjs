#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const VAULT='th30f2e4o74kdox47hsyykv';
const SECRET_READER_CLIENT_ID='474213e1-e16f-413d-8b13-a8b4e048de16';
const SANDBOX_CLIENT_ID='fac1f521-f5e3-439e-b7f4-b86382a5d141';
const SUBSCRIPTION='a0129b37-1075-48a4-82f9-bbc6d96d8eb3';
const WORKSPACE='2c79393b-8325-4688-9e30-3cc23e3acbcd';
const FIXTURE_ENDPOINT='https://th30f2e487fx.blob.core.windows.net/';
const FIXTURE_RESOURCE_ID='/subscriptions/a0129b37-1075-48a4-82f9-bbc6d96d8eb3/resourceGroups/rg-thesis-study-central-a0129b37/providers/Microsoft.Storage/storageAccounts/th30f2e487fx/blobServices/default';
const SECRETS=[
  ['resource-admin-key','THESIS_RESOURCE_ADMIN_KEY'],
  ['collector-admin-key','THESIS_COLLECTOR_ADMIN_KEY'],
  ['vm-p1-controller-key','THESIS_VM_P1_CONTROLLER_KEY'],
  ['vm-p2-controller-key','THESIS_VM_P2_CONTROLLER_KEY'],
  ['vm-p3-controller-key','THESIS_VM_P3_CONTROLLER_KEY'],
  ['functions-p1-controller-key','THESIS_FN_P1_CONTROLLER_KEY'],
  ['functions-p2-controller-key','THESIS_FN_P2_CONTROLLER_KEY'],
  ['functions-p3-controller-key','THESIS_FN_P3_CONTROLLER_KEY'],
  ['functions-p1-function-key','THESIS_FN_P1_FUNCTION_KEY'],
  ['functions-p2-function-key','THESIS_FN_P2_FUNCTION_KEY'],
  ['functions-p3-function-key','THESIS_FN_P3_FUNCTION_KEY'],
  ['functions-p1-resource-verifier-key','THESIS_AZURE_FUNCTIONS_FLEX_RESOURCE_VERIFIER_KEY'],
  ['functions-p1-collector-verifier-key','THESIS_AZURE_FUNCTIONS_FLEX_COLLECTOR_VERIFIER_KEY']
];
const IMDS='http://169.254.169.254/metadata/identity/oauth2/token';

async function vaultToken() {
  const url=new URL(IMDS);
  url.searchParams.set('api-version','2018-02-01');
  url.searchParams.set('resource','https://vault.azure.net');
  url.searchParams.set('client_id',SECRET_READER_CLIENT_ID);
  const response=await fetch(url,{headers:{Metadata:'true'},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`IMDS token failed: HTTP ${response.status}`);
  const body=await response.json();
  if(!body.access_token) throw new Error('IMDS returned no token');
  return body.access_token;
}
async function secret(token,name) {
  const response=await fetch(`https://${VAULT}.vault.azure.net/secrets/${encodeURIComponent(name)}?api-version=7.4`,
    {headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`Key Vault secret ${name} failed: HTTP ${response.status}`);
  const body=await response.json();
  if(typeof body.value!=='string'||!body.value) throw new Error(`Key Vault secret ${name} is empty`);
  return body.value;
}

const token=await vaultToken();
const env={...process.env,
  AZURE_CLIENT_ID:SECRET_READER_CLIENT_ID,
  AZURE_SUBSCRIPTION_ID:SUBSCRIPTION,
  THESIS_TOKEN_PROVIDER_MODE:'managed_identity',
  THESIS_STORAGE_IDENTITY_CLIENT_ID:SECRET_READER_CLIENT_ID,
  THESIS_LOGS_IDENTITY_CLIENT_ID:SECRET_READER_CLIENT_ID,
  THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID:SANDBOX_CLIENT_ID,
  THESIS_LOG_ANALYTICS_WORKSPACE_ID:WORKSPACE,
  THESIS_FIXTURE_BLOB_ENDPOINT:FIXTURE_ENDPOINT,
  THESIS_BLOB_RESOURCE_ID:FIXTURE_RESOURCE_ID,
  THESIS_AUDIT_WAIT_MS:'300000',
  THESIS_AUDIT_POLL_MS:'5000',
  THESIS_DENIAL_DESTINATION_IP:'10.48.9.5',
  THESIS_VM_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',
  THESIS_VM_P3_FIREWALL_SOURCE_IP:'10.48.8.4',
  THESIS_VM_P3_FIREWALL_DESTINATION_PORT:'8443',
  THESIS_VM_P3_FIREWALL_DENY_RULE:'p3-deny-collector',
  THESIS_VM_TARGET_RESOURCE_ID:'/subscriptions/a0129b37-1075-48a4-82f9-bbc6d96d8eb3/resourceGroups/rg-thesis-study-central-a0129b37/providers/Microsoft.Compute/virtualMachines/th30f2e487-vm-p3',
  THESIS_FLEX_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',
  THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR:'10.48.6.0/24',
  THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT:'8443',
  THESIS_FLEX_P3_FIREWALL_DENY_RULE:'functions-p3-deny-collector'};
for(const [name,key] of SECRETS) env[key]=await secret(token,name);
for(const deployment of ['VM','AZURE_FUNCTIONS_FLEX','AZURE_CONTAINER_APPS_SANDBOXES']) {
  env[`THESIS_${deployment}_RESOURCE_VERIFIER_KEY`]=env.THESIS_AZURE_FUNCTIONS_FLEX_RESOURCE_VERIFIER_KEY;
  env[`THESIS_${deployment}_COLLECTOR_VERIFIER_KEY`]=env.THESIS_AZURE_FUNCTIONS_FLEX_COLLECTOR_VERIFIER_KEY;
}
const args=['scripts/run-experiment-cli.mjs',
  '--config','config/experiment.azure-live-v3.json',
  '--protocol','config/protocol-450-flex-sandbox-supported-v3-pilot-v1.json',
  '--pilot','--pilot-evidence','results/non-counted-pilot-v3-20261114',
  '--deps','scripts/deps-live.mjs','--concurrency','3','--progress-events'];
const child=execFileSync(process.execPath,args,{cwd:ROOT,env,stdio:'inherit'});
process.exitCode=0;
