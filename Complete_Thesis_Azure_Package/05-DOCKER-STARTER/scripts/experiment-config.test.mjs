import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {validateExperimentConfig,resolveCredentials,loadExperimentConfig,EXPERIMENT_ROUTES} from './experiment-config.mjs';

const guid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('session routes require explicit selection and distinct profile pools',async()=>{
  const raw=JSON.parse(await readFile(new URL('../config/experiment.450-three-architecture.example.json',import.meta.url),'utf8'));
  const requiredRoutes=[...EXPERIMENT_ROUTES,...['P1','P2','P3'].map(p=>`azure_custom_sessions_hyperv:${p}`)];
  assert.throws(()=>validateExperimentConfig(raw),/revision-3 routes/);
  const parsed=validateExperimentConfig(raw,{requiredRoutes});
  assert.equal(parsed.routes.length,9);
  assert.equal(parsed.deployments.azure_custom_sessions_hyperv.profilePools.P2.poolName,'thesispoolp2');
  raw.deployments.azure_custom_sessions_hyperv.profilePools.P2={...raw.deployments.azure_custom_sessions_hyperv.profilePools.P1};
  assert.throws(()=>validateExperimentConfig(raw,{requiredRoutes}),/distinct pool endpoints/);
});

function baseConfig(){
  const routes=[];
  let n=1;
  for(const key of EXPERIMENT_ROUTES) {
    const [deployment,profile]=key.split(':');
    const credentials={controller:`KEY_CONTROLLER_${n}`,resourceAdmin:`KEY_RESOURCE_${n}`,collectorAdmin:`KEY_COLLECTOR_${n}`};
    if(deployment==='azure_functions_flex') credentials.functionKey=`KEY_FUNCTION_${n}`;
    routes.push({deployment,profile,principalObjectId:guid(n),
      ...(deployment==='azure_functions_flex'?{agentUrl:`https://${profile.toLowerCase()}.fn.example/api`}:{}),credentials});
    n++;
  }
  return {
    evidenceDirectory:'results/evidence',
    auditWindowSeconds:300,
    deployments:{
      azure_vm:{kind:'http',agentUrl:'https://vm.example',resourceUrl:'https://res.example',collectorUrl:'https://col.example'},
      azure_functions_flex:{kind:'http',resourceUrl:'https://res.example',collectorUrl:'https://col.example'}
    },
    routes
  };
}

test('the revision-3 six-route configuration validates',()=>{
  const config=validateExperimentConfig(baseConfig());
  assert.equal(config.routes.length,6);
  assert.equal(config.auditWindowSeconds,300);
});

test('a pilot-retry schedule may select a subset of the six revision-3 config routes',()=>{
  const config=validateExperimentConfig(baseConfig(),{requiredRoutes:['azure_functions_flex:P1']});
  assert.equal(config.routes.length,6);
  assert.equal(config.routes.some(route=>route.deployment==='azure_vm'&&route.profile==='P3'),true);
});

test('the alternate schedule can validate its eight routes including only ACI P1/P2',()=>{
  const config=baseConfig();
  config.deployments.azure_container_instances={kind:'aci',resourceUrl:'https://res.aci.example',
    collectorUrl:'https://col.aci.example',resourceGroup:'aci-rg',region:'westus2',
    subnetResourceId:'/subscriptions/sub/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/vnet/subnets/aci',
    agentImage:'registry.example/agent@sha256:'+('a'.repeat(64))};
  for(const profile of ['P1','P2']) config.routes.push({deployment:'azure_container_instances',profile,
    principalObjectId:guid(profile==='P1'?7:8),credentials:{controller:`ACI_CONTROLLER_${profile}`,
      resourceAdmin:'ACI_RESOURCE_ADMIN',collectorAdmin:'ACI_COLLECTOR_ADMIN'}});
  const requiredRoutes=[...EXPERIMENT_ROUTES,'azure_container_instances:P1','azure_container_instances:P2'];
  const validated=validateExperimentConfig(config,{requiredRoutes});
  assert.equal(validated.routes.length,8);
  assert.equal(validated.deployments.azure_container_instances.kind,'aci');
  config.routes.push({deployment:'azure_container_instances',profile:'P3',principalObjectId:guid(9),
    credentials:{controller:'ACI_CONTROLLER_P3',resourceAdmin:'ACI_RESOURCE_ADMIN',collectorAdmin:'ACI_COLLECTOR_ADMIN'}});
  assert.throws(()=>validateExperimentConfig(config,{requiredRoutes:[...requiredRoutes,'azure_container_instances:P3']}),/must be P1 or P2/);
});

test('rev4 selected-subset config binds only VM P1/P2 to live routes and labels ACI as unselected placeholders',async()=>{
  const raw=JSON.parse(await readFile(new URL('../config/experiment.400-rev4-vm-p1-p2-subset.json',import.meta.url),'utf8'));
  const protocol=JSON.parse(await readFile(new URL('../config/protocol-400-rev4-aci-draft.json',import.meta.url),'utf8'));
  const requiredRoutes=[...EXPERIMENT_ROUTES,'azure_container_instances:P1','azure_container_instances:P2'];
  const config=validateExperimentConfig(raw,{requiredRoutes});
  assert.equal(protocol.revision,'azure-proposed-v1-rev4-aci-draft');
  assert.equal(protocol.matrix.sha256,'1d21c879f34d35d965d258cd427d2e2e0c25538ccb4eec0147f3d9169d5481d4');
  assert.deepEqual(config.routes.filter(route=>route.deployment==='azure_vm'&&['P1','P2'].includes(route.profile))
    .map(route=>[route.profile,route.agentUrl,route.principalObjectId]),[
      ['P1','https://10.48.0.4','37fcb428-951e-48a8-aec2-e9918dedba29'],
      ['P2','https://10.48.7.4','dd6be331-a53b-4c08-8a63-7745e98b3952']
    ]);
  assert.match(raw._comment,/only.*VM P1\/P2/i);
  assert.match(raw._comment,/ACI resources are deployed or started/);
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
  assert.throws(()=>validateExperimentConfig(config),/exactly 6 revision-3 routes/);
});

test('ACA routes are rejected after revision 3 removes the session arms',()=>{
  const config=baseConfig();
  config.routes.push({deployment:'azure_custom_sessions_hyperv',profile:'P1',principalObjectId:guid(99),
    credentials:{controller:'SESSION_KEY',resourceAdmin:'RESOURCE_KEY',collectorAdmin:'COLLECTOR_KEY'}});
  assert.throws(()=>validateExperimentConfig(config),/exactly 6 revision-3 routes/);
});

test('a duplicate route is rejected',()=>{
  const config=baseConfig();
  config.routes[1]={...config.routes[0],principalObjectId:guid(99)};
  assert.throws(()=>validateExperimentConfig(config),/duplicate route/);
});

test('Functions routes require a profile-specific agent URL',()=>{
  const config=baseConfig();
  delete config.routes.find(route=>route.deployment==='azure_functions_flex'&&route.profile==='P2').agentUrl;
  assert.throws(()=>validateExperimentConfig(config),/routes\[.*\]\.agentUrl is required for azure_functions_flex/);
});

test('Functions routes cannot fall back to one deployment-level agent URL',()=>{
  const config=baseConfig();
  config.deployments.azure_functions_flex.agentUrl='https://shared.fn.example/api';
  delete config.routes.find(route=>route.deployment==='azure_functions_flex'&&route.profile==='P2').agentUrl;
  assert.throws(()=>validateExperimentConfig(config),/routes\[.*\]\.agentUrl is required for azure_functions_flex/);
});

test('VM routes can use the deployment-level agent URL fallback',()=>{
  const config=validateExperimentConfig(baseConfig());
  assert.equal(config.routes.find(route=>route.deployment==='azure_vm'&&route.profile==='P2').agentUrl,'https://vm.example');
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
  assert.equal(resolveCredentials(config,env).routes.length,6);
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
