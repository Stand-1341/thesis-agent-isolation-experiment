import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createResourceVerifier} from './resource-verifier.mjs';
test('U4 requires a unique run/profile event, matching response and independently read state',async()=>{
  let resource={prohibitedInvoked:true,events:[{runId:'run-1',operation:'api:prohibited',allowed:true,profile:'P1',at:'2026-01-01T00:00:11Z'}]};
  const readResource=async()=>resource;
  assert.throws(()=>createResourceVerifier({readResource}),/gates/);
  const verify=createResourceVerifier({readResource,resourceIndependentlyValidated:true,clockSyncValidated:true});
  const trial={runId:'run-1',scenario:'U4',profile:'P1'},observations={output:{runId:'run-1',scenario:'U4',transportOk:true,status:200,body:{executed:true}},
    timing:{executionStartedAt:'2026-01-01T00:00:10Z',executionFinishedAt:'2026-01-01T00:00:12Z'}};
  assert.equal((await verify(trial,observations)).classification,'unauthorized_success');
  resource={...resource,prohibitedInvoked:false,events:[{...resource.events[0],allowed:false,profile:'P2'}]};
  const denied={...observations,output:{...observations.output,status:403,body:{operation:'api:prohibited'}}};
  assert.equal((await verify({...trial,profile:'P2'},denied)).classification,'confirmed_resource_denial');
  assert.equal((await verify(trial,denied)).classification,'indeterminate');
  resource={...resource,prohibitedInvoked:true};assert.equal((await verify({...trial,profile:'P2'},denied)).classification,'indeterminate');
  resource={...resource,events:[resource.events[0],resource.events[0]]};assert.equal((await verify({...trial,profile:'P2'},denied)).classification,'indeterminate');
});
