/** Correlate one non-counted isolated-session probe with exported firewall rows.
 * This is an offline review aid, not proof of source authenticity or readiness.
 */
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const ipv4=v=>typeof v==='string' && net.isIP(v)===4;
const port=v=>Number.isInteger(v) && v>=1 && v<=65535;
const timestamp=v=>typeof v==='string' && /(?:Z|[+-]\d\d:\d)$/.test(v) ? Date.parse(v) : NaN;
const rule=v=>typeof v==='string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);

/** Require a unique network tuple and a bounded timestamp window for one probe.
 * Callers must obtain the rows from a separately controlled Azure reader.
 */
export function correlateSessionP3Probe(probe,rows) {
  if(!probe || probe.mode!=='non_counted_pilot' || !/^[A-Za-z0-9_-]{1,150}$/.test(probe.runId??''))
    throw new Error('a non-counted pilot run ID is required');
  const start=timestamp(probe.startedAt), end=timestamp(probe.finishedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||end-start>120000)
    throw new Error('a bounded probe window of at most 120 seconds is required');
  if(!ipv4(probe.sourceIp)||!port(probe.sourcePort)||!ipv4(probe.destinationIp)||!port(probe.destinationPort)||!rule(probe.expectedRule))
    throw new Error('exact IPv4 source and destination, ports, and a named rule are required');
  if(!['TCP','UDP'].includes(probe.protocol)||!Array.isArray(rows)) throw new Error('protocol and event rows are required');
  const matched=rows.filter(row=>{
    const time=timestamp(row?.timeGenerated);
    return Number.isFinite(time)&&time>=start&&time<=end&&row.sourceIp===probe.sourceIp&&
      row.sourcePort===probe.sourcePort&&row.destinationIp===probe.destinationIp&&
      row.destinationPort===probe.destinationPort&&row.protocol===probe.protocol&&
      row.action==='Deny'&&row.ruleName===probe.expectedRule;
  });
  return {runId:probe.runId, verdict:matched.length?'matching_deny_rows':'no_matching_deny_rows',
    matchedRows:matched.length, mode:'non_counted_pilot', measuredExecutionEnabled:false,
    limitations:['Only an exact network tuple, named rule, and time window are matched.',
      'This offline review does not authenticate the supplied telemetry or establish exclusive source attribution.',
      'A matching deny does not establish that allowed destinations work or prove all egress is contained.']};
}

async function main() {
  if(process.argv.length!==3) throw new Error('usage: node scripts/session-p3-pilot-evidence.mjs PILOT-EVIDENCE.json');
  const input=JSON.parse(await readFile(process.argv[2],'utf8'));
  process.stdout.write(JSON.stringify(correlateSessionP3Probe(input.probe,input.rows),null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
