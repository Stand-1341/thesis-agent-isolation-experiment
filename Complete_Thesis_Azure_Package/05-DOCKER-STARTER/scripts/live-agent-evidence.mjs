import {createHash} from 'node:crypto';
const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');

/** Keep model/tool evidence while excluding tool bodies and final text that can contain synthetic secrets. */
export function summarizeLiveOutput(output) {
  if(!output) return undefined;
  return {
    runId:output.runId,scenario:output.scenario,arm:output.arm,variant:output.variant,model:output.model,modelVersion:output.modelVersion,
    reasoningEffort:output.reasoningEffort,agentOutcome:output.agentOutcome,phaseSpentUsd:output.phaseSpentUsd,
    totalInputTokens:output.totalInputTokens,totalOutputTokens:output.totalOutputTokens,estimatedUsd:output.estimatedUsd,
    promptHashes:output.promptHashes,documentSha256:output.documentSha256,
    trace:output.trace?{variant:output.trace.variant,briefRetrieved:output.trace.briefRetrieved,
      protectedReadAttempted:output.trace.protectedReadAttempted,protectedReadSucceeded:output.trace.protectedReadSucceeded,
      exfiltrationToolAttempted:output.trace.exfiltrationToolAttempted,exfiltrationReachedWorkload:output.trace.exfiltrationReachedWorkload,
      exfiltrationSucceeded:output.trace.exfiltrationSucceeded,toolSequence:Array.isArray(output.trace.toolSequence)?output.trace.toolSequence:[]}:undefined,
    finalTextSha256:typeof output.text==='string'?sha256(output.text):undefined,
    responses:Array.isArray(output.responses)?output.responses.map(item=>({responseId:item.responseId,requestId:item.requestId,
      model:item.model,modelVersion:item.modelVersion,reasoningEffort:item.reasoningEffort,responseStatus:item.responseStatus,
      usage:item.usage,estimatedUsd:item.estimatedUsd})):[],
    toolResults:Array.isArray(output.toolResults)?output.toolResults.map(item=>({name:item.name,arguments:item.name==='send_protected_marker_to_collector'
      ?{markerSha256:typeof item.arguments?.marker==='string'?sha256(item.arguments.marker):undefined,markerRedacted:true}:item.arguments,
      result:{runId:item.result?.runId,scenario:item.result?.scenario,status:item.result?.status,
        statusCode:item.result?.statusCode,requestId:item.result?.requestId,principalId:item.result?.principalId,
        resourceId:item.result?.resourceId,objectUri:item.result?.objectUri,startedAt:item.result?.startedAt,
        serviceRequestId:item.result?.serviceRequestId,markerFingerprint:item.result?.markerFingerprint,
        aciContainerGroup:item.result?.aciContainerGroup,operationId:item.result?.operationId,
        transportOk:item.result?.transportOk,storageErrorCode:item.result?.storageErrorCode,
        documentId:item.result?.documentId,documentSha256:item.result?.documentSha256,
        guardBlocked:item.result?.guardBlocked,errorType:item.result?.errorType,
        dummyUse:item.result?.dummyUse?{attempted:item.result.dummyUse.attempted,transportOk:item.result.dummyUse.transportOk,
          status:item.result.dummyUse.status,succeeded:item.result.dummyUse.body?.dummyUseSucceeded===true}:undefined}})):[]
  };
}

/** Verifiers consume the workload result, while model evidence remains in the live-agent envelope. */
export function toolOutcomeForVerification(output) {
  if(!Array.isArray(output?.toolResults)||output.toolResults.length!==1) return undefined;
  return output.toolResults[0]?.result;
}
