/** Create a separate matched draft schedule. It is never launched by this script. */
import {createHash} from 'node:crypto';
import {mkdir,open,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadFrozenSchedule} from './trial-schedule.mjs';
import {liveAgentPromptManifest} from './live-agent-trial.mjs';
import {implementationManifest} from './implementation-manifest.mjs';

const packageRoot=resolve(fileURLToPath(new URL('../..',import.meta.url)));
// Follows the active 300-row revision 3 plan; superseded schedules remain historical.
const inputPath=resolve(packageRoot,'03-PLANNED-TRIAL-MATRIX-300-REV3.csv');
const outputPath=resolve(packageRoot,'05-DOCKER-STARTER','results','gpt5mini-live-agent-plan.draft-v24.csv');
const metadataPath=resolve(packageRoot,'05-DOCKER-STARTER','results','gpt5mini-live-agent-plan.draft-v24.json');
const expectedInputSha256='a6bc3ffe78d677d25e07452e06cfc437062fdd9e8322b4c834d31118337ccc7e';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inputBytes=await readFile(inputPath);
const source=loadFrozenSchedule(inputBytes,expectedInputSha256);
const header=['planned_run_id','block','order_in_block','deployment','permission_profile','scenario_id','scenario_type','status','result','verified_evidence_ref'];
const rows=source.rows.map(row=>({...row,planned_run_id:`live-${row.planned_run_id}`}));
const csv=[header.join(','),...rows.map(row=>header.map(key=>row[key]).join(',')),''].join('\n');
const outputBytes=Buffer.from(csv,'utf8');
const outputSha256=digest(outputBytes);
const manifest=liveAgentPromptManifest();
const manifestSha256=digest(Buffer.from(JSON.stringify(manifest),'utf8'));
const {hashes:implementationHashes,sha256:implementationSha256}=await implementationManifest(packageRoot);
const metadata={scope:'separate_gpt5mini_live_agent_arm',status:'draft_not_frozen_not_run',sourceScheduleSha256:source.sha256,
  scheduleSha256:outputSha256,promptManifestSha256:manifestSha256,implementationSha256,implementationHashes,model:manifest.model,modelVersion:manifest.modelVersion,
  reasoningEffort:manifest.reasoningEffort,rows:rows.length,
  unauthorized:rows.filter(row=>row.scenario_type==='unauthorized').length,
  legitimate:rows.filter(row=>row.scenario_type==='legitimate').length,runPrefix:'live-',
  note:'Matched order only; live prompts and study protocol require researcher review and pilot validation before freezing.'};
const openExclusive=async(path,data)=>{const file=await open(path,'wx',0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}};
// results/ is gitignored, so a clean checkout has no such directory and the
// documented command used to die with ENOENT before writing anything.
await mkdir(dirname(outputPath),{recursive:true});
await openExclusive(outputPath,outputBytes);
await openExclusive(metadataPath,Buffer.from(JSON.stringify(metadata,null,2)+'\n','utf8'));
console.log(JSON.stringify({status:metadata.status,rows:metadata.rows,scheduleSha256:outputSha256,promptManifestSha256:manifestSha256,implementationSha256}));
