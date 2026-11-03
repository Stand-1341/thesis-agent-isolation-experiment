/** Route a validated plan to explicitly supplied deployment/profile adapters. */
import {EXPERIMENT_ROUTES} from './experiment-config.mjs';
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createTrialAdapterRouter(routes,{requiredRoutes}={}) {
  if(!routes || typeof routes!=='object' || Array.isArray(routes)) throw new Error('invalid routes');
  const expected=EXPERIMENT_ROUTES;
  const required=requiredRoutes?[...new Set(requiredRoutes)]:expected;
  if(required.some(key=>!expected.includes(key))) throw new Error('unknown required deployment/profile route');
  if(JSON.stringify(Object.keys(routes).sort())!==JSON.stringify([...required].sort()))
    throw new Error(requiredRoutes?'routes must exactly match selected deployment/profile routes':`all ${expected.length} revision-2 deployment/profile routes are required`);
  const identities=new Set();
  const resolved={};
  for(const key of required) {
    const route=routes[key];
    if(!route || !guid.test(route.principalObjectId || '') || !route.adapter ||
      !['reset','execute','collect'].every(name=>typeof route.adapter[name]==='function')) throw new Error('invalid deployment route');
    const id=route.principalObjectId.toLowerCase();
    if(identities.has(id)) throw new Error('workload principal reused across deployment profiles');
    identities.add(id);
    resolved[key]={principalObjectId:route.principalObjectId,adapter:{reset:route.adapter.reset.bind(route.adapter),
      execute:route.adapter.execute.bind(route.adapter),collect:route.adapter.collect.bind(route.adapter),
      ...(typeof route.adapter.cleanup==='function'?{cleanup:route.adapter.cleanup.bind(route.adapter)}:{})}};
  }
  function routeFor(trial) {
    const key=`${trial?.deployment}:${trial?.profile}`;
    if(!required.includes(key)) throw new Error('unknown deployment route');
    return resolved[key];
  }
  return {
    principalObjectId:trial=>routeFor(trial).principalObjectId,
    reset:trial=>routeFor(trial).adapter.reset(trial),
    execute:(trial,reset)=>routeFor(trial).adapter.execute(trial,reset),
    collect:(trial,reset,output,timing)=>routeFor(trial).adapter.collect(trial,reset,output,timing),
    cleanup:(trial,reset)=>routeFor(trial).adapter.cleanup?.(trial,reset)
  };
}
