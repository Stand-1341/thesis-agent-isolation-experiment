/**
 * Compose the nine deployment/profile routes the runner requires.
 *
 * `createTrialAdapterRouter` demands exactly nine routes, each with its own
 * workload principal and a reset/execute/collect adapter, and nothing in the
 * package built them — which is why no measured trial could ever start. This
 * module is that missing step and only that step: it does not decide whether the
 * experiment is safe to run, and it does not invent credentials.
 */
import {createHttpPilotAdapter} from './http-pilot-adapter.mjs';
import {createSessionPilotAdapter} from './session-pilot-adapter.mjs';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';
import {DEPLOYMENTS,PROFILES} from './experiment-config.mjs';

const required=(names,where)=>{
  const missing=names.filter(name=>!where || typeof where[name]!=='function');
  if(missing.length) throw new Error(`missing dependencies for ${names[0]}: ${missing.join(', ')}`);
};

/**
 * @param config   output of loadExperimentConfig()
 * @param deps     optional runtime dependencies. HTTP routes need none; session
 *                 routes need the Azure fixture/registry/observation machinery,
 *                 supplied here rather than defaulted so a missing piece fails
 *                 loudly at start-up instead of midway through the matrix.
 * @param deps.sessionFactory  (route, deployment) => reset/execute/collect/cleanup
 */
export function buildRoutes(config, deps={}, {routeKeys}={}) {
  if(!config || !Array.isArray(config.routes) || config.routes.length!==DEPLOYMENTS.length*PROFILES.length)
    throw new Error('config must contain all nine routes; run validateExperimentConfig first');
  const routes={};
  for(const route of config.routes) {
    const key=`${route.deployment}:${route.profile}`;
    if(routeKeys && !routeKeys.has(key)) continue;
    const deployment=config.deployments[route.deployment];
    if(!deployment) throw new Error(`route ${route.deployment}:${route.profile} has no deployment block`);
    if(deployment.kind==='http') {
      if(typeof deps.httpFactory==='function') {
        routes[key]={principalObjectId:route.principalObjectId,adapter:deps.httpFactory(route,deployment)};
        continue;
      }
      routes[key]={principalObjectId:route.principalObjectId,adapter:createHttpPilotAdapter({
        agentUrl:deployment.agentUrl,resourceUrl:deployment.resourceUrl,collectorUrl:deployment.collectorUrl,
        resourceAdminToken:route.credentials.resourceAdmin,collectorAdminToken:route.credentials.collectorAdmin,
        controllerToken:route.credentials.controller,
        ...(route.credentials.functionKey===undefined?{}:{functionKey:route.credentials.functionKey}),
        ...(deployment.timeoutMs===undefined?{}:{timeoutMs:deployment.timeoutMs})})};
      continue;
    }
    // Custom container sessions: the workload is reached through the pool, and the
    // fixture lives in Blob storage, so the adapter cannot be assembled from URLs
    // and tokens alone. Refuse to guess.
    if(typeof deps.sessionFactory!=='function')
      throw new Error(`route ${key} is a session route but no sessionFactory was supplied`);
    routes[key]={principalObjectId:route.principalObjectId,adapter:deps.sessionFactory(route,deployment)};
  }
  return routes;
}

/**
 * Map a scheduled row to the lane that owns its fixture. Two trials may run at the
 * same time only if their lanes differ, so this is the function that decides how
 * much of the experiment is allowed to overlap.
 *
 * Default: the deployment. All three profiles of a deployment share its resource
 * and collector service, so they must not overlap. A route or deployment that is
 * given genuinely separate fixture endpoints declares a `laneKey` and becomes its
 * own lane.
 */
export function createLaneSelector(config) {
  const byRoute=new Map();
  for(const route of config.routes) {
    const deploymentKey=config.deployments[route.deployment]?.laneKey;
    const key=route.laneKey ?? (typeof deploymentKey==='string' && deploymentKey?deploymentKey:route.deployment);
    byRoute.set(`${route.deployment}:${route.profile}`,key);
  }
  return row=>{
    const profile=row?.permission_profile ?? row?.profile;
    return byRoute.get(`${row?.deployment}:${profile}`) ?? String(row?.deployment ?? 'unknown');
  };
}

/** Build the router the runner consumes, so a bad route fails before spend. */
export function buildAdapterRouter(config, deps={}) {
  return createTrialAdapterRouter(buildRoutes(config,deps));
}

/**
 * Describe what a route would do, for --dry-run and for the operator's review
 * before anything is created. Never returns credential values.
 */
export function describeRoutes(config, {routeKeys}={}) {
  return config.routes.map(route=>{
    const key=`${route.deployment}:${route.profile}`;
    if(routeKeys && !routeKeys.has(key)) return null;
    const deployment=config.deployments[route.deployment];
    return {route:key,kind:deployment.kind,
      principalObjectId:route.principalObjectId,
      target:deployment.kind==='http'?deployment.agentUrl:`${deployment.poolName} (${deployment.region})`,
      credentialVariables:Object.values(route.credentials).sort()};
  }).filter(Boolean).sort((a,b)=>a.route<b.route?-1:1);
}
