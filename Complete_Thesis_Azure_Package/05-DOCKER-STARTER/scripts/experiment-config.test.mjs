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

test('U7 requires a separate restricted-service base URL on every scheduled HTTP arm',()=>{
  const config=baseConfig();
  assert.throws(()=>validateExperimentConfig(config,{requiredScenarios:['U7']}),/restrictedUrl/);
  config.deployments.azure_vm.restrictedUrl='https://restricted.example';
  config.deployments.azure_functions_flex.restrictedUrl='https://restricted.example';
  const validated=validateExperimentConfig(config,{requiredScenarios:['U7']});
  assert.equal(validated.deployments.azure_vm.restrictedUrl,'https://restricted.example');
  assert.equal(validated.deployments.azure_functions_flex.restrictedUrl,'https://restricted.example');
  config.deployments.azure_functions_flex.restrictedUrl='https://col.example';
  assert.throws(()=>validateExperimentConfig(config,{requiredScenarios:['U7']}),/separate host/);
});

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

function threeArmConfig(){
  const profiles=['P1','P2','P3'];
  const resourceUrl='https://resource.example.test',collectorUrl='https://collector.example.test',restrictedUrl='https://restricted.example.test';
  const image=`registry.example.test/agent@sha256:${'a'.repeat(64)}`;
  const identityResourceId=(name,n)=>`/subscriptions/${guid(900)}/resourceGroups/identity-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}-${n}`;
  const deployments={
    azure_vm:{kind:'http',agentUrl:'https://vm-p1.example.test',resourceUrl,collectorUrl,restrictedUrl,
      sessionDataStore:'azure_blob_external_namespace'},
    azure_container_apps_jobs:{kind:'aca_job',subscriptionId:guid(901),resourceGroup:'thesis-rg',
      workloadProfileName:'Consumption',jobNames:{P1:'job-p1',P2:'job-p2',P3:'job-p3'},agentImage:image,
      imagePullIdentityResourceId:identityResourceId('jobs-image-pull',1),resources:{cpu:0.25,memory:'0.5Gi'},resourceUrl,collectorUrl,restrictedUrl,sessionDataStore:'azure_blob_external_namespace'},
    azure_container_apps_sandboxes:{kind:'aca_sandbox',subscriptionId:guid(901),resourceGroup:'thesis-rg',region:'eastus2',
      sandboxGroups:{P1:'sandbox-p1',P2:'sandbox-p2',P3:'sandbox-p3'},
      diskImageIds:{P1:'disk-p1',P2:'disk-p2',P3:'disk-p3'},agentImage:image,
      imagePullIdentityResourceId:identityResourceId('image-pull',1),resources:{cpu:'1000m',memory:'2048Mi',disk:'20Gi'},
      resourceUrl,collectorUrl,restrictedUrl,sessionDataStore:'azure_blob_external_namespace'}
  };
  const routes=[];let index=1;
  for(const deployment of Object.keys(deployments)) for(const profile of profiles){
    const kind=deployments[deployment].kind;
    const route={deployment,profile,principalObjectId:guid(index),workloadClientId:guid(100+index),
      workloadIdentityResourceId:identityResourceId('workload',index),secretReaderClientId:guid(200+index),
      secretReaderIdentityResourceId:identityResourceId('secret-reader',index),
      workloadTokenSecretUri:`https://thesis-secrets.vault.azure.net/secrets/${profile.toLowerCase()}-workload-token`,
      credentials:kind==='http'?{controller:`VM_CONTROLLER_${profile}`,resourceAdmin:`VM_RESOURCE_${profile}`,collectorAdmin:`VM_COLLECTOR_${profile}`}
        :{resourceAdmin:`${deployment.toUpperCase()}_RESOURCE_${profile}`,collectorAdmin:`${deployment.toUpperCase()}_COLLECTOR_${profile}`}};
    if(deployment==='azure_vm') route.agentUrl=`https://vm-${profile.toLowerCase()}.example.test`;
    routes.push(route);index++;
  }
  return {evidenceDirectory:'results/azure-three-arm',auditWindowSeconds:3600,deployments,routes};
}

const threeArmRoutes=['azure_vm','azure_container_apps_jobs','azure_container_apps_sandboxes']
  .flatMap(deployment=>['P1','P2','P3'].map(profile=>`${deployment}:${profile}`));

test('the three Azure route kinds validate complete workload identities, service endpoints, and session namespaces',()=>{
  const validated=validateExperimentConfig(threeArmConfig(),{requiredRoutes:threeArmRoutes,requiredScenarios:['U6','U8','U7']});
  assert.equal(validated.routes.length,9);
  assert.equal(validated.deployments.azure_container_apps_jobs.workloadProfileName,'Consumption');
  assert.equal(validated.routes.find(route=>route.deployment==='azure_container_apps_jobs'&&route.profile==='P2').jobName,'job-p2');
  assert.equal(validated.routes.find(route=>route.deployment==='azure_container_apps_sandboxes'&&route.profile==='P3').diskImageId,'disk-p3');
  assert.equal(validated.routes.find(route=>route.deployment==='azure_vm'&&route.profile==='P1').sessionDataStore,'azure_blob_external_namespace');
  assert.equal(validated.routes.find(route=>route.deployment==='azure_vm'&&route.profile==='P1').workloadClientId,guid(101));
});

test('three-arm deployment rejects consumption-only profile mislabeling and unpinned image tags',()=>{
  const config=threeArmConfig();
  config.deployments.azure_container_apps_jobs.workloadProfileName='Consumption-only';
  assert.throws(()=>validateExperimentConfig(config,{requiredRoutes:threeArmRoutes}),/workloadProfileName.*Consumption/);
  const imageConfig=threeArmConfig();imageConfig.deployments.azure_container_apps_sandboxes.agentImage='registry.example.test/agent:latest';
  assert.throws(()=>validateExperimentConfig(imageConfig,{requiredRoutes:threeArmRoutes}),/agentImage.*digest/);
});

test('three-arm routes reject reused or overlapping workload and secret-reader identities',()=>{
  const reused=threeArmConfig();reused.routes[1].workloadClientId=reused.routes[0].workloadClientId;
  assert.throws(()=>validateExperimentConfig(reused,{requiredRoutes:threeArmRoutes}),/workloadClientId.*reused/);
  const overlap=threeArmConfig();overlap.routes[0].secretReaderClientId=overlap.routes[0].workloadClientId;
  assert.throws(()=>validateExperimentConfig(overlap,{requiredRoutes:threeArmRoutes}),/different identities/);
});

test('U6/U8 cells cannot be declared supported without external namespace backing on each applicable arm',()=>{
  const config=threeArmConfig();delete config.deployments.azure_container_apps_jobs.sessionDataStore;
  assert.throws(()=>validateExperimentConfig(config,{requiredRoutes:threeArmRoutes,requiredScenarios:['U6','U8']}),/sessionDataStore/);
});

test('three-arm example config is structurally valid for all nine routes without asserting readiness',async()=>{
  const raw=JSON.parse(await readFile(new URL('../config/experiment.azure-three-arm.example.json',import.meta.url),'utf8'));
  const validated=validateExperimentConfig(raw,{requiredRoutes:threeArmRoutes,requiredScenarios:['U6','U8','U7']});
  assert.equal(validated.routes.length,9);
  assert.equal(validated.deployments.azure_container_apps_jobs.apiVersion,'2026-07-01');
  assert.equal(validated.deployments.azure_container_apps_sandboxes.apiVersion,'2026-02-01-preview');
  assert.equal(validated.routes.every(route=>route.workloadClientId&&route.secretReaderClientId&&route.workloadTokenSecretUri),true);
});
