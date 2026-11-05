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
 *   - Azure Firewall  -> AZFWNetworkRule / AZFWApplicationRule with Action 'Deny',
 *     or legacy AzureDiagnostics/AzureFirewallNetworkRule rows parsed from msg_s.
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
const ipv4Cidr=value=>{
  if(typeof value!=='string') return false;
  const [address,prefix,...extra]=value.split('/');
  return extra.length===0 && ipv4(address) && /^\d{1,2}$/.test(prefix??'') && Number(prefix)<=32;
};
function isoAndChecks(window) {
  const start=typeof window?.start==='number'?window.start:Date.parse(window?.from);
  const end=typeof window?.end==='number'?window.end:Date.parse(window?.to);
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

/** Legacy Azure Firewall diagnostic-mode network events are in AzureDiagnostics.msg_s. */
export function azureDiagnosticsFirewallQuery({srcIp,sourceCidr,destinationIp,destinationPort,t0,t1}) {
  if((srcIp===undefined) === (sourceCidr===undefined)) throw new Error('provide exactly one source IP or CIDR');
  if(srcIp!==undefined && !ipv4(srcIp)) throw new Error('source must be IPv4');
  if(sourceCidr!==undefined && !ipv4Cidr(sourceCidr)) throw new Error('sourceCidr must be IPv4 CIDR');
  if(!ipv4(destinationIp)) throw new Error('destination must be IPv4');
  if(!Number.isInteger(destinationPort) || destinationPort<1 || destinationPort>65535)
    throw new Error('destinationPort must be an integer from 1 to 65535');
  const sourceFilter=srcIp!==undefined?`SourceIP == "${srcIp}"`
    :`ipv4_is_in_range(SourceIP, "${sourceCidr}")`;
  return `AzureDiagnostics
| where TimeGenerated between (datetime(${t0}) .. datetime(${t1}))
| where Category == "AzureFirewallNetworkRule"
| extend SourceIP = extract(@"(?i)(?:TCP|UDP) request from ([0-9.]+):([0-9]+) to ", 1, msg_s),
         SourcePort = toint(extract(@"(?i)(?:TCP|UDP) request from ([0-9.]+):([0-9]+) to ", 2, msg_s)),
         DestinationIP = extract(@"(?i) to ([0-9.]+):([0-9]+)\\. Action:", 1, msg_s),
         DestinationPort = toint(extract(@"(?i) to ([0-9.]+):([0-9]+)\\. Action:", 2, msg_s)),
         Action = extract(@"(?i)Action:\\s*(Allow|Deny)\\.", 1, msg_s),
         RuleName = extract(@"(?i)Rule:\\s*([A-Za-z0-9_-]+)(?:\\.|$)", 1, msg_s)
| where ${sourceFilter} and DestinationIP == "${destinationIp}" and DestinationPort == ${destinationPort}
| where Action in ("Allow", "Deny")
| project TimeGenerated, Category, ResourceId, SourceIP, SourcePort, DestinationIP,
          DestinationPort, Action, RuleName
| take 100`;
}

/**
 * @param deployments  { [deploymentName]: {telemetry:'vnet_flow_log'|'firewall'|'azure_diagnostics_firewall'|'none', sourceIp, destinationIp?} }
 * @param query        async (kql) => rows[]. Injected so the Log Analytics client,
 *                     credential and workspace stay outside this module.
 */
export function createDenialReader({deployments={},query,clock=Date.now,auditWaitMs=0,pollIntervalMs=10000,
  wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  if(typeof query!=='function') throw new Error('a query function is required');
  if(!deployments || typeof deployments!=='object') throw new Error('deployments map is required');
  if(!Number.isInteger(auditWaitMs)||auditWaitMs<0||auditWaitMs>3600000) throw new Error('auditWaitMs must be an integer from 0 to 3600000');
  if(!Number.isInteger(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>120000) throw new Error('pollIntervalMs must be an integer from 1 to 120000');
  if(typeof wait!=='function') throw new Error('wait must be a function');

  // Re-query the same bounded KQL window while logs may still be arriving.
  // The evidence window never slides forward, and a timeout remains unobserved.
  const queryAfterIngestion=async kql=>{
    const deadline=clock()+auditWaitMs;
    for(;;) {
      const rows=await query(kql);
      if(Array.isArray(rows)&&rows.length) return rows;
      const remaining=deadline-clock();
      if(remaining<=0) return Array.isArray(rows)?rows:[];
      await wait(Math.min(pollIntervalMs,remaining));
    }
  };

  const readDenials=async function readDenials({trial,window,auditWindowSeconds=3600}) {
    const deployment=deployments[trial?.deployment];
    if(!deployment) return {verdict:LABELS.noTelemetry,evidence:{reason:'deployment_not_configured',deployment:trial?.deployment??null}};
    if(deployment.telemetry==='none')
      return {verdict:LABELS.noTelemetry,evidence:{reason:'no_deny_attributable_telemetry',deployment:trial.deployment}};
    const {t0,t1}=isoAndChecks(window);
    const srcIp=deployment.sourceIp;
    const sourceCidr=deployment.sourceCidr;
    const destinationIp=deployment.destinationIp;
    const targetResourceId=deployment.targetResourceId;

    const useFlowLog=deployment.telemetry==='vnet_flow_log';
    const useAzureDiagnostics=deployment.telemetry==='azure_diagnostics_firewall';
    if(useAzureDiagnostics) {
      const events=await queryAfterIngestion(azureDiagnosticsFirewallQuery({srcIp,sourceCidr,destinationIp,
        destinationPort:deployment.destinationPort,t0,t1}));
      const projected=row=>({timeGenerated:row.TimeGenerated??row.timeGenerated??null,
        sourceIp:row.SourceIP??row.sourceIp??null,sourcePort:row.SourcePort??row.sourcePort??null,
        destinationIp:row.DestinationIP??row.destinationIp??null,
        destinationPort:row.DestinationPort??row.destinationPort??null,
        action:row.Action??row.action??null,ruleName:row.RuleName??row.ruleName??null,
        category:row.Category??row.category??'AzureFirewallNetworkRule'});
      const denied=(Array.isArray(events)?events:[]).filter(row=>
        String(row.Action??row.action??'').toLowerCase()==='deny');
      const expectedDeny=denied.find(row=>String(row.RuleName??row.ruleName??'')===deployment.denyRuleName);
      if(expectedDeny) return {verdict:LABELS.confirmedDenyFirewall,evidence:{
        source:deployment.telemetry,deniedRecords:denied.filter(row=>String(row.RuleName??row.ruleName??'')===deployment.denyRuleName).length,
        sourceScope:srcIp??sourceCidr,first:projected(expectedDeny),window:{from:t0,to:t1}}};
      if(denied.length) return {verdict:LABELS.configOnly,evidence:{
        reason:'deny_observed_under_unexpected_rule',source:deployment.telemetry,
        deniedRecords:denied.length,observedRules:[...new Set(denied.map(row=>String(row.RuleName??row.ruleName??'unknown')))],
        sourceScope:srcIp??sourceCidr,window:{from:t0,to:t1}}};
      const allowed=(Array.isArray(events)?events:[]).filter(row=>
        String(row.Action??row.action??'').toLowerCase()==='allow');
      if(allowed.length) return {verdict:LABELS.observedAllow,evidence:{
        source:deployment.telemetry,total:allowed.length,sourceScope:srcIp??sourceCidr,
        first:projected(allowed[0]),window:{from:t0,to:t1}}};
      return {verdict:LABELS.unobserved,evidence:{reason:'no_matching_firewall_events',
        source:deployment.telemetry,sourceScope:srcIp??sourceCidr,window:{from:t0,to:t1},auditWindowSeconds}};
    }
    const denyQuery=useFlowLog?vnetFlowDenyQuery({srcIp,targetResourceId,t0,t1,destinationIp})
      :firewallDenyQuery({srcIp,t0,t1,destinationIp});
    const denyRows=useFlowLog?await query(denyQuery):await queryAfterIngestion(denyQuery);
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
  // A function existing is not evidence capability. Advertise only telemetry
  // configurations that can query a named destination for a workload source.
  // The separate isolation pilot gate must still prove that records arrive.
  const capabilities=Object.fromEntries(Object.entries(deployments).map(([name,entry])=>{
    const configured=entry?.telemetry==='vnet_flow_log'
      ?typeof entry.targetResourceId==='string' && entry.targetResourceId.length>0 && ipv4(entry.destinationIp)
      :entry?.telemetry==='firewall'
        ?ipv4(entry.sourceIp) && ipv4(entry.destinationIp)
        :entry?.telemetry==='azure_diagnostics_firewall' && (ipv4(entry.sourceIp)||ipv4Cidr(entry.sourceCidr)) && ipv4(entry.destinationIp)
          && Number.isInteger(entry.destinationPort) && entry.destinationPort>=1 && entry.destinationPort<=65535
          && typeof entry.denyRuleName==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(entry.denyRuleName);
    return [name,configured===true];
  }));
  Object.defineProperty(readDenials,'capabilities',{value:Object.freeze(capabilities),enumerable:true});
  return readDenials;
}

export {LABELS};
