/**
 * Determine which scheduled cells are executable for this deployment design.
 * This module is deliberately conservative: unsupported evidence is a blocker,
 * never a result and never an implicit skip.
 */
const SESSION_DEPLOYMENT='azure_custom_sessions_hyperv';
const SESSION_ONLY=new Set(['U6','U8']);
export const NETWORK_DENIAL_SCENARIOS=new Set(['U5','U7']);

export function classifyTrialScope(trial,{networkCapabilities={}}={}) {
  if(!trial || typeof trial!=='object') throw new Error('trial scope requires a trial row');
  const profile=trial.permission_profile ?? trial.profile;
  const scenario=trial.scenario_id ?? trial.scenario;
  const deployment=trial.deployment;
  if(SESSION_ONLY.has(scenario) && deployment!==SESSION_DEPLOYMENT)
    return {status:'not_applicable',reason:'scenario_requires_sessions',deployment,scenario};

  // A P3 session route represents P2 authorization plus selective network
  // containment. The current pool cannot support that selective egress design,
  // even if some other kind of denial telemetry happens to be available.
  if(profile==='P3' && deployment===SESSION_DEPLOYMENT)
    return {status:'unsupported',reason:'custom_session_p3_selective_egress_unverifiable',deployment,profile,scenario};

  if(profile==='P3' && NETWORK_DENIAL_SCENARIOS.has(scenario) && networkCapabilities[deployment]!==true)
    return {status:'unsupported',reason:'independent_network_denial_evidence_unavailable',deployment,profile,scenario};

  return {status:'measurable',deployment,profile,scenario};
}

export function analyzeTrialScope(rows,options={}) {
  if(!Array.isArray(rows)) throw new Error('scope rows must be an array');
  const dispositions=rows.map(row=>({runId:row.planned_run_id ?? row.runId ?? null,
    ...classifyTrialScope(row,options)}));
  const notApplicable=dispositions.filter(item=>item.status==='not_applicable');
  const unsupported=dispositions.filter(item=>item.status==='unsupported');
  const measurable=dispositions.filter(item=>item.status==='measurable');
  const grouped={};
  for(const item of unsupported) {
    const key=`${item.deployment}:${item.profile}:${item.reason}`;
    grouped[key]=(grouped[key]??0)+1;
  }
  return {total:rows.length,measurable:measurable.length,notApplicable:notApplicable.length,
    unsupported:unsupported.length,unsupportedByRoute:grouped,dispositions};
}
