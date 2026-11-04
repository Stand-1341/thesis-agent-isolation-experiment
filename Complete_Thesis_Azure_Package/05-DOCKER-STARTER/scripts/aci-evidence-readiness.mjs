/** Fail-closed ACI evidence gate. Inputs must come from a live, recorded preflight. */
import {createAzureBlobVerifier} from './azure-blob-verifier.mjs';
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function principal(value,name) {
  if(typeof value!=='string'||!GUID.test(value)) throw new Error(`${name} must be an Entra object ID`);
  return value.toLowerCase();
}

/**
 * Validate identity separation and evidence observations before constructing an
 * ACI pilot verifier. This checks supplied observations only; it makes no Azure
 * calls and cannot establish that the observations are genuine.
 */
export function validateAciEvidenceReadiness(input) {
  const ids=[
    principal(input?.workloadPrincipalId,'workloadPrincipalId'),
    principal(input?.evidenceWriterPrincipalId,'evidenceWriterPrincipalId'),
    principal(input?.verifierPrincipalId,'verifierPrincipalId'),
    principal(input?.auditReaderPrincipalId,'auditReaderPrincipalId'),
  ];
  if(new Set(ids).size!==ids.length) throw new Error('ACI workload, evidence writer, verifier, and audit reader identities must be distinct');
  const required=[
    ['lockedRetention','locked evidence retention was not observed'],
    ['independentReadback','independent verifier read-back was not observed'],
    ['overwriteDenied','evidence overwrite denial was not observed'],
    ['deleteDenied','evidence deletion denial was not observed'],
    ['auditAttribution','workload and verifier audit attribution was not observed'],
  ];
  for(const [key,message] of required) {
    const proof=input?.observations?.[key];
    if(proof?.passed!==true || !GUID.test(proof?.runId??'') || !proof?.observedAt || !proof?.resourceId)
      throw new Error(message);
    if(!Number.isFinite(Date.parse(proof.observedAt))) throw new Error(`${key} observation timestamp is invalid`);
  }
  const retention=input.observations.lockedRetention.retentionDays;
  if(!Number.isInteger(retention)||retention<1) throw new Error('locked evidence retention period is invalid');
  return {ready:true,identitySeparation:'asserted_by_supplied_ids',retentionDays:retention,
    evidence:'externally_observed_preflight_required',azureValidated:false};
}

/** Construct only after the ACI-specific evidence gate has passed. */
export function createAciEvidenceVerifier({readAudit,principalForTrial,blobEndpoint,blobResourceId,workspaceId,
  runAuthorizationControl,readiness,...options}={}) {
  const gate=validateAciEvidenceReadiness(readiness);
  if(options.pilotMode===true) throw new Error('ACI evidence verifier cannot run in pilotMode');
  if(options.auditPipelineValidated!==true||options.authorizationValidated!==true||options.clockSyncValidated!==true||
    options.denialStatusTextValidated!==true) throw new Error('ACI verifier Azure validation gates have not passed');
  const verify=createAzureBlobVerifier({readAudit,principalForTrial,blobEndpoint,blobResourceId,workspaceId,
    runAuthorizationControl,...options,pilotMode:false});
  return Object.assign(verify,{readiness:gate});
}
