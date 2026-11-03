/** Request and observe retirement; only sanitized fingerprints are returned. */
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function retireSession({observer,runId,expectedFingerprint,waitMs=60000,pollMs=3000,clock=Date.now,wait=pause}) {
  if(!observer || typeof observer.observe!=='function' || typeof observer.requestStop!=='function' ||
    !/^[A-Za-z0-9_-]{1,150}$/.test(runId || '') || !/^[a-f0-9]{64}$/.test(expectedFingerprint || '') ||
    !Number.isInteger(waitMs) || waitMs<0 || waitMs>60000 || !Number.isInteger(pollMs) || pollMs<1 || pollMs>60000) throw new Error('invalid session retirement configuration');
  let observed=await observer.observe(runId);
  if(observed?.sessionFingerprint!==expectedFingerprint || !['present','not_found'].includes(observed.state)) throw new Error('session observation mismatch');
  if(observed.state==='not_found') return {scope:'session_retirement_observation',state:'already_not_found',observation:observed};
  const request=await observer.requestStop(runId,{evidenceCollected:true});
  const deadline=clock()+waitMs;
  do {
    observed=await observer.observe(runId);
    if(observed?.sessionFingerprint!==expectedFingerprint || !['present','not_found'].includes(observed.state)) throw new Error('session observation mismatch');
    if(observed.state==='not_found') return {scope:'session_retirement_observation',state:'not_found_after_stop',request,observation:observed};
    if(clock()>=deadline) break;
    await wait(Math.min(pollMs,Math.max(1,deadline-clock())));
  } while(clock()<=deadline);
  throw new Error('session retirement not observed');
}
