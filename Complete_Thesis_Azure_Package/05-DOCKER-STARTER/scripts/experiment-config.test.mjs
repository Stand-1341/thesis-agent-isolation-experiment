import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateExperimentConfig,resolveCredentials,loadExperimentConfig,EXPERIMENT_ROUTES} from './experiment-config.mjs';

const guid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

function baseConfig(){
  const routes=[];
  let n=1;
  for(const key of EXPERIMENT_ROUTES) {
    const [deployment,profile]=key.split(':');
    const credentials={controller:`KEY_CONTROLLER_${n}`,resourceAdmin:`KEY_RESOURCE_${n}`,collectorAdmin:`KEY_COLLECTOR_${n}`};
    if(deployment==='azure_functions_flex') credentials.functionKey=`KEY_FUNCTION_${n}`;
    routes.push({deployment,profile,principalObjectId:guid(n),credentials});
    n++;
  }
  return {
    evidenceDirectory:'results/evidence',
    auditWindowSeconds:300,
    deployments:{
      azure_vm:{kind:'http',agentUrl:'https://vm.example',resourceUrl:'https://res.example',collectorUrl:'https://col.example'},
      azure_functions_flex:{kind:'http',agentUrl:'https://fn.example/api',resourceUrl:'https://res.example',collectorUrl:'https://col.example'},
      azure_custom_sessions_hyperv:{kind:'session',managementEndpoint:'https://thesissessionpool.envabc123.eastus.azurecontainerapps.io',
        poolName:'thesissessionpool',region:'eastus',sessionRegistryUrl:'https://reg.blob.core.windows.net/map',
        fixtureBlobEndpoint:'https://fixture.blob.core.windows.net'}
    },
    routes
  };
}

test('the revision-2 eight-route configuration validates',()=>{
  const config=validateExperimentConfig(baseConfig());
  assert.equal(config.routes.length,8);
  assert.equal(config.auditWindowSeconds,300);
});

test('a configuration that holds a secret instead of naming one is rejected',()=>{
  const config=baseConfig();
  config.routes[0].credentials.controller='sk-live-abcdefghijklmnop';
  assert.throws(()=>validateExperimentConfig(config),/must name an environment variable/);
});

test('a reused workload principal is rejected',()=>{
  const config=baseConfig();
  config.routes[1].principalObjectId=config.routes[0].principalObjectId;
  assert.throws(()=>validateExperimentConfig(config),/reused across routes/);
});

test('a missing route is rejected',()=>{
  const config=baseConfig();
  config.routes.pop();
  assert.throws(()=>validateExperimentConfig(config),/exactly 8 revision-2 routes/);
});

test('a withdrawn custom-session P3 route is rejected by revision 2',()=>{
  const config=baseConfig();
  config.routes.push({...config.routes.find(route=>route.deployment==='azure_custom_sessions_hyperv' && route.profile==='P2'),
    profile:'P3',principalObjectId:guid(99),credentials:{controller:'SESSION_P3_KEY'}});
  assert.throws(()=>validateExperimentConfig(config),/exactly 8 revision-2 routes/);
});

test('a duplicate route is rejected',()=>{
  const config=baseConfig();
  config.routes[1]={...config.routes[0],principalObjectId:guid(99)};
  assert.throws(()=>validateExperimentConfig(config),/duplicate route/);
});

test('plain HTTP is refused for anything but loopback',()=>{
  const config=baseConfig();
  config.deployments.azure_vm.agentUrl='http://vm.example';
  assert.throws(()=>validateExperimentConfig(config),/must use HTTPS/);
});

test('an out-of-range audit window is rejected',()=>{
  const config=baseConfig();
  config.auditWindowSeconds=9000;
  assert.throws(()=>validateExperimentConfig(config),/auditWindowSeconds/);
});

test('credentials resolve from the environment and name what is missing',()=>{
  const config=validateExperimentConfig(baseConfig());
  const env={};
  for(const route of config.routes) for(const name of Object.values(route.credentials)) env[name]=`value-for-${name}`;
  assert.equal(resolveCredentials(config,env).routes.length,8);
  delete env[config.routes[0].credentials.controller];
  assert.throws(()=>resolveCredentials(config,env),/missing credential environment variables: KEY_CONTROLLER_1/);
});

test('a placeholder-length credential is rejected rather than used',()=>{
  const config=validateExperimentConfig(baseConfig());
  const env={};
  for(const route of config.routes) for(const name of Object.values(route.credentials)) env[name]=`value-for-${name}`;
  env[config.routes[0].credentials.controller]='short';
  assert.throws(()=>resolveCredentials(config,env),/too short to be a credential/);
});

test('loadExperimentConfig reads a file and refuses invalid JSON',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cfg-'));
  const file=join(dir,'c.json');
  await writeFile(file,'{not json');
  await assert.rejects(loadExperimentConfig(file,{}),/not valid JSON/);
});
