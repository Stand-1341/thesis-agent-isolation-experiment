/** Create a separate matched draft schedule. It is never launched by this script. */
import {createHash} from 'node:crypto';
import {open,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadFrozenSchedule} from './trial-schedule.mjs';
import {liveAgentPromptManifest} from './live-agent-trial.mjs';
import {implementationManifest} from './implementation-manifest.mjs';

const packageRoot=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const inputPath=resolve(packageRoot,'03-PLANNED-TRIAL-MATRIX-450.csv');
const outputPath=resolve(packageRoot,'05-DOCKER-STARTER','results','gpt5mini-live-agent-plan.draft-v23.csv');
const metadataPath=resolve(packageRoot,'05-DOCKER-STARTER','results','gpt5mini-live-agent-plan.draft-v23.json');
const expectedInputSha256='39bb833e0a3af2c7bcbd9c7460119cbac97c324cf07bda4ebcc3b10cfd532298';
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
  reasoningEffort:manifest.reasoningEffort,rows:rows.length,unauthorized:360,legitimate:90,runPrefix:'live-',
  note:'Matched order only; live prompts and study protocol require researcher review and pilot validation before freezing.'};
const openExclusive=async(path,data)=>{const file=await open(path,'wx',0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}};
await openExclusive(outputPath,outputBytes);
await openExclusive(metadataPath,Buffer.from(JSON.stringify(metadata,null,2)+'\n','utf8'));
console.log(JSON.stringify({status:metadata.status,rows:metadata.rows,scheduleSha256:outputSha256,promptManifestSha256:manifestSha256,implementationSha256}));
