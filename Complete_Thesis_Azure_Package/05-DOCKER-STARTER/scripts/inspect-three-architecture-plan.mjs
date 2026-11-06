/** Inspect the original 450-row schedule without executing or changing a trial. */
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadFrozenSchedule} from './trial-schedule.mjs';
import {analyzeTrialScope} from './scenario-scope.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const configPath=resolve(root,'config/protocol-450-three-architecture-planning.json');

export function inspectOriginalPlan(bytes,config) {
  if(config.status!=='planning_not_validated' || config.measuredExecutionEnabled!==false)
    throw new Error('three-architecture plan must remain planning only');
  const {rows,sha256}=loadFrozenSchedule(bytes,config.matrixSha256);
  const deployments=['azure_vm','azure_functions_flex','azure_custom_sessions_hyperv'];
  const profiles=['P1','P2','P3'];
  const scenarios=['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'];
  if(rows.length!==450 || config.expectedTrials!==450 || config.blocks!==5)
    throw new Error('original plan requires 450 rows in five blocks');
  const cells=new Set(rows.map(r=>[r.block,r.deployment,r.permission_profile,r.scenario_id].join('|')));
  for(let block=1;block<=5;block++) for(const deployment of deployments)
    for(const profile of profiles) for(const scenario of scenarios)
      if(!cells.has([block,deployment,profile,scenario].join('|'))) throw new Error('original plan is missing a required cell');
  const scope=analyzeTrialScope(rows);
  return {status:'planning_not_validated',measuredExecutionEnabled:false,sha256,rows:rows.length,
    blocks:5,scheduledPerDeployment:150,scope:{structurallyInScope:scope.measurable,notApplicable:scope.notApplicable,
      unsupported:scope.unsupported,unsupportedByRoute:scope.unsupportedByRoute},
    limitations:['U6 and U8 are currently session-only; their VM and Functions cells are not applicable.',
      'Session P3 selective egress is currently unsupported; a replacement arm requires implementation and validation.',
      'Structurally in scope does not establish runtime, credentials or verifier readiness.',
      'A valid schedule is not evidence of deployed infrastructure or completed trials.']};
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config=JSON.parse(readFileSync(configPath,'utf8'));
    const bytes=readFileSync(resolve(root,'..',config.matrixFile));
    process.stdout.write(JSON.stringify(inspectOriginalPlan(bytes,config),null,2)+'\n');
  } catch(error) { process.stderr.write(`Plan inspection failed: ${error.message}\n`); process.exitCode=1; }
}
