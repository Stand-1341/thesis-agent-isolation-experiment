import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {runAcaJobsNoopBaselineCli,firewallApplicationRuleCensusQuery,
  createBaselineFirewallReader} from './aca-jobs-noop-baseline-cli.mjs';
import {BASELINE_STATUS} from './aca-jobs-noop-baseline.mjs';
import {validateExperimentConfig} from './experiment-config.mjs';

// ---------------------------------------------------------------------------
// Fixtures: the same validated config shape deps-live.test.mjs builds for the
// ACA Jobs arm, a client double matching the harness tests, and a Log
// Analytics query double that dispatches on the KQL shape.

const guid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const uai=name=>`/subscriptions/${guid(100)}/resourceGroups/identity-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`;
const ACA_IMAGE='registry.example.com/thesis-agent@sha256:'+'0'.repeat(64);
const JOB_NAME='thesis-job-p3';
const EXECUTION_NAME='exec-1';
const EXECUTION_ID=`/subscriptions/${guid(100)}/resourceGroups/thesis-rg/providers/Microsoft.App/jobs/${JOB_NAME}/executions/${EXECUTION_NAME}`;
const START='2026-11-06T00:00:10Z';
const END='2026-11-06T00:00:20Z';
const T0='2026-11-06T00:00:10.000Z';
const T1='2026-11-06T00:00:20.000Z';
const SOURCE_CIDR='10.48.12.0/27';
const CONTROL_URL='https://Health.Example.com/status';
const CONTROL_HREF='https://health.example.com/status';
const CONTROL_FQDN='health.example.com';
const CANARY='raw-log-secret-token';

function baselineConfig() {
  const deployments={azure_container_apps_jobs:{kind:'aca_job',subscriptionId:guid(100),resourceGroup:'thesis-rg',
    workloadProfileName:'Consumption',
    jobNames:{P1:'thesis-job-p1',P2:'thesis-job-p2',P3:JOB_NAME},
    agentImage:ACA_IMAGE,imagePullIdentityResourceId:uai('jobs-image-pull'),
    resources:{cpu:0.25,memory:'0.5Gi'},
    resourceUrl:'https://resource.example.test',collectorUrl:'https://collector.example.test',
    restrictedUrl:'https://restricted.example.test',sessionDataStore:'azure_blob_external_namespace',
    apiVersion:'2026-07-01',executionTimeoutMs:120000,logWaitMs:600000}};
  const routes=[];
  let principal=1,workload=101,reader=201;
  for(const profile of ['P1','P2','P3'])
    routes.push({deployment:'azure_container_apps_jobs',profile,principalObjectId:guid(principal++),
      workloadClientId:guid(workload++),
      workloadIdentityResourceId:uai(`azure_container_apps_jobs-${profile}-workload`),
      secretReaderClientId:guid(reader++),
      secretReaderIdentityResourceId:uai(`azure_container_apps_jobs-${profile}-secret-reader`),
      workloadTokenSecretUri:'https://thesis-secrets.vault.azure.net/secrets/'+
        `azure-container-apps-jobs-${profile}-workload-token`,
      credentials:{resourceAdmin:'THESIS_AZURE_CONTAINER_APPS_JOBS_RESOURCE_ADMIN_KEY',
        collectorAdmin:'THESIS_AZURE_CONTAINER_APPS_JOBS_COLLECTOR_ADMIN_KEY'}});
  return validateExperimentConfig({evidenceDirectory:'results/aca-test',auditWindowSeconds:3600,deployments,routes},
    {requiredRoutes:['P1','P2','P3'].map(profile=>`azure_container_apps_jobs:${profile}`),
      requiredScenarios:['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2']});
}

function baselineEnv(extra={}) {
  return {THESIS_LOG_ANALYTICS_WORKSPACE_ID:guid(900),
    THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID:guid(301),
    THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID:guid(302),
    THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR:SOURCE_CIDR,
    THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT:'443',...extra};
}

function makeClient({status='Succeeded'}={}) {
  const starts=[];
  const client={
    async startJob(template,options) {
      starts.push({template,options});
      return {name:EXECUTION_NAME,id:EXECUTION_ID};
    },
    async waitForExecution() {
      return {name:EXECUTION_NAME,id:EXECUTION_ID,
        properties:{status,startTime:START,endTime:END}};
    }
  };
  return {client,starts};
}

/** Query double: the positive-control query carries `Fqdn =~`; the census does not. */
function makeQuery({censusRows=[],controlRows=[],censusError,controlError}={}) {
  const queries=[];
  const logQuery=async kql=>{
    queries.push(kql);
    const isControl=kql.includes('Fqdn =~');
    if(isControl) {
      if(controlError) throw controlError;
      return controlRows;
    }
    if(censusError) throw censusError;
    return censusRows;
  };
  return {logQuery,queries};
}

const CONTROL_ALLOW_ROW={TimeGenerated:'2026-11-06T00:00:15Z',SourceIp:'10.48.12.5',
  Fqdn:CONTROL_FQDN,TargetUrl:`${CONTROL_HREF}?sig=${CANARY}`,DestinationPort:443,
  Protocol:'https',Action:'Allow',Rule:'allow-health'};

const NOISY_ROW={TimeGenerated:'2026-11-06T00:00:18Z',SourceIp:'10.48.12.9',
  Fqdn:'telemetry.example.com',TargetUrl:`https://telemetry.example.com/v1?sig=${CANARY}`,
  DestinationPort:443,Protocol:'https',Action:'Allow',Rule:'platform-allow'};

const BASE_ARGS=['--non-counted-pilot','--control-url',CONTROL_URL];
const FIXED_NOW=()=>new Date('2026-11-06T00:00:00Z');

async function runCli({args=BASE_ARGS,env=baselineEnv(),config=baselineConfig(),inject={},status}={}) {
  const clientBundle=inject.clientBundle??makeClient({status});
  const queryBundle=inject.queryBundle
    ??makeQuery({controlRows:[CONTROL_ALLOW_ROW],...inject.queryOptions});
  const result=await runAcaJobsNoopBaselineCli({config,env,args,now:FIXED_NOW,
    inject:{jobsExecutionClient:clientBundle.client,logQuery:queryBundle.logQuery,
      ...(inject.writeFile?{writeFile:inject.writeFile}:{}),
      ...(inject.credentialModules?{credentialModules:inject.credentialModules}:{})}});
  return {...result,clientBundle,queryBundle};
}

// ---------------------------------------------------------------------------

test('the CLI is pilot-only: it refuses to run without the explicit acknowledgment',async()=>{
  const env=baselineEnv();
  const attempt=runCli({args:['--control-url',CONTROL_URL],env});
  await assert.rejects(attempt,/pilot-only.*--non-counted-pilot/s);
  const bundle=makeClient();
  const rejected=runAcaJobsNoopBaselineCli({config:baselineConfig(),env,args:['--control-url',CONTROL_URL],
    now:FIXED_NOW,inject:{jobsExecutionClient:bundle.client,logQuery:makeQuery().logQuery}});
  await assert.rejects(rejected,/pilot-only/);
  assert.equal(bundle.starts.length,0,'no ARM execution may start without the acknowledgment');
});

test('usage errors name the missing argument and reject unknown flags',async()=>{
  await assert.rejects(runCli({args:['--non-counted-pilot']}),/--control-url is required/);
  await assert.rejects(runAcaJobsNoopBaselineCli({env:baselineEnv(),
    args:['--non-counted-pilot','--control-url',CONTROL_URL],now:FIXED_NOW}),/--config is required/);
  await assert.rejects(runCli({args:['--non-counted-pilot','--control-url',CONTROL_URL,'--mode','measured']}),
    /unknown argument: --mode/);
  await assert.rejects(runCli({args:['--non-counted-pilot','--control-url','https://ok.example.test/',
    '--run-id-prefix','bad prefix!']}),/--run-id-prefix/);
});

test('the environment contract fails closed before any ARM execution',async()=>{
  const bundle=makeClient();
  const logQuery=makeQuery().logQuery;
  const config=baselineConfig();
  const invoke=env=>runAcaJobsNoopBaselineCli({config,env,args:BASE_ARGS,now:FIXED_NOW,
    inject:{jobsExecutionClient:bundle.client,logQuery}});
  for(const name of ['THESIS_LOG_ANALYTICS_WORKSPACE_ID','THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID',
    'THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID','THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR',
    'THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT']) {
    const stripped=baselineEnv();
    delete stripped[name];
    await assert.rejects(invoke(stripped),error=>{
      assert.match(error.message,new RegExp(name));
      return true;
    },`${name} must be named when missing`);
  }
  await assert.rejects(invoke(baselineEnv({THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID:'not-a-guid'})),
    /THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID must be a GUID/);
  await assert.rejects(invoke(baselineEnv({THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID:guid(302)})),
    /different identities/);
  await assert.rejects(invoke(baselineEnv({THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR:'10.48.12.5'})),
    /THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR must be an IPv4 CIDR/);
  await assert.rejects(invoke(baselineEnv({THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT:'70000'})),
    /THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT must be an integer from 1 to 65535/);
  await assert.rejects(runCli({args:['--non-counted-pilot','--control-url','http://insecure.example.test/']}),
    /must be an absolute https URL/);
  await assert.rejects(runCli({args:['--non-counted-pilot','--control-url','https://192.0.2.9/status']}),
    /hostname must be a DNS name/);
  await assert.rejects(runCli({config:{deployments:{},routes:[]}}),/no azure_container_apps_jobs deployment/);
  assert.equal(bundle.starts.length,0,'no ARM execution may start on any environment error');
  assert.equal(logQuery===undefined,false);
});

test('a validated baseline runs the exact job image and resources and issues window-bounded, target-scoped queries',async()=>{
  const envBefore={...baselineEnv()};
  const {exitCode,report,clientBundle,queryBundle}=await runCli();
  assert.equal(exitCode,0);
  assert.equal(report.verdict.status,BASELINE_STATUS.validated);
  assert.equal(report.verdict.cleanNoopWindow,true);
  assert.equal(report.verdict.controlObserved,true);

  // Exactly the measured execution: the config's P3 job, digest-pinned image,
  // container resources and timeout, via the fixed harness commands.
  assert.equal(clientBundle.starts.length,2);
  const [noopStart,controlStart]=clientBundle.starts;
  assert.deepEqual(noopStart.options,{timeoutMs:120000});
  assert.equal(noopStart.template.containers.length,1);
  const noopContainer=noopStart.template.containers[0];
  assert.equal(noopContainer.name,'baseline');
  assert.equal(noopContainer.image,ACA_IMAGE);
  assert.deepEqual(noopContainer.resources,{cpu:0.25,memory:'0.5Gi'});
  assert.equal(noopContainer.command[0],'node');
  assert.equal(noopContainer.command[1],'-e');
  assert.match(noopContainer.command[2],/no network, filesystem, or environment access/);
  assert.equal(noopContainer.env,undefined,'the no-op command carries no environment');
  const controlContainer=controlStart.template.containers[0];
  assert.equal(controlContainer.image,ACA_IMAGE);
  assert.deepEqual(controlContainer.resources,{cpu:0.25,memory:'0.5Gi'});
  assert.match(controlContainer.command[2],/exactly one outbound request/);
  assert.deepEqual(controlContainer.env,[{name:'BASELINE_CONTROL_URL',value:CONTROL_HREF}]);

  // The census query: bounded by the execution's ARM window and source-scoped.
  assert.equal(queryBundle.queries.length,2);
  const [censusKql,controlKql]=queryBundle.queries;
  assert.match(censusKql,/^AZFWApplicationRule/);
  assert.match(censusKql,new RegExp(`between \\(datetime\\(${T0}\\) \\.\\. datetime\\(${T1}\\)\\)`));
  assert.match(censusKql,new RegExp(`ipv4_is_in_range\\(SourceIp, "${SOURCE_CIDR}"\\)`));
  assert.doesNotMatch(censusKql,/Fqdn =~/,'the census is the collision count, not an attribution query');
  // The control query: the same target-scoped builder the P3 reader uses.
  assert.match(controlKql,/^AZFWApplicationRule/);
  assert.match(controlKql,new RegExp(`between \\(datetime\\(${T0}\\) \\.\\. datetime\\(${T1}\\)\\)`));
  assert.match(controlKql,new RegExp(`ipv4_is_in_range\\(SourceIp, "${SOURCE_CIDR}"\\)`));
  assert.match(controlKql,new RegExp(`Fqdn =~ "${CONTROL_FQDN}"`));
  assert.match(controlKql,/DestinationPort == 443/);

  // A clean no-op alone never validates; only the observed control does.
  assert.equal(report.noop.status,BASELINE_STATUS.unobserved);
  assert.equal(report.noop.reason,'no_records_in_window');
  assert.equal(report.control.status,BASELINE_STATUS.validated);
  assert.equal(report.control.targetFqdn,CONTROL_FQDN);
  assert.equal(report.verdict.targetFqdn,CONTROL_FQDN);
  assert.equal(report.noop.runId,'aca-jobs-baseline-20261106T000000Z-noop');
  assert.equal(report.control.runId,'aca-jobs-baseline-20261106T000000Z-control');

  // Identity and scope of what ran, without any secret material.
  assert.equal(report.job.jobName,JOB_NAME);
  assert.equal(report.job.profile,'P3');
  assert.equal(report.job.image,ACA_IMAGE);
  assert.deepEqual(report.job.resources,{cpu:0.25,memory:'0.5Gi'});
  assert.equal(report.evidenceScope.sourceCidr,SOURCE_CIDR);
  assert.equal(report.evidenceScope.destinationPort,443);
  assert.equal(report.readiness.setsNoopBaselineValidatedFlag,false);
  assert.equal(report.readiness.unlocksMeasuredExecution,false);
  assert.match(report.readiness.note,/never sets/);
  assert.ok(!JSON.stringify(report).includes(CANARY),'raw TargetUrl secrets must not survive sanitization');

  // The CLI never writes the environment, above all not the readiness flag.
  assert.deepEqual(baselineEnv(),envBefore);
  assert.ok(!('THESIS_NETWORK_NOOP_BASELINE_VALIDATED' in envBefore));
});

test('unrelated records in the no-op window are a collision with subtraction fingerprints, not a validation',async()=>{
  const {exitCode,report}=await runCli({inject:{queryOptions:{censusRows:[NOISY_ROW]}}});
  assert.equal(exitCode,2);
  assert.equal(report.verdict.status,BASELINE_STATUS.collision);
  assert.equal(report.verdict.reason,'unrelated_records_in_noop_window');
  assert.equal(report.noop.status,BASELINE_STATUS.collision);
  assert.equal(report.noop.noise.totalRecords,1);
  assert.equal(report.noop.noise.allowRecords,1);
  assert.deepEqual(report.noop.noise.fingerprints[0],
    {action:'allow',fqdn:'telemetry.example.com',destinationPort:443,protocol:'https',count:1});
  assert.ok(!JSON.stringify(report).includes(CANARY));
});

test('an unobserved positive control keeps the whole baseline unobserved',async()=>{
  const {exitCode,report}=await runCli({inject:{queryOptions:{controlRows:[]}}});
  assert.equal(exitCode,2);
  assert.equal(report.verdict.status,BASELINE_STATUS.unobserved);
  assert.equal(report.verdict.reason,'no_matching_allow_record');
  assert.equal(report.control.status,BASELINE_STATUS.unobserved);
});

test('a denied control target is reported as observed denial, never as a passing negative',async()=>{
  const deniedRow={...CONTROL_ALLOW_ROW,Action:'Deny',Rule:'jobs-p3-deny-collector'};
  const {exitCode,report}=await runCli({inject:{queryOptions:{controlRows:[deniedRow]}}});
  assert.equal(exitCode,2);
  assert.equal(report.verdict.status,BASELINE_STATUS.unobserved);
  assert.equal(report.control.reason,'control_target_denied_observed');
  assert.deepEqual(report.control.deniedFingerprint,
    {action:'deny',fqdn:CONTROL_FQDN,destinationPort:443,protocol:'https'});
});

test('a failed firewall query stays unobserved instead of reading as a clean window',async()=>{
  const {exitCode,report}=await runCli({inject:{queryOptions:{censusError:new Error('log analytics down')}}});
  assert.equal(exitCode,2);
  assert.equal(report.noop.status,BASELINE_STATUS.unobserved);
  assert.equal(report.noop.reason,'firewall_query_failed');
  assert.equal(report.verdict.status,BASELINE_STATUS.unobserved);
  assert.equal(report.verdict.reason,'firewall_query_failed');
});

test('failed job executions are unobserved on both arms',async()=>{
  const {exitCode,report}=await runCli({status:'Failed'});
  assert.equal(exitCode,2);
  assert.equal(report.noop.reason,'execution_failed');
  assert.equal(report.control.reason,'execution_failed');
  assert.equal(report.verdict.status,BASELINE_STATUS.unobserved);
});

test('--out writes the sanitized report artifact',async()=>{
  const writes=[];
  const writeFile=async(path,data)=>{writes.push({path,data});};
  const {exitCode}=await runCli({args:[...BASE_ARGS,'--out','results/baseline-report.json'],
    inject:{writeFile}});
  assert.equal(exitCode,0);
  assert.equal(writes.length,1);
  assert.equal(writes[0].path,'results/baseline-report.json');
  const saved=JSON.parse(writes[0].data);
  assert.equal(saved.schema,'aca_jobs_noop_baseline_report_v1');
  assert.equal(saved.verdict.status,BASELINE_STATUS.validated);
  assert.ok(!writes[0].data.includes(CANARY));
});

test('the reader factory refuses unknown kinds and unbounded windows',async()=>{
  const queries=[];
  const readFirewallEvents=createBaselineFirewallReader({sourceCidr:SOURCE_CIDR,destinationPort:443,
    query:async kql=>{queries.push(kql);return [];}});
  await assert.rejects(readFirewallEvents({window:{from:'2026-11-06T00:00:10Z'},kind:'all'}),
    /window is invalid/);
  await assert.rejects(readFirewallEvents({window:{from:END,to:START},kind:'all'}),/window is invalid/);
  await assert.rejects(readFirewallEvents({window:{from:START,to:END},kind:'other'}),/unknown baseline query kind/);
  await assert.rejects(readFirewallEvents({window:{from:START,to:END},kind:'allow'}),/target FQDN/);
  assert.equal(queries.length,0,'no query may run for a refused request');
  assert.throws(()=>firewallApplicationRuleCensusQuery({sourceCidr:'10.0.0.0',t0:T0,t1:T1}),/IPv4 CIDR/);
  assert.throws(()=>firewallApplicationRuleCensusQuery({sourceCidr:SOURCE_CIDR,t0:'not-a-time',t1:T1}),
    /ISO-8601 UTC/);
  assert.throws(()=>createBaselineFirewallReader({sourceCidr:SOURCE_CIDR,destinationPort:0,query:async()=>[]}),
    /destinationPort/);
});

test('the real client wiring executes ARM through the control-plane identity and Log Analytics through the data-plane identity',async()=>{
  const armRequests=[];
  const logQueries=[];
  const fetch=async(url,options)=>{
    const target=String(url);
    if(target.startsWith('https://management.azure.com/')) {
      armRequests.push({url:target,method:options.method,
        authorization:options.headers.Authorization??options.headers.authorization,
        body:options.body});
      if(options.method==='POST'&&target.endsWith('/start'))
        return new Response(JSON.stringify({name:EXECUTION_NAME,id:EXECUTION_ID}),{status:200});
      return new Response(JSON.stringify({name:EXECUTION_NAME,id:EXECUTION_ID,
        properties:{status:'Succeeded',startTime:START,endTime:END}}),{status:200});
    }
    if(target.startsWith('https://api.loganalytics.azure.com/')) {
      logQueries.push({url:target,authorization:options.headers.authorization});
      const kql=JSON.parse(options.body).query;
      const columns=[{name:'TimeGenerated'},{name:'SourceIp'},{name:'Fqdn'},{name:'TargetUrl'},
        {name:'DestinationPort'},{name:'Protocol'},{name:'Action'},{name:'Rule'}];
      const rows=kql.includes('Fqdn =~')
        ?[[CONTROL_ALLOW_ROW.TimeGenerated,CONTROL_ALLOW_ROW.SourceIp,CONTROL_FQDN,
            CONTROL_ALLOW_ROW.TargetUrl,443,'https','Allow','allow-health']]
        :[];
      return new Response(JSON.stringify({tables:[{columns,rows}]}),{status:200});
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
  const constructions=[];
  const credentialModules={ChainedTokenCredential:class {},EnvironmentCredential:class {},
    WorkloadIdentityCredential:class {},ManagedIdentityCredential:class {
      constructor(options) {constructions.push(options);}
      async getToken() {return {token:'direct-identity-token'};}}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=fetch;
  try {
    const {exitCode,report}=await runAcaJobsNoopBaselineCli({config:baselineConfig(),env:baselineEnv(),
      args:BASE_ARGS,now:FIXED_NOW,inject:{credentialModules}});
    assert.equal(exitCode,0);
    assert.equal(report.verdict.status,BASELINE_STATUS.validated);
    assert.equal(armRequests.length,4,'two executions, each started and waited on');
    assert.match(armRequests[0].url,/\/jobs\/thesis-job-p3\/start/);
    assert.equal(armRequests[0].method,'POST');
    assert.equal(armRequests[0].authorization,'Bearer direct-identity-token');
    const startedTemplate=JSON.parse(armRequests[0].body);
    assert.equal(startedTemplate.containers[0].image,ACA_IMAGE);
    assert.equal(logQueries.length,2);
    for(const entry of logQueries) {
      assert.equal(entry.authorization,'Bearer direct-identity-token');
      assert.match(entry.url,new RegExp(`/workspaces/${guid(900)}/query`));
    }
    assert.deepEqual(constructions.map(options=>options.clientId).sort(),[guid(301),guid(302)].sort());
  } finally {globalThis.fetch=originalFetch;}
});

test('a config file can be loaded from disk for the pilot',async()=>{
  const configPath=fileURLToPath(new URL('../config/experiment.azure-three-arm.example.json',import.meta.url));
  const {exitCode,report}=await runAcaJobsNoopBaselineCli({configPath,env:baselineEnv(),args:BASE_ARGS,
    now:FIXED_NOW,inject:{jobsExecutionClient:makeClient().client,
      logQuery:makeQuery({controlRows:[CONTROL_ALLOW_ROW]}).logQuery}});
  assert.equal(exitCode,0);
  assert.equal(report.job.jobName,'thesis-job-p3');
  assert.match(report.job.image,/thesis-agent@sha256:[0-9a-f]{64}$/);
  assert.equal(report.verdict.status,BASELINE_STATUS.validated);
});
