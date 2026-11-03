#!/usr/bin/env node
/**
 * Entry point for a measured run.
 *
 * `runExperiment` existed only as an import for its own test, so nothing in the
 * package could start the matrix and no process exit code ever reflected a halted
 * or incomplete run. This CLI is that entry point.
 *
 * Exit codes are part of the interface; a wrapper script or a human watching a
 * terminal must be able to tell "finished" from "stopped":
 *   0  every scheduled trial ran and none was indeterminate
 *   2  the run halted on an indeterminate trial, or produced fewer records than
 *      the schedule asked for — the matrix is partial
 *   3  a readiness gate is not satisfied
 *   4  configuration or dependency error (nothing was executed)
 *   5  usage error
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadExperimentConfig} from './experiment-config.mjs';
import {buildRoutes,describeRoutes} from './build-experiment.mjs';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';
import {runExperiment} from './experiment-runner.mjs';
import {loadFrozenSchedule} from './trial-schedule.mjs';

const EXIT={complete:0,partial:2,gates:3,config:4,usage:5};

const USAGE=`Usage: run-experiment-cli.mjs --config <file> [options]

  --config <file>        deployment configuration (no secrets; see experiment-config.mjs)
  --matrix <file>        schedule to run (default ../03-PLANNED-TRIAL-MATRIX-450.csv)
  --evidence <dir>       evidence directory (default: config evidenceDirectory)
  --limit <n>            stop after n trials, for a pilot run
  --deployment <name>    restrict to one deployment
  --profile <P1|P2|P3>   restrict to one profile
  --gates <v,v,v,v>      the four readiness gates, in the order
                         protocolFrozen,deploymentValidated,isolationValidated,verifierValidated
  --deps <file>          module default-exporting {blobVerifier, collectorVerifier,
                         resourceVerifier, denialReader, sessionFactory, httpFactory}
  --allow-incomplete-verifier
                         permit a pilot where some scenarios have no verifier
  --dry-run              validate config, build routes and print the plan; execute nothing
  --json                 machine-readable summary on stdout
  --help

A measured run is refused unless all four gates are asserted. The gates are
operator assertions: this tool cannot verify them, and says so in the summary.`;

function parseArgs(argv) {
  const options={dryRun:false,json:false};
  for(let index=0;index<argv.length;index++) {
    const arg=argv[index];
    const value=()=>{const v=argv[++index];if(v===undefined) throw new Error(`${arg} requires a value`);return v;};
    switch(arg) {
      case '--config': options.config=value(); break;
      case '--deps': options.deps=value(); break;
      case '--matrix': options.matrix=value(); break;
      case '--evidence': options.evidence=value(); break;
      case '--limit': {
        const raw=value();
        if(!/^\d+$/.test(raw) || Number(raw)<1) throw new Error('--limit must be a positive integer');
        options.limit=Number(raw); break;
      }
      case '--deployment': options.deployment=value(); break;
      case '--profile': options.profile=value(); break;
      case '--gates': options.gates=value().split(',').map(s=>s.trim()).filter(Boolean); break;
      case '--dry-run': options.dryRun=true; break;
      case '--allow-incomplete-verifier': options.allowIncompleteVerifier=true; break;
      case '--json': options.json=true; break;
      case '--help': case '-h': options.help=true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  if(options.help) return options;
  if(!options.config) throw new Error('--config is required');
  return options;
}

const GATE_NAMES=['protocolFrozen','deploymentValidated','isolationValidated','verifierValidated'];

function gatesFrom(values) {
  const gates={};
  for(const name of GATE_NAMES) gates[name]=false;
  for(const value of values||[]) {
    if(!GATE_NAMES.includes(value)) throw new Error(`unknown gate ${value}`);
    gates[value]=true;
  }
  return gates;
}

function selectRows(rows, options) {
  let selected=rows;
  if(options.deployment) selected=selected.filter(row=>row.deployment===options.deployment);
  if(options.profile) selected=selected.filter(row=>row.permission_profile===options.profile);
  if(options.limit) selected=selected.slice(0,options.limit);
  return selected;
}

async function main(argv) {
  let options;
  try {
    options=parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return EXIT.usage;
  }
  if(options.help) { process.stdout.write(`${USAGE}\n`); return EXIT.complete; }

  const say=message=>{ if(!options.json) process.stdout.write(`${message}\n`); };

  let config;
  try {
    config=await loadExperimentConfig(resolve(options.config));
  } catch (error) {
    process.stderr.write(`configuration error: ${error.message}\n`);
    return EXIT.config;
  }

  // Runtime dependencies that cannot be derived from the config file: the evidence
  // readers, the session adapter factory, and the network-denial reader. Supplied as
  // a module so their construction (token providers, log clients) stays testable and
  // separate from this CLI.
  let deps={};
  if(options.deps) {
    try {
      const {pathToFileURL}=await import('node:url');
      const module=await import(pathToFileURL(resolve(options.deps)).href);
      deps=module.default ?? module;
      if(!deps || typeof deps!=='object') throw new Error('deps module must export an object');
    } catch (error) {
      process.stderr.write(`deps error: ${error.message}\n`);
      return EXIT.config;
    }
  }

  const matrixPath=resolve(options.matrix ?? new URL('../../03-PLANNED-TRIAL-MATRIX-450.csv',import.meta.url).pathname);
  let matrix,rows;
  try {
    matrix=await readFile(matrixPath);
    rows=loadFrozenSchedule(matrix,createHash('sha256').update(matrix).digest('hex')).rows;
  } catch (error) {
    process.stderr.write(`schedule error: ${error.message}\n`);
    return EXIT.config;
  }
  const selected=selectRows(rows,options);
  if(!selected.length) {
    process.stderr.write('no scheduled trials match the filters\n');
    return EXIT.config;
  }

  const matrixSha256=createHash('sha256').update(matrix).digest('hex');
  say(`schedule    ${matrixPath}`);
  say(`             ${rows.length} planned trials, ${selected.length} selected`);
  say(`matrix hash ${matrixSha256}`);
  say(`evidence    ${resolve(options.evidence ?? config.evidenceDirectory)}`);

  // Build the routes even for a dry run: a missing dependency or a reused
  // workload principal must surface now, not after the first trial.
  const gates=gatesFrom(options.gates);
  if(!options.dryRun && !Object.values(gates).every(Boolean)) {
    process.stderr.write('refusing to run: not all readiness gates are asserted\n'+
      `${GATE_NAMES.map(name=>`  ${name}: ${gates[name]}`).join('\n')}\n`+
      'Pass --gates with all four names only after each one is independently established.\n');
    return EXIT.gates;
  }

  let rawRoutes,routeError;
  try {
    rawRoutes=buildRoutes(config,deps);
    // Validate through the same router the runner uses, so a reused principal or a
    // route with a missing adapter member fails here rather than at trial 1.
    createTrialAdapterRouter(rawRoutes);
  } catch (error) {
    routeError=error;
  }
  say(`routes      ${config.routes.length} configured${routeError?' — not yet buildable':''}`);

  if(options.dryRun) {
    const plan=describeRoutes(config);
    // A dry run is a readiness report: it names what is still missing instead of
    // stopping at the first gap, and it never touches Azure to find out.
    const blockers=[];
    if(routeError) blockers.push(routeError.message);
    if(!deps.denialReader) blockers.push('no denialReader: P3 network verdicts cannot be produced');
    if(typeof deps.blobVerifier!=='function') blockers.push('no blobVerifier: U1/U2/U3/U6/U8/L1/L2 cannot be classified');
    if(typeof deps.collectorVerifier!=='function') blockers.push('no collectorVerifier: U5/U7 cannot be classified');
    if(typeof deps.resourceVerifier!=='function') blockers.push('no resourceVerifier: U4 cannot be classified');
    const ready=blockers.length===0;
    if(options.json) process.stdout.write(`${JSON.stringify({dryRun:true,ready,matrixSha256,selected:selected.length,blockers,routes:plan},null,2)}\n`);
    else {
      say('');
      say('route                          kind     target');
      for(const entry of plan) say(`${entry.route.padEnd(30)} ${entry.kind.padEnd(8)} ${entry.target}`);
      say('');
      for(const blocker of blockers) say(`BLOCKER ${blocker}`);
      say('');
      say(ready?'Dry run: configuration, routes and verifiers all resolve. Nothing executed.'
              :`Dry run: ${blockers.length} blocker(s). Nothing executed.`);
    }
    return ready?EXIT.complete:EXIT.config;
  }
  if(routeError) {
    process.stderr.write(`route error: ${routeError.message}\n`);
    return EXIT.config;
  }

  const evidenceStore=await buildEvidenceStore(resolve(options.evidence ?? config.evidenceDirectory));
  const selectedIds=new Set(selected.map(row=>row.planned_run_id));
  // Refuse to start without a real verifier. A placeholder that returns
  // 'indeterminate' would halt the schedule at trial 1, and one that guesses would
  // write fabricated classifications into the study's evidence directory.
  let verifier,coverage;
  try {
    const module=await import('./experiment-verifier.mjs');
    // The verifier is composed from the same dependency bundle as the routes, so a
    // scenario with no verifier is a start-up failure rather than a halt at trial 100.
    const built=module.createExperimentVerifier({config,denialReader:deps.denialReader,
      blobVerifier:deps.blobVerifier,collectorVerifier:deps.collectorVerifier,resourceVerifier:deps.resourceVerifier});
    verifier=built;
    coverage=module.verifierCoverage({denialReader:deps.denialReader,blobVerifier:deps.blobVerifier,
      collectorVerifier:deps.collectorVerifier,resourceVerifier:deps.resourceVerifier});
  } catch (error) {
    process.stderr.write(`verifier error: ${error.message}\n`);
    return EXIT.config;
  }
  const gaps=[...(coverage.resourceProfiles.supported.length?[]:Object.entries(coverage.resourceProfiles.missing).map(([s,r])=>`${s} (P1/P2): ${r}`)),
    ...(coverage.networkProfile.supported?[]:[`U1-U8,L1,L2 (P3): ${coverage.networkProfile.reason}`])];
  if(gaps.length && !options.allowIncompleteVerifier) {
    process.stderr.write('refusing to run: the verifier cannot classify every scheduled trial\n'+
      `${gaps.map(gap=>`  ${gap}`).join('\n')}\n`+
      'A measured run that halts at the first unclassifiable trial wastes the spend.\n'+
      'Pass --allow-incomplete-verifier for an explicitly partial pilot.\n');
    return EXIT.gates;
  }
  let results;
  try {
    results=await runExperiment({planBytes:matrix,planSha256:matrixSha256,routes:rawRoutes,
      gates,verifier,evidenceStore,arm:'deterministic',rowFilter:selectedIds});
  } catch (error) {
    // A throw here means the run stopped; the evidence store already holds the
    // indeterminate records for the trial that failed.
    process.stderr.write(`run stopped: ${error.message}\n`);
    return EXIT.partial;
  }

  const counts={};
  for(const record of results) counts[record.classification]=(counts[record.classification]??0)+1;
  const summary={arm:'deterministic',matrixSha256,planned:selected.length,executed:results.length,
    halted:results.halted===true,haltedAt:results.haltedAt??null,complete:results.complete===true,classifications:counts,
    gates,gatesVerifiedByTool:false};
  if(options.json) process.stdout.write(`${JSON.stringify(summary,null,2)}\n`);
  else {
    say('');
    say(`executed    ${summary.executed}/${summary.planned}`);
    for(const [name,count] of Object.entries(counts).sort()) say(`  ${name.padEnd(26)} ${count}`);
    if(summary.halted) say(`HALTED at ${summary.haltedAt} — investigate before resuming`);
    say('Note: the four readiness gates are operator assertions; this tool does not verify them.');
  }
  return summary.halted || !summary.complete || summary.executed!==summary.planned ? EXIT.partial : EXIT.complete;
}

function buildRoutesForDisplay(config) {
  const out={};
  for(const route of config.routes) out[`${route.deployment}:${route.profile}`]=true;
  return out;
}

async function buildEvidenceStore(directory) {
  const {saveEvidence}=await import('./evidence-store.mjs');
  return {async claim(runId) {
    // Mirror the runner's contract: the claim is written before any fixture is
    // touched, so an interrupted run is never automatically repeated.
    const {open,mkdir}=await import('node:fs/promises');
    const {join}=await import('node:path');
    await mkdir(directory,{recursive:true});
    const file=await open(join(directory,`${runId}.claim`),'wx',0o600);
    try { await file.writeFile(JSON.stringify({runId,claimedAt:new Date().toISOString()})); await file.sync(); }
    finally { await file.close(); }
  },save:record=>saveEvidence(directory,record)};
}

if(import.meta.url===`file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code=>{process.exitCode=code;})
    .catch(error=>{process.stderr.write(`unhandled: ${error?.message ?? error}\n`);process.exitCode=EXIT.config;});
}

export {main,parseArgs,selectRows,gatesFrom,EXIT};
