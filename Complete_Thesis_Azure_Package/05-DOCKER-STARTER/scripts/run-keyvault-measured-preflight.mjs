#!/usr/bin/env node
/**
 * Non-executing config and live-dependency preflight for a selected VM P1/P2/P3 route.
 *
 * Run on the controller VM with its Key Vault reader identity. Credentials are
 * fetched into memory and passed only to a child process environment. This
 * launcher always adds --pilot --dry-run and never starts a counted or pilot row.
 */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const DEFAULT_VAULT='thesisexpkv20261103';
const DEFAULT_IDENTITY_CLIENT_ID='011128da-854a-43e6-ba75-461be5958b1b';
const STORAGE_IDENTITY_CLIENT_ID='011128da-854a-43e6-ba75-461be5958b1b';
const LOGS_IDENTITY_CLIENT_ID='85b40cb2-af3c-4fe5-b2e0-464abafeb9ea';
const EVIDENCE_WRITER_IDENTITY_CLIENT_ID='89c2d92e-9290-4178-a410-87018a136866';
const EVIDENCE_POLICY_READER_IDENTITY_CLIENT_ID='f6ddc11b-c227-4d97-935c-341997c5d6a8';
const WORKSPACE_ID='e5bd1dbf-98ea-4a32-985a-caa6e0f5965e';
const FIXTURE_BLOB_ENDPOINT='https://thesisfixture20261103.blob.core.windows.net';
const FIXTURE_BLOB_RESOURCE_ID='/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/RG-THESIS-RESEARCH-PILOT-EUS/providers/Microsoft.Storage/storageAccounts/thesisfixture20261103/blobServices/default';
const EVIDENCE_BLOB_CONTAINER_URL='https://thesispilotblob20261102.blob.core.windows.net/trial-evidence';
const EVIDENCE_CONTAINER_RESOURCE_ID='/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/RG-THESIS-RESEARCH-PILOT-EUS/providers/Microsoft.Storage/storageAccounts/thesispilotblob20261102/blobServices/default/containers/trial-evidence';
const CENTRAL_P3_CA='/opt/thesis-aci-runner-20261104/certs/thesis-pilot-ca.pem';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MAP=Object.freeze({
  P1:[['vm-p1-controller-key','THESIS_VM_P1_CONTROLLER_KEY']],
  P2:[['vm-p2-controller-key','THESIS_VM_P2_CONTROLLER_KEY']],
  // Central P3's route controller key is the target's unique trial-request key.
  P3:[['vm-p3-centralus-trial-request-key','THESIS_VM_P3_CONTROLLER_KEY']]
});
const COMMON=[
  ['resource-admin-key','THESIS_RESOURCE_ADMIN_KEY'],
  ['collector-admin-key','THESIS_COLLECTOR_ADMIN_KEY'],
  ['vm-resource-verifier-key','THESIS_AZURE_VM_RESOURCE_VERIFIER_KEY'],
  ['vm-collector-verifier-key','THESIS_AZURE_VM_COLLECTOR_VERIFIER_KEY']
];

function fail(message) { throw new Error(message); }

function parseProfile(argv) {
  let profile;
  for(let i=0;i<argv.length;i++) {
    if(argv[i]==='--profile' && ['P1','P2','P3'].includes(argv[i+1]) && !profile) {
      profile=argv[++i];
    } else {
      fail('usage: run-keyvault-measured-preflight.mjs --profile P1|P2|P3');
    }
  }
  if(!profile) fail('a selected profile is required: P1, P2, or P3');
  return profile;
}

async function managedIdentityToken({clientId,fetchImpl}) {
  const imds=new URL('http://169.254.169.254/metadata/identity/oauth2/token');
  imds.searchParams.set('api-version','2018-02-01');
  imds.searchParams.set('resource','https://vault.azure.net');
  imds.searchParams.set('client_id',clientId);
  let response;
  try { response=await fetchImpl(imds,{headers:{Metadata:'true'},redirect:'error',signal:AbortSignal.timeout(15000)}); }
  catch { fail('managed identity token request failed'); }
  if(!response.ok) fail(`managed identity token request failed (HTTP ${response.status})`);
  let body;
  try { body=await response.json(); } catch { fail('managed identity returned invalid token data'); }
  if(typeof body?.access_token!=='string' || !body.access_token) fail('managed identity returned no access token');
  return body.access_token;
}

export async function loadSelectedVmCredentials({profile,env=process.env,fetchImpl=globalThis.fetch}={}) {
  if(!MAP[profile]) fail('only VM P1, P2, or Central P3 credentials can be loaded');
  if(typeof fetchImpl!=='function') fail('fetch implementation is required');
  const vaultName=env.THESIS_KEYVAULT_NAME||DEFAULT_VAULT;
  if(!/^[a-zA-Z0-9-]{3,24}$/.test(vaultName)) fail('invalid Key Vault name');
  const identityClientId=env.THESIS_KEYVAULT_IDENTITY_CLIENT_ID||DEFAULT_IDENTITY_CLIENT_ID;
  const accessToken=await managedIdentityToken({clientId:identityClientId,fetchImpl});
  const values={};
  for(const [secretName,environmentName] of [...MAP[profile],...COMMON]) {
    const url=`https://${vaultName}.vault.azure.net/secrets/${encodeURIComponent(secretName)}?api-version=7.4`;
    let response;
    try { response=await fetchImpl(url,{headers:{authorization:`Bearer ${accessToken}`},redirect:'error',signal:AbortSignal.timeout(15000)}); }
    catch { fail(`Key Vault request failed for ${secretName}`); }
    if(!response.ok) fail(`required Key Vault secret unavailable: ${secretName} (HTTP ${response.status})`);
    let body;
    try { body=await response.json(); } catch { fail(`invalid Key Vault response for ${secretName}`); }
    if(typeof body?.value!=='string' || body.value.length<32 || body.value.length>512 || /[\r\n]/.test(body.value))
      fail(`required Key Vault secret is empty or invalid: ${secretName}`);
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
    THESIS_EVIDENCE_IDENTITY_CLIENT_ID:EVIDENCE_WRITER_IDENTITY_CLIENT_ID,
    THESIS_EVIDENCE_POLICY_READER_IDENTITY_CLIENT_ID:EVIDENCE_POLICY_READER_IDENTITY_CLIENT_ID,
    THESIS_EVIDENCE_BLOB_CONTAINER_URL:EVIDENCE_BLOB_CONTAINER_URL,
    THESIS_EVIDENCE_CONTAINER_RESOURCE_ID:EVIDENCE_CONTAINER_RESOURCE_ID,
    THESIS_EVIDENCE_RETENTION_DAYS:'146000',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVED:'true',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE:'rev4_owner_directed_measured_study',
    THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE:'file:docs/400-REV4-OWNER-DIRECTED-RETENTION.md',
    THESIS_AUDIT_WAIT_MS:env.THESIS_AUDIT_WAIT_MS||'3600000',
    THESIS_AUDIT_POLL_MS:env.THESIS_AUDIT_POLL_MS||'10000',
    ...(profile==='P3'?{
      THESIS_VM_P3_DENIAL_TELEMETRY:'azure_diagnostics_firewall',
      THESIS_VM_P3_FIREWALL_SOURCE_IP:'10.49.8.4',
      THESIS_DENIAL_DESTINATION_IP:'10.48.9.5',
      THESIS_VM_P3_FIREWALL_DESTINATION_PORT:'8443',
      THESIS_VM_P3_FIREWALL_DENY_RULE:'deny-centralus-p3-collector',
      NODE_EXTRA_CA_CERTS:env.THESIS_NODE_EXTRA_CA_CERTS||CENTRAL_P3_CA
    }:{}),
    ...(env.THESIS_NODE_EXTRA_CA_CERTS?{NODE_EXTRA_CA_CERTS:env.THESIS_NODE_EXTRA_CA_CERTS}:{})
  };
}

export function buildPreflightArgs(profile) {
  if(!MAP[profile]) fail('only VM P1, P2, or Central P3 profiles are supported');
  const args=[resolve(ROOT,'scripts/run-experiment-cli.mjs'),
    '--config',resolve(ROOT,'config/experiment.azure-live.json'),
    '--deps',resolve(ROOT,'scripts/deps-live.mjs'),
    '--pilot','--dry-run','--json','--deployment','azure_vm','--profile',profile];
  // Candidate B declares a distinct one-row P3 U5 pilot. Keep the older
  // P1/P2 route preflight schedule on the default rev3 protocol.
  if(profile==='P3') args.push('--protocol',resolve(ROOT,'config/protocol-400-rev4-vm-functions-draft.json'));
  return args;
}

export async function runPreflight({argv=process.argv.slice(2),env=process.env,spawnImpl=spawn,fetchImpl=globalThis.fetch}={}) {
  const profile=parseProfile(argv);
  const childEnv=await loadSelectedVmCredentials({profile,env,fetchImpl});
  const child=spawnImpl(process.execPath,buildPreflightArgs(profile),{cwd:ROOT,env:childEnv,stdio:'inherit'});
  return await new Promise((resolvePromise,reject)=>{
    child.once('error',reject);
    child.once('exit',(code,signal)=>{
      if(signal) return reject(new Error(`preflight stopped by signal ${signal}`));
      resolvePromise(Number.isInteger(code)?code:1);
    });
  });
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(!existsSync(resolve(ROOT,'config/experiment.azure-live.json'))) fail('live route config is missing');
    process.exitCode=await runPreflight();
  } catch(error) {
    console.error(error?.message||'Key Vault measured preflight failed');
    process.exitCode=2;
  }
}
