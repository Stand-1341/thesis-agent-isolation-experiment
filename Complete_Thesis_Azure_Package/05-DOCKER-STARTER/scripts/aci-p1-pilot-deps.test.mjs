import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import createDeps,{validateAciP1DependencyConfig,validateAciP1DependencyRows} from './aci-p1-pilot-deps.mjs';
import {validateAciP1DraftSchedule} from './aci-p1-pilot-draft-validator.mjs';
import {buildAciRunIdentitySpecs} from './aci-preprovisioned-identity-provider.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const env={
  THESIS_ACI_SUBSCRIPTION_ID:id(1),THESIS_ACI_TENANT_ID:id(13),THESIS_ACI_RESOURCE_GROUP:'rg-pilot',THESIS_ACI_LOCATION:'eastus',
  THESIS_ACI_IMAGE_DIGEST_REFERENCE:`example.azurecr.io/agent@sha256:${'a'.repeat(64)}`,
  THESIS_ACI_REGISTRY_SERVER:'example.azurecr.io',
  THESIS_ACI_PULL_IDENTITY_RESOURCE_ID:`/subscriptions/${id(1)}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull`,
  THESIS_ACI_P1_IDENTITY_RESOURCE_ID:`/subscriptions/${id(1)}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/workload`,
  THESIS_ACI_P1_IDENTITY_CLIENT_ID:id(2),
  THESIS_ACI_SUBNET_ID:`/subscriptions/${id(1)}/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/vnet/subnets/aci`,
  THESIS_ACI_RESEARCH_URL:'https://research.example.test',THESIS_ACI_COLLECTOR_URL:'https://collector.example.test',
  THESIS_ACI_AGENT_URL:'https://agent.example.test',THESIS_FIXTURE_BLOB_ENDPOINT:'https://storageacct.blob.core.windows.net',
  THESIS_BLOB_RESOURCE_ID:`/subscriptions/${id(1)}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/storageacct/blobServices/default`,
  THESIS_LOG_ANALYTICS_WORKSPACE_ID:id(3),THESIS_ACI_P1_PRINCIPAL_OBJECT_ID:id(4),
  THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID:id(5),THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID:id(6),
  THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID:id(7),THESIS_ACI_CONTROLLER_PRINCIPAL_OBJECT_ID:id(9),
  THESIS_ACI_FIXTURE_VERIFIER_PRINCIPAL_OBJECT_ID:id(10),THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID:id(11),
  THESIS_KEY_VAULT_URI:'https://vault-name.vault.azure.net',THESIS_EVIDENCE_IDENTITY_CLIENT_ID:id(8),
  THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID:id(12),THESIS_EVIDENCE_RETENTION_APPROVED:'true',
  THESIS_EVIDENCE_RETENTION_DAYS:'180',THESIS_EVIDENCE_BLOB_CONTAINER_URL:'https://evidenceacct.blob.core.windows.net/evidence',
  THESIS_EVIDENCE_CONTAINER_RESOURCE_ID:`/subscriptions/${id(1)}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/evidenceacct/blobServices/default/containers/evidence`,
  THESIS_ACI_RESOURCE_ADMIN_SECRET_NAME:'resource-admin',THESIS_ACI_COLLECTOR_ADMIN_SECRET_NAME:'collector-admin',
  THESIS_ACI_CONTROLLER_KEY_SECRET_NAME:'controller-key',THESIS_ACI_WORKLOAD_TOKEN_SECRET_NAME:'workload-token',
  THESIS_ACI_COLLECTOR_VERIFIER_SECRET_NAME:'collector-verifier',THESIS_ACI_RESOURCE_VERIFIER_SECRET_NAME:'resource-verifier'
};
const row=scenario=>({deployment:'azure_container_instances',permission_profile:'P1',scenario_id:scenario});

const methodDecision={status:'approved',reference:'https://institution.example.test/method/aci-amendment',
  approvalEvidenceReference:'https://institution.example.test/approvals/aci-amendment',reviewerPrincipalId:id(14),
  unauthorizedOperations:{U6:'read_other_active_group_blob_marker',U8:'read_retired_group_blob_marker'}};
const sessionAnalog=async()=>({classification:'indeterminate',evidence:{}});
const sessionAnalogVerifier=async()=>({classification:'indeterminate',evidence:{}});
let verifiedDecision;
const approval=async decision=>{verifiedDecision=decision;return true;};
const lifecycleRows=Array.from({length:10},(_,i)=>({deployment:'azure_container_instances',permission_profile:'P1',
  scenario_id:i%2?'U8':'U6',planned_run_id:`pilot-aci-fixture-${i+1}`}));
const inventorySpecs=buildAciRunIdentitySpecs(lifecycleRows.map(r=>({runId:r.planned_run_id,scenario:r.scenario_id})))
  .map((spec,i)=>({...spec,principalId:`70000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`}));
const preprovisionedIdentityManifest={scheduleSha256:'a'.repeat(64),identitySpecs:inventorySpecs};

test('dependency schedule validation rejects ACI U6 and U8 without separately injected callbacks',async()=>{
  for(const scenario of ['U6','U8']) await assert.rejects(createDeps({rows:[row(scenario)],env:{}}),/method-decision/);
  assert.throws(()=>validateAciP1DependencyRows([row('U6')]),/separate sessionAnalog/);
  assert.throws(()=>validateAciP1DependencyRows([row('U8')]),/separate sessionAnalog/);
  assert.throws(()=>validateAciP1DependencyRows([row('U6')],{sessionAnalog,sessionAnalogVerifier}),/method-decision/);
  assert.throws(()=>validateAciP1DependencyRows([row('U6')],{sessionAnalog,sessionAnalogVerifier,methodDecision}),/verifier callback/);
  assert.equal(validateAciP1DependencyRows([row('U6'),row('U8')],{sessionAnalog,sessionAnalogVerifier,methodDecision,verifyMethodApproval:approval}),true);
});

test('checked-in 50-row draft still blocks dependency creation because U6 and U8 are present',async()=>{
  const protocol=JSON.parse(await readFile(new URL('../config/aci-p1-pilot-draft.json',import.meta.url),'utf8'));
  const schedulePath=new URL(`../../${protocol.scheduleFile}`,import.meta.url);
  const bytes=await readFile(schedulePath);
  const schedule=validateAciP1DraftSchedule({bytes,protocol});
  assert.equal(schedule.rows,50);
  const text=bytes.toString('utf8');
  assert.match(text,/U6/);assert.match(text,/U8/);
  await assert.rejects(createDeps({rows:[row('U1'),row('U6'),row('U8')],env:{}}),/method-decision/);
});

test('dependency schedule validation is limited to ACI P1 and known scenario adapters',()=>{
  assert.throws(()=>validateAciP1DependencyRows([row('U9')]),/outside the supported/);
  assert.throws(()=>validateAciP1DependencyRows([{...row('U1'),permission_profile:'P2'}]),/outside the supported/);
  assert.throws(()=>validateAciP1DependencyRows([{...row('U1'),deployment:'azure_vm'}]),/outside the supported/);
  assert.equal(validateAciP1DependencyRows([row('U1'),row('U4'),row('U7'),row('L1')]),true);
});

test('configuration validation identifies required inputs and rejects shared privileged identities',()=>{
  assert.throws(()=>validateAciP1DependencyConfig({}),/missing ACI pilot dependency configuration: .*THESIS_KEY_VAULT_URI/);
  assert.throws(()=>validateAciP1DependencyConfig({...env,THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID:env.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID}),/must be distinct/);
  assert.throws(()=>validateAciP1DependencyConfig({...env,THESIS_EVIDENCE_PRINCIPAL_OBJECT_ID:env.THESIS_ACI_P1_PRINCIPAL_OBJECT_ID}),/principals must be distinct/);
  assert.throws(()=>validateAciP1DependencyConfig({...env,THESIS_EVIDENCE_IDENTITY_CLIENT_ID:env.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID}),/managed identities must be distinct/);
  assert.throws(()=>validateAciP1DependencyConfig({...env,THESIS_ACI_IMAGE_DIGEST_REFERENCE:'example.azurecr.io/agent:latest'}),/pinned by digest/);
  assert.throws(()=>validateAciP1DependencyConfig({...env,THESIS_EVIDENCE_RETENTION_APPROVED:'false'}),/retention is not asserted/);
});

test('approved method-decision metadata alone never enables U6/U8 dependencies',async()=>{
  let identitiesCreated=0;
  await assert.rejects(createDeps({rows:[row('U6')],env,components:{sessionAnalog,sessionAnalogVerifier,methodDecision,
    verifyMethodApproval:async()=>false,identity:()=>{identitiesCreated++;return {getToken:async()=>({token:'unused'})};}}}),
  /method decision was not independently verified/);
  assert.equal(identitiesCreated,0);
});

test('wires separated identity providers, Key Vault secrets, adapter, independent verifiers, and protected evidence store',async()=>{
  const identityIds=[],secretReads=[],storageIds=[],logIds=[]; let captured;
  const mockCredential=clientId=>{identityIds.push(clientId);return {getToken:async()=>({token:'mock-token'})};};
  const components={
    identityLifecycleRoleDefinitionId:`/subscriptions/${id(1)}/providers/Microsoft.Authorization/roleDefinitions/${id(15)}`,
    preprovisionedIdentityManifest,
    identity:mockCredential,
    storageProvider:({clientId})=>{storageIds.push(clientId);return async()=>'mock-storage-token';},
    logsProvider:({clientId})=>{logIds.push(clientId);return async()=>'mock-logs-token';},
    readSecret:async({name})=>{secretReads.push(name);return `secret-value-${name}`;},
    httpAdapter:args=>({reset:async()=>({}),execute:async()=>({}),collect:async()=>({resource:{},collector:{}}),config:args}),
    fixtureAdapter:args=>({reset:async()=>({}),execute:async()=>({}),collect:async()=>({}),config:args}),
    groupClient:args=>({create:async()=>{},delete:async()=>{},config:args}),
    groupBody:args=>({received:args}),
    trialAdapter:args=>({config:args}),
    auditReader:args=>Object.assign(async()=>[],{config:args}),
    blobVerifier:args=>Object.assign(async()=>({classification:'indeterminate'}),{config:args}),
    collectorVerifier:args=>Object.assign(async()=>({classification:'indeterminate'}),{config:args}),
    resourceVerifier:args=>Object.assign(async()=>({classification:'indeterminate'}),{config:args}),
    collectorReader:args=>Object.assign(async()=>({}),{config:args}),
    resourceReader:args=>Object.assign(async()=>({}),{config:args}),
    verifierRouter:args=>Object.assign(async()=>({classification:'indeterminate'}),{config:args}),
    methodDecision,verifyMethodApproval:approval,
    reviewCredentialPaths:async({principalId,runId,container,targetResourceId,observerPrincipalId})=>({
      status:'complete',source:'azure_live_identity_credential_path_review_v1',principalId,runId,container,
      resourceId:targetResourceId,observerPrincipalId,readOnly:true,allPathsResolved:true,unresolvedPaths:[],
      evidenceReference:'urn:credential-review:test',snapshotFingerprint:`sha256:${'c'.repeat(64)}`,observedAt:'2026-11-04T12:00:00Z'}),
    observeGroup:async({group})=>({state:'Running',name:group.name,identityObjectId:group.identityObjectId,
      createdAt:'2026-11-04T12:00:00Z'}),
    readAciLifecycleEvidence:async()=>({source:'azure_aci_arm_activity_snapshot_v1',readOnly:true,
      observerPrincipalId:env.THESIS_ACI_AUDIT_PRINCIPAL_OBJECT_ID,snapshot:{}}),
    evidenceStore:async args=>{captured={...(captured??{}),evidenceArgs:args};return {claim:async()=>{},save:async()=>{}};}
  };
  const deps=await createDeps({rows:[row('U1'),row('U4'),row('U5'),row('U7'),row('L1'),...lifecycleRows],env,components});
  assert.equal(typeof deps.adapter,'object');assert.equal(typeof deps.verifier,'function');
  assert.equal(typeof deps.evidenceStore.claim,'function');assert.equal(typeof deps.evidenceStore.save,'function');
  assert.deepEqual(identityIds,[env.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID,
    env.THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID,env.THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID]);
  assert.deepEqual(storageIds,[env.THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID,env.THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID,
    env.THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID]);
  assert.deepEqual(logIds,[env.THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID,env.THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID]);
  assert.deepEqual(secretReads,['resource-admin','collector-admin','controller-key','workload-token','collector-verifier','resource-verifier']);
  assert.equal(deps.adapter.config.controllerToken,'secret-value-controller-key');
  assert.equal(deps.adapter.config.groupBodyForTrial instanceof Function,true);
  assert.equal(typeof deps.adapter.config.sessionAnalog,'function');
  assert.equal(deps.adapter.config.groupClient.config.resourceGroup,'rg-pilot');
  assert.equal(deps.verifier.config.blobVerifier.config.pilotMode,true);
  assert.equal(typeof deps.verifier.config.sessionAnalogVerifier,'function');
  assert.notEqual(deps.verifier.config.sessionAnalogVerifier,deps.adapter.config.sessionAnalog);
  assert.equal(verifiedDecision,methodDecision);
  assert.equal(Object.hasOwn(deps,'readiness'),false);
  assert.equal(Object.hasOwn(deps,'gates'),false);
  assert.equal(captured.evidenceArgs.env.THESIS_TOKEN_PROVIDER_MODE,'managed_identity');
  assert.equal(captured.evidenceArgs.env.THESIS_EVIDENCE_RETENTION_APPROVED,'true');
});
