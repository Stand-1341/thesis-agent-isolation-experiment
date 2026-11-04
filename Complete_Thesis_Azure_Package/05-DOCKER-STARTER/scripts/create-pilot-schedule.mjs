#!/usr/bin/env node
/** Create the separate, non-counted pilot schedule from the frozen study matrix. */
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const protocolPath=new URL('../config/protocol.json',import.meta.url);
const protocol=JSON.parse(await readFile(protocolPath,'utf8'));
const study=protocol.matrix;
const studyBytes=await readFile(new URL(`../../${study.file}`,import.meta.url));
const studySha=createHash('sha256').update(studyBytes).digest('hex');
if(studySha!==study.sha256) throw new Error('official study matrix does not match its frozen digest');

const lines=studyBytes.toString('utf8').replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/);
const header=lines.shift();
const expected='planned_run_id,block,order_in_block,deployment,permission_profile,scenario_id,scenario_type,status,result,verified_evidence_ref';
if(header!==expected) throw new Error('official study matrix header changed');
const first=new Map(), deployments=new Set(), profiles=new Set();
for(const line of lines) {
  const values=line.split(',');
  if(values.length!==10) throw new Error('official study matrix contains an invalid row');
  const key=[values[3],values[4],values[5]].join('|');
  if(!first.has(key)) first.set(key,values);
  deployments.add(values[3]); profiles.add(values[4]);
}
const scenarios=['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'];
const rows=[];
for(const deployment of [...deployments].sort()) for(const profile of [...profiles].sort()) {
  if(!scenarios.every(scenario=>first.has([deployment,profile,scenario].join('|')))) continue;
  for(const scenario of scenarios) {
    const source=first.get([deployment,profile,scenario].join('|'));
    if(!source) throw new Error(`official matrix lacks ${deployment}:${profile}:${scenario}`);
    rows.push([`pilot-${deployment}-${profile}-${scenario}`,1,rows.length+1,deployment,profile,scenario,source[6],'NOT RUN','',''].join(','));
  }
}
if(rows.length!==60) throw new Error(`pilot schedule must have 60 rows; got ${rows.length}`);
const output=new URL('../../03-PILOT-TRIAL-MATRIX-60-REV3.csv',import.meta.url);
const bytes=Buffer.from(`${expected}\n${rows.join('\n')}\n`,'utf8');
const sha=createHash('sha256').update(bytes).digest('hex');
if(process.argv.includes('--write')) await writeFile(output,bytes,{flag:'w'});
console.log(JSON.stringify({path:fileURLToPath(output),rows:rows.length,sha256:sha,studyMatrixSha256:studySha,written:process.argv.includes('--write')},null,2));
