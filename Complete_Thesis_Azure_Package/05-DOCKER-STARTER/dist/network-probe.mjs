// Run only against the experiment's own controlled endpoints. These observations
// are not a substitute for independent network-enforcer logs.
import net from 'node:net';
import {lookup} from 'node:dns/promises';

function destination(value) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('HTTP(S) endpoint without credentials, query or fragment required');
  return url;
}
async function httpProbe(url) {
  try {
    const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(5000)});
    return {transport:'response',status:response.status,redirect:response.status>=300 && response.status<400};
  } catch(error) { return {transport:'error',errorType:error?.name || 'Error'}; }
}
async function socketProbe(url,override) {
  try {
    if(override && !net.isIP(override)) throw new Error('invalid operator-supplied IP');
    const addresses=override?[{address:override,family:net.isIP(override)}]:await lookup(url.hostname,{all:true});
    const address=addresses.find(a=>a.family===4) || addresses[0];
    if(!address) return {transport:'error',errorType:'NoAddress'};
    return await new Promise(resolve=>{
      const socket=net.createConnection({host:address.address,port:Number(url.port || (url.protocol==='https:'?443:80))});
      const finish=(transport,errorType)=>{socket.destroy();resolve({transport,...(errorType?{errorType}:{}),addressFamily:address.family})};
      socket.setTimeout(5000,()=>finish('error','Timeout'));
      socket.once('connect',()=>finish('connected'));
      socket.once('error',error=>finish('error',error.code || 'Error'));
    });
  } catch(error) { return {transport:'error',errorType:error?.code || error?.name || 'Error'}; }
}

// Follow one redirect only after confirming both endpoints match the operator's
// controlled approved/restricted URLs. Never follow an arbitrary Location.
export async function probeControlledRedirect(approvedRedirect,approvedEndpoint,restrictedEndpoint) {
  const start=destination(approvedRedirect), approved=destination(approvedEndpoint), restricted=destination(restrictedEndpoint);
  if (start.origin!==approved.origin) throw new Error('redirect source must use the approved origin');
  try {
    const first=await fetch(start,{redirect:'manual',signal:AbortSignal.timeout(5000)});
    const location=first.headers.get('location');
    if (first.status<300 || first.status>=400 || !location) return {transport:'unexpected_response',status:first.status};
    const target=new URL(location,start);
    if (target.href!==restricted.href) return {transport:'unexpected_redirect_target',status:first.status};
    const second=await fetch(target,{redirect:'manual',signal:AbortSignal.timeout(5000)});
    return {transport:'response',redirectStatus:first.status,targetStatus:second.status,
      conclusion:'observation_only_without_independent_enforcer_evidence'};
  } catch(error) { return {transport:'error',errorType:error?.name || 'Error',conclusion:'indeterminate'}; }
}
export async function probeNetwork(approved,restricted,options={}) {
  const allowed=destination(approved), denied=destination(restricted);
  return {scope:'connectivity_observation_only',timestamp:new Date().toISOString(),
    approved:{http:await httpProbe(allowed),directSocket:await socketProbe(allowed)},
    restricted:{http:await httpProbe(denied),directSocket:await socketProbe(denied,options.restrictedIp),directSocketTargetSource:options.restrictedIp?'operator_supplied_ip':'workload_dns'},
    ...(options.redirectUrl ? {controlledRedirect:await probeControlledRedirect(options.redirectUrl,allowed,denied)} : {}),
    conclusion:'indeterminate_without_independent_enforcer_evidence'};
}
