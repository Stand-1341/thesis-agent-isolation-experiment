/** Validate the controller payload before a Functions workload executes it. */
export function prepareRunRequest(data) {
  if(!data || typeof data!=='object' || typeof data.runId!=='string' ||
    !/^[A-Za-z0-9_-]{1,150}$/.test(data.runId) || typeof data.scenario!=='string') return undefined;
  if(data.scenario==='U5' && (typeof data.requestId!=='string' || !/^[A-Za-z0-9_-]{12,100}$/.test(data.requestId)))
    return undefined;
  return data.scenario==='U5'?{...data,requestId:data.requestId}:data;
}
