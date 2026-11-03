/** Render only the two controlled private listener addresses. */
import net from 'node:net';
function privateIp(value) {
  if(net.isIP(value)!==4) return false;
  const [a,b]=value.split('.').map(Number);
  return a===10 || a===172 && b>=16 && b<=31 || a===192 && b===168;
}
export function renderResearchProxy(template,{researchIp,collectorIp}) {
  if(typeof template!=='string' || !privateIp(researchIp) || !privateIp(collectorIp) || researchIp===collectorIp) throw new Error('distinct private IPv4 addresses required');
  const pairs=[['__RESEARCH_PRIVATE_IP__',researchIp],['__COLLECTOR_PRIVATE_IP__',collectorIp]];
  let rendered=template;
  for(const [placeholder,address] of pairs) {
    if(rendered.split(placeholder).length!==2) throw new Error('invalid proxy template');
    rendered=rendered.replace(placeholder,address);
  }
  return rendered;
}
