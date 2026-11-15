const RESOURCE_ID=/^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Storage\/storageAccounts\/([^/]+)$/i;
const ACCOUNT_HOST=/^([a-z0-9]{3,24})\.blob\.core\.windows\.net$/i;
const API_VERSION='2025-08-01';

function unknown(reason) { return {state:'unknown',locked:false,reason}; }

/** Resolve and cross-check the exact storage container and ARM account scope. */
export function resolveEvidenceContainerScope({accountId,containerUrl,subscriptionId}={}) {
  const match=typeof accountId==='string' && RESOURCE_ID.exec(accountId);
  if(!match) throw new Error('evidence account resource ID is missing or invalid');
  const [,idSubscription,resourceGroup,accountName]=match;
  let url;
  try { url=new URL(containerUrl); } catch { throw new Error('evidence container URL is missing or invalid'); }
  const host=ACCOUNT_HOST.exec(url.hostname);
  const pathParts=url.pathname.split('/').filter(Boolean);
  if(url.protocol!=='https:' || url.username || url.password || url.port || url.search || url.hash || !host || pathParts.length!==1 ||
    !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(pathParts[0]) ||
    host[1].toLowerCase()!==accountName.toLowerCase())
    throw new Error('evidence URL must identify one exact Azure Blob container on the resolved storage account');
  if(subscriptionId && idSubscription.toLowerCase()!==subscriptionId.toLowerCase())
    throw new Error('evidence account subscription does not match the resolved deployment');
  const policyResourceId=`${accountId}/blobServices/default/containers/${pathParts[0]}/immutabilityPolicies/default`;
  return {subscriptionId:idSubscription,resourceGroup,accountName,containerName:pathParts[0],policyResourceId};
}

/** Read container immutability policy through ARM; this function never writes. */
export async function readEvidenceRetentionStatus({az,accountId,containerUrl,subscriptionId,requiredDays=7}={}) {
  if(typeof az!=='function') return unknown('Azure Resource Manager query is unavailable');
  if(!Number.isInteger(requiredDays) || requiredDays<1) return unknown('configured evidence retention period is invalid');
  let scope;
  try { scope=resolveEvidenceContainerScope({accountId,containerUrl,subscriptionId}); }
  catch(error) { return unknown(error.message); }
  const url=`https://management.azure.com${scope.policyResourceId}?api-version=${API_VERSION}`;
  let policy;
  try {
    policy=await az(['rest','--method','get','--url',url,'--subscription',scope.subscriptionId]);
  } catch(error) {
    const code=String(error?.code ?? error?.statusCode ?? '');
    const detail=`${error?.stderr ?? ''} ${error?.message ?? ''}`;
    if(code==='404' || /ResourceNotFound|NotFound|\b404\b/i.test(detail))
      return {state:'unlocked',locked:false,reason:'container immutability policy was not found',policyResourceId:scope.policyResourceId};
    return unknown('Azure Resource Manager could not verify the container policy');
  }
  const properties=policy?.properties;
  const state=properties?.state;
  const periodDays=properties?.immutabilityPeriodSinceCreationInDays;
  const policyId=policy?.id;
  const policyType=policy?.type;
  const expectedType='Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies';
  if(typeof policyId!=='string' || policyId.toLowerCase()!==scope.policyResourceId.toLowerCase() ||
    typeof policy?.name!=='string' || policy.name.toLowerCase()!=='default' || typeof policyType!=='string' || policyType.toLowerCase()!==expectedType.toLowerCase() ||
    !Number.isInteger(periodDays) || periodDays<1 || !['Locked','Unlocked'].includes(state))
    return unknown('Azure Resource Manager returned an incomplete or mismatched container policy');
  if(state!=='Locked') return {state:'unlocked',locked:false,periodDays,policyResourceId:scope.policyResourceId,reason:'container policy is not locked'};
  if(periodDays<requiredDays)
    return {state:'locked',locked:false,periodDays,policyResourceId:scope.policyResourceId,reason:`locked period is shorter than configured ${requiredDays}-day retention`};
  return {state:'locked',locked:true,periodDays,policyResourceId:scope.policyResourceId};
}
