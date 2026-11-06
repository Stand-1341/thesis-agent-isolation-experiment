/** Read-only 450-row launch assessment. This command cannot start trials. */
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspectOriginalPlan} from './inspect-three-architecture-plan.mjs';
import {validateExperimentConfig} from './experiment-config.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const routeKeys=['azure_vm','azure_functions_flex','azure_custom_sessions_hyperv']
  .flatMap(deployment=>['P1','P2','P3'].map(profile=>`${deployment}:${profile}`));

export function preflightThreeArchitecture({planBytes,protocol,config}={}) {
  // The plan inspector pins the exact original matrix and rejects a protocol
  // whose planning-only flag has been changed to enable measured execution.
  const plan=inspectOriginalPlan(planBytes,protocol);
  const routes=Array.isArray(config?.routes)?config.routes:[];
  const seen=routes.map(route=>`${route?.deployment}:${route?.profile}`);
  const missingRoutes=routeKeys.filter(key=>!seen.includes(key));
  const duplicateRoutes=[...new Set(seen.filter((key,index)=>seen.indexOf(key)!==index))];
  let configValidation;
  try {
    validateExperimentConfig(config,{requiredRoutes:routeKeys});
    configValidation={status:'valid_shape_only'};
  } catch(error) {
    // Error messages can refer to user supplied values; publish only the
    // validation result, not credentials or untrusted configuration values.
    configValidation={status:'invalid_or_unsupported'};
  }
  return {schema:'three_architecture_preflight_v1',ready:false,launchEnabled:false,
    matrixSha256:plan.sha256,plannedRows:plan.rows,
    requiredRoutes:routeKeys,missingRoutes,duplicateRoutes,configValidation,
    scope:plan.scope,
    blockers:[
      'The original protocol remains planning only and is not frozen for measured execution.',
      'The current session P3 selective egress and independently attributable denial evidence are unsupported.',
      'Session profiles require independently verified pool-to-workload-identity binding; a shared pool endpoint alone does not establish distinct identities.',
      'The existing scope checker marks U6 and U8 on VM and Functions as not applicable; the study method must specify how those cells are analyzed.',
      'This offline preflight cannot establish live cloud resources, identity binding, credentials, protected evidence, or pilot success.'
    ],
    note:'A valid configuration or in-scope row is not proof of deployment or trial readiness.'};
}

async function main(args) {
  if(args.length!==2 || args[0]!=='--config') throw new Error('usage: node scripts/preflight-three-architecture.mjs --config PATH');
  const [configBytes,protocolBytes,planBytes]=await Promise.all([
    readFile(resolve(args[1])),readFile(resolve(root,'config/protocol-450-three-architecture-planning.json')),
    readFile(resolve(root,'../03-PLANNED-TRIAL-MATRIX-450.csv'))
  ]);
  const report=preflightThreeArchitecture({planBytes,protocol:JSON.parse(protocolBytes),config:JSON.parse(configBytes)});
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  process.exitCode=4; // blocked, not a launch or a successful readiness check
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error=>{console.error(`Preflight failed: ${error.message}`);process.exitCode=3;});
