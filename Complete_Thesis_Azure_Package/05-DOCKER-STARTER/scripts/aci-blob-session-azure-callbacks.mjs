/**
 * Composition layer for the candidate ACI U6/U8 Blob analogue.
 *
 * This does not establish readiness. Institution method approval, approved
 * evidence retention, live validation, and independent effective-access review
 * remain mandatory. In particular, callers must supply the identity/effective
 * access and Blob operation adapters; this module does not claim those cloud
 * behaviors have been validated. It is intentionally not wired into a run
 * schedule.
 */
import {createAciContainerGroupClient,buildAciContainerGroupBody,aciGroupName} from './aci-container-group-runtime.mjs';
import {createManagedStorageTokenProvider} from './azure-managed-token.mjs';
import {createManagedLogsTokenProvider} from './azure-managed-logs-token.mjs';
import {createStorageAuditReader} from './azure-storage-audit-reader.mjs';

const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requiredBlobOps=['targetForMarker'];
const requiredIdentityOps=['createIdentity','deleteIdentity','evaluateEffectiveAccess'];

function requireFn(value,name) {
  if(typeof value!=='function') throw new Error(`ACI Azure callback provider requires ${name}`);
}

function mapAuditRow(row,runId) {
  return {
    time:row.TimeGenerated,
    resourceId:row._ResourceId,
    principalId:row.RequesterObjectId,
    clientRequestId:row.ClientRequestId,
    runId,
    operation:row.OperationName,
    objectUri:row.Uri,
    statusCode:Number(row.StatusCode)
  };
}

/**
 * Build callbacks for createAciBlobSessionAnalog from the existing Azure
 * primitives plus explicitly supplied, independently reviewable adapters.
 * No credentials are printed or persisted. Constructing this object performs
 * no network operation; requests occur only when returned callbacks are used.
 */
export function createAciBlobSessionAzureCallbacks({
  subscriptionId,resourceGroup,workspaceId,managementIdentityClientId,storageIdentityClientId,auditIdentityClientId,
  getManagementToken,createCredential,groupBodyForIdentity,profileForRun,identityProvider,effectiveAccessEvaluator,blobOperations,
  agentSessionCallbacks,independentMarkerReader,
  observeGroup,fetchImpl=fetch,groupClientFactory=createAciContainerGroupClient,
  storageTokenProvider=createManagedStorageTokenProvider,logsTokenProvider=createManagedLogsTokenProvider,
  auditReaderFactory=createStorageAuditReader,groupBodyBuilder=buildAciContainerGroupBody,now=()=>Date.now()
}={}) {
  if(!GUID.test(subscriptionId||'')||!GUID.test(workspaceId||'')||
    !/^[A-Za-z0-9_.()\-]{1,90}$/.test(resourceGroup||'')) throw new Error('invalid ACI callback Azure scope');
  for(const [id,name] of [[managementIdentityClientId,'management'],[storageIdentityClientId,'storage'],[auditIdentityClientId,'audit']])
    if(!GUID.test(id||'')) throw new Error(`invalid ${name} managed identity client ID`);
  if(new Set([managementIdentityClientId.toLowerCase(),storageIdentityClientId.toLowerCase(),auditIdentityClientId.toLowerCase()]).size!==3)
    throw new Error('ACI management, Blob, and audit identities must be distinct');
  requireFn(getManagementToken,'a management token callback');
  requireFn(createCredential,'a ManagedIdentityCredential factory');
  requireFn(groupBodyForIdentity,'a group body builder');
  requireFn(profileForRun,'a frozen schedule profile resolver');
  requireFn(observeGroup,'an independent ACI group observer');
  for(const name of requiredIdentityOps) requireFn(identityProvider?.[name],`identityProvider.${name}`);
  requireFn(effectiveAccessEvaluator,'an independent effective-access evaluator');
  for(const name of requiredBlobOps) requireFn(blobOperations?.[name],`blobOperations.${name}`);
  for(const name of ['seedMarker','attemptRead','deleteMarker']) requireFn(agentSessionCallbacks?.[name],`agentSessionCallbacks.${name}`);
  requireFn(independentMarkerReader,'a separately credentialed positive-control marker reader');
  requireFn(fetchImpl,'fetch implementation');
  requireFn(now,'clock');

  const managementToken=getManagementToken;
  const getVerifierBlobToken=storageTokenProvider({clientId:storageIdentityClientId,createCredential});
  const getAuditToken=logsTokenProvider({clientId:auditIdentityClientId,createCredential});
  const groupClient=groupClientFactory({subscriptionId,resourceGroup,getManagementToken:managementToken,fetchImpl});
  const readStorageAudit=auditReaderFactory({workspaceId,getToken:getAuditToken});

  const callbacks={
    createIdentity:args=>identityProvider.createIdentity(args),
    deleteIdentity:args=>identityProvider.deleteIdentity(args),
    evaluateEffectiveAccess:args=>effectiveAccessEvaluator(args),
    targetForMarker:args=>blobOperations.targetForMarker(args),
    // The source, probe, and cleanup operations happen inside identity-bound
    // ACI groups. Controller credentials are never substituted for them.
    seedMarker:args=>agentSessionCallbacks.seedMarker(args),
    deleteMarker:args=>agentSessionCallbacks.deleteMarker(args),
    attemptRead:args=>agentSessionCallbacks.attemptRead(args),
    readMarker:args=>independentMarkerReader({...args,getToken:getVerifierBlobToken}),
    observeGroup:args=>observeGroup({...args,getManagementToken:managementToken,fetchImpl}),
    async createGroup({runId,scenario,phase,container,identity}) {
      if(!/^[A-Za-z0-9_-]{1,130}$/.test(runId||'')||!['U6','U8'].includes(scenario)||
        !['source','probe'].includes(phase)||!identity?.resourceId||!identity?.clientId)
        throw new Error('invalid ACI Blob analogue group request');
      const profile=profileForRun(runId);
      if(!['P1','P2'].includes(profile)) throw new Error('ACI profile resolver returned an unsupported profile');
      const phaseRunId=`${runId}-${phase}`;
      const name=aciGroupName(phaseRunId,profile);
      const body=await groupBodyForIdentity({runId,scenario,phase,container,identity,
        name,workloadIdentityId:identity.resourceId,workloadIdentityClientId:identity.clientId,
        buildBody:groupBodyBuilder});
      const result=await groupClient.create(name,body);
      const candidate={...result,identityObjectId:identity.objectId,ready:result.provisioningState==='Succeeded'};
      const observed=await observeGroup({group:candidate,runId,scenario,phase,identity,getManagementToken:managementToken,fetchImpl});
      if(observed?.state!=='Running'||observed.name!==name||observed.identityObjectId?.toLowerCase()!==identity.objectId.toLowerCase()||
        !Number.isFinite(Date.parse(observed.createdAt))) throw new Error('ACI group creation lacks independent live observation');
      return {...candidate,createdAt:observed.createdAt};
    },
    async deleteGroup({group}) {
      const result=await groupClient.delete(group?.name);
      return {...result,absentAt:result.deleted===true?new Date(now()).toISOString():undefined};
    },
    async readAudit({runId,requestId,from,to}) {
      if(typeof requestId!=='string'||requestId.length<12||requestId.length>100||/[\r\n]/.test(requestId))
        throw new Error('invalid Blob audit request ID');
      const startMs=Date.parse(from),endMs=Date.parse(to);
      if(!Number.isSafeInteger(startMs)||!Number.isSafeInteger(endMs)||endMs<startMs)
        throw new Error('invalid Blob audit window');
      // The shared reader filters ClientRequestId. The analogue supplies a
      // separate request ID for every operation, so query by that value.
      const rows=await readStorageAudit({runId:requestId,startMs,endMs});
      return rows.map(row=>mapAuditRow(row,runId));
    }
  };

  return Object.freeze({
    callbacks:Object.freeze(callbacks),
    methodApprovalRequired:true,
    evidenceRetentionApprovalRequired:true,
    liveValidationRequired:true,
    scheduleIntegrationAllowed:false
  });
}
