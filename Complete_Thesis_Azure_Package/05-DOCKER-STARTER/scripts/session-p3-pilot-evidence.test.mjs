import {test} from 'node:test';
import assert from 'node:assert/strict';
import {correlateSessionP3Probe} from './session-p3-pilot-evidence.mjs';

const probe={mode:'non_counted_pilot',runId:'pilot-session-p3-u5-1',startedAt:'2026-11-05T10:00:00Z',finishedAt:'2026-11-05T10:00:10Z',sourceIp:'10.0.0.4',sourcePort:4123,destinationIp:'10.0.1.5',destinationPort:8443,protocol:'TCP',expectedRule:'deny-collector'};
const event={timeGenerated:'2026-11-05T10:00:05Z',sourceIp:'10.0.0.4',sourcePort:4123,destinationIp:'10.0.1.5',destinationPort:8443,protocol:'TCP',action:'Deny',ruleName:'deny-collector'};
test('matches only an exact named deny in the bounded run window',()=>{
  assert.equal(correlateSessionP3Probe(probe,[event]).verdict,'matching_deny_rows');
  for(const row of [{...event,sourcePort:4124},{...event,destinationIp:'10.0.1.6'},
    {...event,action:'Allow'},{...event,ruleName:'other'},{...event,timeGenerated:'2026-11-05T10:00:11Z'}])
    assert.equal(correlateSessionP3Probe(probe,[row]).verdict,'no_matching_deny_rows');
});
test('refuses broad or malformed attribution and cannot enable a measured run',()=>{
  for(const p of [{...probe,mode:'measured'},{...probe,sourceIp:'10.0.0.0/24'},
    {...probe,sourcePort:0},{...probe,expectedRule:''},{...probe,finishedAt:'2026-11-05T10:03:00Z'}])
    assert.throws(()=>correlateSessionP3Probe(p,[event]));
  assert.equal(correlateSessionP3Probe(probe,[event]).measuredExecutionEnabled,false);
});
