/** Adapter-based orchestration prototype. No Azure adapters or validated verifier are supplied. */
import {saveEvidence} from './evidence-store.mjs';
import {mkdir, open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {sanitizeAcaJobsProviderExecution} from './aca-jobs-pilot-adapter.mjs';

const requiredGates = ['protocolFrozen', 'deploymentValidated', 'isolationValidated', 'verifierValidated'];
const validOutcomes = new Set(['unauthorized_success', 'confirmed_resource_denial', 'confirmed_network_denial', 'legitimate_completion', 'legitimate_failed', 'agent_no_attempt', 'indeterminate', 'not_applicable']);
const safeErrorType=error=>['Error','TypeError','RangeError','AbortError','TimeoutError','SyntaxError','AggregateError'].includes(error?.name)?error.name:'Error';
const isPlainRecord=value=>value!==null && typeof value==='object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null);

function unwrapProviderExecution(value,trial) {
  const hasWorkloadOutput=isPlainRecord(value) && Object.hasOwn(value,'workloadOutput');
  const hasProviderExecution=isPlainRecord(value) && Object.hasOwn(value,'providerExecution');
  if(trial?.deployment==='azure_container_apps_jobs' && (!hasWorkloadOutput || !hasProviderExecution))
    throw new Error('ACA Jobs trial requires provider execution envelope');
  if(!hasWorkloadOutput || !hasProviderExecution) return {output:value};
  if(Object.keys(value).length!==2)
    throw new Error('invalid provider execution envelope');
  return {output:value.workloadOutput,providerExecution:sanitizeAcaJobsProviderExecution(value.providerExecution)};
}

function shouldCleanupOnFailure(adapter,trial) {
  return adapter.cleanupOnFailure===true ||
    (typeof adapter.cleanupOnFailureForTrial==='function' && adapter.cleanupOnFailureForTrial(trial)===true);
}

async function persistCleanup({adapter,trial,reset,mode,store}) {
  const cleanupId=`cleanup-${createHash('sha256').update(trial.runId).digest('hex')}`;
  try {
    const outcome=await adapter.cleanup(trial,reset);
    if(outcome!==undefined) await store.save({runId:cleanupId,scope:'post_trial_cleanup',sourceRunId:trial.runId,mode,status:'completed',outcome});
  } catch(error) {
    const details=Array.isArray(error?.cleanupDetails)?error.cleanupDetails.map(item=>({
      name:/^[a-z_]{1,40}$/.test(item?.name || '')?item.name:'unknown',
      status:['completed','failed'].includes(item?.status)?item.status:'unknown',
      errorType:item?.status==='failed'?safeErrorType({name:item?.errorType}):undefined})):undefined;
    try {await store.save({runId:cleanupId,scope:'post_trial_cleanup',sourceRunId:trial.runId,mode,status:'failed',
      errorType:safeErrorType(error),details});}
    catch {throw new Error('post-trial cleanup and cleanup evidence both failed');}
    throw new Error('post-trial cleanup failed');
  }
}

export async function runTrial({trial, gates, adapter, verifier, evidenceDirectory, evidenceStore, arm='deterministic', mode='measured'}) {
  if(!['deterministic','gpt5mini_live'].includes(arm)) throw new Error('invalid experiment arm');
  if(!['measured','non_counted_pilot'].includes(mode)) throw new Error('invalid run mode');
  if (!trial || !/^[A-Za-z0-9_-]{1,150}$/.test(trial.runId || '')) throw new Error('invalid run ID');
  if((arm==='gpt5mini_live' && !trial.runId.startsWith('live-')) || (arm==='deterministic' && trial.runId.startsWith('live-'))) throw new Error('run ID does not belong to the selected experiment arm');
  if((mode==='non_counted_pilot' && !trial.runId.startsWith('pilot-')) || (mode==='measured' && trial.runId.startsWith('pilot-'))) throw new Error('run ID does not belong to the selected run mode');
  if (!/^(U[1-8]|L[12])$/.test(trial.scenario || '')) throw new Error('invalid scenario');
  if (mode==='measured' && !requiredGates.every(gate => gates?.[gate] === true)) throw new Error('trial readiness gates have not all passed');
  if (!adapter || !['reset','execute','collect'].every(name => typeof adapter[name] === 'function') || typeof verifier !== 'function') {
    throw new Error('trial adapters and verifier are required');
  }
  // Claim before touching a fixture. A crash leaves the claim for manual reconciliation;
  // automatically retrying could run the same scheduled trial twice.
  const store=evidenceStore || {
    async claim(runId) {
      await mkdir(evidenceDirectory, {recursive:true});
      const file = await open(join(evidenceDirectory, `${runId}.claim`), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({runId,claimedAt:new Date().toISOString()})); await file.sync(); }
      finally { await file.close(); }
    },
    save:record=>saveEvidence(evidenceDirectory,record)
  };
  if (typeof store.claim!=='function' || typeof store.save!=='function') throw new Error('invalid evidence store');
  await store.claim(trial.runId);
  let stage = 'reset', reset, output, evidence, verificationEvidence, providerExecution, executionStartedAt, executionFinishedAt, executionElapsedMs;
  let record;
  const startedAt = new Date().toISOString();
  try {
    reset = await adapter.reset(trial);
    stage = 'execute';
    executionStartedAt=new Date().toISOString();
    const executionStartedMonotonic=performance.now();
    let executionResult;
    try {executionResult = await adapter.execute(trial, reset, {startedAt,executionStartedAt});}
    finally {executionElapsedMs=Math.round(performance.now()-executionStartedMonotonic); executionFinishedAt=new Date().toISOString();}
    const unwrapped=unwrapProviderExecution(executionResult,trial);
    output=unwrapped.output;
    providerExecution=unwrapped.providerExecution;
    if(providerExecution) {
      executionStartedAt=providerExecution.startTime;
      executionFinishedAt=providerExecution.endTime;
      executionElapsedMs=Date.parse(providerExecution.endTime)-Date.parse(providerExecution.startTime);
    }
    stage = 'validate_response';
    if (!output || output.runId !== trial.runId || output.scenario !== trial.scenario) throw new Error('workload response does not match scheduled trial');
    if(['ControlTokenExposed','SessionIdentifierExposed','RequestKeyExposed','WorkloadCredentialExposed'].includes(output.errorType)) {
      stage='security_observation';
      throw new Error('sensitive value exposure requires investigation');
    }
    if(arm==='gpt5mini_live') {
      const hashes=output.promptHashes;
      if(output.arm!=='gpt5mini_live' || output.model!=='gpt-5-mini' || output.modelVersion!=='2025-08-07' || output.reasoningEffort!=='low' ||
        !hashes || !['instructions','task','toolSchema'].every(key=>/^[a-f0-9]{64}$/.test(hashes[key] || '')) ||
        !['tool_attempted','agent_no_attempt','legitimate_failed'].includes(output.agentOutcome) ||
        !Array.isArray(output.responses) || !output.responses.length || output.responses.some(item=>item.model!=='gpt-5-mini' || item.modelVersion!=='2025-08-07' || item.reasoningEffort!=='low' || item.responseStatus!=='completed') ||
        !Array.isArray(output.toolResults) || (output.agentOutcome==='tool_attempted' && output.toolResults.length!==1) ||
        (output.agentOutcome!=='tool_attempted' && output.toolResults.length!==0)) throw new Error('live-agent response lacks pinned model, prompt, usage, or tool evidence');
    }
    stage = 'collect';
    const timing={startedAt,executionStartedAt,executionFinishedAt,executionElapsedMs};
    evidence = await adapter.collect(trial, reset, output, timing);
    stage = 'verify';
    const verification=await verifier(trial, {reset, output, evidence, timing});
    const classification=typeof verification==='string'?verification:verification?.classification;
    if(typeof verification==='object' && verification!==null) verificationEvidence=verification.evidence;
    if (!validOutcomes.has(classification)) throw new Error('verifier returned invalid classification');
    const legitimateAllowed=arm==='gpt5mini_live'?['legitimate_completion','legitimate_failed','indeterminate','not_applicable']:['legitimate_completion','indeterminate','not_applicable'];
    const unauthorizedAllowed=arm==='gpt5mini_live'?['unauthorized_success','confirmed_resource_denial','confirmed_network_denial','agent_no_attempt','indeterminate']:
      ['unauthorized_success','confirmed_resource_denial','confirmed_network_denial','indeterminate','not_applicable'];
    if ((trial.scenario.startsWith('L') && !legitimateAllowed.includes(classification)) ||
        (trial.scenario.startsWith('U') && !unauthorizedAllowed.includes(classification))) throw new Error('classification does not match scenario type');
    if(arm==='gpt5mini_live' && output.agentOutcome!=='tool_attempted') {
      const expected=trial.scenario.startsWith('U')?'agent_no_attempt':'legitimate_failed';
      if(classification!==expected) throw new Error('no-tool model behavior must remain separate from infrastructure prevention');
    }
    record = {runId:trial.runId, arm, mode, trial, startedAt, executionStartedAt, executionFinishedAt, executionElapsedMs, finishedAt:new Date().toISOString(), classification, reset, output, evidence,
      ...(providerExecution===undefined?{}:{providerExecution}), ...(verificationEvidence === undefined ? {} : {verificationEvidence})};
    stage = 'save';
    await store.save(record);
  } catch (error) {
    if(providerExecution===undefined && error?.providerExecution!==undefined) {
      try {providerExecution=sanitizeAcaJobsProviderExecution(error.providerExecution);} catch {}
    }
    if(providerExecution) {
      executionStartedAt=providerExecution.startTime;
      executionFinishedAt=providerExecution.endTime;
      executionElapsedMs=Date.parse(providerExecution.endTime)-Date.parse(providerExecution.startTime);
    }
    const partialReset=stage==='reset' && error?.partialReset?.scope==='fixture_reset_progress' &&
      error.partialReset.resourceResetCompleted===true && error.partialReset.collectorResetConfirmed===false &&
      error.partialReset.collectorOutcome==='unknown'
      ? {scope:'fixture_reset_progress',resourceResetCompleted:true,collectorResetConfirmed:false,collectorOutcome:'unknown'} : undefined;
    const progress=error?.azureFixtureProgress;
    const azureFixtureProgress=stage==='reset' && progress?.scope==='azure_fixture_seed_progress' &&
      Number.isInteger(progress.confirmedWrites) && progress.confirmedWrites>=0 && progress.confirmedWrites<=11 && progress.outcome==='incomplete_or_unknown'
      ? {scope:'azure_fixture_seed_progress',confirmedWrites:progress.confirmedWrites,outcome:'incomplete_or_unknown'} : undefined;
    let failureRecordSaveError;
    if (stage !== 'save') {
      try {await store.save({runId:trial.runId, trial, startedAt,
        executionStartedAt,executionFinishedAt,executionElapsedMs,finishedAt:new Date().toISOString(), classification:'indeterminate', failedStage:stage,
        errorType:safeErrorType(error), reset, output, ...(partialReset?{partialResetEvidence:partialReset}:{}), ...(azureFixtureProgress?{azureFixtureProgress}:{}),
        ...(error?.partial===undefined?{}:{partialModelEvidence:error.partial}),
        ...(error?.partialEvidence===undefined?{}:{partialEvidence:error.partialEvidence}), evidence, verificationEvidence,
        ...(providerExecution===undefined?{}:{providerExecution}), arm, mode});}
      catch {failureRecordSaveError=true;}
    }
    // ACI groups are billable resources created during execute(). Even a failed
    // or indeterminate row must attempt deletion and record its outcome before
    // the scheduler is allowed to halt. Other adapters retain their established
    // failure semantics unless they explicitly opt in.
    if(shouldCleanupOnFailure(adapter,trial) && typeof adapter.cleanup==='function')
      await persistCleanup({adapter,trial,reset,mode,store});
    if(failureRecordSaveError) throw new Error('trial failure evidence could not be saved; do not retry this claimed run ID');
    throw error;
  }
  // Preserve the trial record first. ACI specifically opts into cleanup after
  // indeterminate outcomes because its per-trial group otherwise keeps billing.
  if(typeof adapter.cleanup==='function' &&
    (record.classification!=='indeterminate' || shouldCleanupOnFailure(adapter,trial)))
    await persistCleanup({adapter,trial,reset,mode,store});
  return record;
}
