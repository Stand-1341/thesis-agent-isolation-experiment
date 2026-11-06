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
 *   THESIS_VM_P3_DENIAL_TELEMETRY=azure_diagnostics_firewall \
 *   THESIS_VM_P3_FIREWALL_SOURCE_IP=10.49.8.4 \
 *   THESIS_VM_P3_FIREWALL_DESTINATION_PORT=8443 \
 *   THESIS_VM_P3_FIREWALL_DENY_RULE=deny-centralus-p3-collector \
 *   THESIS_FLEX_P3_DENIAL_TELEMETRY=azure_diagnostics_firewall \
 *   THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR=10.48.6.0/24 \
 *   THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT=8443 \
 *   THESIS_FLEX_P3_FIREWALL_DENY_RULE=functions-p3-deny-collector \
 *   npm run run:experiment -- --config config/experiment.json --deps scripts/deps-live.mjs ...
 */
import {createAzureCliLogsTokenProvider,createAzureCliSessionsTokenProvider,createAzureCliStorageTokenProvider} from './azure-cli-token.mjs';
import {createManagedStorageTokenProvider} from './azure-managed-token.mjs';
import {createManagedLogsTokenProvider} from './azure-managed-logs-token.mjs';
import {createManagedSessionsTokenProvider} from './azure-managed-sessions-token.mjs';
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
import {createHttpPilotAdapter} from './http-pilot-adapter.mjs';
import {createLaneSelector} from './build-experiment.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the workload principal from either scheduler or normalized trial shape.
 * If both labels are present they must agree; a verifier must never guess a route.
 */
export function principalForConfiguredTrial(config,trial) {
  const profile=trial?.permission_profile ?? trial?.profile;
  if(trial?.profile!==undefined && trial?.permission_profile!==undefined && trial.profile!==trial.permission_profile)
    throw new Error('trial profile fields disagree; refusing principal attribution');
  if(typeof trial?.deployment!=='string' || typeof profile!=='string')
    throw new Error('trial deployment/profile is missing; refusing principal attribution');
  const matches=config?.routes?.filter(entry=>entry.deployment===trial.deployment && entry.profile===profile)??[];
  if(matches.length!==1 || !GUID.test(matches[0]?.principalObjectId??''))
    throw new Error('no unique configured principal for this trial');
  return matches[0].principalObjectId;
}

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
function cidr(env,missing,name,{optional=false}={}) {
  const value=env[name];
  if(value===undefined || value==='') { if(optional) return undefined; missing.add(name); return undefined; }
  const match=/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value.trim());
  if(!match || !/^(?:0|[1-9]|[12]\d|3[0-2])$/.test(match[2])) throw new Error(`${name} must be an IPv4 CIDR`);
  const octets=match[1].split('.').map(Number);
  if(octets.some(octet=>octet>255)) throw new Error(`${name} must be an IPv4 CIDR`);
  return `${match[1]}/${Number(match[2])}`;
}

/**
 * @param config  validated experiment config
 * @param env     environment (injectable for tests)
 * @param overrides  optional per-deployment telemetry, e.g.
 *                {azure_vm:{sourceIp,destinationIp}, azure_functions_flex:{sourceIp}}
 */
export default function createLiveDeps({config,env=process.env,overrides={},mode='measured',routeKeys}={}) {
  if(!config || !config.deployments) throw new Error('createLiveDeps requires the validated experiment config');
  if(!['measured','non_counted_pilot'].includes(mode)) throw new Error('invalid live dependency mode');
  const pilotMode=mode==='non_counted_pilot';
  const selectedRoutes=routeKeys?new Set(routeKeys):new Set(config.routes.map(route=>`${route.deployment}:${route.profile}`));
  const selects=(deployment,profile)=>selectedRoutes.has(`${deployment}:${profile}`);
  const needsVmDenial=selects('azure_vm','P3');
  const needsFlexDenial=selects('azure_functions_flex','P3');
  const needsSessions=config.routes.some(route=>route.deployment==='azure_custom_sessions_hyperv' &&
    selectedRoutes.has(`${route.deployment}:${route.profile}`));
  const tokenMode=env.THESIS_TOKEN_PROVIDER_MODE??'azure_cli';
  if(!['azure_cli','managed_identity'].includes(tokenMode)) throw new Error('THESIS_TOKEN_PROVIDER_MODE must be azure_cli or managed_identity');
  // Fixture-owner and session-control principals must be distinct. A single
  // Azure CLI login cannot supply both identities, so require explicit managed
  // identity selectors for a session route.
  if(needsSessions && tokenMode!=='managed_identity') throw new Error('session routes require separate managed control and fixture-owner identities');
  const missing=new Set();
  const notes=[];

  const workspaceId=reader(env,missing,'THESIS_LOG_ANALYTICS_WORKSPACE_ID');
  if(workspaceId && !GUID.test(workspaceId)) throw new Error('THESIS_LOG_ANALYTICS_WORKSPACE_ID must be a workspace GUID');
  const fixtureBlobEndpoint=reader(env,missing,'THESIS_FIXTURE_BLOB_ENDPOINT');
  if(fixtureBlobEndpoint) {
    let parsed;
    try { parsed=new URL(fixtureBlobEndpoint); } catch { throw new Error('THESIS_FIXTURE_BLOB_ENDPOINT must be an HTTPS URL'); }
    if(parsed.protocol!=='https:' || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error('THESIS_FIXTURE_BLOB_ENDPOINT must be an HTTPS URL without credentials, query or fragment');
  }
  const destinationIp=needsVmDenial||needsFlexDenial?ip(env,missing,'THESIS_DENIAL_DESTINATION_IP'):undefined;
  const vmP3Telemetry=env.THESIS_VM_P3_DENIAL_TELEMETRY??'vnet_flow_log';
  if(!['vnet_flow_log','azure_diagnostics_firewall'].includes(vmP3Telemetry))
    throw new Error('THESIS_VM_P3_DENIAL_TELEMETRY must be vnet_flow_log or azure_diagnostics_firewall');
  const vmSource=vmP3Telemetry==='azure_diagnostics_firewall'
    ?needsVmDenial?ip(env,missing,'THESIS_VM_P3_FIREWALL_SOURCE_IP'):undefined
    :overrides.azure_vm?.sourceIp ?? ip(env,missing,'THESIS_VM_SOURCE_IP',{optional:true});
  // Scoping the VM arm's flow-log query on the VM's IP would return nothing for
  // internet egress, because SrcIp is blank for AzurePublic/ExternalPublic flows.
  // The resource ID is populated for every flow type, so it is the primary scope.
  const vmTargetResourceId=needsVmDenial&&vmP3Telemetry==='vnet_flow_log'
    ?reader(env,missing,'THESIS_VM_TARGET_RESOURCE_ID'):undefined;
  const vmFirewallDestinationPortValue=needsVmDenial&&vmP3Telemetry==='azure_diagnostics_firewall'
    ?reader(env,missing,'THESIS_VM_P3_FIREWALL_DESTINATION_PORT'):undefined;
  const vmFirewallDestinationPort=vmFirewallDestinationPortValue===undefined?undefined:Number(vmFirewallDestinationPortValue);
  if(vmFirewallDestinationPortValue!==undefined && (!Number.isInteger(vmFirewallDestinationPort)
    || vmFirewallDestinationPort<1 || vmFirewallDestinationPort>65535))
    throw new Error('THESIS_VM_P3_FIREWALL_DESTINATION_PORT must be an integer from 1 to 65535');
  const vmFirewallDenyRuleName=needsVmDenial&&vmP3Telemetry==='azure_diagnostics_firewall'
    ?reader(env,missing,'THESIS_VM_P3_FIREWALL_DENY_RULE'):undefined;
  if(vmFirewallDenyRuleName!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(vmFirewallDenyRuleName))
    throw new Error('THESIS_VM_P3_FIREWALL_DENY_RULE must be a plain rule name');
  const flexSource=overrides.azure_functions_flex?.sourceIp ?? ip(env,missing,'THESIS_FLEX_SOURCE_IP',{optional:true});
  const flexP3Telemetry=env.THESIS_FLEX_P3_DENIAL_TELEMETRY??'firewall';
  if(!['firewall','azure_diagnostics_firewall'].includes(flexP3Telemetry))
    throw new Error('THESIS_FLEX_P3_DENIAL_TELEMETRY must be firewall or azure_diagnostics_firewall');
  const flexP3SourceCidr=needsFlexDenial&&flexP3Telemetry==='azure_diagnostics_firewall'
    ?cidr(env,missing,'THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR'):undefined;
  const flexP3FirewallDestinationPortValue=needsFlexDenial&&flexP3Telemetry==='azure_diagnostics_firewall'
    ?reader(env,missing,'THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT'):undefined;
  const flexP3FirewallDestinationPort=flexP3FirewallDestinationPortValue===undefined
    ?undefined:Number(flexP3FirewallDestinationPortValue);
  if(flexP3FirewallDestinationPortValue!==undefined && (!Number.isInteger(flexP3FirewallDestinationPort)
    || flexP3FirewallDestinationPort<1 || flexP3FirewallDestinationPort>65535))
    throw new Error('THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT must be an integer from 1 to 65535');
  const flexP3FirewallDenyRuleName=needsFlexDenial&&flexP3Telemetry==='azure_diagnostics_firewall'
    ?reader(env,missing,'THESIS_FLEX_P3_FIREWALL_DENY_RULE'):undefined;
  if(flexP3FirewallDenyRuleName!==undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(flexP3FirewallDenyRuleName))
    throw new Error('THESIS_FLEX_P3_FIREWALL_DENY_RULE must be a plain rule name');
  const storageIdentityClientId=tokenMode==='managed_identity'?reader(env,missing,'THESIS_STORAGE_IDENTITY_CLIENT_ID'):undefined;
  const logsIdentityClientId=tokenMode==='managed_identity'?reader(env,missing,'THESIS_LOGS_IDENTITY_CLIENT_ID'):undefined;
  const sessionIdentityClientId=tokenMode==='managed_identity'&&needsSessions?reader(env,missing,'THESIS_SESSION_IDENTITY_CLIENT_ID'):undefined;
  const sessionFixtureOwnerClientId=needsSessions?reader(env,missing,'THESIS_SESSION_FIXTURE_OWNER_IDENTITY_CLIENT_ID'):undefined;
  const sessionControlPrincipalId=needsSessions?reader(env,missing,'THESIS_SESSION_CONTROL_PRINCIPAL_ID'):undefined;
  const sessionFixtureOwnerPrincipalId=needsSessions?reader(env,missing,'THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID'):undefined;
  if(needsSessions && sessionIdentityClientId && sessionFixtureOwnerClientId && sessionIdentityClientId.toLowerCase()===sessionFixtureOwnerClientId.toLowerCase())
    throw new Error('session control and fixture owner must use different managed identities');

  // Fail before constructing anything, so the operator sees every missing variable
  // at once rather than one constructor's message at a time.
  if(missing.size) throw new Error(`missing live dependency environment: ${[...missing].sort().join(', ')}`);

  const getStorageToken=tokenMode==='managed_identity'
    ?createManagedStorageTokenProvider({clientId:storageIdentityClientId})
    :createAzureCliStorageTokenProvider({});
  const getLogsToken=tokenMode==='managed_identity'
    ?createManagedLogsTokenProvider({clientId:logsIdentityClientId})
    :createAzureCliLogsTokenProvider({});
  const getSessionToken=needsSessions
    ?tokenMode==='managed_identity'
      ?createManagedSessionsTokenProvider({clientId:sessionIdentityClientId})
      :createAzureCliSessionsTokenProvider({})
    :undefined;
  const getSessionFixtureOwnerToken=needsSessions?createManagedStorageTokenProvider({clientId:sessionFixtureOwnerClientId}):undefined;

  // ---- independent network-denial evidence -------------------------------
  const denialReader=missing.size?undefined:createDenialReader({
    deployments:{
      azure_vm:{telemetry:needsVmDenial?vmP3Telemetry:'none',sourceIp:vmSource,targetResourceId:vmTargetResourceId,
        destinationIp:needsVmDenial?destinationIp:undefined,destinationPort:vmFirewallDestinationPort,
        denyRuleName:vmFirewallDenyRuleName},
      // Microsoft lists Azure Functions as incompatible with VNet flow logs, so the
      // strongest available attribution for this arm is the firewall.
      azure_functions_flex:{telemetry:!needsFlexDenial?'none':flexP3Telemetry==='azure_diagnostics_firewall'
        ?'azure_diagnostics_firewall':flexSource?'firewall':'none',sourceIp:flexP3Telemetry==='firewall'?flexSource:undefined,
        sourceCidr:flexP3SourceCidr,destinationIp:needsFlexDenial?destinationIp:undefined,
        destinationPort:flexP3FirewallDestinationPort,denyRuleName:flexP3FirewallDenyRuleName},
      // Session pools expose only EgressEnabled/EgressDisabled: no VNet path, no
      // attributable deny record. Saying so is the honest answer.
      azure_custom_sessions_hyperv:{telemetry:'none'}
    },
    auditWaitMs:Number(env.THESIS_AUDIT_WAIT_MS??3600000),
    pollIntervalMs:Number(env.THESIS_AUDIT_POLL_MS??10000),
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

  // Measured mode requires the verifier assertions. Non-counted pilot mode can
  // run the candidate verifiers while labeling all records provisional; it never
  // turns an unverified assertion into a readiness gate.
  const ASSERTIONS={
    THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED:'independent collector evidence established',
    THESIS_RESOURCE_INDEPENDENTLY_VALIDATED:'independent resource evidence established',
    THESIS_CLOCK_SYNC_VALIDATED:'controller and verifier clocks verified in sync',
    THESIS_AUDIT_PIPELINE_VALIDATED:'audit pipeline proven to deliver complete records',
    THESIS_AUTHORIZATION_VALIDATED:'authorization outcomes independently confirmed',
    THESIS_DENIAL_STATUS_TEXT_VALIDATED:'denial status text independently confirmed',
    ...(needsSessions?{THESIS_SESSION_HEADER_ISOLATION_VERIFIED:'session proxy proven to strip privileged headers'}:{})
  };
  const unasserted=Object.entries(ASSERTIONS).filter(([name])=>!flag(env,name)).map(([name,what])=>`${name} (${what})`);
  if(unasserted.length && !pilotMode) throw new Error(
    `verifier pilot gates have not been established:\n${unasserted.map(item=>`  ${item}`).join('\n')}\n`+
    'Each of these is the outcome of a pilot check, not a configuration switch. Set one to true only after that check actually passed.');
  if(unasserted.length) notes.push(`NON-COUNTED PILOT: unestablished verifier assertions: ${unasserted.join('; ')}`);

  // ---- resource and collector verdicts -----------------------------------
  const deploymentOf=trial=>config.deployments[trial?.deployment];
  const verifierKeyFor=(trial,service)=>{
    const prefix=`THESIS_${trial.deployment.toUpperCase()}`;
    const serviceKey=env[`${prefix}_${service.toUpperCase()}_VERIFIER_KEY`];
    const sharedKey=env[`${prefix}_VERIFIER_KEY`];
    const key=serviceKey||sharedKey;
    if(!key) throw new Error(`missing ${prefix}_${service.toUpperCase()}_VERIFIER_KEY`);
    return key;
  };
  const collectorVerifier=createCollectorVerifier({
    readCollector:async trial=>createCollectorEvidenceReader({collectorUrl:deploymentOf(trial)?.collectorUrl,
      verifierKey:verifierKeyFor(trial,'collector')})(trial.runId),
    collectorIndependentlyValidated:flag(env,'THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED'),pilotMode});
  const resourceVerifier=createResourceVerifier({
    readResource:async trial=>createResourceEvidenceReader({resourceUrl:deploymentOf(trial)?.resourceUrl,
      verifierKey:verifierKeyFor(trial,'resource')})(trial.runId),
    resourceIndependentlyValidated:flag(env,'THESIS_RESOURCE_INDEPENDENTLY_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED'),pilotMode});

  // ---- Blob-backed scenarios ---------------------------------------------
  const blobVerifier=createAzureBlobVerifier({
    readAudit:createStorageAuditReader({workspaceId,getToken:getLogsToken}),
    principalForTrial:trial=>principalForConfiguredTrial(config,trial),
    blobEndpoint:fixtureBlobEndpoint,
    blobResourceId:reader(env,missing,'THESIS_BLOB_RESOURCE_ID'),
    workspaceId,
    runAuthorizationControl:undefined,
    sessionFixtureOwnerPrincipalId:env.THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID,
    auditPipelineValidated:flag(env,'THESIS_AUDIT_PIPELINE_VALIDATED'),
    authorizationValidated:flag(env,'THESIS_AUTHORIZATION_VALIDATED'),
    clockSyncValidated:flag(env,'THESIS_CLOCK_SYNC_VALIDATED'),
    denialStatusTextValidated:flag(env,'THESIS_DENIAL_STATUS_TEXT_VALIDATED'),
    pilotMode,
    auditWaitMs:Number(env.THESIS_AUDIT_WAIT_MS??3600000),
    pollIntervalMs:Number(env.THESIS_AUDIT_POLL_MS??10000)});

  // ---- custom container sessions -----------------------------------------
  const sessionDeployment=needsSessions?config.deployments.azure_custom_sessions_hyperv:undefined;
  let sessionFactory;
  if(sessionDeployment) {
    const controllerTokenFor=route=>{
      if(!route?.credentials?.controller) throw new Error('session route has no controller credential');
      return route.credentials.controller;
    };
    const registryContainerUrl=typeof env.THESIS_SESSION_REGISTRY_URL==='string' && env.THESIS_SESSION_REGISTRY_URL.trim()
      ?env.THESIS_SESSION_REGISTRY_URL.trim():sessionDeployment.sessionRegistryUrl;
    const sessionRegistry=createAzureSessionRegistry({containerUrl:registryContainerUrl,getToken:getStorageToken,timeoutMs:15000});
    sessionFactory=route=>{
      if(route?.deployment!=='azure_custom_sessions_hyperv' || !['P1','P2','P3'].includes(route.profile))
        throw new Error('invalid session route');
      const configured=config.routes.filter(entry=>entry.deployment===route.deployment && entry.profile===route.profile);
      if(configured.length!==1 || configured[0].principalObjectId!==route.principalObjectId)
        throw new Error('session route principal does not match configuration');
      const pool=sessionDeployment.profilePools?.[route.profile];
      if(!pool) throw new Error('a profile-specific session pool is required');
      const lifecycleObserver=createSessionLifecycleObserver({managementEndpoint:pool.managementEndpoint,
        poolName:pool.poolName,region:pool.region,getAccessToken:getSessionToken,
        expectedPrincipalId:sessionControlPrincipalId,sessionRegistry,timeoutMs:30000});
      const controllerToken=controllerTokenFor(route);
      // Session workloads still share the research fixture service, but their
      // reset/evidence credentials are route-scoped just like the HTTP arms.
      const base=createHttpPilotAdapter({agentUrl:pool.managementEndpoint,
        resourceUrl:sessionDeployment.resourceUrl,collectorUrl:sessionDeployment.collectorUrl,
        resourceAdminToken:route.credentials.resourceAdmin,collectorAdminToken:route.credentials.collectorAdmin,
        controllerToken,timeoutMs:sessionDeployment.timeoutMs??30000});
      const fixturePreparer=createSessionFixturePreparer({
        managementEndpoint:pool.managementEndpoint,poolName:pool.poolName,
        region:pool.region,blobEndpoint:sessionDeployment.fixtureBlobEndpoint,
        blobResourceId:env.THESIS_BLOB_RESOURCE_ID,
        controllerToken,getControlToken:getSessionToken,
        controlPrincipalId:sessionControlPrincipalId,
        getOwnerToken:getSessionFixtureOwnerToken,ownerPrincipalId:sessionFixtureOwnerPrincipalId,
        sessionRegistry,lifecycleObserver,
        readAudit:createStorageAuditReader({workspaceId,getToken:getLogsToken})});
      const fixtureAdapter=createAzureFixtureAdapter({base,
        blobEndpoint:sessionDeployment.fixtureBlobEndpoint,getControllerToken:getStorageToken,
        getVerifierToken:getStorageToken,prepareSessionFixture:fixturePreparer,
        observeSessionFixture:fixtureRunId=>lifecycleObserver.observe(fixtureRunId)});
      return createSessionPilotAdapter({
        fixtureAdapter,managementEndpoint:pool.managementEndpoint,poolName:pool.poolName,
        region:pool.region,getAccessToken:getSessionToken,
        expectedControllerPrincipalId:sessionControlPrincipalId,
        controllerToken,sessionRegistry,lifecycleObserver,
        // This one must be established by a pilot, not assumed: it decides whether a
        // privileged token is forwarded into the workload.
        headerIsolationVerified:flag(env,'THESIS_SESSION_HEADER_ISOLATION_VERIFIED'),timeoutMs:sessionDeployment.timeoutMs??30000});
    };
  }

  // HTTP workloads also exercise Azure Blob scenarios. Seed each run-scoped
  // fixture before execution; resetting only the research/collector APIs leaves
  // authorized-docs and authorized-records missing (BlobNotFound). The controller
  // identity seeds pilot fixtures; study readiness still depends on separately
  // validated audit and evidence controls.
  const httpFactory=(route,deployment)=>{
    const base=createHttpPilotAdapter({agentUrl:route.agentUrl ?? deployment.agentUrl,
      resourceUrl:deployment.resourceUrl,collectorUrl:deployment.collectorUrl,
      resourceAdminToken:route.credentials.resourceAdmin,collectorAdminToken:route.credentials.collectorAdmin,
      controllerToken:route.credentials.controller,
      ...(route.credentials.functionKey===undefined?{}:{functionKey:route.credentials.functionKey}),
      ...(deployment.timeoutMs===undefined?{}:{timeoutMs:deployment.timeoutMs})});
    return createAzureFixtureAdapter({base,blobEndpoint:fixtureBlobEndpoint,
      getControllerToken:getStorageToken,getVerifierToken:getStorageToken,
      timeoutMs:deployment.timeoutMs??15000});
  };

  if(missing.size) throw new Error(`missing live dependency environment: ${[...missing].sort().join(', ')}`);

  return {denialReader,blobVerifier,collectorVerifier,resourceVerifier,
    httpFactory,
    ...(sessionFactory?{sessionFactory}:{}),laneFor:createLaneSelector(config),notes};
}
