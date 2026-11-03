/**
 * Live runtime dependencies for a measured run.
 *
 * This is the module the CLI loads with `--deps`. It assembles the evidence
 * readers, the network-denial reader, the session adapter factory and the lane
 * selector from the deployment config plus environment variables. Nothing here
 * invents an endpoint, a credential or an assertion.
 *
 * Every "validated" flag the underlying verifiers demand is an OPERATOR
 * assertion: this module reads it from the environment and passes it through
 * unchanged. Setting one to true because a run is wanted is the exact failure the
 * gates exist to prevent, so a missing flag produces a construction error naming
 * the variable, never a default of true.
 *
 * Usage:
 *   THESIS_LOG_ANALYTICS_WORKSPACE_ID=<guid> \
 *   THESIS_VM_SOURCE_IP=10.20.4.7 \
 *   THESIS_FLEX_SOURCE_IP=10.20.9.4 \
 *   THESIS_DENIAL_DESTINATION_IP=203.0.113.10 \
 *   npm run run:experiment -- --config config/experiment.json --deps scripts/deps-live.mjs ...
 */
import {createAzureCliLogsTokenProvider,createAzureCliSessionsTokenProvider,createAzureCliStorageTokenProvider} from './azure-cli-token.mjs';
import {createStorageAuditReader} from './azure-storage-audit-reader.mjs';
import {createAzureBlobVerifier} from './azure-blob-verifier.mjs';
import {createCollectorVerifier} from './collector-verifier.mjs';
import {createResourceVerifier,createResourceEvidenceReader} from './resource-verifier.mjs';
import {createCollectorEvidenceReader} from './collector-evidence-reader.mjs';
import {createDenialReader} from './denial-reader.mjs';
import {createAzureSessionRegistry} from './azure-session-registry.mjs';
import {createSessionLifecycleObserver} from './session-lifecycle-observer.mjs';
import {createSessionFixturePreparer} from './session-fixture-preparer.mjs';
import {createAzureFixtureAdapter} from './azure-fixture-adapter.mjs';
import {createSessionPilotAdapter} from './session-pilot-adapter.mjs';
import {createLaneSelector} from './build-experiment.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reader(env,missing,name) {
  const value=env[name];
  if(typeof value!=='string' || !value.trim()) {missing.add(name);return undefined;}
  return value.trim();
}
function flag(env,name) { return String(env[name]??'').toLowerCase()==='true'; }
function ip(env,missing,name,{optional=false}={}) {
  const value=env[name];
  if(value===undefined || value==='') { if(optional) return undefined; missing.add(name); return undefined; }
  const net=value.trim();
  if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(net)) throw new Error(`${name} must be an IPv4 address`);
  return net;
}

/**
 * @param config  validated experiment config
 * @param env     environment (injectable for tests)
 * @param overrides  optional per-deployment telemetry, e.g.
 *                {azure_vm:{sourceIp,destinationIp}, azure_functions_flex:{sourceIp}}
 */
export default function createLiveDeps({config,env=process.env,overrides={}}={}) {
  if(!config || !config.deployments) throw new Error('createLiveDeps requires the validated experiment config');
  const missing=new Set();
  const notes=[];

  const workspaceId=reader(env,missing,'THESIS_LOG_ANALYTICS_WORKSPACE_ID');
  if(workspaceId && !GUID.test(workspaceId)) throw new Error('THESIS_LOG_ANALYTICS_WORKSPACE_ID must be a workspace GUID');
  const destinationIp=ip(env,missing,'THESIS_DENIAL_DESTINATION_IP');
  const vmSource=overrides.azure_vm?.sourceIp ?? ip(env,missing,'THESIS_VM_SOURCE_IP',{optional:true});
  // Scoping the VM arm's flow-log query on the VM's IP would return nothing for
  // internet egress, because SrcIp is blank for AzurePublic/ExternalPublic flows.
  // The resource ID is populated for every flow type, so it is the primary scope.
  const vmTargetResourceId=reader(env,missing,'THESIS_VM_TARGET_RESOURCE_ID');
  const flexSource=overrides.azure_functions_flex?.sourceIp ?? ip(env,missing,'THESIS_FLEX_SOURCE_IP',{optional:true});

  // Fail before constructing anything, so the operator sees every missing variable
  // at once rather than one constructor's message at a time.
  if(missing.size) throw new Error(`missing live dependency environment: ${[...missing].sort().join(', ')}`);

  const getLogsToken=createAzureCliLogsTokenProvider({});
  const getSessionToken=createAzureCliSessionsTokenProvider({});
  const getStorageToken=createAzureCliStorageTokenProvider({});

  // ---- independent network-denial evidence -------------------------------
  const denialReader=missing.size?undefined:createDenialReader({
    deployments:{
      azure_vm:{telemetry:'vnet_flow_log',sourceIp:vmSource,targetResourceId:vmTargetResourceId,destinationIp},
      // Microsoft lists Azure Functions as incompatible with VNet flow logs, so the
      // strongest available attribution for this arm is the firewall.
      azure_functions_flex:{telemetry:flexSource?'firewall':'none',sourceIp:flexSource,destinationIp},
      // Session pools expose only EgressEnabled/EgressDisabled: no VNet path, no
      // attributable deny record. Saying so is the honest answer.
      azure_custom_sessions_hyperv:{telemetry:'none'}
    },
    query:async kql=>{
      const token=await getLogsToken();
      // api.loganalytics.io is being replaced by api.loganalytics.azure.com; the
      // latter is the documented public endpoint and matches the existing audit reader.
      const response=await fetch(`https://api.loganalytics.azure.com/v1/workspaces/${workspaceId}/query`,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(120000),
        headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
        body:JSON.stringify({query:kql})});
      if(!response.ok) throw new Error(`log analytics query failed: HTTP ${response.status}`);
      const body=await response.json();
      const table=body?.tables?.[0];
      if(!table) return [];
      const columns=table.columns.map(column=>column.name);
      return (table.rows??[]).map(values=>Object.fromEntries(columns.map((name,index)=>[name,values[index]])));
    }
  });

  // The verifier constructors below refuse to run unless their pilot gates are
  // asserted. Collect them here so the operator sees the whole list, and say
  // plainly what they are: results of a pilot, not switches to flip when a run is
  // wanted.
  const ASSERTIONS={
    THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED:'independent collector evidence established',
    THESIS_RESOURCE_INDEPENDENTLY_VALIDATED:'independent resource evidence established',
    THESIS_CLOCK_SYNC_VALIDATED:'controller and verifier clocks verified in sync',
    THESIS_AUDIT_PIPELINE_VALIDATED:'audit pipeline proven to deliver complete records',
    THESIS_AUTHORIZATION_VALIDATED:'authorization outcomes independently confirmed',
    THESIS_DENIAL_STATUS_TEXT_VALIDATED:'denial status text independently confirmed',
    THESIS_SESSION_HEADER_ISOLATION_VERIFIED:'session proxy proven to strip privileged headers'
  };
  const unasserted=Object.entries(ASSERTIONS).filter(([name])=>!flag(env,name)).map(([name,what])=>`${name} (${what})`);
  if(unasserted.length) throw new Error(
    `verifier pilot gates have not been established:\n${unasserted.map(item=>`  ${item}`).join('\n')}\n`+
    'Each of these is the outcome of a pilot check, not a configuration switch. Set one to true only after that check actually passed.');

  // ---- resource and collector verdicts -----------------------------------
  const deploymentOf=trial=>config.deployments[trial?.deployment];
  const verifierKeyFor=trial=>{
    const key=env[`THESIS_${trial.deployment.toUpperCase()}_VERIFIER_KEY`];
    if(!key) throw new Error(`missing THESIS_${trial.deployment.toUpperCase()}_VERIFIER_KEY`);
    return key;
  };
  const collectorVerifier=createCollectorVerifier({
    readCollector:async trial=>createCollectorEvidenceReader({collectorUrl:deploymentOf(trial)?.collectorUrl,
      verifierKey:verifierKeyFor(trial)})(trial),
    collectorIndependentlyValidated:flag(env,'THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED')});
  const resourceVerifier=createResourceVerifier({
    readResource:async trial=>createResourceEvidenceReader({resourceUrl:deploymentOf(trial)?.resourceUrl,
      verifierKey:verifierKeyFor(trial)})(trial),
    resourceIndependentlyValidated:flag(env,'THESIS_RESOURCE_INDEPENDENTLY_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED')});

  // ---- Blob-backed scenarios ---------------------------------------------
  const blobDeployment=config.deployments.azure_vm;
  const blobVerifier=createAzureBlobVerifier({
    readAudit:createStorageAuditReader({workspaceId,getToken:getStorageToken}),
    principalForTrial:trial=>{
      const route=config.routes.find(entry=>entry.deployment===trial.deployment && entry.profile===trial.profile);
      if(!route) throw new Error('no configured principal for this trial');
      return route.principalObjectId;
    },
    blobEndpoint:blobDeployment.fixtureBlobEndpoint,
    blobResourceId:reader(env,missing,'THESIS_BLOB_RESOURCE_ID'),
    workspaceId,
    runAuthorizationControl:undefined,
    sessionFixtureOwnerPrincipalId:env.THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID,
    auditPipelineValidated:flag(env,'THESIS_AUDIT_PIPELINE_VALIDATED'),
    authorizationValidated:flag(env,'THESIS_AUTHORIZATION_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED'),
    denialStatusTextValidated:flag(env,'THESIS_DENIAL_STATUS_TEXT_VALIDATED'),
    auditWaitMs:Number(env.THESIS_AUDIT_WAIT_MS??3600000),
    pollIntervalMs:Number(env.THESIS_AUDIT_POLL_MS??10000)});

  // ---- custom container sessions -----------------------------------------
  const sessionDeployment=config.deployments.azure_custom_sessions_hyperv;
  let sessionFactory;
  if(sessionDeployment) {
    const controllerTokenFor=route=>{
      if(!route?.credentials?.controller) throw new Error('session route has no controller credential');
      return route.credentials.controller;
    };
    const registryContainerUrl=reader(env,missing,'THESIS_SESSION_REGISTRY_URL')??sessionDeployment.sessionRegistryUrl;
    const storageContainerUrl=reader(env,missing,'THESIS_BLOB_FIXTURE_CONTAINER_URL');
    const sessionRegistry=createAzureSessionRegistry({containerUrl:registryContainerUrl,getToken:getStorageToken,timeoutMs:15000});
    const lifecycleObserver=createSessionLifecycleObserver({managementEndpoint:sessionDeployment.managementEndpoint,
      poolName:sessionDeployment.poolName,region:sessionDeployment.region,getAccessToken:getSessionToken,
      expectedPrincipalId:reader(env,missing,'THESIS_SESSION_CONTROL_PRINCIPAL_ID'),sessionRegistry,timeoutMs:30000});
    const fixturePreparer=createSessionFixturePreparer({
      managementEndpoint:sessionDeployment.managementEndpoint,poolName:sessionDeployment.poolName,
      region:sessionDeployment.region,blobEndpoint:sessionDeployment.fixtureBlobEndpoint,
      blobResourceId:env.THESIS_BLOB_RESOURCE_ID,
      controllerToken:'unused-placeholder-not-a-secret',getControlToken:getSessionToken,
      controlPrincipalId:env.THESIS_SESSION_CONTROL_PRINCIPAL_ID,
      getOwnerToken:getSessionToken,ownerPrincipalId:env.THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID,
      sessionRegistry,lifecycleObserver,
      readAudit:createStorageAuditReader({workspaceId,getToken:getStorageToken})});
    const fixtureAdapter=createAzureFixtureAdapter({base:sessionDeployment.fixtureBlobEndpoint,
      blobEndpoint:sessionDeployment.fixtureBlobEndpoint,getControllerToken:getStorageToken,
      getVerifierToken:getStorageToken,prepareSessionFixture:fixturePreparer,observeSessionFixture:async()=>({})});
    sessionFactory=route=>createSessionPilotAdapter({
      fixtureAdapter,managementEndpoint:sessionDeployment.managementEndpoint,poolName:sessionDeployment.poolName,
      region:sessionDeployment.region,getAccessToken:getSessionToken,
      expectedControllerPrincipalId:env.THESIS_SESSION_CONTROL_PRINCIPAL_ID,
      controllerToken:controllerTokenFor(route),sessionRegistry,lifecycleObserver,
      // This one must be established by a pilot, not assumed: it decides whether a
      // privileged token is forwarded into the workload.
      headerIsolationVerified:flag(env,'THESIS_SESSION_HEADER_ISOLATION_VERIFIED'),timeoutMs:30000});
  }

  if(missing.size) throw new Error(`missing live dependency environment: ${[...missing].sort().join(', ')}`);

  return {denialReader,blobVerifier,collectorVerifier,resourceVerifier,
    ...(sessionFactory?{sessionFactory}:{}),laneFor:createLaneSelector(config),notes};
}
