/** Validate deployment inputs; does not prove network, identity, quota or policy. */
import net from 'node:net';
function publicIpv4Cidr(value) {
  if(typeof value!=='string' || !value.endsWith('/32')) return false;
  const ip=value.slice(0,-3);
  if(net.isIP(ip)!==4) return false;
  const [a,b]=ip.split('.').map(Number);
  return a!==0 && a!==10 && a!==127 && a<224 && !(a===169 && b===254) &&
    !(a===172 && b>=16 && b<=31) && !(a===192 && b===168) && !(a===100 && b>=64 && b<=127);
}
function safeHttps(value) {
  try {const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password && !u.search && !u.hash;}
  catch {return false;}
}
export function validateFlexConfig(config) {
  if(!config || !publicIpv4Cidr(config.controllerIpCidr)) throw new Error('controller access requires a specific non-private IPv4 /32');
  if(!/^[a-z0-9]{3,24}$/.test(config.hostStorageName || '')) throw new Error('invalid host storage name');
  if(!safeHttps(config.researchUrl) || !safeHttps(config.collectorUrl)) throw new Error('fixture URLs must use HTTPS without embedded credentials');
  let blob; try {blob=new URL(config.fixtureBlobEndpoint);} catch {throw new Error('invalid fixture Blob endpoint');}
  if(blob.protocol!=='https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(blob.hostname) ||
    blob.username || blob.password || blob.port || blob.pathname!=='/' || blob.search || blob.hash) throw new Error('invalid fixture Blob endpoint');
  const {workloadToken,trialRequestKey}=config;
  if(typeof workloadToken!=='string' || typeof trialRequestKey!=='string' || workloadToken.length<32 || trialRequestKey.length<32 ||
    workloadToken===trialRequestKey || /[\r\n]/.test(workloadToken+trialRequestKey) || /REPLACE-WITH/i.test(workloadToken+trialRequestKey)) throw new Error('invalid workload credentials');
  return {status:'input_shape_only_azure_configuration_unverified'};
}
