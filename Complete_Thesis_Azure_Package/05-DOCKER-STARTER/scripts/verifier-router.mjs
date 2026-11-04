/** Dispatch by scenario; an absent verifier never implies prevention. */
export function createVerifierRouter({blobVerifier,collectorVerifier,resourceVerifier,sessionAnalogVerifier}) {
  if(typeof blobVerifier!=='function' || typeof collectorVerifier!=='function' || (resourceVerifier!==undefined && typeof resourceVerifier!=='function')) throw new Error('invalid candidate verifiers');
  if(sessionAnalogVerifier!==undefined && typeof sessionAnalogVerifier!=='function') throw new Error('invalid independent ACI session analogue verifier');
  const blobCases=new Set(['U1','U2','U3','L1','L2']);
  return async function verify(trial,observations) {
    if(['U6','U8'].includes(trial?.scenario)) {
      if(typeof sessionAnalogVerifier!=='function')
        return {classification:'indeterminate',evidence:{reason:'independent_aci_session_analogue_verifier_not_configured'}};
      return sessionAnalogVerifier(trial,observations);
    }
    if(blobCases.has(trial?.scenario)) return blobVerifier(trial,observations);
    if(['U5','U7'].includes(trial?.scenario)) return collectorVerifier(trial,observations);
    if(trial?.scenario==='U4' && resourceVerifier) return resourceVerifier(trial,observations);
    return {classification:'indeterminate',evidence:{reason:'scenario_verifier_not_implemented'}};
  };
}
