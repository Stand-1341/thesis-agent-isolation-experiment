#!/usr/bin/env node
/** Read-only managed-identity token smoke for the ACI 50-condition pilot. */
import {ManagedIdentityCredential} from '@azure/identity';

const env=process.env;
const required=[
  ['controller-management',env.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID,'https://management.azure.com/.default'],
  ['controller-key-vault',env.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID,'https://vault.azure.net/.default'],
  ['fixture-verifier-storage',env.THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID,'https://storage.azure.com/.default'],
  ['independent-evidence-reader-storage',env.THESIS_EVIDENCE_READER_IDENTITY_CLIENT_ID,'https://storage.azure.com/.default'],
  ['audit-reader-log-analytics',env.THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID,'https://api.loganalytics.io/.default'],
  ['evidence-writer-storage',env.THESIS_EVIDENCE_IDENTITY_CLIENT_ID,'https://storage.azure.com/.default'],
  ['evidence-writer-management',env.THESIS_EVIDENCE_IDENTITY_CLIENT_ID,'https://management.azure.com/.default'],
  ['gpt5-mini-cognitive-services',env.AZURE_OPENAI_CLIENT_ID||env.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID,
    'https://cognitiveservices.azure.com/.default']
];
const results=[];
for(const [name,clientId,scope] of required) {
  if(!clientId) {results.push({name,acquired:false,reason:'client_id_missing'});continue;}
  try {
    const result=await new ManagedIdentityCredential({clientId}).getToken(scope);
    results.push({name,acquired:typeof result?.token==='string'&&result.token.length>0});
  } catch {
    results.push({name,acquired:false,reason:'token_request_failed'});
  }
}
console.log(JSON.stringify({scope:'read_only_managed_identity_token_smoke_not_trial',results,
  allAcquired:results.every(result=>result.acquired),tokenValuesDisplayed:false}));
if(results.some(result=>!result.acquired)) process.exitCode=1;
