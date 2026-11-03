/** Shape and overlap checks only; private routes and Azure enforcement require pilot verification. */
import net from 'node:net';
function cidr(value) {
  if(typeof value!=='string' || !/^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/.test(value)) throw new Error('explicit IPv4 CIDR required');
  const [ip,prefixText]=value.split('/'),prefix=Number(prefixText);
  if(net.isIP(ip)!==4 || prefix<16 || prefix>32) throw new Error('invalid private IPv4 CIDR');
  const octets=ip.split('.').map(Number);
  if(!(octets[0]===10 || octets[0]===172 && octets[1]>=16 && octets[1]<=31 || octets[0]===192 && octets[1]===168)) throw new Error('private IPv4 CIDR required');
  const n=octets.reduce((acc,x)=>acc*256+x,0),size=2**(32-prefix),first=Math.floor(n/size)*size;
  if(n!==first) throw new Error('CIDR must be a network address');
  const last=first+size-1,privateEnd=octets[0]===10?0x0affffff:octets[0]===172?0xac1fffff:0xc0a8ffff;
  if(last>privateEnd) throw new Error('CIDR crosses private address boundary');
  return {first,last};
}
export function validateResearchHostNetwork({workloadSourcePrefixes,operatorSourcePrefixes}) {
  if(!Array.isArray(workloadSourcePrefixes) || !workloadSourcePrefixes.length || !Array.isArray(operatorSourcePrefixes) || !operatorSourcePrefixes.length || workloadSourcePrefixes.length+operatorSourcePrefixes.length>100) throw new Error('source prefixes required');
  const workloads=workloadSourcePrefixes.map(cidr),operators=operatorSourcePrefixes.map(cidr);
  if(workloads.some(w=>operators.some(o=>w.first<=o.last && o.first<=w.last))) throw new Error('operator and workload networks overlap');
  return {status:'address_shape_only_private_routes_and_enforcement_unverified'};
}
