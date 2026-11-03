/** Candidate VNet flow-log matcher. A match alone does not establish unique trial attribution. */
import net from 'node:net';

const isTime=n=>Number.isSafeInteger(n) && n>=0;
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();

export function findVnetFlowDenials(documents,{targetResourceId,aclId,ruleName,sourceIp,destinationIp,destinationPort,startMs,endMs}) {
  if(!Array.isArray(documents) || !targetResourceId?.startsWith('/') || !aclId?.startsWith('/') ||
    typeof ruleName!=='string' || !ruleName || !net.isIPv4(sourceIp) || !net.isIPv4(destinationIp) ||
    !Number.isInteger(destinationPort) || destinationPort<1 || destinationPort>65535 || !isTime(startMs) || !isTime(endMs) || endMs<startMs)
    throw new Error('invalid VNet flow query');
  const matches=[];
  for(const doc of documents) {
    if(!Array.isArray(doc?.records)) throw new Error('invalid VNet flow document');
    for(const record of doc.records) {
      if(!same(record?.targetResourceID,targetResourceId)) continue;
      if(!Array.isArray(record?.flowRecords?.flows)) throw new Error('invalid VNet flow records');
      for(const flow of record.flowRecords.flows) {
        if(!same(flow?.aclID,aclId)) continue;
        if(!Array.isArray(flow.flowGroups)) throw new Error('invalid VNet flow groups');
        for(const group of flow.flowGroups) {
          if(!same(group?.rule,ruleName)) continue;
          if(!Array.isArray(group.flowTuples)) throw new Error('invalid VNet flow tuples');
          for(const tuple of group.flowTuples) {
            if(typeof tuple!=='string') throw new Error('invalid VNet flow tuple');
            const parts=tuple.split(',');
            if(parts.length<9 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[3]) || !/^\d+$/.test(parts[4])) throw new Error('invalid VNet flow tuple');
            const timestamp=Number(parts[0]);
            if(!isTime(timestamp)) throw new Error('invalid VNet flow timestamp');
            if(timestamp>=startMs && timestamp<=endMs && parts[1]===sourceIp && parts[2]===destinationIp && Number(parts[4])===destinationPort &&
              parts[5]==='6' && parts[6]==='O' && parts[7]==='D')
              matches.push({timestamp,sourceIp,destinationIp,sourcePort:Number(parts[3]),destinationPort,protocol:'TCP',direction:'Outbound',state:'Deny',aclId:flow.aclID,rule:group.rule});
          }
        }
      }
    }
  }
  return {scope:'candidate_flow_log_match_not_trial_attribution',matches};
}
