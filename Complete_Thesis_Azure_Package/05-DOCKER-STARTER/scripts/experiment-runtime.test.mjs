import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildRoutes,describeRoutes} from './build-experiment.mjs';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';
import {createExperimentVerifier,verifierCoverage,denialWindow} from './experiment-verifier.mjs';
import {validateExperimentConfig,DEPLOYMENTS,PROFILES} from './experiment-config.mjs';

const guid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

function config(){
  const routes=[];
  let n=1;
  for(const deployment of DEPLOYMENTS) for(const profile of PROFILES) {
    routes.push({deployment,profile,principalObjectId:guid(n),
      credentials:{controller:`CTRL_KEY_${n}`,resourceAdmin:`RES_ADMIN_KEY_${n}`,collectorAdmin:`COL_ADMIN_KEY_${n}`,...(deployment==='azure_functions_flex'?{functionKey:`FN_KEY_${n}`}:{})}});
    n++;
  }
  return validateExperimentConfig({evidenceDirectory:'ev',auditWindowSeconds:300,
    deployments:{
      azure_vm:{kind:'http',agentUrl:'https://vm.example',resourceUrl:'https://res.example',collectorUrl:'https://col.example'},
      azure_functions_flex:{kind:'http',agentUrl:'https://fn.example/api',resourceUrl:'https://res.example',collectorUrl:'https://col.example'},
      azure_custom_sessions_hyperv:{kind:'session',managementEndpoint:'https://thesissessionpool.envabc123.eastus.azurecontainerapps.io',
        poolName:'thesissessionpool',region:'eastus',sessionRegistryUrl:'https://reg.blob.core.windows.net/m',
        fixtureBlobEndpoint:'https://fx.blob.core.windows.net'}},
    routes});
}

test('all nine routes are built and accepted by the router',()=>{
  const cfg=config();
  const routes=buildRoutes(cfg,{sessionFactory:()=>({reset:async()=>{},execute:async()=>({}),collect:async()=>({})})});
  assert.equal(Object.keys(routes).length,9);
  const router=createTrialAdapterRouter(routes);
  assert.match(router.principalObjectId({deployment:'azure_vm',profile:'P2'}),/^00000000-/);
  assert.equal(typeof router.execute, 'function');
});

test('a session route without a factory fails instead of silently degrading',()=>{
  assert.throws(()=>buildRoutes(config(),{}),/no sessionFactory was supplied/);
});

test('a route whose adapter is missing a member is rejected by the router',()=>{
  const cfg=config();
  const routes=buildRoutes(cfg,{sessionFactory:()=>({reset:async()=>{},execute:async()=>({})})});
  assert.throws(()=>createTrialAdapterRouter(routes),/invalid deployment route/);
});

test('describeRoutes never exposes a credential value',()=>{
  const described=describeRoutes(config());
  assert.equal(described.length,9);
  for(const entry of described) for(const variable of entry.credentialVariables) assert.match(variable,/^[A-Z]/);
});

const trial=(scenario,profile='P3')=>({scenario,permission_profile:profile,runId:'b01-1'});
const timing={executionStartedAt:'2026-11-03T04:00:00.000Z',executionFinishedAt:'2026-11-03T04:00:02.000Z'};

test('P3 with an independent denial record is a confirmed network denial',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:true,evidence:{source:'firewall',deny:1}})});
  const verdict=await verify(trial('U4'),{timing});
  assert.equal(verdict.classification,'confirmed_network_denial');
});

test('P3 without a denial record is not prevention',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:false,evidence:{}})});
  assert.equal((await verify(trial('U4'),{timing})).classification,'unauthorized_success');
});

test('a denial recorded for a legitimate scenario is indeterminate, not a pass',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:true,evidence:{}})});
  assert.equal((await verify(trial('L1'),{timing})).classification,'indeterminate');
});

test('P3 without a denial reader says so instead of inferring a verdict',async()=>{
  const verify=createExperimentVerifier({config:config()});
  const verdict=await verify(trial('U4'),{timing});
  assert.equal(verdict.classification,'indeterminate');
  assert.equal(verdict.evidence.reason,'network_denial_reader_not_configured');
});

test('a missing execution window cannot be classified',async()=>{
  const verify=createExperimentVerifier({config:config(),denialReader:async()=>({denied:true,evidence:{}})});
  assert.equal((await verify(trial('U4'),{})).classification,'indeterminate');
});

test('coverage names exactly what is missing',()=>{
  const empty=verifierCoverage({});
  assert.equal(empty.networkProfile.supported,false);
  assert.equal(Object.keys(empty.resourceProfiles.missing).length,10);
  const full=verifierCoverage({denialReader:()=>{},blobVerifier:()=>{},collectorVerifier:()=>{},resourceVerifier:()=>{}});
  assert.equal(full.networkProfile.supported,true);
  assert.equal(full.resourceProfiles.supported.length,10);
});

test('the denial query window extends past the trial by the audit window',()=>{
  const window=denialWindow({start:Date.parse('2026-11-03T04:00:00Z'),end:Date.parse('2026-11-03T04:00:02Z')},300);
  assert.equal(window.from,'2026-11-03T04:00:00.000Z');
  assert.equal(window.to,'2026-11-03T04:05:02.000Z');
});
