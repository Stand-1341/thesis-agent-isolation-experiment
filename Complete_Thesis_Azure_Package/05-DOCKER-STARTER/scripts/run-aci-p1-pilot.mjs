#!/usr/bin/env node
/**
 * Dedicated sequential runner for the isolated ACI P1 50-row draft.
 * The checked-in draft is intentionally blocked. This entry point requires a
 * separate, evidence-referenced readiness record before loading runtime deps.
 * It never modifies the thesis's frozen matrix or runs a counted study row.
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runTrial} from './trial-runner.mjs';
import {runSchedule} from './trial-schedule.mjs';
import {validateAciP1DraftSchedule} from './aci-p1-pilot-draft-validator.mjs';

const REQUIRED_GATES=[
  'methodApproval','deploymentValidated','isolationValidated','verifierValidated',
  'independentEvidenceProtection','u6Validated','u8Validated','credentialsValidated',
];
const HEADER='planned_run_id,block,order_in_block,deployment,permission_profile,scenario_id,scenario_type,status,result,verified_evidence_ref';
const USAGE=`Usage: run-aci-p1-pilot.mjs --readiness <json> [--deps <module>] [--dry-run|--run]

  --readiness <json>  separate, evidence-referenced readiness record
  --deps <module>    ESM module exporting {adapter, verifier, evidenceStore}
  --dry-run          report structural and readiness blockers; execute nothing
  --run              run the 50 rows sequentially as a non-counted pilot

The checked-in protocol is not approved and cannot run. The 50-row schedule
is never counted as thesis data. A failed/indeterminate row halts the sequence.`;

export function inspectAciP1Readiness({bytes,protocol,readiness}) {
  const schedule=validateAciP1DraftSchedule({bytes,protocol});
  const blockers=[...schedule.blockers];
  if(protocol.runPermitted!==true || protocol.status!=='approved_for_non_counted_pilot')
    blockers.push('protocol does not explicitly authorize this non-counted pilot');
  if(protocol.countedAsStudyTrials!==false)
    blockers.push('ACI draft must remain explicitly non-counted');
  const approvals=readiness?.approvals;
  if(!approvals || approvals.status!=='approved' || !isEvidenceRef(approvals.methodReference) || !isEvidenceRef(approvals.approvedByReference))
    blockers.push('method approval record and reviewer reference are missing');
  const gates=readiness?.gates;
  for(const name of REQUIRED_GATES) {
    if(gates?.[name]?.passed!==true || !isEvidenceRef(gates?.[name]?.evidenceReference))
      blockers.push(`readiness gate ${name} is not passed with an evidence reference`);
  }
  if(readiness?.scheduleSha256!==schedule.sha256)
    blockers.push('readiness record does not bind the exact ACI draft schedule digest');
  if(readiness?.countedAsStudyTrials!==false)
    blockers.push('readiness record must mark every row non-counted');
  return {runnable:blockers.length===0,countedAsStudyTrials:false,rows:50,sha256:schedule.sha256,blockers};
}

function isEvidenceRef(value) {
  return typeof value==='string' && value.length<=300 && /^(https:\/\/|urn:|file:)/i.test(value) && !/[\r\n]/.test(value);
}

function rowsFromBytes(bytes) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const lines=text.replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/);
  if(lines.shift()!==HEADER) throw new Error('ACI draft schedule header mismatch');
  return lines.map((line,index)=>{
    const values=line.split(',');
    if(values.length!==10) throw new Error(`invalid ACI row ${index+1}`);
    const row=Object.fromEntries(HEADER.split(',').map((key,i)=>[key,values[i]]));
    return {planned_run_id:row.planned_run_id,block:Number(row.block),order_in_block:Number(row.order_in_block),
      deployment:row.deployment,permission_profile:row.permission_profile,scenario_id:row.scenario_id};
  });
}

export async function runAciP1Pilot({bytes,protocol,readiness,dependencies}) {
  const inspection=inspectAciP1Readiness({bytes,protocol,readiness});
  if(!inspection.runnable) throw new Error(`ACI P1 pilot is blocked: ${inspection.blockers.join('; ')}`);
  if(typeof dependencies!=='function') throw new Error('ACI pilot dependencies are required');
  const rows=rowsFromBytes(bytes);
  const deps=await dependencies({mode:'non_counted_pilot',countedAsStudyTrials:false,
    rows:rows.map(row=>({...row,scenario_id:row.scenario_id,permission_profile:row.permission_profile??row.profile})),
    scheduleSha256:inspection.sha256});
  if(!deps || typeof deps!=='object' || !deps.adapter || !deps.evidenceStore ||
      typeof deps.evidenceStore.claim!=='function' || typeof deps.evidenceStore.save!=='function' ||
      typeof deps.verifier!=='function') throw new Error('ACI pilot requires adapter, verifier, and exclusive evidence store');
  return runSchedule(rows,async row=>{
    const trial={runId:row.planned_run_id,deployment:'azure_container_instances',profile:'P1',scenario:row.scenario_id,
      block:row.block,order:row.order_in_block,planSha256:inspection.sha256};
    return runTrial({trial,gates:{},adapter:deps.adapter,verifier:deps.verifier,evidenceStore:deps.evidenceStore,
      arm:'deterministic',mode:'non_counted_pilot'});
  },{validatedSubset:true});
}

function parseArgs(argv) {
  const options={};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--help'||arg==='-h') {options.help=true;continue;}
    if(arg==='--dry-run'||arg==='--run') {
      if(options.mode) throw new Error('choose only one of --dry-run or --run');
      options.mode=arg.slice(2);continue;
    }
    if(arg==='--readiness'||arg==='--deps') {
      const value=argv[++i]; if(!value) throw new Error(`${arg} requires a path`);
      options[arg.slice(2)]=value;continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  if(!options.help && !options.mode) throw new Error('choose --dry-run or --run');
  if(options.mode==='run'&&!options.readiness) throw new Error('--run requires --readiness');
  return options;
}

async function main(argv) {
  let options;
  try {options=parseArgs(argv);} catch(error) {process.stderr.write(`${error.message}\n\n${USAGE}\n`);return 5;}
  if(options.help) {process.stdout.write(`${USAGE}\n`);return 0;}
  const protocol=JSON.parse(await readFile(new URL('../config/aci-p1-pilot-draft.json',import.meta.url),'utf8'));
  const schedulePath=resolve(fileURLToPath(new URL(`../../${protocol.scheduleFile}`,import.meta.url)));
  const bytes=await readFile(schedulePath);
  let readiness;
  if(options.readiness) readiness=JSON.parse(await readFile(resolve(options.readiness),'utf8'));
  const inspection=inspectAciP1Readiness({bytes,protocol,readiness});
  if(options.mode==='dry-run') {
    process.stdout.write(`${JSON.stringify({...inspection,mode:'structural_only',scheduleFile:schedulePath,executionStarted:false},null,2)}\n`);
    return inspection.runnable?0:3;
  }
  if(!inspection.runnable) {
    process.stderr.write(`ACI P1 pilot refused before loading credentials or adapters:\n${inspection.blockers.map(item=>`- ${item}`).join('\n')}\n`);
    return 3;
  }
  if(!options.deps) {process.stderr.write('--run requires --deps after every readiness gate passes\n');return 4;}
  try {
    const module=await import(pathToFileURL(resolve(options.deps)).href);
    const factory=module.default??module;
    const results=await runAciP1Pilot({bytes,protocol,readiness,dependencies:typeof factory==='function'?factory:async()=>factory});
    process.stdout.write(`${JSON.stringify({mode:'non_counted_pilot',countedAsStudyTrials:false,plannedRows:50,completedRows:results.length,
      complete:results.complete===true,haltedAt:results.haltedAt??null,scheduleSha256:inspection.sha256},null,2)}\n`);
    return results.complete===true?0:2;
  } catch(error) {process.stderr.write(`${String(error?.message??error)}\n`);return 2;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=4;});
