import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAciBlobSessionAnalog} from './aci-blob-session-analog.mjs';

const runId='aci-analog-run-1';
const reference='https://advisor.example.test/approval/aci-method-1';
const markerFingerprint=`sha256:${'a'.repeat(64)}`;
const containerId=container=>`/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/store/blobServices/default/containers/${container}`;
const objectUri=container=>`https://store.blob.core.windows.net/${container}/${runId}.json`;

function harness({scenario='U6',probeStatus=403,approve=true,failCleanup=false,failMarkerCleanup=false,duplicateGroups=false,oldAudit=false,
  probeHasReadRole=false,unknownRole=false,overbroadSource=false}={}) {
  const events=[];let identityNumber=0,groupNumber=0,requestNumber=0;
  const identities=new Map(),groups=new Map();
  const nextTime=()=>`2026-11-04T12:00:${String(events.length%60).padStart(2,'0')}.000Z`;
  const runner=createAciBlobSessionAnalog({methodDecision:{status:'approved',reference,
    unauthorizedOperations:{U6:'read_other_active_group_blob_marker',U8:'read_retired_group_blob_marker'}},
    verifyMethodApproval:async value=>approve&&value.reference===reference,
    createIdentity:async ({runId,role,container,target})=>{
      identityNumber++;
      const objectId=`10000000-0000-4000-8000-${String(identityNumber).padStart(12,'0')}`;
      const identity={objectId,clientId:`20000000-0000-4000-8000-${String(identityNumber).padStart(12,'0')}`,
        resourceId:`/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${role}-${identityNumber}`,
        runId,role,created:true,createdAt:nextTime(),accessReview:{runId,principalId:objectId,container,
          complete:true,includesInherited:true,httpStatus:200,readMethod:'azure_role_assignments_effective_snapshot',
          observerPrincipalId:'50000000-0000-4000-8000-000000000001',evidenceReference:`https://evidence.example.test/rbac/${role}`,
          effectiveRoleAssignments:['source','cleanup'].includes(role)?[{assignmentId:`/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/60000000-0000-4000-8000-${String(identityNumber).padStart(12,'0')}`,
            roleDefinitionId:'ba92f5b4-2d11-453d-a403-e96b0029c9fe',scope:target.resourceId,principalId:objectId},
            ...(overbroadSource&&role==='source'?[{assignmentId:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/60000000-0000-4000-8000-000000000099',
              roleDefinitionId:'2a2b9908-6ea1-4ae2-8e65-a410df84e7d1',scope:target.resourceId.split('/providers/Microsoft.Storage/')[0],principalId:objectId}]:[])]:
            probeHasReadRole&&role==='probe'?[{assignmentId:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/60000000-0000-4000-8000-000000000098',
              roleDefinitionId:'2a2b9908-6ea1-4ae2-8e65-a410df84e7d1',scope:target.resourceId,principalId:objectId}]:[],
          snapshotFingerprint:`sha256:${'b'.repeat(64)}`,observedAt:nextTime()}};
      identities.set(objectId,identity); events.push(`identity:${role}`);return identity;
    },
    evaluateEffectiveAccess:async ({identity,runId,container,targetResourceId})=>({
      status:'complete',runId,principalId:identity.objectId,container,resourceId:targetResourceId,
      source:'azure_live_effective_access_evaluator_v1',httpStatus:200,readOnly:true,
      observerPrincipalId:'50000000-0000-4000-8000-000000000003',
      evidenceReference:`https://evidence.example.test/effective-access/${identity.role}`,
      snapshotFingerprint:`sha256:${'d'.repeat(64)}`,observedAt:nextTime(),
      inheritanceResolved:true,groupMembershipsResolved:true,customRolesResolved:true,dataActionsResolved:true,
      indirectCredentialPathsResolved:true,unknownRoleDefinitions:unknownRole?['custom-unknown-role']:[],
      hasBlobRead:['source','cleanup'].includes(identity.role)||(identity.role==='probe'&&probeHasReadRole),
      hasBlobWrite:['source','cleanup'].includes(identity.role),effectiveAssignments:[]
    }),
    deleteIdentity:async ({identity})=>({deleted:true,objectId:identity.objectId,roleAssignmentsRemoved:true,deletedAt:nextTime()}),
    createGroup:async ({runId,phase,identity})=>{
      groupNumber++;const name=`thesis-aci-p1-${String(groupNumber).padStart(24,'0')}`;
      const resolvedName=duplicateGroups&&groupNumber>1?'thesis-aci-p1-000000000000000000000001':name;
      const result={name:resolvedName,resourceId:`/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.ContainerInstance/containerGroups/${resolvedName}`,
        privateIp:`10.48.13.${groupNumber}`,identityObjectId:identity.objectId,ready:true,createdAt:nextTime()};
      groups.set(name,result);events.push(`group:${phase}`);return result;
    },
    deleteGroup:async ({group})=>{
      events.push(`delete:${group.name}`);
      if(failCleanup) return {deleted:false,name:group.name};
      groups.delete(group.name);
      return {deleted:true,name:group.name,absentAt:nextTime()};
    },
    observeGroup:async ({group})=>({state:groups.has(group.name)?'Running':'Absent',name:group.name,
      identityObjectId:group.identityObjectId,observedAt:nextTime()}),
    targetForMarker:async ({container})=>({resourceId:containerId(container),objectUri:objectUri(container)}),
    seedMarker:async ({trial,group,identity,container,target})=>{
      events.push('seed');
      return {runId:trial.runId,container,statusCode:201,principalId:identity.objectId,resourceId:target.resourceId,objectUri:target.objectUri,
        requestId:`seed-request-${++requestNumber}-long`,startedAt:nextTime(),markerFingerprint};
    },
    readMarker:async ({container})=>({matched:true,markerFingerprint,verifierPrincipalId:'30000000-0000-4000-8000-000000000001',
      verifierAccessReview:{runId,principalId:'30000000-0000-4000-8000-000000000001',container,complete:true,includesInherited:true,
        httpStatus:200,readMethod:'azure_role_assignments_effective_snapshot',observerPrincipalId:'50000000-0000-4000-8000-000000000002',
        evidenceReference:'https://evidence.example.test/rbac/verifier',snapshotFingerprint:`sha256:${'c'.repeat(64)}`,
        observedAt:nextTime(),effectiveRoleAssignments:[{assignmentId:'/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/60000000-0000-4000-8000-000000000002',
          roleDefinitionId:'2a2b9908-6ea1-4ae2-8e65-a410df84e7d1',scope:containerId(container),principalId:'30000000-0000-4000-8000-000000000001'}]},
      verifierEffectiveAccess:{status:'complete',runId,principalId:'30000000-0000-4000-8000-000000000001',container,
        resourceId:containerId(container),source:'azure_live_effective_access_evaluator_v1',httpStatus:200,readOnly:true,
        observerPrincipalId:'50000000-0000-4000-8000-000000000004',evidenceReference:'https://evidence.example.test/effective-access/verifier',
        snapshotFingerprint:`sha256:${'e'.repeat(64)}`,observedAt:nextTime(),inheritanceResolved:true,
        groupMembershipsResolved:true,customRolesResolved:true,dataActionsResolved:true,indirectCredentialPathsResolved:true,
        unknownRoleDefinitions:[],hasBlobRead:true,hasBlobWrite:false,effectiveAssignments:[]},
      resourceId:containerId(container),objectUri:objectUri(container),requestId:`readback-request-${++requestNumber}-long`,startedAt:nextTime()}),
    attemptRead:async ({trial,group,identity})=>{
      events.push(`probe:${trial.scenario}`);
      return {runId:trial.runId,container:trial.scenario==='U6'?'session-b':'prior-session',
        statusCode:probeStatus,principalId:identity.objectId,resourceId:containerId(trial.scenario==='U6'?'session-b':'prior-session'),
        objectUri:objectUri(trial.scenario==='U6'?'session-b':'prior-session'),requestId:`probe-request-${++requestNumber}-long`,
        startedAt:nextTime(),groupName:group.name,sourceGroupActiveAtProbe:scenario==='U6',
        ...(probeStatus===200?{markerFingerprint}:{errorCode:'AuthorizationPermissionMismatch'})};
    },
    deleteMarker:async ({trial,container,target,identity})=>{
      events.push('marker-delete');
      return {runId:trial.runId,container,resourceId:target.resourceId,objectUri:target.objectUri,
        removed:!failMarkerCleanup,statusCode:202,principalId:identity.objectId,
        requestId:`delete-marker-${++requestNumber}-long`,startedAt:nextTime()};
    },
    readAudit:async ({requestId,principalId,resourceId,objectUri})=>[{
      clientRequestId:requestId,principalId,resourceId,
      objectUri,operation:requestId.startsWith('seed-request-')?'PutBlob':requestId.startsWith('delete-marker-')?'DeleteBlob':'GetBlob',
      statusCode:requestId.startsWith('seed-request-')?201:requestId.startsWith('readback-request-')?200:
        requestId.startsWith('delete-marker-')?202:probeStatus,
      runId,time:oldAudit?'1990-01-01T00:00:00.000Z':nextTime()}],
    now:()=>Date.parse('2026-11-04T12:30:10.000Z')
  });
  return {runner,events};
}

test('candidate U6 requires verified method approval and independent active-group observation',async()=>{
  const denied=harness({approve:false});
  await assert.rejects(denied.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'}),/method approval could not be independently verified/);
  assert.deepEqual(denied.events,[]);
  const pass=harness();
  const result=await pass.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'});
  assert.equal(result.classification,'confirmed_resource_denial');
  assert.equal(result.evidence.equivalence,'not_claimed');
  assert.ok(pass.events.indexOf('group:probe')>pass.events.indexOf('group:source'));
  assert.equal(pass.events.filter(event=>event.startsWith('delete:')).length,2);
});

test('candidate U8 retires the source group before creating a fresh probe identity/group',async()=>{
  const {runner,events}=harness({scenario:'U8'});
  const result=await runner({runId,scenario:'U8',deployment:'azure_container_instances',profile:'P1'});
  assert.equal(result.classification,'confirmed_resource_denial');
  assert.ok(events.indexOf('delete:thesis-aci-p1-000000000000000000000001')<events.indexOf('group:fresh_probe'));
  assert.equal(result.evidence.sourceRetiredAt!==null,true);
});

test('exact correlated read of the marker is classified as unauthorized success',async()=>{
  const {runner}=harness({probeStatus:200});
  const result=await runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'});
  assert.equal(result.classification,'unauthorized_success');
});

test('ambiguous cleanup downgrades an otherwise verified outcome to indeterminate',async()=>{
  const {runner}=harness({failCleanup:true});
  const result=await runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'});
  assert.equal(result.classification,'indeterminate');
  assert.equal(result.evidence.cleanupComplete,false);
});

test('marker must be removed and exact DeleteBlob audit must be observed before row remains classified',async()=>{
  const good=harness();
  const result=await good.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'});
  assert.equal(result.classification,'confirmed_resource_denial');
  assert.equal(result.evidence.observations.markerDelete.statusCode,202);
  assert.ok(good.events.indexOf('marker-delete')>good.events.indexOf('probe:U6'));
  const failed=harness({failMarkerCleanup:true});
  const failedResult=await failed.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'});
  assert.equal(failedResult.classification,'indeterminate');
  assert.equal(failedResult.evidence.cleanupComplete,false);
});

test('duplicate ACI groups and out-of-window audit records cannot produce a verdict',async()=>{
  const duplicate=harness({duplicateGroups:true});
  await assert.rejects(duplicate.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'}),error=>
    /indeterminate/.test(error.message)&&/distinct names and resource IDs/.test(error.partialEvidence?.reason)&&
    Array.isArray(error.partialEvidence?.events));
  const stale=harness({oldAudit:true});
  await assert.rejects(stale.runner({runId,scenario:'U8',deployment:'azure_container_instances',profile:'P1'}),/inspect preserved evidence/);
});

test('overbroad source roles and unresolved custom roles fail closed; a probe grant is recorded separately',async()=>{
  const broadSource=harness({overbroadSource:true});
  await assert.rejects(broadSource.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'}),error=>
    /only a container-scoped/.test(error.partialEvidence?.reason));
  const unknown=harness({unknownRole:true});
  await assert.rejects(unknown.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'}),error=>
    /effective access is not completely resolved/.test(error.partialEvidence?.reason));
  const probeGranted=harness({probeHasReadRole:true,probeStatus:403});
  const result=await probeGranted.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'});
  assert.equal(result.classification,'indeterminate');
  assert.equal(result.evidence.permissionBaseline.probeHadEffectiveBlobReadRole,true);
});

test('a run ID cannot be replayed and identity separation is mandatory',async()=>{
  const state=harness();
  await state.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'});
  await assert.rejects(state.runner({runId,scenario:'U6',deployment:'azure_container_instances',profile:'P1'}),/already claimed/);
  await assert.rejects(harness().runner({runId:'bad/run',scenario:'U8',deployment:'azure_container_instances',profile:'P1'}),/invalid ACI session analogue trial/);
});
