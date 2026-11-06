import assert from 'node:assert/strict';
import test from 'node:test';

import {readAgentEndpoints} from '../dist/agent-config.js';

test('U7 configuration requires a dedicated restricted-service URL',()=>{
  assert.throws(()=>readAgentEndpoints({RESEARCH_URL:'https://research.example',COLLECTOR_URL:'https://collector.example'},
    {requireRestricted:true}),/RESTRICTED_URL is required/);
});

test('non-U7 agent startup may omit the restricted-service URL',()=>{
  const endpoints=readAgentEndpoints({RESEARCH_URL:'https://research.example',COLLECTOR_URL:'https://collector.example'});
  assert.deepEqual(endpoints,{resourceUrl:'https://research.example',collectorUrl:'https://collector.example',restrictedUrl:undefined});
});

test('agent configuration allows local smoke endpoints while retaining separate service targets',()=>{
  const endpoints=readAgentEndpoints({RESEARCH_URL:'http://127.0.0.1:9000',COLLECTOR_URL:'http://127.0.0.1:9001',
    RESTRICTED_URL:'http://127.0.0.1:9002'});
  assert.deepEqual(endpoints,{resourceUrl:'http://127.0.0.1:9000',collectorUrl:'http://127.0.0.1:9001',
    restrictedUrl:'http://127.0.0.1:9002'});
});

test('workload token resolves from the direct local value or an injected managed secret reader',async()=>{
  const {resolveWorkloadTokenFromEnvironment}=await import('../dist/agent-config.js');
  assert.equal(typeof resolveWorkloadTokenFromEnvironment,'function');
  assert.equal(await resolveWorkloadTokenFromEnvironment({WORKLOAD_TOKEN:'local-synthetic-token'}),'local-synthetic-token');
  const env={THESIS_WORKLOAD_TOKEN_SECRET_URI:'https://example.vault.azure.net/secrets/p1-token',
    THESIS_SECRET_READER_CLIENT_ID:'00000000-0000-4000-8000-000000000001'};
  let seen;
  const value=await resolveWorkloadTokenFromEnvironment(env,{readSecret:async(uri,options)=>{
    seen={uri,options};return 'synthetic-keyvault-token';
  }});
  assert.equal(value,'synthetic-keyvault-token');
  assert.deepEqual(seen,{uri:env.THESIS_WORKLOAD_TOKEN_SECRET_URI,options:{clientId:env.THESIS_SECRET_READER_CLIENT_ID}});
});

test('workload token resolver refuses ambiguous or missing secret sources and multiline values',async()=>{
  const {resolveWorkloadTokenFromEnvironment}=await import('../dist/agent-config.js');
  assert.equal(typeof resolveWorkloadTokenFromEnvironment,'function');
  await assert.rejects(()=>resolveWorkloadTokenFromEnvironment({}),/WORKLOAD_TOKEN or THESIS_WORKLOAD_TOKEN_SECRET_URI is required/);
  await assert.rejects(()=>resolveWorkloadTokenFromEnvironment({WORKLOAD_TOKEN:'a',THESIS_WORKLOAD_TOKEN_SECRET_URI:'https://example.vault.azure.net/secrets/x'}),/choose one/);
  await assert.rejects(()=>resolveWorkloadTokenFromEnvironment({WORKLOAD_TOKEN:'one\ntwo'}),/invalid/);
  await assert.rejects(()=>resolveWorkloadTokenFromEnvironment({THESIS_WORKLOAD_TOKEN_SECRET_URI:'https://example.vault.azure.net/secrets/x'},
    {readSecret:async()=>''}),/invalid/);
});

test('agent configuration rejects a nonlocal restricted endpoint that aliases the collector host',()=>{
  assert.throws(()=>readAgentEndpoints({RESEARCH_URL:'https://research.example',COLLECTOR_URL:'https://shared.example',
    RESTRICTED_URL:'https://shared.example'}),/separate host/);
});
