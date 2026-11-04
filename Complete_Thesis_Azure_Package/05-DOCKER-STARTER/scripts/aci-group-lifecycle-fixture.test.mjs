import test from 'node:test';
import assert from 'node:assert/strict';
import {aciLifecycleFixtureGroupName,createAciGroupLifecycleFixture} from './aci-group-lifecycle-fixture.mjs';

const mainIdentityFingerprint='a'.repeat(64);
const otherIdentityFingerprint='b'.repeat(64);
function trial(scenario,runId='lifecycle-test-1') {
  return {scenario,runId,profile:'P1',mainGroupName:`thesis-aci-p1-${'c'.repeat(24)}`,mainIdentityFingerprint};
}
function setup({scenario='U6',identityFingerprint=otherIdentityFingerprint,observeOverride,observationTimeoutMs=30}={}) {
  const events=[];
  const live=new Map();
  const groupClient={
    create:async(name,body)=>{events.push(`create:${name}`);live.set(name,identityFingerprint);return {provisioningState:'Failed',rawSecret:'must-not-be-returned'};},
    delete:async name=>{events.push(`delete:${name}`);live.delete(name);return {deleted:false,rawSecret:'must-not-be-returned'};}
  };
  const observeGroup=observeOverride??(async({groupName})=>{
    events.push(`observe:${live.has(groupName)?'present':'absent'}:${groupName}`);
    const found=live.get(groupName);
    return {groupName,state:found?'present':'absent',...(found?{identityFingerprint:found}:{}),observedAt:new Date().toISOString(),rawSecret:'must-not-be-returned'};
  });
  const fixture=createAciGroupLifecycleFixture({groupClient,observeGroup,
    groupBodyForFixture:async({groupName,role})=>{
      events.push(`body:${role}:${groupName}`);
      return {body:{environmentVariables:[{name:'TRIAL_REQUEST_KEY',secureValue:'raw-secret'}]},identityFingerprint};
    },
    now:(()=>{let second=0;return()=>new Date(Date.UTC(2026,0,1,0,0,second++));})(),sleep:async()=>{},pollIntervalMs:1,observationTimeoutMs});
  return {fixture,events,live};
}

test('U6 keeps a distinct fixture group active through main execution and retires only after collection',async()=>{
  const {fixture,events,live}=setup();
  const input=trial('U6');
  const prepared=await fixture.prepareU6(input);
  assert.equal(prepared.state,'fixture_active_for_main_trial');
  assert.equal(prepared.observations.fixtureCreated.state,'present');
  assert.notEqual(prepared.fixtureGroup.identityFingerprint,prepared.mainGroup.identityFingerprint);
  assert.ok(live.has(prepared.fixtureGroup.name));
  await assert.rejects(fixture.completeU6AfterCollection(input,{collectionCompleted:true}),/verified active observation/);
  await assert.rejects(fixture.confirmU6ActiveThroughMainTrial(input),/must follow main trial completion/);
  const active=await fixture.confirmU6ActiveThroughMainTrial(input,{mainTrialCompleted:true});
  assert.equal(active.observations.activeAfterMainTrial.state,'present');
  assert.ok(live.has(active.fixtureGroup.name));
  await assert.rejects(fixture.completeU6AfterCollection(input,{collectionCompleted:false}),/completed collection/);
  const completed=await fixture.completeU6AfterCollection(input,{collectionCompleted:true});
  assert.equal(completed.state,'fixture_retired_after_collection');
  assert.equal(completed.observations.fixtureRetired.state,'absent');
  assert.ok(!live.has(completed.fixtureGroup.name));
  assert.ok(events.findIndex(e=>e.startsWith('delete:'))>events.findIndex(e=>e.startsWith('observe:present:')));
  assert.doesNotMatch(JSON.stringify(completed),/raw-secret|TRIAL_REQUEST_KEY|secureValue/);
});

test('U8 retires the prior group independently before invoking fresh main-group creation',async()=>{
  const {fixture,events,live}=setup({scenario:'U8'});
  const input=trial('U8','lifecycle-test-2');
  let mainCreated=false;
  const evidence=await fixture.prepareU8BeforeMain(input,{createMainGroup:async descriptor=>{
    events.push(`main:${descriptor.name}`);
    assert.ok(!live.has(aciLifecycleFixtureGroupName(input.runId,'U8')));
    assert.ok(events.some(e=>e===`observe:absent:${aciLifecycleFixtureGroupName(input.runId,'U8')}`));
    mainCreated=true;
    return {rawSecret:'main-secret'};
  }});
  assert.equal(mainCreated,true);
  assert.equal(evidence.state,'prior_fixture_retired_before_main_group');
  assert.equal(evidence.observations.fixtureCreated.state,'present');
  assert.equal(evidence.observations.fixtureRetired.state,'absent');
  assert.ok(Number.isFinite(Date.parse(evidence.observations.fixtureRetired.observedAt)));
  assert.ok(evidence.timestamps.mainGroupCreateCallbackCompletedAt>evidence.timestamps.fixtureDeleteRequestedAt);
  assert.doesNotMatch(JSON.stringify(evidence),/raw-secret|main-secret|secureValue/);
  assert.ok(events.indexOf(`delete:${evidence.fixtureGroup.name}`)<events.findIndex(e=>e.startsWith('main:')));
});

test('fixture identity must be distinct from the main-group identity and independently observed',async()=>{
  const same=setup({identityFingerprint:mainIdentityFingerprint});
  // The fixture lifecycle intentionally sanitizes internal setup errors so
  // identity details from a failed cloud operation are not returned to callers.
  await assert.rejects(same.fixture.prepareU6(trial('U6','same-id')),/sanitized lifecycle state/);

  const bad=setup({observationTimeoutMs:2,observeOverride:async({groupName})=>({groupName,state:'present',identityFingerprint:'f'.repeat(64),observedAt:new Date().toISOString()})});
  await assert.rejects(bad.fixture.prepareU6(trial('U6','wrong-observer')),/sanitized lifecycle state/);
});

test('U8 requires explicit sequencing callback and validates fixture names/scenarios',async()=>{
  const {fixture}=setup({scenario:'U8'});
  await assert.rejects(fixture.prepareU8BeforeMain(trial('U8','no-callback')),/main-group creation callback/);
  assert.throws(()=>aciLifecycleFixtureGroupName('unsafe/run','U6'),/invalid ACI lifecycle fixture identity/);
  await assert.rejects(fixture.prepareU6(trial('U8','wrong-scenario')),/invalid U6 ACI lifecycle trial/);
});
