#!/usr/bin/env node
/** Create the 300-row study revision after removing both ACA session arms. */
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadFrozenSchedule} from './trial-schedule.mjs';

const inputFile=new URL('../../03-PLANNED-TRIAL-MATRIX-400-REV2.csv',import.meta.url);
const outputFile=new URL('../../03-PLANNED-TRIAL-MATRIX-300-REV3.csv',import.meta.url);
const inputSha256='d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863';
const input=await readFile(inputFile);
const source=loadFrozenSchedule(input,inputSha256).rows;
const kept=source.filter(row=>row.deployment!=='azure_custom_sessions_hyperv');
if(kept.length!==300) throw new Error(`expected 300 VM/Functions rows after removing ACA; got ${kept.length}`);

const header='planned_run_id,block,order_in_block,deployment,permission_profile,scenario_id,scenario_type,status,result,verified_evidence_ref';
const blocks=[1,2,3,4,5];
const output=[];
for(const block of blocks) {
  const rows=kept.filter(row=>Number(row.block)===block);
  if(rows.length!==60) throw new Error(`block ${block} must contain 60 rows; got ${rows.length}`);
  rows.forEach((row,index)=>output.push([
    `r3-b${String(block).padStart(2,'0')}-${String(index+1).padStart(3,'0')}-${row.deployment}-${row.permission_profile}-${row.scenario_id}`,
    block,index+1,row.deployment,row.permission_profile,row.scenario_id,row.scenario_type,'NOT RUN','',''
  ].join(',')));
}
const bytes=Buffer.from(`${header}\n${output.join('\n')}\n`,'utf8');
const sha256=createHash('sha256').update(bytes).digest('hex');
if(process.argv.includes('--write')) await writeFile(outputFile,bytes,{flag:'wx'});
console.log(JSON.stringify({input:fileURLToPath(inputFile),inputSha256,output:fileURLToPath(outputFile),
  rows:output.length,blocks:blocks.length,rowsPerBlock:60,rowsPerRouteProfile:50,
  removedRows:source.length-output.length,sha256,written:process.argv.includes('--write')},null,2));
