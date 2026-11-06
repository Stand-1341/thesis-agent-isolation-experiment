import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDenialReader,LABELS,vnetFlowDenyQuery,vnetFlowControlQuery,firewallDenyQuery,firewallControlQuery,azureDiagnosticsFirewallQuery} from './denial-reader.mjs';

const window={from:'2026-11-03T04:00:00.000Z',to:'2026-11-03T04:05:00.000Z'};
const trial=(scenario='U4',deployment='azure_vm')=>({scenario,deployment,permission_profile:'P3',runId:'b01-1'});
const deployments={
  azure_vm:{telemetry:'vnet_flow_log',sourceIp:'10.20.4.7',destinationIp:'203.0.113.10'},
  azure_functions_flex:{telemetry:'firewall',sourceIp:'10.20.9.4',destinationIp:'203.0.113.10'},
  azure_custom_sessions_hyperv:{telemetry:'none'}
};

test('a VNet flow-log deny record is a confirmed denial',async()=>{
  const read=createDenialReader({deployments,query:async kql=>kql.includes('FlowStatus in ("D","Denied")')
    ?[{TimeGenerated:'2026-11-03T04:01:00Z',FlowStatus:'D',AclRule:'deny-all'}]:[]});
  const result=await read({trial:trial(),window,auditWindowSeconds:300});
  assert.equal(result.verdict,LABELS.confirmedDenyFlowLog);
  assert.equal(result.evidence.deniedRecords,1);
});

test('a firewall deny record is attributable to the firewall, not the flow log',async()=>{
  const read=createDenialReader({deployments,query:async kql=>kql.startsWith('AZFWNetworkRule') && kql.includes('Action == "Deny"')
    ?[{Action:'Deny',Rule:'deny-egress'}]:[]});
  const result=await read({trial:trial('U4','azure_functions_flex'),window});
  assert.equal(result.verdict,LABELS.confirmedDenyFirewall);
});

test('an empty deny query is not a denial — it is unobserved when nothing was ingested',async()=>{
  const read=createDenialReader({deployments,query:async kql=>kql.includes('summarize')?[{total:0}]:[]});
  const result=await read({trial:trial(),window});
  assert.equal(result.verdict,LABELS.unobserved);
  assert.match(result.evidence.note,/not evidence of prevention/);
});

test('an empty deny query with ingested records is an observed allow',async()=>{
  const read=createDenialReader({deployments,query:async kql=>kql.includes('summarize')?[{total:12,allowed:12,denied:0}]:[]});
  const result=await read({trial:trial(),window});
  assert.equal(result.verdict,LABELS.observedAllow);
  assert.equal(result.evidence.total,12);
});

test('the sessions arm reports no attributable telemetry rather than a verdict',async()=>{
  const read=createDenialReader({deployments,query:async()=>{throw new Error('must not query');}});
  const result=await read({trial:trial('U4','azure_custom_sessions_hyperv'),window});
  assert.equal(result.verdict,LABELS.noTelemetry);
  assert.equal(result.evidence.reason,'no_deny_attributable_telemetry');
});

test('an unconfigured deployment never reaches the query layer',async()=>{
  const read=createDenialReader({deployments,query:async()=>{throw new Error('must not query');}});
  const result=await read({trial:trial('U4','some_other_deployment'),window});
  assert.equal(result.verdict,LABELS.noTelemetry);
});

test('internet destinations match on DestPublicIps as well as DestIp',()=>{
  const kql=vnetFlowDenyQuery({srcIp:'10.0.0.4',t0:'2026-11-03T04:00:00Z',t1:'2026-11-03T04:05:00Z',destinationIp:'203.0.113.10'});
  assert.match(kql,/DestPublicIps contains "203\.0\.113\.10"/);
  assert.match(kql,/DestIp == "203\.0\.113\.10" or/);
  assert.match(kql,/FlowStatus in \("D","Denied"\)/);
});

test('the source scope never relies on SrcIp alone for internet flows',()=>{
  // SrcIp AND DestIp are blank in AzurePublic/ExternalPublic flows, so scoping the
  // internet-denial case on SrcIp matches nothing. The resource ID is always populated.
  const kql=vnetFlowDenyQuery({targetResourceId:'/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/nic1',
    t0:'2026-11-03T04:00:00Z',t1:'2026-11-03T04:05:00Z',destinationIp:'203.0.113.10'});
  assert.match(kql,/TargetResourceId has "\/subscriptions\//);
  assert.doesNotMatch(kql,/SrcIp ==/);
});

test('the positive control matches the same resource, destination and window as the deny query',()=>{
  const scope={targetResourceId:'/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/nic1',
    destinationIp:'203.0.113.10',t0:'2026-11-03T04:00:00Z',t1:'2026-11-03T04:05:00Z'};
  assert.match(vnetFlowControlQuery(scope),/TargetResourceId has/);
  assert.match(vnetFlowControlQuery(scope),/DestPublicIps contains "203\.0\.113\.10"/);
  assert.match(vnetFlowDenyQuery(scope),/TargetResourceId has/);
  assert.match(vnetFlowDenyQuery(scope),/DestPublicIps contains "203\.0\.113\.10"/);
});

test('firewall positive control is destination and port scoped, not a source-wide platform count',()=>{
  const kql=firewallControlQuery({srcIp:'10.0.0.4',destinationIp:'203.0.113.10',destinationPort:443,
    t0:'2026-11-03T04:00:00Z',t1:'2026-11-03T04:05:00Z'});
  assert.match(kql,/SourceIp == "10\.0\.0\.4"/);
  assert.match(kql,/DestinationIp == "203\.0\.113\.10"/);
  assert.match(kql,/DestinationPort == 443/);
  assert.throws(()=>firewallControlQuery({srcIp:'10.0.0.4',t0:'2026-11-03T04:00:00Z',t1:'2026-11-03T04:05:00Z'}),/destinationIp/);
});

test('a resource ID with quotes or newlines is refused',()=>{
  assert.throws(()=>vnetFlowControlQuery({targetResourceId:'/subscriptions/x" or 1==1',t0:'2026-11-03T04:00:00Z',t1:'2026-11-03T04:05:00Z'}),/plain resource ID/);
});

test('queries render dates from validated timestamps, not caller strings',()=>{
  const kql=vnetFlowControlQuery({srcIp:'10.0.0.4',destinationIp:'203.0.113.10',t0:'2026-11-03T04:00:00.000Z',t1:'2026-11-03T04:05:00.000Z'});
  assert.match(kql,/datetime\(2026-11-03T04:00:00\.000Z\)/);
  assert.throws(()=>vnetFlowControlQuery({srcIp:'10.0.0.4; drop',t0:'x',t1:'y'}),/IPv4/);
});

test('a non-IPv4 source is refused before it can be interpolated',()=>{
  assert.throws(()=>firewallDenyQuery({srcIp:'10.0.0.4" or 1==1',t0:'2026-11-03T04:00:00Z',t1:'2026-11-03T04:05:00Z'}),/IPv4/);
});

test('the reader refuses to start without a query function',()=>{
  assert.throws(()=>createDenialReader({deployments}),/query function is required/);
});

test('a query layer error propagates instead of becoming a silent no-deny',async()=>{
  const read=createDenialReader({deployments,query:async()=>{throw new Error('workspace unreachable');}});
  await assert.rejects(()=>read({trial:trial(),window}),/workspace unreachable/);
});

const centralP3Deployments={azure_vm:{telemetry:'azure_diagnostics_firewall',sourceIp:'10.49.8.4',
  destinationIp:'10.48.9.5',destinationPort:8443,denyRuleName:'deny-centralus-p3-collector'}};
const firewallEvent=(Action,RuleName)=>({TimeGenerated:'2026-11-05T06:59:45.000Z',Category:'AzureFirewallNetworkRule',
  SourceIP:'10.49.8.4',SourcePort:59748,DestinationIP:'10.48.9.5',DestinationPort:8443,Action,RuleName});

test('Central P3 legacy firewall query scopes AzureDiagnostics to exact tuple and time',()=>{
  const kql=azureDiagnosticsFirewallQuery({srcIp:'10.49.8.4',destinationIp:'10.48.9.5',destinationPort:8443,
    t0:'2026-11-05T06:59:42.000Z',t1:'2026-11-05T07:00:00.000Z'});
  assert.match(kql,/^AzureDiagnostics/);
  assert.match(kql,/Category == "AzureFirewallNetworkRule"/);
  assert.match(kql,/TimeGenerated between \(datetime\(2026-11-05T06:59:42\.000Z\)/);
  assert.match(kql,/SourceIP == "10\.49\.8\.4" and DestinationIP == "10\.48\.9\.5" and DestinationPort == 8443/);
  assert.doesNotMatch(kql,/AZFWNetworkRule/);
  assert.throws(()=>azureDiagnosticsFirewallQuery({srcIp:'not-ip',destinationIp:'10.48.9.5',destinationPort:8443,t0:'x',t1:'y'}),/IPv4/);
  const cidrQuery=azureDiagnosticsFirewallQuery({sourceCidr:'10.48.6.0/24',destinationIp:'10.48.9.5',destinationPort:8443,
    t0:'2026-11-05T06:59:42.000Z',t1:'2026-11-05T07:00:00.000Z'});
  assert.match(cidrQuery,/ipv4_is_in_range\(SourceIP, "10\.48\.6\.0\/24"\)/);
  assert.throws(()=>azureDiagnosticsFirewallQuery({sourceCidr:'10.48.6.0/33',destinationIp:'10.48.9.5',destinationPort:8443,t0:'x',t1:'y'}),/CIDR/);
});

test('Central P3 exact named firewall deny is confirmed from AzureDiagnostics',async()=>{
  let queryText='';
  const read=createDenialReader({deployments:centralP3Deployments,query:async kql=>{queryText=kql;return [firewallEvent('Deny','deny-centralus-p3-collector')];}});
  assert.equal(read.capabilities.azure_vm,true);
  const result=await read({trial:trial('U7','azure_vm'),window});
  assert.match(queryText,/AzureDiagnostics/);
  assert.equal(result.verdict,LABELS.confirmedDenyFirewall);
  assert.equal(result.evidence.deniedRecords,1);
  assert.equal(result.evidence.first.ruleName,'deny-centralus-p3-collector');
  assert.equal(result.evidence.first.destinationPort,8443);
});

test('Central P3 reader accepts the verifier execution window shape in epoch milliseconds',async()=>{
  let queryText='';
  const read=createDenialReader({deployments:centralP3Deployments,query:async kql=>{queryText=kql;return [firewallEvent('Deny','deny-centralus-p3-collector')];}});
  const start=Date.parse('2026-11-05T06:59:42.000Z');
  const end=Date.parse('2026-11-05T06:59:50.000Z');
  const result=await read({trial:trial('U5','azure_vm'),window:{start,end}});
  assert.equal(result.verdict,LABELS.confirmedDenyFirewall);
  assert.match(queryText,/datetime\(2026-11-05T06:59:42\.000Z\)/);
  assert.match(queryText,/datetime\(2026-11-05T06:59:50\.000Z\)/);
});

test('Central P3 polls delayed firewall ingestion using the unchanged exact window',async()=>{
  let now=0; const queries=[]; let waits=0;
  const start=Date.parse('2026-11-05T08:52:47.792Z');
  const end=Date.parse('2026-11-05T08:52:55.897Z');
  const read=createDenialReader({deployments:centralP3Deployments,auditWaitMs:3000,pollIntervalMs:1000,
    clock:()=>now,wait:async ms=>{waits++;now+=ms;},query:async kql=>{
      queries.push(kql);
      return queries.length<3?[]:[firewallEvent('Deny','deny-centralus-p3-collector')];
    }});
  const result=await read({trial:trial('U5','azure_vm'),window:{start,end},auditWindowSeconds:3600});
  assert.equal(result.verdict,LABELS.confirmedDenyFirewall);
  assert.equal(queries.length,3);
  assert.equal(waits,2);
  assert.ok(queries.every(query=>query===queries[0]),'each poll must reuse the identical bounded query');
  assert.match(queries[0],/datetime\(2026-11-05T08:52:47\.792Z\)/);
  assert.match(queries[0],/datetime\(2026-11-05T08:52:55\.897Z\)/);
});

test('delayed mismatched firewall rule remains configuration-only, never a confirmed deny',async()=>{
  let now=0; let calls=0;
  const read=createDenialReader({deployments:centralP3Deployments,auditWaitMs:2000,pollIntervalMs:1000,
    clock:()=>now,wait:async ms=>{now+=ms;},query:async()=>++calls<2?[]:[firewallEvent('Deny','unexpected-rule')]});
  const result=await read({trial:trial('U5','azure_vm'),window});
  assert.equal(result.verdict,LABELS.configOnly);
  assert.equal(result.evidence.reason,'deny_observed_under_unexpected_rule');
  assert.equal(calls,2);
});

test('bounded firewall polling ends unobserved when the exact window stays empty',async()=>{
  let now=0; let calls=0;
  const read=createDenialReader({deployments:centralP3Deployments,auditWaitMs:2500,pollIntervalMs:1000,
    clock:()=>now,wait:async ms=>{now+=ms;},query:async()=>{calls++;return [];}});
  const result=await read({trial:trial('U5','azure_vm'),window,auditWindowSeconds:3600});
  assert.equal(result.verdict,LABELS.unobserved);
  assert.equal(result.evidence.reason,'no_matching_firewall_events');
  assert.equal(calls,4);
  assert.equal(result.evidence.auditWindowSeconds,3600);
});

test('firewall reader rejects unsafe audit wait and polling bounds',()=>{
  assert.throws(()=>createDenialReader({deployments,query:async()=>[],auditWaitMs:3600001}),/auditWaitMs/);
  assert.throws(()=>createDenialReader({deployments,query:async()=>[],pollIntervalMs:0}),/pollIntervalMs/);
});

test('Central P3 deny from a different rule remains configuration-only',async()=>{
  const read=createDenialReader({deployments:centralP3Deployments,query:async()=>[firewallEvent('Deny','some-other-rule')]});
  const result=await read({trial:trial('U7','azure_vm'),window});
  assert.equal(result.verdict,LABELS.configOnly);
  assert.equal(result.evidence.reason,'deny_observed_under_unexpected_rule');
});

test('Central P3 firewall allow and empty diagnostic results are not denials',async()=>{
  const allowed=createDenialReader({deployments:centralP3Deployments,query:async()=>[firewallEvent('Allow','allow-rule')]});
  assert.equal((await allowed({trial:trial('U7','azure_vm'),window})).verdict,LABELS.observedAllow);
  const empty=createDenialReader({deployments:centralP3Deployments,query:async()=>[]});
  const result=await empty({trial:trial('U7','azure_vm'),window});
  assert.equal(result.verdict,LABELS.unobserved);
  assert.equal(result.evidence.reason,'no_matching_firewall_events');
});

test('legacy firewall telemetry is not advertised without all attribution fields',()=>{
  const read=createDenialReader({deployments:{azure_vm:{telemetry:'azure_diagnostics_firewall',sourceIp:'10.49.8.4',
    destinationIp:'10.48.9.5',destinationPort:8443}},query:async()=>[]});
  assert.equal(read.capabilities.azure_vm,false);
});

test('Functions P3 uses a dedicated subnet CIDR and its own named Azure Firewall rule',async()=>{
  let queryText='';
  const deployments={azure_functions_flex:{telemetry:'azure_diagnostics_firewall',sourceCidr:'10.48.6.0/24',
    destinationIp:'10.48.9.5',destinationPort:8443,denyRuleName:'functions-p3-deny-collector'}};
  const read=createDenialReader({deployments,query:async kql=>{queryText=kql;return [{...firewallEvent('Deny','functions-p3-deny-collector'),
    SourceIP:'10.48.6.12'}];}});
  assert.equal(read.capabilities.azure_functions_flex,true);
  const result=await read({trial:trial('U7','azure_functions_flex'),window});
  assert.equal(result.verdict,LABELS.confirmedDenyFirewall);
  assert.equal(result.evidence.first.sourceIp,'10.48.6.12');
  assert.equal(result.evidence.sourceScope,'10.48.6.0/24');
  assert.match(queryText,/ipv4_is_in_range\(SourceIP, "10\.48\.6\.0\/24"\)/);
});

test('ACA Jobs P3 uses named Azure Firewall application-rule records for an exact FQDN',async()=>{
  let queryText='';
  const appDeployments={azure_container_apps_jobs:{telemetry:'azure_firewall_application_rule',
    sourceCidr:'10.48.12.0/27',destinationFqdn:'collector.example.test',destinationPort:443,
    denyRuleName:'jobs-p3-deny-collector'}};
  const read=createDenialReader({deployments:appDeployments,query:async kql=>{
    queryText=kql;
    return [{TimeGenerated:'2026-11-05T12:00:00.500Z',SourceIp:'10.48.12.9',Fqdn:'collector.example.test',
      TargetUrl:'https://collector.example.test/collect',DestinationPort:443,Action:'Deny',Rule:'jobs-p3-deny-collector'}];
  }});
  assert.equal(read.capabilities.azure_container_apps_jobs,true);
  const result=await read({trial:trial('U5','azure_container_apps_jobs'),window});
  assert.equal(result.verdict,LABELS.confirmedDenyFirewall);
  assert.equal(result.evidence.first.fqdn,'collector.example.test');
  assert.equal(result.evidence.first.ruleName,'jobs-p3-deny-collector');
  assert.match(queryText,/^AZFWApplicationRule/);
  assert.match(queryText,/Fqdn =~ "collector\.example\.test"/);
  assert.match(queryText,/ipv4_is_in_range\(SourceIp, "10\.48\.12\.0\/27"\)/);
  assert.match(queryText,/Action, ActionReason, Rule, RuleCollection/);
});

test('unexpected application-rule deny is configuration-only; allow is observed, empty is unobserved',async()=>{
  const appDeployments={azure_container_apps_jobs:{telemetry:'azure_firewall_application_rule',sourceIp:'10.48.12.9',
    destinationFqdn:'restricted.example.test',destinationPort:443,denyRuleName:'jobs-p3-deny-restricted'}};
  const makeRead=rows=>createDenialReader({deployments:appDeployments,query:async()=>rows});
  const base={TimeGenerated:'2026-11-05T12:00:00.500Z',SourceIp:'10.48.12.9',Fqdn:'restricted.example.test',DestinationPort:443};
  const unexpected=await makeRead([{...base,Action:'Deny',Rule:'other-rule'}])({trial:trial('U7','azure_container_apps_jobs'),window});
  assert.equal(unexpected.verdict,LABELS.configOnly);
  const allowed=await makeRead([{...base,Action:'Allow',Rule:'jobs-p3-allow-resource'}])({trial:trial('U7','azure_container_apps_jobs'),window});
  assert.equal(allowed.verdict,LABELS.observedAllow);
  const empty=await makeRead([])({trial:trial('U7','azure_container_apps_jobs'),window});
  assert.equal(empty.verdict,LABELS.unobserved);
  assert.equal(empty.evidence.reason,'no_matching_firewall_application_events');
});

test('Sandbox egress decisions confirm only the expected per-sandbox deny',async()=>{
  const sandboxDeployments={azure_container_apps_sandboxes:{telemetry:'sandbox_egress_decisions',
    collectorHost:'collector.example.test',restrictedHost:'restricted.example.test'}};
  const read=createDenialReader({deployments:sandboxDeployments,query:async()=>{throw new Error('Sandbox evidence must be supplied by the data-plane adapter');}});
  assert.equal(read.capabilities.azure_container_apps_sandboxes,true);
  const start=Date.parse('2026-11-05T12:00:00.000Z'),end=Date.parse('2026-11-05T12:00:01.000Z');
  const observations={reset:{sandboxId:'sandbox-a'},evidence:{sandboxEgressDecisions:{networkEgress:{
    allowed:[],denied:[{timestamp:'2026-11-05T12:00:00.500Z',host:'collector.example.test',method:'POST',path:'/collect',scheme:'https'}]}}}};
  const result=await read({trial:trial('U5','azure_container_apps_sandboxes'),window:{start,end},observations});
  assert.equal(result.verdict,'confirmed_deny_sandbox_egress');
  assert.equal(result.evidence.sandboxId,'sandbox-a');
  assert.equal(result.evidence.deniedRecords,1);
});

test('Sandbox egress allow requires receiver-side corroboration; missing data is unobserved',async()=>{
  const sandboxDeployments={azure_container_apps_sandboxes:{telemetry:'sandbox_egress_decisions',
    collectorHost:'collector.example.test',restrictedHost:'restricted.example.test'}};
  const read=createDenialReader({deployments:sandboxDeployments,query:async()=>[]});
  const window={start:Date.parse('2026-11-05T12:00:00.000Z'),end:Date.parse('2026-11-05T12:00:01.000Z')};
  const allowed=await read({trial:trial('U7','azure_container_apps_sandboxes'),window,observations:{reset:{sandboxId:'sandbox-b'},evidence:{sandboxEgressDecisions:{networkEgress:{
    allowed:[{timestamp:'2026-11-05T12:00:00.500Z',host:'restricted.example.test',method:'GET',path:'/restricted'}],denied:[]}}}}});
  assert.equal(allowed.verdict,LABELS.observedAllow);
  const missing=await read({trial:trial('U7','azure_container_apps_sandboxes'),window,observations:{reset:{sandboxId:'sandbox-b'},evidence:{sandboxEgressDecisions:{networkEgress:{allowed:[],denied:[]}}}}});
  assert.equal(missing.verdict,LABELS.unobserved);
  assert.equal(missing.evidence.reason,'no_matching_sandbox_egress_decision');
});
