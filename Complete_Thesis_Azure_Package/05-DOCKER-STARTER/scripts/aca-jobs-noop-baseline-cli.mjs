/**
 * Pilot-only CLI for the ACA Jobs no-op / positive-control baseline.
 *
 * This is the executable entrypoint the ACA Jobs P3 design refers to: it makes
 * scripts/aca-jobs-noop-baseline.mjs actually invocable against the SAME
 * resources a measured trial would use, without going through the measured
 * runner or its gates:
 *
 *   - exact Jobs execution: the real ACA Jobs ARM client
 *     (createAcaJobsExecutionClient) against the configured P3 job, with the
 *     config's digest-pinned agent image and container resources, so the
 *     baseline characterizes the exact bits measured trials run;
 *   - exact evidence path: Log Analytics queries go through the same shared
 *     transport the live dependency reader uses (createLogAnalyticsQuery from
 *     deps-live.mjs), and the positive-control query is the SAME
 *     firewallApplicationRuleQuery the Jobs P3 candidate reader issues —
 *     window-bounded by each execution's ARM startTime/endTime and
 *     target-scoped (source AND exact FQDN AND port; never source-only);
 *   - exact identities: the explicit control-plane and data-plane user-assigned
 *     identities the ACA arms require, regardless of THESIS_TOKEN_PROVIDER_MODE.
 *
 * What it deliberately never does:
 *   - it never sets, updates or reads THESIS_NETWORK_NOOP_BASELINE_VALIDATED;
 *     the report is the operator's assertion input, nothing more;
 *   - it never unlocks measured execution — there is no mode flag, no gate is
 *     satisfied, and no readiness state is written anywhere;
 *   - it never treats an observed clean no-op as validation: only the positive
 *     allow-control observed in its own ARM window can validate observability.
 *
 * Usage:
 *   node scripts/aca-jobs-noop-baseline-cli.mjs \
 *     --config config/experiment.azure-three-arm.example.json \
 *     --control-url https://<allowed-health-host>/<path> \
 *     [--run-id-prefix aca-jobs-baseline-20261106] \
 *     [--out results/aca-jobs-noop-baseline-report.json] \
 *     --non-counted-pilot
 *
 * Environment contract (all required; fail closed before any ARM call):
 *   THESIS_LOG_ANALYTICS_WORKSPACE_ID            Log Analytics workspace GUID
 *   THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID  GUID (ARM job execution)
 *   THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID     GUID (Log Analytics query)
 *   THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR          IPv4 CIDR of the Jobs subnet
 *   THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT     1..65535 (the P3 reader port)
 *
 * The two identity client IDs must differ, exactly as deps-live.mjs demands.
 * The source CIDR and destination port are the same values the Jobs P3
 * candidate reader is configured with, so the baseline queries the same scope
 * measured evidence would come from.
 *
 * Exit codes: 0 = baseline validated (clean no-op + observed positive control);
 *             2 = pilot completed but not validated (collision / unobserved —
 *                 the report explains which and why);
 *             1 = usage, configuration or environment error (message on stderr).
 */
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {validateExperimentConfig} from './experiment-config.mjs';
import {createLogAnalyticsQuery} from './deps-live.mjs';
import {createAcaJobsExecutionClient} from './aca-jobs-execution.mjs';
import {createAzureRestTokenProvider} from './azure-inventory.mjs';
import {firewallApplicationRuleQuery} from './denial-reader.mjs';
import {BASELINE_STATUS,createAcaJobsNoopBaseline,evaluateNoopBaseline,
  validateBaselineControlUrl} from './aca-jobs-noop-baseline.mjs';

const ACA_LOG_ANALYTICS_SCOPE='https://api.loganalytics.io/.default';
const GUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPV4_CIDR_PATTERN=/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
const SAFE_RUN_ID=/^[A-Za-z0-9_-]{1,150}$/;
const UTC_STAMP=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const USAGE='usage: node scripts/aca-jobs-noop-baseline-cli.mjs --config CONFIG.json '+
  '--control-url https://allowed.example.test/health '+
  '[--run-id-prefix PREFIX] [--out REPORT.json] --non-counted-pilot';

function parseArguments(args) {
  const parsed={configPath:undefined,controlUrl:undefined,outPath:undefined,runIdPrefix:undefined,
    acknowledged:false};
  for(let index=0;index<args.length;index+=1) {
    const argument=args[index];
    if(argument==='--non-counted-pilot') {parsed.acknowledged=true;continue;}
    const value=args[index+1];
    if(argument==='--config') parsed.configPath=value;
    else if(argument==='--control-url') parsed.controlUrl=value;
    else if(argument==='--out') parsed.outPath=value;
    else if(argument==='--run-id-prefix') parsed.runIdPrefix=value;
    else throw new Error(`unknown argument: ${argument}\n${USAGE}`);
    if(typeof value!=='string' || value.length===0)
      throw new Error(`${argument} requires a value\n${USAGE}`);
    index+=1;
  }
  return parsed;
}

function requireGuid(env,name) {
  const value=env[name];
  if(typeof value!=='string' || !value.trim()) throw new Error(`missing required environment: ${name}`);
  if(!GUID_PATTERN.test(value.trim())) throw new Error(`${name} must be a GUID`);
  return value.trim().toLowerCase();
}

function requireCidr(env,name) {
  const value=env[name];
  if(typeof value!=='string' || !value.trim()) throw new Error(`missing required environment: ${name}`);
  const match=IPV4_CIDR_PATTERN.exec(value.trim());
  if(!match ||!/^(?:0|[1-9]|[12]\d|3[0-2])$/.test(match[2])) throw new Error(`${name} must be an IPv4 CIDR`);
  const octets=match[1].split('.').map(Number);
  if(octets.some(octet=>octet>255)) throw new Error(`${name} must be an IPv4 CIDR`);
  return `${match[1]}/${Number(match[2])}`;
}

function requirePort(env,name) {
  const value=env[name];
  if(typeof value!=='string' || !value.trim()) throw new Error(`missing required environment: ${name}`);
  const port=Number(value.trim());
  if(!Number.isInteger(port) || port<1 || port>65535)
    throw new Error(`${name} must be an integer from 1 to 65535`);
  return port;
}

/**
 * Census KQL for the no-op window. Unlike the attribution query this is
 * deliberately source-scoped: the no-op command performs no request, so EVERY
 * application-rule record inside the execution's ARM window from the Jobs
 * source scope is by construction unrelated platform traffic — the exact
 * collision surface the baseline exists to measure. It can never become deny
 * evidence; the harness reduces it to action/fqdn/port/protocol fingerprints
 * and the report treats any record as a collision. The projection carries only
 * fingerprint fields — no TargetUrl or raw message text a shared pipeline
 * might carry secrets in.
 */
export function firewallApplicationRuleCensusQuery({sourceCidr,t0,t1}={}) {
  if(typeof sourceCidr!=='string' || !IPV4_CIDR_PATTERN.test(sourceCidr))
    throw new TypeError('sourceCidr must be an IPv4 CIDR');
  for(const [name,value] of [['t0',t0],['t1',t1]])
    if(typeof value!=='string' || !UTC_STAMP.test(value))
      throw new TypeError(`${name} must be an ISO-8601 UTC timestamp`);
  return ['AZFWApplicationRule',
    `| where TimeGenerated between (datetime(${t0}) .. datetime(${t1}))`,
    `| where ipv4_is_in_range(SourceIp, "${sourceCidr}")`,
    '| project TimeGenerated, SourceIp, Action, Fqdn, DestinationPort, Protocol',
    '| order by TimeGenerated asc',
    '| take 1000'].join('\n');
}

/**
 * The readFirewallEvents callback the baseline harness consumes. Every query
 * is bounded by the harness-supplied ARM execution window (rendered to
 * canonical UTC, refused when unparseable so an invalid window can never
 * become a passing negative), and the positive-control query is the exact
 * target-scoped firewallApplicationRuleQuery the Jobs P3 candidate reader
 * uses — source AND exact FQDN AND port, never source-only.
 */
export function createBaselineFirewallReader({sourceCidr,destinationPort,query}={}) {
  if(typeof query!=='function') throw new TypeError('query must be a function');
  if(typeof sourceCidr!=='string' || !IPV4_CIDR_PATTERN.test(sourceCidr))
    throw new TypeError('sourceCidr must be an IPv4 CIDR');
  if(!Number.isInteger(destinationPort) || destinationPort<1 || destinationPort>65535)
    throw new TypeError('destinationPort must be an integer from 1 to 65535');
  const renderWindow=window=>{
    const start=Date.parse(window?.from),end=Date.parse(window?.to);
    if(!Number.isFinite(start) || !Number.isFinite(end) || end<start)
      throw new Error('baseline evidence window is invalid; refusing an unbounded query');
    return {t0:new Date(start).toISOString(),t1:new Date(end).toISOString()};
  };
  return async function readFirewallEvents({window,kind,targetFqdn}={}) {
    const {t0,t1}=renderWindow(window);
    if(kind==='allow') {
      if(typeof targetFqdn!=='string' || !targetFqdn)
        throw new Error('the positive control requires its target FQDN');
      // Same builder, same target scoping as the measured Jobs P3 read.
      return query(firewallApplicationRuleQuery({sourceCidr,destinationFqdn:targetFqdn.toLowerCase(),
        destinationPort,t0,t1}));
    }
    if(kind==='all') return query(firewallApplicationRuleCensusQuery({sourceCidr,t0,t1}));
    throw new Error(`unknown baseline query kind: ${kind}`);
  };
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
}

/**
 * Load and validate an experiment config for the pilot without hardcoding a
 * protocol revision: the file's own declared routes become the required
 * routes, so a three-arm config validates exactly like the runner validates
 * it. Structure (URLs, kinds, resources, per-arm shapes) is still fully
 * enforced by validateExperimentConfig.
 */
async function loadConfigForPilot(path) {
  const text=await readFile(path,'utf8');
  let raw;
  try {raw=JSON.parse(text);} catch (error) {throw new Error(`config is not valid JSON: ${error.message}`);}
  const routeKeys=[...new Set((Array.isArray(raw?.routes)?raw.routes:[])
    .map(route=>typeof route?.deployment==='string' && typeof route?.profile==='string'
      ?`${route.deployment}:${route.profile}`:null)
    .filter(route=>route!==null))];
  if(routeKeys.length===0) throw new Error('the config declares no deployment/profile routes');
  return validateExperimentConfig(raw,{requiredRoutes:routeKeys});
}

/**
 * Run the pilot. Returns {exitCode,report}; performs no process output and
 * mutates nothing outside the injected writeFile. Throws on usage,
 * configuration and environment errors (the CLI maps those to exit 1).
 *
 * @param configPath  experiment config path (ignored when config is injected)
 * @param config      validated experiment config, injectable for tests
 * @param env         environment to read the contract from (never written)
 * @param args        CLI arguments after the script name
 * @param now         clock for run IDs and the report timestamp
 * @param inject      {credentialModules, jobsExecutionClient, logQuery, writeFile}
 */
export async function runAcaJobsNoopBaselineCli({configPath,config:injectedConfig,env=process.env,
  args=[],now=()=>new Date(),inject={}}={}) {
  const parsed=parseArguments(args);
  if(!parsed.acknowledged)
    throw new Error('this CLI is pilot-only evidence gathering: pass --non-counted-pilot to acknowledge '+
      'the run is non-counted and cannot validate readiness by itself');
  if(typeof parsed.controlUrl!=='string')
    throw new Error(`--control-url is required\n${USAGE}`);
  const controlTarget=validateBaselineControlUrl(parsed.controlUrl);
  if(parsed.runIdPrefix!==undefined && !SAFE_RUN_ID.test(parsed.runIdPrefix))
    throw new Error('--run-id-prefix must be a short alphanumeric identifier');

  const effectiveConfigPath=parsed.configPath??configPath;
  if(injectedConfig===undefined && typeof effectiveConfigPath!=='string')
    throw new Error(`--config is required\n${USAGE}`);
  const config=injectedConfig??await loadConfigForPilot(effectiveConfigPath);
  const deployment=config?.deployments?.azure_container_apps_jobs;
  if(deployment?.kind!=='aca_job')
    throw new Error('the experiment config has no azure_container_apps_jobs deployment');
  const jobName=deployment.jobNames?.P3;
  if(typeof jobName!=='string' || jobName.length===0)
    throw new Error('the ACA Jobs deployment must configure the P3 job the baseline executes');
  // Fail closed on every environment input before anything is constructed.
  const workspaceId=requireGuid(env,'THESIS_LOG_ANALYTICS_WORKSPACE_ID');
  const controlPlaneClientId=requireGuid(env,'THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID');
  const dataPlaneClientId=requireGuid(env,'THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID');
  if(controlPlaneClientId===dataPlaneClientId)
    throw new Error('THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID and THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID '+
      'must be different identities');
  const sourceCidr=requireCidr(env,'THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR');
  const destinationPort=requirePort(env,'THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT');

  const {credentialModules,jobsExecutionClient,logQuery:injectedLogQuery,
    writeFile:injectedWriteFile}=inject;
  // Lazy direct Azure Identity providers, exactly like deps-live.mjs builds for
  // the ACA arms: construction stays offline, and only these explicit
  // user-assigned identities are used — never the Azure CLI.
  const tokenProviderFor=clientId=>{
    let provider;
    return async scope=>{
      provider??=await createAzureRestTokenProvider({env:{...env,AZURE_CLIENT_ID:clientId},
        ...(credentialModules===undefined?{}:{credentialModules})});
      return provider(scope);
    };
  };
  const getControlPlaneToken=tokenProviderFor(controlPlaneClientId);
  const getDataPlaneToken=tokenProviderFor(dataPlaneClientId);
  const client=jobsExecutionClient??createAcaJobsExecutionClient({
    subscriptionId:deployment.subscriptionId,resourceGroup:deployment.resourceGroup,jobName,
    getToken:getControlPlaneToken,apiVersion:deployment.apiVersion});
  const query=injectedLogQuery??createLogAnalyticsQuery({workspaceId,
    getToken:()=>getDataPlaneToken(ACA_LOG_ANALYTICS_SCOPE)});
  const readFirewallEvents=createBaselineFirewallReader({sourceCidr,destinationPort,query});

  const executionTimeoutMs=Math.min(deployment.executionTimeoutMs??120000,600000);
  const baseline=createAcaJobsNoopBaseline({client,jobName,agentImage:deployment.agentImage,
    resources:deployment.resources,executionTimeoutMs,readFirewallEvents});
  const stamp=utcStamp(now());
  const prefix=parsed.runIdPrefix??`aca-jobs-baseline-${stamp}`;

  const noop=await baseline.runNoop({runId:`${prefix}-noop`});
  const control=await baseline.runPositiveControl({runId:`${prefix}-control`,
    allowedUrl:controlTarget.href});
  const verdict=evaluateNoopBaseline({noop,control});

  const report={
    schema:'aca_jobs_noop_baseline_report_v1',
    pilot:'non-counted',
    generatedAt:now().toISOString(),
    job:{deployment:'azure_container_apps_jobs',profile:'P3',jobName,image:deployment.agentImage,
      resources:deployment.resources,executionTimeoutMs,apiVersion:deployment.apiVersion},
    evidenceScope:{telemetry:'azure_firewall_application_rule',sourceCidr,destinationPort,
      note:'every query is bounded by its execution\'s ARM startTime/endTime; the positive-control '+
        'query is the same target-scoped application-rule query the Jobs P3 reader issues'},
    noop,control,verdict,
    readiness:{
      setsNoopBaselineValidatedFlag:false,unlocksMeasuredExecution:false,
      note:'assertion input for THESIS_NETWORK_NOOP_BASELINE_VALIDATED only: this pilot never sets '+
        'that flag and never unlocks measured execution. An observed clean no-op alone is insufficient; '+
        'only the matching positive allow-control validates observability.'}
  };
  if(parsed.outPath!==undefined)
    await (injectedWriteFile??writeFile)(parsed.outPath,`${JSON.stringify(report,null,2)}\n`,'utf8');
  return {exitCode:verdict.status===BASELINE_STATUS.validated?0:2,report};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  runAcaJobsNoopBaselineCli({args:process.argv.slice(2)})
    .then(({exitCode,report})=>{
      process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
      process.exitCode=exitCode;
    })
    .catch(error=>{console.error(error.message);process.exitCode=1;});
}
