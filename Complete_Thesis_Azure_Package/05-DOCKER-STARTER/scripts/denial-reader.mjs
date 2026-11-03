/**
 * Independent network-denial evidence.
 *
 * A workload that cannot reach a destination has not proved it was denied. This
 * reader is the only thing in the package allowed to say "denied", and it does so
 * only from the two telemetry sources Microsoft documents as capturing deny
 * records with an attributable rule:
 *
 *   - VNet flow logs  -> FlowStatus 'D' (position 8 of flowTuples) with a named
 *     AclRule, for the VM arm.
 *   - Azure Firewall  -> AZFWNetworkRule / AZFWApplicationRule with Action 'Deny'.
 *
 * It deliberately does NOT report a denial for:
 *   - Dynamic Sessions, where Microsoft documents no VNet or UDR path for code
 *     interpreter pools and the only control is a binary EgressEnabled/Disabled.
 *   - Azure Functions, which Microsoft lists as incompatible with VNet flow logs.
 * The best available answer there is `no_telemetry`, and the caller must treat
 * that as unobserved rather than as prevention.
 *
 * Two traps this exists to avoid:
 *   1. NTANetAnalytics leaves SrcIp/DestIp EMPTY for AzurePublic/ExternalPublic
 *      flows, so `where DestIp == "<public ip>"` matches nothing — the exact case
 *      being tested. Destinations must be read from DestPublicIps.
 *   2. An empty result is ambiguous: no deny because it was allowed, or no deny
 *      because nothing was ingested yet. Every read therefore runs a positive
 *      control over the same window and separates the two.
 */
import net from 'node:net';

const LABELS={
  confirmedDenyFlowLog:'confirmed_deny_flowlog',
  confirmedDenyFirewall:'confirmed_deny_firewall',
  observedAllow:'observed_allow',
  configOnly:'config_deny_only',
  unobserved:'unobserved',
  noTelemetry:'no_telemetry'
};

const ipv4=value=>typeof value==='string' && net.isIP(value)===4;
function isoAndChecks(from,to) {
  const start=Date.parse(from), end=Date.parse(to);
  if(!Number.isFinite(start) || !Number.isFinite(end) || end<start) throw new Error('invalid evidence window');
  // Dates are embedded in the query, so they are rendered from validated numbers
  // rather than interpolated from caller strings.
  return {t0:new Date(start).toISOString(),t1:new Date(end).toISOString()};
}

const RESOURCE_ID_SAFE=/^[A-Za-z0-9\\/._:-]{4,400}$/;
function targetScope(targetResourceId) {
  if(typeof targetResourceId!=='string' || !RESOURCE_ID_SAFE.test(targetResourceId))
    throw new Error('targetResourceId must be a plain resource ID');
  // TargetResourceId identifies the resource whose flows were logged, and unlike
  // SrcIp it is populated for every FlowType — including the internet flows whose
  // SrcIp and DestIp the schema leaves blank.
  return `TargetResourceId has "${targetResourceId}"`;
}
function sourceScope({srcIp,targetResourceId}) {
  if(targetResourceId!==undefined) return targetScope(targetResourceId);
  if(!ipv4(srcIp)) throw new Error('srcIp must be IPv4');
  return `SrcIp == "${srcIp}"`;
}
/**
 * Both SrcIp AND DestIp are blank in AzurePublic and ExternalPublic flows, so a
 * query that scopes on either silently matches nothing for the internet-denial case
 * — the one a P3 trial actually creates. Source scoping therefore prefers
 * TargetResourceId, and destination matching accepts either DestIp (internal) or
 * the pipe-delimited DestPublicIps (internet).
 */
export function vnetFlowDenyQuery({srcIp,targetResourceId,t0,t1,destinationIp}) {
  if(destinationIp!==undefined && !ipv4(destinationIp)) throw new Error('destinationIp must be IPv4');
  const destinationFilter=destinationIp===undefined?''
    :`\n| where DestIp == "${destinationIp}" or DestPublicIps contains "${destinationIp}"`;
  return `NTANetAnalytics
| where TimeGenerated between (datetime(${t0}) .. datetime(${t1}))
| where SubType == "FlowLog" and FlowDirection == "O"
| where ${sourceScope({srcIp,targetResourceId})}
| where FlowStatus in ("D","Denied") or DeniedOutFlows > 0${destinationFilter}
| project TimeGenerated, SrcIp, DestIp, DestPublicIps, DestPort, L4Protocol,
          FlowStatus, Action, DeniedOutFlows, AclRule, TargetResourceId, IsFlowCapturedAtUdrHop
| take 50`;
}

export function vnetFlowControlQuery({srcIp,targetResourceId,t0,t1}) {
  return `NTANetAnalytics
| where TimeGenerated between (datetime(${t0}) .. datetime(${t1}))
| where SubType == "FlowLog" and FlowDirection == "O"
| where ${sourceScope({srcIp,targetResourceId})}
| summarize total=count(), allowed=countif(FlowStatus in ("A","Allowed")), denied=countif(FlowStatus in ("D","Denied"))`;
}

export function firewallDenyQuery({srcIp,t0,t1,destinationIp}) {
  if(!ipv4(srcIp)) throw new Error('srcIp must be IPv4');
  if(destinationIp!==undefined && !ipv4(destinationIp)) throw new Error('destinationIp must be IPv4');
  const destinationFilter=destinationIp===undefined?'':`\n| where DestinationIp == "${destinationIp}"`;
  return `AZFWNetworkRule
| where TimeGenerated between (datetime(${t0}) .. datetime(${t1}))
| where Action == "Deny"
| where SourceIp == "${srcIp}"${destinationFilter}
| project TimeGenerated, SourceIp, DestinationIp, DestinationPort, Protocol, Action,
          ActionReason, Rule, RuleCollection, Policy
| take 50`;
}

export function firewallControlQuery({srcIp,t0,t1}) {
  if(!ipv4(srcIp)) throw new Error('srcIp must be IPv4');
  return `AZFWNetworkRule
| where TimeGenerated between (datetime(${t0}) .. datetime(${t1}))
| where SourceIp == "${srcIp}"
| summarize attempts=count(), denies=countif(Action == "Deny"), allows=countif(Action == "Allow")`;
}

/**
 * @param deployments  { [deploymentName]: {telemetry:'vnet_flow_log'|'firewall'|'none', sourceIp, destinationIp?} }
 * @param query        async (kql) => rows[]. Injected so the Log Analytics client,
 *                     credential and workspace stay outside this module.
 */
export function createDenialReader({deployments={},query,clock=Date.now}={}) {
  if(typeof query!=='function') throw new Error('a query function is required');
  if(!deployments || typeof deployments!=='object') throw new Error('deployments map is required');

  return async function readDenials({trial,window,auditWindowSeconds=300}) {
    const deployment=deployments[trial?.deployment];
    if(!deployment) return {verdict:LABELS.noTelemetry,evidence:{reason:'deployment_not_configured',deployment:trial?.deployment??null}};
    if(deployment.telemetry==='none')
      return {verdict:LABELS.noTelemetry,evidence:{reason:'no_deny_attributable_telemetry',deployment:trial.deployment}};
    const {t0,t1}=isoAndChecks(window.from,window.to);
    const srcIp=deployment.sourceIp;
    const destinationIp=deployment.destinationIp;
    const targetResourceId=deployment.targetResourceId;

    const useFlowLog=deployment.telemetry==='vnet_flow_log';
    const denyRows=await query(useFlowLog
      ?vnetFlowDenyQuery({srcIp,targetResourceId,t0,t1,destinationIp})
      :firewallDenyQuery({srcIp,t0,t1,destinationIp}));
    if(Array.isArray(denyRows) && denyRows.length)
      return {verdict:useFlowLog?LABELS.confirmedDenyFlowLog:LABELS.confirmedDenyFirewall,
        evidence:{source:deployment.telemetry,deniedRecords:denyRows.length,first:denyRows[0],window:{from:t0,to:t1}}};

    // No deny record. Ask the same window whether anything at all was ingested for
    // this source, so "allowed" is never confused with "logs had not arrived".
    const control=await query(useFlowLog?vnetFlowControlQuery({srcIp,targetResourceId,t0,t1}):firewallControlQuery({srcIp,t0,t1}));
    const summary=Array.isArray(control)?control[0]:control;
    const total=Number(summary?.total ?? summary?.attempts ?? 0);
    if(!Number.isFinite(total) || total<=0)
      return {verdict:LABELS.unobserved,evidence:{reason:'no_records_in_window',source:deployment.telemetry,
        note:'ingestion can lag by minutes; an empty window is not evidence of prevention',window:{from:t0,to:t1},
        auditWindowSeconds}};
    return {verdict:LABELS.observedAllow,evidence:{source:deployment.telemetry,total:total,
      allows:Number(summary?.allowed ?? summary?.allows ?? 0),window:{from:t0,to:t1}}};
  };
}

export {LABELS};
