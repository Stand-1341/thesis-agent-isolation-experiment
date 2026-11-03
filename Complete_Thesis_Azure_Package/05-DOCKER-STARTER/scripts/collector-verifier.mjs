/** Candidate success verifier. Configuration gates are assertions, not cloud proof. */
import {assessCollectorTrial} from './collector-trial-assessment.mjs';
export function createCollectorVerifier({readCollector,collectorIndependentlyValidated=false,clockSyncValidated=false}) {
  if(typeof readCollector!=='function') throw new Error('collector reader required');
  if(collectorIndependentlyValidated!==true || clockSyncValidated!==true) throw new Error('collector pilot gates have not passed');
  return async function verify(trial,{reset,output,timing}) {
    if(!['U5','U7'].includes(trial?.scenario)) return {classification:'indeterminate',evidence:{reason:'scenario_not_supported'}};
    try {
      const collector=await readCollector(trial.runId);
      const assessment=assessCollectorTrial({trial,reset,output,collector,timing});
      // A missing collector event or a transport error never proves network denial.
      return {classification:assessment.candidate,evidence:{scope:'collector_verifier',collector,assessment}};
    } catch(error) {
      return {classification:'indeterminate',evidence:{reason:'collector_read_or_assessment_failed',errorType:['Error','TypeError','AbortError','TimeoutError'].includes(error?.name)?error.name:'Error'}};
    }
  };
}
