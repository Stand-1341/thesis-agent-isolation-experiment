import {createHash} from 'node:crypto';

const IDENTITY_FINGERPRINT=/^[a-f0-9]{64}$/i;
const RUN_ID=/^[A-Za-z0-9_-]{1,150}$/;
const GROUP_NAME=/^[a-z0-9-]{3,63}$/;

function timestamp(now) {
  const value=now();
  const date=value instanceof Date?value:new Date(value);
  if(!Number.isFinite(date.getTime())) throw new Error('invalid lifecycle clock');
  return date.toISOString();
}

export function aciLifecycleFixtureGroupName(runId,scenario) {
  if(!RUN_ID.test(runId||'') || !['U6','U8'].includes(scenario)) throw new Error('invalid ACI lifecycle fixture identity');
  const digest=createHash('sha256').update(`${scenario}\0${runId}`).digest('hex').slice(0,24);
  return `thesis-aci-fixture-${scenario.toLowerCase()}-${digest}`;
}

/**
 * Creates the separate disposable group used by the ACI cross-group analogue.
 * `observeGroup` must be an independently credentialed reader and return
 * {groupName,state:'present'|'absent',identityFingerprint?,observedAt}.
 * The create/delete response bodies are intentionally ignored.
 */
export function createAciGroupLifecycleFixture({groupClient,groupBodyForFixture,observeGroup,
  now=()=>new Date(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  observationTimeoutMs=30000,pollIntervalMs=500}) {
  if(!groupClient || typeof groupClient.create!=='function' || typeof groupClient.delete!=='function' ||
    typeof groupBodyForFixture!=='function' || typeof observeGroup!=='function') throw new Error('invalid ACI lifecycle fixture configuration');
  if(!Number.isInteger(observationTimeoutMs)||observationTimeoutMs<1||observationTimeoutMs>120000 ||
    !Number.isInteger(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>10000 || typeof now!=='function' || typeof sleep!=='function')
    throw new Error('invalid ACI lifecycle fixture timing');

  const records=new Map();
  function validateTrial(trial,scenario) {
    if(trial?.scenario!==scenario || !RUN_ID.test(trial?.runId||'') || !['P1','P2'].includes(trial?.profile) ||
      !GROUP_NAME.test(trial?.mainGroupName||'') || !IDENTITY_FINGERPRINT.test(trial?.mainIdentityFingerprint||''))
      throw new Error(`invalid ${scenario} ACI lifecycle trial`);
    const name=aciLifecycleFixtureGroupName(trial.runId,scenario);
    if(name===trial.mainGroupName) throw new Error('fixture and main ACI groups must be distinct');
    return {runId:trial.runId,scenario,profile:trial.profile,mainGroupName:trial.mainGroupName,
      mainIdentityFingerprint:trial.mainIdentityFingerprint.toLowerCase(),name};
  }
  function evidenceFor(record) {
    return {
      schema:'aci-cross-group-lifecycle/v1',
      runId:record.runId,
      scenario:record.scenario,
      state:record.state,
      fixtureGroup:{name:record.name,identityFingerprint:record.identityFingerprint},
      mainGroup:{name:record.mainGroupName,identityFingerprint:record.mainIdentityFingerprint},
      timestamps:{...record.timestamps},
      observations:{...record.observations}
    };
  }
  async function observeUntil(record,wanted) {
    const deadline=Date.now()+observationTimeoutMs;
    let last;
    while(Date.now()<=deadline) {
      try {
        const raw=await observeGroup({groupName:record.name});
        if(raw?.groupName!==record.name || !['present','absent'].includes(raw?.state) ||
          typeof raw.observedAt!=='string' || !Number.isFinite(Date.parse(raw.observedAt)))
          throw new Error('invalid independent group observation');
        if(raw.state===wanted) {
          if(wanted==='present' && raw.identityFingerprint?.toLowerCase()!==record.identityFingerprint)
            throw new Error('independent group identity mismatch');
          return {state:wanted,observedAt:new Date(raw.observedAt).toISOString()};
        }
        last=raw.state;
      } catch(error) {
        if(error?.message==='independent group identity mismatch' || error?.message==='invalid independent group observation') throw error;
        // Reader availability errors are retried until the bounded deadline.
      }
      if(Date.now()<deadline) await sleep(Math.min(pollIntervalMs,Math.max(1,deadline-Date.now())));
    }
    throw new Error(`independent ACI group ${wanted} observation timed out${last?` (last=${last})`:''}`);
  }
  async function createAndObserve(record) {
    if(record.identityFingerprint) throw new Error('ACI lifecycle fixture already prepared');
    const prepared=await groupBodyForFixture({
      trial:{runId:record.runId,scenario:record.scenario,profile:record.profile},
      groupName:record.name,
      role:record.scenario==='U6'?'other_active_group':'prior_group',
      mainGroupName:record.mainGroupName,
      mainIdentityFingerprint:record.mainIdentityFingerprint
    });
    if(!prepared || typeof prepared.body!=='object' || prepared.body===null ||
      !IDENTITY_FINGERPRINT.test(prepared.identityFingerprint||'')) throw new Error('ACI fixture body must provide a hashed identity fingerprint');
    record.identityFingerprint=prepared.identityFingerprint.toLowerCase();
    if(record.identityFingerprint===record.mainIdentityFingerprint) throw new Error('ACI fixture identity must differ from main-group identity');
    record.timestamps.fixtureCreateRequestedAt=timestamp(now);
    try { await groupClient.create(record.name,prepared.body); } catch { /* independently reconcile below */ }
    try {
      record.observations.fixtureCreated=await observeUntil(record,'present');
      record.state='fixture_present';
    } catch {
      await retireAndObserve(record).catch(()=>{});
      throw new Error('ACI fixture group presence and identity were not independently verified');
    }
  }
  async function retireAndObserve(record) {
    if(!record.identityFingerprint) throw new Error('ACI lifecycle fixture identity is unavailable');
    record.timestamps.fixtureDeleteRequestedAt=timestamp(now);
    try { await groupClient.delete(record.name); } catch { /* independently reconcile below */ }
    try {
      record.observations.fixtureRetired=await observeUntil(record,'absent');
      record.state='fixture_absent';
    } catch {
      throw new Error('ACI fixture group absence was not independently verified');
    }
  }
  function getRecord(runId,scenario) {
    const record=records.get(`${scenario}:${runId}`);
    if(!record) throw new Error('ACI lifecycle fixture is not prepared');
    return record;
  }

  return Object.freeze({
    async prepareU6(trial) {
      const identity=validateTrial(trial,'U6'),key=`U6:${identity.runId}`;
      if(records.has(key)) throw new Error('ACI lifecycle fixture run ID already claimed');
      const record={...identity,scenario:'U6',identityFingerprint:null,state:'creating_fixture',timestamps:{},observations:{}};
      records.set(key,record);
      try {
        await createAndObserve(record);
        record.state='fixture_active_for_main_trial';
        return evidenceFor(record);
      } catch {
        records.delete(key);
        throw new Error('ACI U6 lifecycle fixture preparation failed; see sanitized lifecycle state');
      }
    },

    async confirmU6ActiveThroughMainTrial(trial,{mainTrialCompleted}={}) {
      const identity=validateTrial(trial,'U6'),record=getRecord(identity.runId,'U6');
      if(record.state!=='fixture_active_for_main_trial') throw new Error('U6 fixture group is not active for the main trial');
      if(mainTrialCompleted!==true) throw new Error('U6 active observation must follow main trial completion');
      record.observations.activeAfterMainTrial=await observeUntil(record,'present');
      record.timestamps.mainTrialObservedAt=timestamp(now);
      return evidenceFor(record);
    },

    async completeU6AfterCollection(trial,{collectionCompleted}={}) {
      const identity=validateTrial(trial,'U6'),record=getRecord(identity.runId,'U6');
      if(record.state!=='fixture_active_for_main_trial' || collectionCompleted!==true || !record.observations.activeAfterMainTrial)
        throw new Error('U6 fixture cleanup requires a verified active observation after main trial and completed collection');
      record.timestamps.collectionCompletedAt=timestamp(now);
      await retireAndObserve(record);
      record.timestamps.cleanupConfirmedAt=timestamp(now);
      record.state='fixture_retired_after_collection';
      return evidenceFor(record);
    },

    async abortU6(trial) {
      const identity=validateTrial(trial,'U6'),record=getRecord(identity.runId,'U6');
      if(record.state!=='fixture_active_for_main_trial') throw new Error('U6 fixture group is not active for abort cleanup');
      await retireAndObserve(record);
      record.timestamps.cleanupConfirmedAt=timestamp(now);
      record.state='fixture_retired_after_abort';
      return evidenceFor(record);
    },

    async prepareU8BeforeMain(trial,{createMainGroup}={}) {
      const identity=validateTrial(trial,'U8'),key=`U8:${identity.runId}`;
      if(records.has(key)) throw new Error('ACI lifecycle fixture run ID already claimed');
      if(typeof createMainGroup!=='function') throw new Error('U8 requires a main-group creation callback');
      const record={...identity,scenario:'U8',identityFingerprint:null,state:'creating_prior_fixture',timestamps:{},observations:{}};
      records.set(key,record);
      try {
        await createAndObserve(record);
        await retireAndObserve(record);
        record.timestamps.mainGroupCreateRequestedAt=timestamp(now);
        await createMainGroup({name:record.mainGroupName,identityFingerprint:record.mainIdentityFingerprint});
        record.timestamps.mainGroupCreateCallbackCompletedAt=timestamp(now);
        record.state='prior_fixture_retired_before_main_group';
        return evidenceFor(record);
      } catch {
        if(record.identityFingerprint && record.state!=='fixture_absent') await retireAndObserve(record).catch(()=>{});
        records.delete(key);
        throw new Error('U8 prior-group lifecycle or sequenced main-group creation failed');
      }
    }
  });
}
