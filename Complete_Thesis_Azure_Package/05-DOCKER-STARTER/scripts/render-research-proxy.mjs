/** Render the three controlled private listener addresses. */
import net from 'node:net';
function privateIp(value) {
  if(net.isIP(value)!==4) return false;
  const [a,b]=value.split('.').map(Number);
  return a===10 || a===172 && b>=16 && b<=31 || a===192 && b===168;
}
export function renderResearchProxy(template,{researchIp,collectorIp,restrictedIp}) {
  const addresses=[researchIp,collectorIp,restrictedIp];
  if(typeof template!=='string' || addresses.some(value=>!privateIp(value)) || new Set(addresses).size!==addresses.length)
    throw new Error('three distinct private IPv4 addresses required');
  const pairs=[['__RESEARCH_PRIVATE_IP__',researchIp],['__COLLECTOR_PRIVATE_IP__',collectorIp],['__RESTRICTED_PRIVATE_IP__',restrictedIp]];
  let rendered=template;
  for(const [placeholder,address] of pairs) {
    if(rendered.split(placeholder).length!==2) throw new Error('invalid proxy template');
    rendered=rendered.replace(placeholder,address);
  }
  return rendered;
}
