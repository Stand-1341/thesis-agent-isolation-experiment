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
 *   0  the selected scope completed and none was indeterminate (see matrixComplete for full-matrix status)
 *   2  the run halted on an indeterminate trial, or produced fewer records than
 *      the schedule asked for — the matrix is partial
 *   3  a readiness gate is not satisfied
 *   4  configuration or dependency error (nothing was executed)
 *   5  usage error
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadExperimentConfigShape,missingCredentialVariables,resolveCredentials} from './experiment-config.mjs';
import {buildRoutes,describeRoutes,createLaneSelector} from './build-experiment.mjs';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';
import {runExperiment} from './experiment-runner.mjs';
import {loadFrozenSchedule} from './trial-schedule.mjs';
import {analyzeTrialScope} from './scenario-scope.mjs';

const EXIT={complete:0,partial:2,gates:3,config:4,usage:5};

const USAGE=`Usage: run-experiment-cli.mjs --config <file> [options]

  --config <file>        deployment configuration (no secrets; see experiment-config.mjs)
  --evidence <dir>       evidence directory (default: config evidenceDirectory)
  --pilot                run the separate frozen 80-row non-counted pilot schedule
  --pilot-evidence <dir> isolated evidence directory for --pilot (default: results/non-counted-pilot)
  --limit <n>            limit a run to an initial subset (with --pilot this is non-counted)
  --deployment <name>    restrict to one deployment
  --profile <P1|P2|P3>   restrict to one profile
  --gates <v,v,v,v>      the four measured-study readiness gates, in the order
                         protocolFrozen,deploymentValidated,isolationValidated,verifierValidated
  --concurrency <n>      lanes to run at once (default 3, one per deployment).
                         Trials sharing a deployment share its fixture and always run
                         one-at-a-time inside that lane.
  --deps <file>          module default-exporting {blobVerifier, collectorVerifier,
                         resourceVerifier, denialReader, sessionFactory, httpFactory}
  --dry-run              structural config/matrix/scope report only; never proves readiness
  --json                 machine-readable summary on stdout
  --help

A measured run is refused unless all four gates are asserted. A non-counted pilot
uses a separately frozen schedule, its own evidence directory, and never asserts
measured-study gates. The gates are operator assertions: this tool cannot verify them.`;

function parseArgs(argv) {
  const options={dryRun:false,json:false};
  for(let index=0;index<argv.length;index++) {
    const arg=argv[index];
    const value=()=>{const v=argv[++index];if(v===undefined) throw new Error(`${arg} requires a value`);return v;};
    switch(arg) {
      case '--config': options.config=value(); break;
      case '--deps': options.deps=value(); break;
      case '--pilot': options.pilot=true; break;
      case '--pilot-evidence': options.pilotEvidence=value(); break;
      case '--concurrency': {
        const raw=value();
        if(!/^\d+$/.test(raw) || Number(raw)<1 || Number(raw)>32) throw new Error('--concurrency must be 1..32');
        options.concurrency=Number(raw); break;
      }
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

const abilityUnknown=source=>source!=='deps.denialReader';

/** The frozen digest, as declared by the protocol rather than derived from the file. */
async function readDeclaredMatrix(pilot=false) {
  try {
    const text=await readFile(new URL('../config/protocol.json',import.meta.url),'utf8');
    const protocol=JSON.parse(text);
    const matrix=pilot?protocol.pilotPlan:protocol.matrix;
    if(!matrix || typeof matrix.sha256!=='string' || !/^[0-9a-f]{64}$/.test(matrix.sha256)) return null;
    return matrix;
  } catch (error) { return null; }
}

/**
 * The deps module is the only thing that knows whether a deployment has attributable
 * denial telemetry. A structural preflight still has to report scope honestly, so it
 * imports the module when one is supplied and reports why it could not when it can't.
 */
async function resolveNetworkCapabilities(options,configShape) {
  if(!options.deps) return {capabilities:{},source:'no --deps supplied'};
  try {
    const module=await import(pathToFileURL(resolve(options.deps)).href);
    const exported=module.default ?? module;
    const deps=typeof exported==='function'?await exported({config:configShape,env:process.env,mode:options.pilot?'non_counted_pilot':'measured'}):exported;
    const capabilities=deps?.denialReader?.capabilities;
    if(!capabilities || typeof capabilities!=='object')
      return {capabilities:{},source:'deps.denialReader advertises no capabilities'};
    return {capabilities,source:'deps.denialReader'};
  } catch (error) {
    return {capabilities:{},source:`unavailable (${String(error?.message ?? error).split('\n')[0]})`};
  }
}

function selectRows(rows,options) {
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

  if(options.pilot && options.evidence) { process.stderr.write('--evidence cannot be used with --pilot; use --pilot-evidence to keep records separate\n'); return EXIT.usage; }
  if(!options.pilot && options.pilotEvidence) { process.stderr.write('--pilot-evidence requires --pilot\n'); return EXIT.usage; }
  if(options.pilot && options.gates?.length) { process.stderr.write('--pilot never accepts measured-study readiness gates\n'); return EXIT.usage; }

  const say=message=>{ if(!options.json) process.stdout.write(`${message}\n`); };

  const declared=await readDeclaredMatrix(options.pilot);
  if(!declared) { process.stderr.write('protocol error: frozen schedule metadata is missing or invalid\n'); return EXIT.config; }
  const matrixPath=resolve(fileURLToPath(new URL(`../../${declared.file}`,import.meta.url)));
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

  let configShape;
  try { configShape=await loadExperimentConfigShape(resolve(options.config)); }
  catch(error) { process.stderr.write(`configuration error: ${error.message}\n`); return EXIT.config; }
  const routeKeys=new Set(selected.map(row=>`${row.deployment}:${row.permission_profile ?? row.profile}`));
  // Scope must be reported with the same network capability the run would use, or the
  // preflight claims rows are unsupported that the operator has already configured.
  // Without this the BLOCKER lines for VM/Flex P3 were unclearable by any correct setup.
  const {capabilities:networkCapabilities,source:capabilitySource}=await resolveNetworkCapabilities(options,configShape);
  const scope=analyzeTrialScope(selected,{networkCapabilities});
  const missingCredentials=missingCredentialVariables(configShape,process.env,routeKeys);
  const matrixSha256=createHash('sha256').update(matrix).digest('hex');
  // Always compare to protocol metadata; a caller-supplied schedule can never
  // turn an unreviewed subset into measured data.
  if(declared.sha256!==matrixSha256) {
    process.stderr.write(`matrix digest mismatch for ${declared.file}\n  declared ${declared.sha256}\n  actual   ${matrixSha256}\n`);
    return EXIT.config;
  }
  if(options.pilot && (declared.countedAsStudyTrials!==false || declared.trials!==rows.length)) {
    process.stderr.write('pilot schedule metadata must explicitly mark every row non-counted and match its row count\n'); return EXIT.config;
  }

  if(options.dryRun) {
    const routes=describeRoutes(configShape,{routeKeys});
    const report={dryRun:true,mode:options.pilot?'non_counted_pilot':'measured',studyCounted:!options.pilot,readiness:'structural_only_not_ready',matrixSha256,plannedMatrixRows:rows.length,
      selectedRows:selected.length,measurableRows:scope.measurable,notApplicableRows:scope.notApplicable,
      unsupportedRows:scope.unsupported,unsupportedByRoute:scope.unsupportedByRoute,
      networkCapabilitySource:capabilitySource,
      missingCredentialVariables:missingCredentials,readinessGates:GATE_NAMES.map(name=>`${name}=unverified`),
      runtimeDependencies:'not_checked',routes,
      note:'Structural preflight only. Adapter/verifier dependencies, Azure gates, reachability, isolation, and telemetry are not verified.'};
    if(options.json) process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
    else {
      say(`Structural preflight only (${report.mode}): ${rows.length} planned trials, ${selected.length} selected; no trials executed.`);
      say(`matrix hash ${report.matrixSha256}`);
      say(`Scope: ${scope.measurable} measurable, ${scope.notApplicable} not applicable, ${scope.unsupported} unsupported.`);
      for(const [route,count] of Object.entries(scope.unsupportedByRoute)) say(`BLOCKER ${route}: ${count} unsupported rows`);
      if(scope.unsupported && abilityUnknown(capabilitySource))
        say(`       network-denial capability ${capabilitySource}; those rows are reported unsupported until a denialReader advertises it`);
      if(missingCredentials.length) say(`BLOCKER missing credential environment variables: ${missingCredentials.join(', ')}`);
      say(`Readiness gates remain unverified: ${GATE_NAMES.join(', ')}`);
      say('Not deployment-ready. Nothing executed.');
    }
    return EXIT.config;
  }
  if(missingCredentials.length) {
    process.stderr.write(`configuration error: missing credential environment variables: ${missingCredentials.join(', ')}\n`);
    return EXIT.config;
  }
  let config;
  try { config=resolveCredentials(configShape,process.env,routeKeys); }
  catch(error) { process.stderr.write(`configuration error: ${error.message}\n`); return EXIT.config; }
  let deps={};
  if(options.deps) {
    try {
      const module=await import(pathToFileURL(resolve(options.deps)).href);
      const exported=module.default ?? module;
      deps=typeof exported==='function'?await exported({config,env:process.env,mode:options.pilot?'non_counted_pilot':'measured'}):exported;
      if(!deps || typeof deps!=='object') throw new Error('deps module must export an object or a factory returning one');
    } catch(error) { process.stderr.write(`deps error: ${error.message}\n`); return EXIT.config; }
  }

  say(`schedule    ${matrixPath}`);
  say(`             ${rows.length} planned trials, ${selected.length} selected`);
  say(`matrix hash ${matrixSha256}`);
  const defaultPilotEvidence=fileURLToPath(new URL('../results/non-counted-pilot',import.meta.url));
  const evidenceDirectory=resolve(options.pilot?(options.pilotEvidence ?? defaultPilotEvidence):(options.evidence ?? config.evidenceDirectory));
  if(options.pilot) {
    const studyEvidence=resolve(config.evidenceDirectory);
    const overlaps=(a,b)=>{const rel=relative(a,b);return rel==='' || (rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));};
    if(overlaps(evidenceDirectory,studyEvidence) || overlaps(studyEvidence,evidenceDirectory)) {
      process.stderr.write('pilot evidence directory must be separate from measured-study evidence\n'); return EXIT.config;
    }
  }
  say(`mode        ${options.pilot?'NON-COUNTED PILOT':'MEASURED STUDY'}`);
  say(`evidence    ${evidenceDirectory}`);

  // Build the routes even for a dry run: a missing dependency or a reused
  // workload principal must surface now, not after the first trial.
  const gates=gatesFrom(options.gates);
  if(!options.pilot && !options.dryRun && !Object.values(gates).every(Boolean)) {
    process.stderr.write('refusing to run: not all readiness gates are asserted\n'+
      `${GATE_NAMES.map(name=>`  ${name}: ${gates[name]}`).join('\n')}\n`+
      'Pass --gates with all four names only after each one is independently established.\n');
    return EXIT.gates;
  }

  let rawRoutes,routeError;
  try {
    rawRoutes=buildRoutes(config,deps,{routeKeys});
    // Validate through the same router the runner uses, so a reused principal or a
    // route with a missing adapter member fails here rather than at trial 1.
    createTrialAdapterRouter(rawRoutes,{requiredRoutes:[...routeKeys]});
  } catch (error) {
    routeError=error;
  }
  say(`routes      ${routeKeys.size} selected routes${routeError?' — not yet buildable':''}`);
  if(routeError) {
    process.stderr.write(`route error: ${routeError.message}\n`);
    return EXIT.config;
  }

  const evidenceStore=await buildEvidenceStore(evidenceDirectory);
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
      collectorVerifier:deps.collectorVerifier,resourceVerifier:deps.resourceVerifier,
      networkCapabilities:deps.denialReader?.capabilities ?? {},rows:selected});
  } catch (error) {
    process.stderr.write(`verifier error: ${error.message}\n`);
    return EXIT.config;
  }
  const gaps=[...(coverage.resourceProfiles.supported.length?[]:Object.entries(coverage.resourceProfiles.missing).map(([s,r])=>`${s} (P1/P2): ${r}`)),
    ...(coverage.networkProfile.supported?[]:[`selected P3 network-denial cells: ${coverage.networkProfile.reason}`])];
  if(gaps.length) {
    process.stderr.write('refusing to run: the verifier cannot classify every scheduled trial\n'+
      `${gaps.map(gap=>`  ${gap}`).join('\n')}\n`+
      'A measured run that halts at the first unclassifiable trial wastes the spend.\n'+
      'No measured or pilot trials were claimed.\n');
    return EXIT.gates;
  }
  let results;
  try {
    results=await runExperiment({planBytes:matrix,planSha256:matrixSha256,routes:rawRoutes,
      gates,verifier,evidenceStore,arm:'deterministic',mode:options.pilot?'non_counted_pilot':'measured',rowFilter:selectedIds,
      concurrency:options.concurrency ?? 3,
      laneFor:typeof deps.laneFor==='function'?deps.laneFor:createLaneSelector(config),
      networkCapabilities:deps.denialReader?.capabilities ?? {}});
  } catch (error) {
    // A throw here means the run stopped; the evidence store already holds the
    // indeterminate records for the trial that failed.
    process.stderr.write(`run stopped: ${error.message}\n`);
    return EXIT.partial;
  }

  const counts={};
  for(const record of results) counts[record.classification]=(counts[record.classification]??0)+1;
  const summary={arm:'deterministic',mode:options.pilot?'non_counted_pilot':'measured',studyCounted:!options.pilot,matrixSha256,matrixRows:rows.length,planned:selected.length,executed:results.length,
    halted:results.halted===true,haltedAt:results.haltedAt??null,scopeComplete:results.complete===true,
    matrixComplete:results.matrixComplete===true,pilotScheduleComplete:results.pilotScheduleComplete===true,classifications:counts,scope:results.scopeSummary,
    concurrency:results.concurrency??1,lanes:results.laneCount??1,notApplicable:results.notApplicable??0,
    gates,gatesVerifiedByTool:false};
  if(options.json) process.stdout.write(`${JSON.stringify(summary,null,2)}\n`);
  else {
    say('');
    say(`executed    ${summary.executed}/${summary.planned}`);
    for(const [name,count] of Object.entries(counts).sort()) say(`  ${name.padEnd(26)} ${count}`);
    if(summary.halted) say(`HALTED at ${summary.haltedAt} — investigate before resuming`);
    if(options.pilot) say('Pilot records are isolated, labeled non-counted, and do not clear study readiness gates.');
    if(!options.pilot && !summary.matrixComplete && summary.scopeComplete && !summary.halted)
      say('Scope note: the selected rows all completed, but this is not the full 400-row matrix.');
    say('Note: the four readiness gates are operator assertions; this tool does not verify them.');
  }
  // The exit code describes the run that was asked for, not the matrix that was not.
  // Requiring matrixComplete made success unreachable: a complete full-matrix selection
  // is refused because the session P3 cells have no selective-egress design, so every
  // executable run — always a scoped subset — would report the same code as a halt.
  // matrixComplete stays in the summary as information; it must not gate the result.
  return summary.halted || !summary.scopeComplete || summary.executed!==summary.planned ? EXIT.partial : EXIT.complete;
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

// Compare canonical file URLs instead of concatenating `file://` with argv[1].
// On Windows argv[1] contains a drive-letter path (`C:\...`), so the old form
// never matched Node's `file:///C:/...` import.meta.url and the CLI exited 0
// without validating anything.
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code=>{process.exitCode=code;})
    .catch(error=>{process.stderr.write(`unhandled: ${error?.message ?? error}\n`);process.exitCode=EXIT.config;});
}

export {main,parseArgs,selectRows,gatesFrom,EXIT};
