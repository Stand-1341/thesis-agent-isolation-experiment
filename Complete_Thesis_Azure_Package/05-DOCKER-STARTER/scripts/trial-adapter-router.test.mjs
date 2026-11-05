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
