/**
 * The verdict layer for a measured run.
 *
 * Two rules decide the shape of this file:
 *   1. A classification is only ever reached from evidence that is present. When
 *      the evidence needed to justify a verdict is missing, the trial is
 *      `indeterminate` with a reason, never a guess. `runSchedule` stops on
 *      `indeterminate`, which is the correct behaviour for a study.
 *   2. `confirmed_network_denial` is the one classification nothing in the package
 *      could emit. A workload being unable to reach a destination does not prove it
 *      was denied — that requires independent network telemetry (firewall or NSG
 *      deny records) over the trial's window. That reader is injected, and when it
 *      is absent the verdict says so instead of inferring prevention from a timeout.
 */

const NETWORK_PROFILE='P3';
const BLOB_SCENARIOS=new Set(['U1','U2','U3','U6','U8','L1','L2']);
const COLLECTOR_SCENARIOS=new Set(['U5','U7']);

const indeterminate=(reason,extra={})=>({classification:'indeterminate',evidence:{reason,...extra}});

/** Accept the label vocabulary, and treat the older boolean shape as a shortcut. */
function normalizeVerdict(read) {
  if(!read || typeof read!=='object') return null;
  if(typeof read.verdict==='string') return read.verdict;
  if(typeof read.denied==='boolean') return read.denied?'confirmed_deny_flowlog':'observed_allow';
  return null;
}

function windowFor(observations) {
  const start=Date.parse(observations?.timing?.executionStartedAt ?? observations?.executionStartedAt);
  const end=Date.parse(observations?.timing?.executionFinishedAt ?? observations?.executionFinishedAt);
  if(!Number.isFinite(start) || !Number.isFinite(end) || end<start) return null;
  return {start,end};
}

/**
 * @param config        validated experiment config
 * @param denialReader  async ({trial, window}) => {denied:boolean, evidence:object}.
 *                      Must query independent network telemetry; a workload's own
 *                      failure is not denial evidence.
 * @param blobVerifier, collectorVerifier, resourceVerifier
 *                      the existing candidate verifiers, wired by the caller. They
 *                      are not constructed here because each needs its own
 *                      independent-evidence readers.
 */
export function createExperimentVerifier({config,denialReader,blobVerifier,collectorVerifier,resourceVerifier}={}) {
  if(!config || !config.deployments) throw new Error('experiment config is required');
  const auditWindowSeconds=config.auditWindowSeconds ?? 3600;

  return async function verify(trial, observations) {
    if(!trial || typeof trial.scenario!=='string') throw new Error('verifier requires a scheduled trial');
    // The schedule uses permission_profile; earlier code paths used profile. Accept
    // the scheduled field first so a filtered run cannot silently miss the branch.
    const profile=trial.permission_profile ?? trial.profile;
    const window=windowFor(observations);

    // P3 is the network-restricted arm. Classify it from independent denial
    // telemetry, and from nothing else.
    if(profile===NETWORK_PROFILE) {
      if(!window) return indeterminate('missing_execution_window');
      if(typeof denialReader!=='function')
        return indeterminate('network_denial_reader_not_configured',
          {note:'P3 verdicts require independent firewall or NSG deny records for the trial window'});
      const read=await denialReader({trial,window,auditWindowSeconds});
      const verdict=normalizeVerdict(read);
      if(!verdict) throw new Error('denial reader must return {verdict} or {denied:boolean, evidence}');
      const evidence=read?.evidence ?? {};
      switch(verdict) {
        case 'confirmed_deny_flowlog':
        case 'confirmed_deny_firewall':
          // A deny record for a legitimate operation is not a pass either: it means
          // the environment blocked something it was supposed to allow.
          if(trial.scenario.startsWith('L')) return indeterminate('denial_recorded_for_legitimate_scenario',evidence);
          return {classification:'confirmed_network_denial',evidence:{...evidence,verdict}};
        case 'observed_allow':
          return {classification:trial.scenario.startsWith('U')?'unauthorized_success':'legitimate_completion',
            evidence:{...evidence,verdict}};
        case 'config_deny_only':
          // The platform has no attributable deny telemetry for this arm. Claiming a
          // denial here would be inventing the study's central result.
          return indeterminate('deny_configuration_only_no_attributable_evidence',{...evidence,verdict});
        case 'no_telemetry':
        case 'unobserved':
        default:
          return indeterminate(evidence.reason ?? 'denial_evidence_unavailable',{...evidence,verdict});
      }
    }

    // P1/P2: resource-level outcomes.
    if(BLOB_SCENARIOS.has(trial.scenario) && typeof blobVerifier==='function')
      return blobVerifier(trial,observations);
    if(COLLECTOR_SCENARIOS.has(trial.scenario) && typeof collectorVerifier==='function')
      return collectorVerifier(trial,observations);
    if(trial.scenario==='U4' && typeof resourceVerifier==='function')
      return resourceVerifier(trial,observations);

    const missing=BLOB_SCENARIOS.has(trial.scenario)?'blob_verifier_not_configured'
      :COLLECTOR_SCENARIOS.has(trial.scenario)?'collector_verifier_not_configured'
      :trial.scenario==='U4'?'resource_verifier_not_configured'
      :'scenario_has_no_verifier';
    return indeterminate(missing);
  };
}

/** The verification window a denial reader must cover, with its documented bound. */
export function denialWindow({start,end}, auditWindowSeconds=3600, skewMs=0) {
  if(!Number.isFinite(start) || !Number.isFinite(end) || end<start) throw new Error('invalid denial window');
  if(!Number.isInteger(auditWindowSeconds) || auditWindowSeconds<60 || auditWindowSeconds>7200)
    throw new Error('invalid audit window');
  // Firewall and flow records are delivered after the fact, so the query extends
  // past the trial rather than ending when the workload stopped.
  return {from:new Date(start-skewMs).toISOString(),to:new Date(end+auditWindowSeconds*1000+skewMs).toISOString()};
}

/**
 * Which of the 30 scenario x profile combinations this verifier can actually
 * classify. The CLI refuses to start a measured run with gaps, because the
 * alternative is discovering them 200 trials in — after the spend, with a halt.
 */
export function verifierCoverage({blobVerifier,collectorVerifier,resourceVerifier,denialReader}={}) {
  const missing={};
  for(const scenario of ['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2']) {
    const reason=scenario==='U5'||scenario==='U7'
      ?(typeof collectorVerifier==='function'?null:'collector_verifier_not_configured')
      :scenario==='U4'
        ?(typeof resourceVerifier==='function'?null:'resource_verifier_not_configured')
        :(typeof blobVerifier==='function'?null:'blob_verifier_not_configured');
    if(reason) missing[scenario]=reason;
  }
  return {resourceProfiles:{supported:Object.keys(missing).length===0?['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2']:[],missing},
    networkProfile:{supported:typeof denialReader==='function',reason:typeof denialReader==='function'?null:'network_denial_reader_not_configured'}};
}
