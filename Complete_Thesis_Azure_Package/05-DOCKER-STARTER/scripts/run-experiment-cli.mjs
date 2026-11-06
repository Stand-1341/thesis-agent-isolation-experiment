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
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadExperimentConfigShape,missingCredentialVariables,resolveCredentials} from './experiment-config.mjs';
import {buildRoutes,describeRoutes,createLaneSelector} from './build-experiment.mjs';
import {createTrialAdapterRouter} from './trial-adapter-router.mjs';
import {runExperiment} from './experiment-runner.mjs';
import {loadFrozenSchedule} from './trial-schedule.mjs';
import {analyzeTrialScope} from './scenario-scope.mjs';
import {freezeLockPathFor,THREE_ARM_DEPLOYMENTS,validateFrozenPilotProtocol,validateSelectedProtocol} from './preflight-three-architecture.mjs';

const EXIT={complete:0,partial:2,gates:3,config:4,usage:5};

const USAGE=`Usage: run-experiment-cli.mjs --config <file> [options]

  --config <file>        deployment configuration (no secrets; see experiment-config.mjs)
  --protocol <json>      protocol file selecting the matrix (defaults to config/protocol.json)
  --pilot                run the protocol's separately frozen non-counted pilot schedule
  --pilot-retry          run the versioned non-counted Functions P1 retry schedule
  --pilot-evidence <dir> isolated evidence directory for --pilot (default: results/non-counted-pilot)
  --limit <n>            limit a run to an initial subset (with --pilot this is non-counted)
  --offset <n>           skip the first n rows after route filters (useful to avoid a prior claim)
  --deployment <name>    restrict to one deployment
  --profile <P1|P2|P3>   restrict to one profile
  --gates <v,v,v,v>      the four measured-study readiness gates, in the order
                         protocolFrozen,deploymentValidated,isolationValidated,verifierValidated
  --concurrency <n>      lanes to run at once (default 3, one per deployment).
                         Trials sharing a deployment share its fixture and always run
                         one-at-a-time inside that lane.
  --deps <file>          module default-exporting {blobVerifier, collectorVerifier,
                         resourceVerifier, denialReader, sessionFactory, httpFactory,
                         aciAdapters keyed by deployment:profile for ACI routes}
  --dry-run              structural config/matrix/scope report only; never proves readiness
  --json                 machine-readable summary on stdout
  --help

A measured run is refused unless all four gates are asserted. A non-counted pilot
uses a separately frozen schedule, its own evidence directory, and never asserts
measured-study gates. Measured evidence requires a locked Azure Blob immutability
policy and an institution-approved retention period. The gates are operator
assertions: this tool cannot verify them.`;

function parseArgs(argv) {
  const options={dryRun:false,json:false};
  for(let index=0;index<argv.length;index++) {
    const arg=argv[index];
    const value=()=>{const v=argv[++index];if(v===undefined) throw new Error(`${arg} requires a value`);return v;};
    switch(arg) {
      case '--config': options.config=value(); break;
      case '--protocol': options.protocol=value(); break;
      case '--deps': options.deps=value(); break;
      case '--pilot':
        if(options.pilotSchedule) throw new Error('choose only one pilot schedule');
        options.pilot=true; options.pilotSchedule='standard'; break;
      case '--pilot-retry':
        if(options.pilotSchedule) throw new Error('choose only one pilot schedule');
        options.pilot=true; options.pilotSchedule='retry'; break;
      case '--pilot-evidence': options.pilotEvidence=value(); break;
      case '--evidence': options.evidence=value(); break;
      case '--concurrency': {
        const raw=value();
        if(!/^\d+$/.test(raw) || Number(raw)<1 || Number(raw)>32) throw new Error('--concurrency must be 1..32');
        options.concurrency=Number(raw); break;
      }
      case '--limit': {
        const raw=value();
        if(!/^\d+$/.test(raw) || Number(raw)<1) throw new Error('--limit must be a positive integer');
        options.limit=Number(raw); break;
      }
      case '--offset': {
        const raw=value();
        if(!/^\d+$/.test(raw)) throw new Error('--offset must be a non-negative integer');
        options.offset=Number(raw); break;
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
const VM_FUNCTIONS_REV4={revision:'azure-proposed-v1-rev4-vm-functions-only-draft',
  matrixSha256:'2ecce88dab8e7a61fa457ee6e27e5c6551a0035528aacd51d6e7502c6c0b0abe',
  ownerDirectionReference:'User instruction in this session to prepare a full 400-row VM/Functions-only plan after removing ACA and stopping ACI.'};
const VM_FUNCTIONS_REV5_IDFIX={revision:'azure-proposed-v1-rev5-vm-functions-idfix',
  matrixSha256:'2bd601c4de01900c318857901b36578b62fff95385f33f2e34a2c05b78a4bee5',
  ownerDirectionReference:'User instruction in this session to prepare a full 400-row VM/Functions-only plan after removing ACA and stopping ACI.'};

export function isOwnerDirectedVmFunctionsRev4(declared) {
  return declared?.protocolRevision===VM_FUNCTIONS_REV4.revision && declared?.sha256===VM_FUNCTIONS_REV4.matrixSha256 &&
    declared?.trials===400 && declared?.ownerDirection?.authorized===true &&
    declared?.ownerDirection?.reference===VM_FUNCTIONS_REV4.ownerDirectionReference;
}

export function isOwnerDirectedVmFunctionsRev5Idfix(declared) {
  return declared?.protocolRevision===VM_FUNCTIONS_REV5_IDFIX.revision && declared?.sha256===VM_FUNCTIONS_REV5_IDFIX.matrixSha256 &&
    declared?.trials===400 && declared?.ownerDirection?.authorized===true &&
    declared?.ownerDirection?.reference===VM_FUNCTIONS_REV5_IDFIX.ownerDirectionReference;
}

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

/** Dry-runs may inspect capabilities, but never request measured dependency construction. */
export function dependencyModeFor(options={}) {
  return options.pilot||options.dryRun?'non_counted_pilot':'measured';
}

/** The frozen digest, as declared by the protocol rather than derived from the file. */
async function readDeclaredMatrix(protocolPath,schedule='measured') {
  try {
    const text=await readFile(protocolPath,'utf8');
    const protocol=JSON.parse(text);
    const matrix=schedule==='retry'?protocol.pilotRetryPlan:schedule==='standard'?protocol.pilotPlan:protocol.matrix;
    if(!matrix || typeof matrix.sha256!=='string' || !/^[0-9a-f]{64}$/.test(matrix.sha256)) return null;
    const sessionDataCapabilities=protocol.sessionDataCapabilities??{};
    if(!sessionDataCapabilities||typeof sessionDataCapabilities!=='object'||Array.isArray(sessionDataCapabilities)||
      Object.values(sessionDataCapabilities).some(value=>value!==true)) return null;
    // The frozen three-arm v2 revision declares the per-arm U6/U8 schedule here
    // instead of in the legacy flat sessionDataCapabilities map.
    const scheduledOn=protocol.u6U8Operationalization?.scheduledOn;
    if(scheduledOn!==undefined&&(!Array.isArray(scheduledOn)||scheduledOn.some(name=>typeof name!=='string'||!name))) return null;
    return {...matrix,protocolRevision:protocol.revision,ownerDirection:protocol.ownerDirection,protocolBytes:Buffer.from(text,'utf8'),
      measuredExecutionEnabled:protocol.readiness?.measuredExecutionEnabled ?? protocol.runner?.measuredExecutionEnabled,
      sessionDataCapabilities,...(scheduledOn===undefined?{}:{u6U8ScheduledOn:[...scheduledOn]})};
  } catch (error) { return null; }
}

/**
 * Session capability follows the config's explicit per-deployment declaration:
 * an arm whose deployment sets sessionDataStore to azure_blob_external_namespace
 * realizes U6/U8 as run-scoped external Blob container namespaces, so its
 * scheduled U6/U8 rows are measurable-but-fixture-gated, never silently
 * not applicable. A scheduled arm without the declaration stays not_applicable
 * (scenario_requires_sessions). Legacy protocols that enumerate
 * sessionDataCapabilities keep their original deps-advertised semantics.
 */
export function sessionCapabilitiesFor(declared,configShape,available={}) {
  const capabilities={};
  for(const deployment of Object.keys(declared?.sessionDataCapabilities??{}))
    capabilities[deployment]=available[deployment]===true;
  for(const deployment of declared?.u6U8ScheduledOn??[]) {
    const store=configShape?.deployments?.[deployment]?.sessionDataStore;
    if(store==='azure_blob_external_namespace') capabilities[deployment]=true;
    else if(store!==undefined) capabilities[deployment]=false;
    // No declaration: leave the arm unset so scope reports it not_applicable.
  }
  return capabilities;
}

/**
 * The deps module is the only thing that knows whether a deployment has attributable
 * denial telemetry. A structural preflight still has to report scope honestly, so it
 * imports the module when one is supplied and reports why it could not when it can't.
 */
async function resolveNetworkCapabilities(options,configShape,routeKeys) {
  if(!options.deps) return {capabilities:{},sessionCapabilities:{},source:'no --deps supplied'};
  try {
    const module=await import(pathToFileURL(resolve(options.deps)).href);
    const exported=module.default ?? module;
    const deps=typeof exported==='function'?await exported({config:configShape,env:process.env,
      // Structural preflight constructs dependencies only to inspect capability.
      // It is never an executed pilot and must not require the measured gates.
      mode:dependencyModeFor(options),routeKeys}):exported;
    const capabilities=deps?.denialReader?.capabilities;
    const sessionCapabilities=deps?.sessionCapabilities??{};
    if(!capabilities || typeof capabilities!=='object')
      return {capabilities:{},sessionCapabilities,source:'deps.denialReader advertises no capabilities',deps};
    return {capabilities,sessionCapabilities,source:'deps.denialReader',deps};
  } catch (error) {
    return {capabilities:{},sessionCapabilities:{},source:`unavailable (${String(error?.message ?? error).split('\n')[0]})`};
  }
}

function selectRows(rows,options) {
  let selected=rows;
  if(options.deployment) selected=selected.filter(row=>row.deployment===options.deployment);
  if(options.profile) selected=selected.filter(row=>row.permission_profile===options.profile);
  const start=options.offset??0;
  selected=selected.slice(start,options.limit===undefined?undefined:start+options.limit);
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

  if(options.evidence) { process.stderr.write('--evidence is local-only and no longer accepted; use --pilot-evidence for non-counted pilot records. Measured evidence uses locked Azure Blob storage.\n'); return EXIT.usage; }
  if(!options.pilot && options.pilotEvidence) { process.stderr.write('--pilot-evidence requires --pilot\n'); return EXIT.usage; }
  if(options.pilot && options.gates?.length) { process.stderr.write('--pilot never accepts measured-study readiness gates\n'); return EXIT.usage; }

  const say=message=>{ if(!options.json) process.stdout.write(`${message}\n`); };

  const defaultProtocol=fileURLToPath(new URL('../config/protocol.json',import.meta.url));
  const protocolPath=resolve(options.protocol??defaultProtocol);
  const declared=await readDeclaredMatrix(protocolPath,options.pilotSchedule??'measured');
  if(!declared) { process.stderr.write('protocol error: schedule metadata is missing or invalid\n'); return EXIT.config; }
  if(declared.protocolRevision==='three-arm-supported-450-v2-pilot-v1'&&!options.pilot) {
    process.stderr.write('protocol error: the three-arm v2 pilot protocol requires --pilot and cannot select a measured schedule\n');
    return EXIT.config;
  }
  if(!options.pilot && !options.dryRun) {
    const requestedGates=gatesFrom(options.gates);
    if(declared.measuredExecutionEnabled!==true || !Object.values(requestedGates).every(Boolean)) {
      process.stderr.write('refusing to run: not all readiness gates are asserted\n'+
        `${GATE_NAMES.map(name=>`  ${name}: ${requestedGates[name]}`).join('\n')}\n`+
        `protocol measuredExecutionEnabled: ${declared.measuredExecutionEnabled===true?'true':'false (missing explicit true)'}\n`+
        'Every gate must be established independently before a measured run.\n');
      return EXIT.gates;
    }
  }
  // Matrix filenames are rooted either at the package directory above
  // 05-DOCKER-STARTER (the original 03-*.csv plans) or at 05-DOCKER-STARTER
  // itself (the config/plan-*.csv three-arm revisions). Both roots are fixed
  // relative to this script, and the declared digest below still authenticates
  // the exact bytes, so resolving through either root fails closed on any
  // substitution. A file that exists at the first root but fails validation is
  // never substituted with a same-named file from the second.
  const starterRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const packageRoot=resolve(starterRoot,'..');
  const matrixCandidates=[resolve(packageRoot,declared.file),resolve(starterRoot,declared.file)];
  let matrixPath,matrix,readError;
  for(const candidate of matrixCandidates) {
    try { matrix=await readFile(candidate); matrixPath=candidate; break; }
    catch (error) { readError=error; }
  }
  if(!matrix) {
    process.stderr.write(`schedule error: ${declared.file} not found under ${packageRoot} or ${starterRoot} (${readError.message})\n`);
    return EXIT.config;
  }
  let rows;
  try {
    rows=loadFrozenSchedule(matrix,createHash('sha256').update(matrix).digest('hex'),{
      allowRepeatedCellsWithinBlock:declared.allowRepeatedCellsWithinBlock===true
    }).rows;
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
  const protocolRoutes=[...new Set(rows.map(row=>`${row.deployment}:${row.permission_profile}`))];
  const requiredScenarios=[...new Set(selected.map(row=>row.scenario_id??row.scenario))];
  try { configShape=await loadExperimentConfigShape(resolve(options.config),{requiredRoutes:protocolRoutes,requiredScenarios}); }
  catch(error) { process.stderr.write(`configuration error: ${error.message}\n`); return EXIT.config; }
  const selectedThreeArmConfig=THREE_ARM_DEPLOYMENTS.filter(deployment=>deployment!=='azure_vm')
    .some(deployment=>Object.hasOwn(configShape.deployments??{},deployment));
  if(selectedThreeArmConfig) {
    try {
      // Pin by exact bytes and code-side identity, never by the mutable revision
      // string. A renamed pilot/candidate remains an unapproved protocol.
      const lockPath=freezeLockPathFor(protocolPath);
      const lock=JSON.parse(await readFile(lockPath,'utf8'));
      const validation={protocolBytes:declared.protocolBytes,matrixBytes:matrix,lock,
        paths:{protocolFile:protocolPath,matrixFile:declared.file,lockFile:lockPath}};
      if(options.pilot) validateFrozenPilotProtocol(validation);
      else validateSelectedProtocol(validation);
    } catch(error) {
      process.stderr.write(`protocol error: three-arm exact-byte freeze-lock validation failed: ${error.message}`+String.fromCharCode(10));
      return EXIT.config;
    }
  }
  const routeKeys=new Set(selected.map(row=>`${row.deployment}:${row.permission_profile ?? row.profile}`));
  // Scope must be reported with the same network capability the run would use, or the
  // preflight claims rows are unsupported that the operator has already configured.
  // Without this the BLOCKER lines for VM/Flex P3 were unclearable by any correct setup.
  const {capabilities:networkCapabilities,sessionCapabilities:availableSessionCapabilities={},source:capabilitySource,deps:preflightDeps}=
    await resolveNetworkCapabilities(options,configShape,routeKeys);
  const sessionCapabilities=sessionCapabilitiesFor(declared,configShape,availableSessionCapabilities);
  const scope=analyzeTrialScope(selected,{networkCapabilities,sessionCapabilities});
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
    let runtimeDependencyPreflight={status:'not_requested'};
    if(options.deps) {
      if(missingCredentials.length) runtimeDependencyPreflight={status:'blocked_missing_credentials',missing:missingCredentials};
      else if(!preflightDeps) runtimeDependencyPreflight={status:'blocked_dependency_construction',reason:capabilitySource};
      else {
        try {
          const resolved=resolveCredentials(configShape,process.env,routeKeys);
          const builtRoutes=buildRoutes(resolved,preflightDeps,{routeKeys});
          createTrialAdapterRouter(builtRoutes,{requiredRoutes:[...routeKeys]});
          const {createExperimentVerifier,verifierCoverage}=await import('./experiment-verifier.mjs');
          const verifier=createExperimentVerifier({config:resolved,denialReader:preflightDeps.denialReader,
            blobVerifier:preflightDeps.blobVerifier,collectorVerifier:preflightDeps.collectorVerifier,
            collectorEffectMonitor:preflightDeps.collectorEffectMonitor,
            resourceVerifier:preflightDeps.resourceVerifier,sessionAnalogVerifier:preflightDeps.sessionAnalogVerifier});
          const coverage=verifierCoverage({denialReader:preflightDeps.denialReader,
            blobVerifier:preflightDeps.blobVerifier,collectorVerifier:preflightDeps.collectorVerifier,
            collectorEffectMonitor:preflightDeps.collectorEffectMonitor,
            resourceVerifier:preflightDeps.resourceVerifier,sessionAnalogVerifier:preflightDeps.sessionAnalogVerifier,
            networkCapabilities,sessionCapabilities,rows:selected});
          runtimeDependencyPreflight={status:'constructed',routeCount:Object.keys(builtRoutes).length,
            verifierConstructed:typeof verifier==='function',resourceVerifierGaps:coverage.resourceProfiles.missing,
            networkVerifierSupported:coverage.networkProfile.supported,networkVerifierReason:coverage.networkProfile.reason,
            evidenceStore:'not checked in dry-run'};
        } catch(error) {
          runtimeDependencyPreflight={status:'blocked_dependency_construction',reason:String(error?.message??error).split('\n')[0]};
        }
      }
    }
    const report={dryRun:true,mode:options.pilot?'non_counted_pilot':'measured',studyCounted:!options.pilot,readiness:'structural_only_not_ready',matrixSha256,plannedMatrixRows:rows.length,
      selectedRows:selected.length,measurableRows:scope.measurable,notApplicableRows:scope.notApplicable,
      unsupportedRows:scope.unsupported,unsupportedByRoute:scope.unsupportedByRoute,
      networkCapabilitySource:capabilitySource,sessionCapabilities,
      missingCredentialVariables:missingCredentials,readinessGates:GATE_NAMES.map(name=>`${name}=unverified`),
      runtimeDependencies:runtimeDependencyPreflight,routes,
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
    deps=typeof exported==='function'?await exported({config,env:process.env,
      mode:options.pilot?'non_counted_pilot':'measured',routeKeys}):exported;
      if(!deps || typeof deps!=='object') throw new Error('deps module must export an object or a factory returning one');
    } catch(error) { process.stderr.write(`deps error: ${error.message}\n`); return EXIT.config; }
  }

  say(`schedule    ${matrixPath}`);
  say(`             ${rows.length} planned trials, ${selected.length} selected`);
  say(`matrix hash ${matrixSha256}`);
  const defaultPilotEvidence=fileURLToPath(new URL('../results/non-counted-pilot',import.meta.url));
  const evidenceDirectory=options.pilot?resolve(options.pilotEvidence ?? defaultPilotEvidence):undefined;
  if(options.pilot) {
    const studyEvidence=resolve(config.evidenceDirectory);
    const overlaps=(a,b)=>{const rel=relative(a,b);return rel==='' || (rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));};
    if(overlaps(evidenceDirectory,studyEvidence) || overlaps(studyEvidence,evidenceDirectory)) {
      process.stderr.write('pilot evidence directory must be separate from measured-study evidence\n'); return EXIT.config;
    }
  }
  say(`mode        ${options.pilot?'NON-COUNTED PILOT':'MEASURED STUDY'}`);
  say(`evidence    ${options.pilot?evidenceDirectory:'locked Azure Blob container (policy checked before first claim)'}`);

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
      blobVerifier:deps.blobVerifier,collectorVerifier:deps.collectorVerifier,
      collectorEffectMonitor:deps.collectorEffectMonitor,resourceVerifier:deps.resourceVerifier,
      sessionAnalogVerifier:deps.sessionAnalogVerifier});
    verifier=built;
    coverage=module.verifierCoverage({denialReader:deps.denialReader,blobVerifier:deps.blobVerifier,
      collectorVerifier:deps.collectorVerifier,collectorEffectMonitor:deps.collectorEffectMonitor,
      resourceVerifier:deps.resourceVerifier,sessionAnalogVerifier:deps.sessionAnalogVerifier,networkCapabilities:deps.denialReader?.capabilities ?? {},
      sessionCapabilities,rows:selected});
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
  let evidenceStore;
  try {
    if(options.pilot) evidenceStore=await buildEvidenceStore(evidenceDirectory);
    else if(deps.evidenceStore && typeof deps.evidenceStore.claim==='function' && typeof deps.evidenceStore.save==='function')
      evidenceStore=deps.evidenceStore;
    else {
      const {createMeasuredEvidenceStoreFromEnvironment}=await import('./azure-measured-evidence-store.mjs');
      const ownerDirectedRev4Study=!options.pilot&&(
        (declared.protocolRevision==='azure-proposed-v1-rev4-aci-draft'&&
          declared.sha256==='1d21c879f34d35d965d258cd427d2e2e0c25538ccb4eec0147f3d9169d5481d4'&&declared.trials===400)||
        isOwnerDirectedVmFunctionsRev4(declared));
      const ownerDirectedRev5IdfixStudy=!options.pilot&&!ownerDirectedRev4Study&&isOwnerDirectedVmFunctionsRev5Idfix(declared);
      evidenceStore=await createMeasuredEvidenceStoreFromEnvironment({env:process.env,
        allowOwnerDirectedRev4Study:ownerDirectedRev4Study,
        ownerDirectionReference:ownerDirectedRev4Study?'file:docs/400-REV4-OWNER-DIRECTED-RETENTION.md':undefined,
        allowOwnerDirectedRev5IdfixStudy:ownerDirectedRev5IdfixStudy,
        ownerDirectionRev5IdfixReference:ownerDirectedRev5IdfixStudy?'file:docs/400-REV5-IDFIX-OWNER-DIRECTED-RETENTION.md':undefined});
    }
  } catch(error) {
    process.stderr.write(`evidence store error: ${error.message}\nNo trials were claimed or executed.\n`);
    return EXIT.gates;
  }
  let results;
  try {
    results=await runExperiment({planBytes:matrix,planSha256:matrixSha256,routes:rawRoutes,
      gates,verifier,evidenceStore,arm:'deterministic',mode:options.pilot?'non_counted_pilot':'measured',rowFilter:selectedIds,
      concurrency:options.concurrency ?? 3,
      laneFor:typeof deps.laneFor==='function'?deps.laneFor:createLaneSelector(config),
      networkCapabilities:deps.denialReader?.capabilities ?? {},sessionCapabilities,
      allowRepeatedCellsWithinBlock:declared.allowRepeatedCellsWithinBlock===true});
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
      say('Scope note: the selected rows all completed, but this is not the full 300-row matrix.');
    say('Note: the four readiness gates are operator assertions; this tool does not verify them.');
  }
  // The exit code describes the run that was asked for, not the matrix that was not.
  // Requiring matrixComplete would make a completed scoped execution report the same
  // code as a halt; matrixComplete remains in the summary as scope information.
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
