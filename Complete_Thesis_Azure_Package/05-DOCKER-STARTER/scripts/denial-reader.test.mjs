import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDenialReader,LABELS,vnetFlowDenyQuery,vnetFlowControlQuery,firewallDenyQuery} from './denial-reader.mjs';

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

test('the positive control uses the same scope as the deny query',()=>{
  const scope={targetResourceId:'/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/nic1',
    t0:'2026-11-03T04:00:00Z',t1:'2026-11-03T04:05:00Z'};
  assert.match(vnetFlowControlQuery(scope),/TargetResourceId has/);
  assert.match(vnetFlowDenyQuery(scope),/TargetResourceId has/);
});

test('a resource ID with quotes or newlines is refused',()=>{
  assert.throws(()=>vnetFlowControlQuery({targetResourceId:'/subscriptions/x" or 1==1',t0:'2026-11-03T04:00:00Z',t1:'2026-11-03T04:05:00Z'}),/plain resource ID/);
});

test('queries render dates from validated timestamps, not caller strings',()=>{
  const kql=vnetFlowControlQuery({srcIp:'10.0.0.4',t0:'2026-11-03T04:00:00.000Z',t1:'2026-11-03T04:05:00.000Z'});
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
