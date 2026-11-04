import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runLiveDeploymentSmoke} from './live-deployment-smoke.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'live-smoke-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const raw=JSON.parse(await readFile(new URL('../config/experiment.example.json',import.meta.url),'utf8'));
  raw.deployments.azure_vm.agentUrl='https://vm.example.test';
  raw.deployments.azure_vm.resourceUrl='https://resource.example.test';
  raw.deployments.azure_vm.collectorUrl='https://collector.example.test';
  raw.deployments.azure_functions_flex.resourceUrl='https://fn-resource.example.test';
  raw.deployments.azure_functions_flex.collectorUrl='https://fn-collector.example.test';
  for(const route of raw.routes.filter(route=>route.deployment==='azure_functions_flex'))
    route.agentUrl=`https://${route.profile.toLowerCase()}-functions.example.test/api`;
  const configPath=join(directory,'experiment.json');
  await writeFile(configPath,JSON.stringify(raw));
  const env={};
  for(const route of raw.routes) for(const variable of Object.values(route.credentials)) env[variable]=`secret-${variable}`;
  return {configPath,env};
}

function mockFetch(calls) {
  return async (url,options={})=>{
    const parsed=new URL(url);
    calls.push({method:options.method??'GET',host:parsed.host,path:parsed.pathname,headers:options.headers??{}});
    if(parsed.pathname.endsWith('/health')) return new Response(JSON.stringify({ready:true}),{status:200});
    if(parsed.pathname.endsWith('/network-probe')) {
      const p3=String(options.headers?.['x-trial-key']).includes('THESIS_FN_P3');
      return new Response(JSON.stringify({
        approved:{http:{transport:'response',status:200}},
        restricted:{directSocket:{transport:p3?'error':'connected'}},
        conclusion:'indeterminate_without_independent_enforcer_evidence'
      }),{status:200});
    }
    return new Response('{}',{status:404});
  };
}

test('live smoke uses only health and diagnostic probes and never claims study readiness',async t=>{
  const {configPath,env}=await fixture(t),calls=[];
  const report=await runLiveDeploymentSmoke({configPath,env,fetchImpl:mockFetch(calls)});
  assert.equal(report.kind,'non_trial_deployment_smoke');
  assert.equal(report.status,'blocked');
  assert.equal(report.connectivityStatus,'pass');
  assert.equal(report.measuredTrialsExecuted,0);
  assert.equal(report.checks.filter(check=>check.name==='azure_functions_flex:P1' || check.name==='azure_functions_flex:P2' || check.name==='azure_functions_flex:P3').length,3);
  assert.deepEqual(calls.filter(call=>call.path.endsWith('/network-probe')).map(call=>call.host),[
    'p1-functions.example.test','p2-functions.example.test','p3-functions.example.test']);
  assert.equal(report.checks.find(check=>check.name==='route_identity_binding').status,'blocked');
  assert.equal(report.checks.find(check=>check.name==='independent_enforcement_evidence').status,'blocked');
  assert.ok(calls.every(call=>call.method==='GET'||call.path.endsWith('/network-probe')));
  assert.ok(calls.every(call=>!call.path.endsWith('/run')&&!call.path.includes('/reset')));
  assert.ok(!JSON.stringify(report).includes('secret-'));
});

test('missing route credentials are named but values are never exposed or used',async t=>{
  const {configPath,env}=await fixture(t),calls=[];
  delete env.THESIS_FN_P1_CONTROLLER_KEY;
  const report=await runLiveDeploymentSmoke({configPath,env,fetchImpl:mockFetch(calls)});
  const creds=report.checks.find(check=>check.name==='route_credentials');
  assert.equal(creds.status,'blocked');
  assert.deepEqual(creds.missingVariableNames,['THESIS_FN_P1_CONTROLLER_KEY']);
  assert.ok(!calls.some(call=>call.path.endsWith('/network-probe')&&call.headers['x-trial-key']===undefined));
  assert.ok(!JSON.stringify(report).includes('secret-'));
});
