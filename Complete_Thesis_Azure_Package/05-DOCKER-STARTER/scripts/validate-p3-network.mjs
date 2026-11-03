/** Validate candidate address separation only; never establishes enforcement. */
import net from 'node:net';
function privateIpv4(value) {
  if(net.isIP(value)!==4) return false;
  const [a,b]=value.split('.').map(Number);
  return a===10 || (a===172 && b>=16 && b<=31) || (a===192 && b===168);
}
export function validateP3Network({researchIp,fixtureBlobIp,collectorIp,researchPort}) {
  if(!privateIpv4(researchIp) || !privateIpv4(fixtureBlobIp) || net.isIP(collectorIp)!==4) throw new Error('invalid controlled destination addresses');
  if(new Set([researchIp,fixtureBlobIp,collectorIp]).size!==3) throw new Error('controlled destination addresses must be distinct');
  if(!Number.isInteger(researchPort) || researchPort<1 || researchPort>65535) throw new Error('invalid research service port');
  return {status:'address_shape_only_azure_network_unverified'};
}
