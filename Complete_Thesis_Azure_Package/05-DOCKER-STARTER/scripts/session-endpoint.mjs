/** Validate the documented public-cloud custom-container pool endpoint. */
export function validateCustomSessionEndpoint(value,{poolName,region}) {
  if(typeof poolName!=='string' || !/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(poolName) ||
    typeof region!=='string' || !/^[a-z0-9]+$/.test(region)) throw new Error('invalid expected session pool or region');
  let endpoint; try {endpoint=new URL(value);} catch {throw new Error('invalid custom session endpoint');}
  const labels=endpoint.hostname.split('.');
  if(endpoint.protocol!=='https:' || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname!=='/' ||
     labels.length!==5 || labels[0]!==poolName || !/^[a-z0-9-]+$/.test(labels[1]) || labels[2]!==region ||
     labels[3]!=='azurecontainerapps' || labels[4]!=='io') throw new Error('custom session endpoint does not match expected pool and region');
  return endpoint;
}
