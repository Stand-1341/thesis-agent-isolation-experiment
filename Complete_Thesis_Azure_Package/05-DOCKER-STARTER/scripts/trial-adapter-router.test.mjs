import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';

test('requires the six revision-3 principals and dispatches to the intended route',async()=>{
  const routes={}; let index=0;
  for(const deployment of ['azure_vm','azure_functions_flex'])
    for(const profile of ['P1','P2','P3']) {
      const key=`${deployment}:${profile}`;
      routes[key]={principalObjectId:`00000000-0000-0000-0000-${String(++index).padStart(12,'0')}`,
        adapter:{reset:async()=>key,execute:async()=>key,collect:async()=>key}};
    }
  const router=createTrialAdapterRouter(routes);
  const trial={deployment:'azure_functions_flex',profile:'P2'};
  assert.equal(await router.reset(trial),'azure_functions_flex:P2');
  assert.equal(router.principalObjectId(trial),routes['azure_functions_flex:P2'].principalObjectId);
  const duplicate={...routes,'azure_vm:P2':{...routes['azure_vm:P2'],principalObjectId:routes['azure_vm:P1'].principalObjectId}};
  assert.throws(()=>createTrialAdapterRouter(duplicate),/reused/);
  assert.throws(()=>createTrialAdapterRouter({}),/revision-3/);
  routes['azure_functions_flex:P2']={principalObjectId:'changed',adapter:{}};
  assert.equal(await router.reset(trial),'azure_functions_flex:P2');
});

test('an explicitly selected ACI P1/P2 route is accepted, while ACI P3 is rejected',()=>{
  const route={principalObjectId:'00000000-0000-0000-0000-000000000007',
    adapter:{reset:async()=>{},execute:async()=>({}),collect:async()=>({})}};
  assert.doesNotThrow(()=>createTrialAdapterRouter({'azure_container_instances:P1':route},
    {requiredRoutes:['azure_container_instances:P1']}));
  assert.throws(()=>createTrialAdapterRouter({'azure_container_instances:P3':route},
    {requiredRoutes:['azure_container_instances:P3']}),/unknown required/);
});

test('a session route can only be selected explicitly and is bound to its own principal',async()=>{
  const key='azure_custom_sessions_hyperv:P1';
  const route={principalObjectId:'00000000-0000-4000-8000-000000000007',adapter:{reset:async()=>key,execute:async()=>({}),collect:async()=>({})}};
  assert.throws(()=>createTrialAdapterRouter({[key]:route}),/revision-3/);
  const router=createTrialAdapterRouter({[key]:route},{requiredRoutes:[key]});
  assert.equal(await router.reset({deployment:'azure_custom_sessions_hyperv',profile:'P1'}),key);
});

test('forwards execution timing and exposes cleanup-on-failure per route',async()=>{
  const timing={startedAt:'controller-start'};
  const calls=[];
  const routes={
    'azure_container_apps_sandboxes:P1':{principalObjectId:'00000000-0000-0000-0000-000000000011',adapter:{
      reset:async()=>({}),execute:async(...args)=>{calls.push(args);return 'sandbox-output';},collect:async()=>({}),
      cleanup:async()=>({sandboxDeleted:true}),cleanupOnFailure:true,
    }},
    'azure_vm:P1':{principalObjectId:'00000000-0000-0000-0000-000000000012',adapter:{
      reset:async()=>({}),execute:async()=> 'vm-output',collect:async()=>({}),
      cleanup:async()=>({vmCleanup:true}),
    }},
  };
  const router=createTrialAdapterRouter(routes,{requiredRoutes:Object.keys(routes)});
  const sandboxTrial={deployment:'azure_container_apps_sandboxes',profile:'P1'};
  const vmTrial={deployment:'azure_vm',profile:'P1'};

  assert.equal(await router.execute(sandboxTrial,{reset:true},timing),'sandbox-output');
  assert.deepEqual(calls,[[sandboxTrial,{reset:true},timing]]);
  assert.equal(router.cleanupOnFailureForTrial(sandboxTrial),true);
  assert.equal(router.cleanupOnFailureForTrial(vmTrial),false);
  assert.equal(router.cleanupOnFailureForTrial({deployment:'not-configured',profile:'P1'}),false);
  assert.deepEqual(await router.cleanup(sandboxTrial,{reset:true}),{sandboxDeleted:true});
  assert.deepEqual(await router.cleanup(vmTrial,{reset:true}),{vmCleanup:true});
});
