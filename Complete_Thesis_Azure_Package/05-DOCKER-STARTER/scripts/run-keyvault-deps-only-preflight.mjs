#!/usr/bin/env node
/**
 * Construct and validate one VM route's live dependencies without executing a row.
 * Key Vault values remain in process memory and are never included in the report.
 */
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {loadSelectedVmCredentials} from './run-keyvault-measured-preflight.mjs';
import {loadExperimentConfigShape,resolveCredentials} from './experiment-config.mjs';
import {buildRoutes} from './build-experiment.mjs';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';

function profileArg(argv) {
  if(argv.length!==2 || argv[0]!=='--profile' || !['P1','P2'].includes(argv[1]))
    throw new Error('usage: run-keyvault-deps-only-preflight.mjs --profile P1|P2');
  return argv[1];
}

const profile=profileArg(process.argv.slice(2));
const routeKey=`azure_vm:${profile}`;
const routeKeys=new Set([routeKey]);
const env=await loadSelectedVmCredentials({profile});
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const configShape=await loadExperimentConfigShape(resolve(root,'config/experiment.azure-live.json'));
const config=resolveCredentials(configShape,env,routeKeys);
const module=await import(pathToFileURL(resolve(root,'scripts/deps-live.mjs')).href);
const createLiveDeps=module.default??module;
const deps=await createLiveDeps({config,env,mode:'non_counted_pilot',routeKeys});
const routes=buildRoutes(config,deps,{routeKeys});
createTrialAdapterRouter(routes,{requiredRoutes:[...routeKeys]});

process.stdout.write(`${JSON.stringify({
  status:'constructed',
  mode:'non_counted_pilot_dependencies_only',
  route:routeKey,
  routeAdapterKeys:Object.keys(routes),
  dependencyKeys:Object.keys(deps).sort(),
  assertionsSet:Object.fromEntries([
    'THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED','THESIS_RESOURCE_INDEPENDENTLY_VALIDATED',
    'THESIS_CLOCK_SYNC_VALIDATED','THESIS_AUDIT_PIPELINE_VALIDATED',
    'THESIS_AUTHORIZATION_VALIDATED','THESIS_DENIAL_STATUS_TEXT_VALIDATED'
  ].map(name=>[name,String(env[name]??'').toLowerCase()==='true'])),
  trialsExecuted:0,
  note:'Dependency constructors and selected adapter/router validation completed; no trial/reset/execute/collect calls were made.'
},null,2)}\n`);
