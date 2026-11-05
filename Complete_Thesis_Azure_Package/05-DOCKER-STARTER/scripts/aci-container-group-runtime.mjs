import {createHash} from 'node:crypto';
import {randomUUID} from 'node:crypto';

const API='2023-05-01';
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARM_ID=/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[^/]+$/i;
const RFC1918=value=>{
  const parts=String(value||'').split('.').map(Number);
  if(parts.length!==4 || parts.some(n=>!Number.isInteger(n)||n<0||n>255)) return false;
  return parts[0]===10 || (parts[0]===172 && parts[1]>=16 && parts[1]<=31) || (parts[0]===192 && parts[1]===168);
};

export function aciGroupName(runId,profile) {
  if(!/^[A-Za-z0-9_-]{1,150}$/.test(runId||'') || !['P1','P2'].includes(profile)) throw new Error('invalid ACI run identity');
  return `thesis-aci-${profile.toLowerCase()}-${createHash('sha256').update(runId).digest('hex').slice(0,24)}`;
}

export function buildAciContainerGroupBody({location,imageDigestReference,registryServer,pullIdentityId,workloadIdentityId,
  workloadIdentityClientId,workloadPrincipalObjectId,blobResourceId,subnetId,researchUrl,collectorUrl,blobEndpoint,workloadToken,trialRequestKey,cpu=1,memoryInGiB=1.5,dnsServer='168.63.129.16'}) {
  if(typeof location!=='string' || !location || typeof imageDigestReference!=='string' || !/@sha256:[a-f0-9]{64}$/.test(imageDigestReference)) throw new Error('ACI image must be pinned by digest');
  if(typeof registryServer!=='string' || !/^[a-z0-9-]+\.azurecr\.io$/i.test(registryServer)) throw new Error('invalid ACR server');
  if(!ARM_ID.test(pullIdentityId||'') || !ARM_ID.test(workloadIdentityId||'') || pullIdentityId.toLowerCase()===workloadIdentityId.toLowerCase()) throw new Error('ACR pull and workload identities must be distinct user-assigned identities');
  if(!GUID.test(workloadIdentityClientId||'')) throw new Error('invalid workload identity client ID');
  if(!GUID.test(workloadPrincipalObjectId||'')) throw new Error('invalid workload identity principal object ID');
  const blobMatch=/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]+\/providers\/Microsoft\.Storage\/storageAccounts\/([a-z0-9]{3,24})\/blobServices\/default$/i.exec(blobResourceId||'');
  if(!blobMatch||`${blobMatch[1]}.blob.core.windows.net`.toLowerCase()!==new URL(blobEndpoint).hostname.toLowerCase())
    throw new Error('ACI Blob service resource ID must match the configured endpoint');
  if(typeof subnetId!=='string' || !/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/virtualNetworks\/[^/]+\/subnets\/[^/]+$/i.test(subnetId)) throw new Error('invalid ACI subnet resource ID');
  for(const [value,name] of [[researchUrl,'researchUrl'],[collectorUrl,'collectorUrl'],[blobEndpoint,'blobEndpoint']]) {
    let url; try {url=new URL(value);} catch {throw new Error(`invalid ${name}`);}
    if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash) throw new Error(`invalid ${name}`);
  }
  if(typeof workloadToken!=='string' || workloadToken.length<16 || /[\r\n]/.test(workloadToken) ||
    typeof trialRequestKey!=='string' || trialRequestKey.length<16 || /[\r\n]/.test(trialRequestKey)) throw new Error('missing ACI workload or controller credential');
  if(cpu!==1 || memoryInGiB!==1.5) throw new Error('ACI pilot resources are fixed at 1 vCPU and 1.5 GiB');
  if(dnsServer!=='168.63.129.16') throw new Error('ACI DNS must use the configured Azure VNet resolver');
  return {
    location,
    identity:{type:'UserAssigned',userAssignedIdentities:{[pullIdentityId]:{},[workloadIdentityId]:{}}},
    properties:{
      containers:[{name:'agent',properties:{
        image:imageDigestReference,
        ports:[{port:8080,protocol:'TCP'}],
        resources:{requests:{cpu,memoryInGB:memoryInGiB}},
        environmentVariables:[
          {name:'PORT',value:'8080'},
          {name:'AZURE_TOKEN_MODE',value:'managed'},
          {name:'AZURE_CLIENT_ID',value:workloadIdentityClientId},
          {name:'AZURE_PRINCIPAL_OBJECT_ID',value:workloadPrincipalObjectId},
          {name:'THESIS_BLOB_RESOURCE_ID',value:blobResourceId},
          {name:'AZURE_BLOB_ENDPOINT',value:blobEndpoint},
          {name:'RESEARCH_URL',value:researchUrl},
          {name:'COLLECTOR_URL',value:collectorUrl},
          {name:'WORKLOAD_TOKEN',secureValue:workloadToken},
          {name:'TRIAL_REQUEST_KEY',secureValue:trialRequestKey}
        ]}}],
      imageRegistryCredentials:[{server:registryServer,identity:pullIdentityId}],
      ipAddress:{type:'Private',ports:[{port:8080,protocol:'TCP'}]},
      osType:'Linux',restartPolicy:'Never',sku:'Standard',subnetIds:[{id:subnetId}],dnsConfig:{nameServers:[dnsServer]}
    }
  };
}

export function createAciContainerGroupClient({subscriptionId,resourceGroup,getManagementToken,fetchImpl=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  pollIntervalMs=3000,createTimeoutMs=900000,deleteTimeoutMs=180000,now=()=>Date.now()}) {
  if(!/^[0-9a-f-]{36}$/i.test(subscriptionId||'') || !/^[A-Za-z0-9_.()\-]{1,90}$/.test(resourceGroup||'') || typeof getManagementToken!=='function' || typeof fetchImpl!=='function') throw new Error('invalid ACI ARM client configuration');
  if(!Number.isInteger(pollIntervalMs)||pollIntervalMs<10 || !Number.isInteger(createTimeoutMs)||createTimeoutMs<100 || !Number.isInteger(deleteTimeoutMs)||deleteTimeoutMs<100) throw new Error('invalid ACI polling configuration');
  const urlFor=name=>`https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.ContainerInstance/containerGroups/${encodeURIComponent(name)}?api-version=${API}`;
  async function request(url,method,body) {
    const token=await getManagementToken();
    if(typeof token!=='string'||!token||/\s/.test(token)) throw new Error('ACI management token unavailable');
    let response;
    try {response=await fetchImpl(url,{method,redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});}
    catch {throw new Error('ACI ARM request failed');}
    let result;
    try {result=await response.json();} catch {result={};}
    if(response.status===404) return {status:404,body:result};
    if(!response.ok) {
      const code=typeof result?.error?.code==='string' && /^[A-Za-z0-9_.-]{1,80}$/.test(result.error.code)?result.error.code:'unknown';
      throw new Error(`ACI ARM ${method} failed (${response.status}, ${code})`);
    }
    return {status:response.status,body:result};
  }
  async function poll(name,predicate,timeoutMs,stage) {
    const deadline=now()+timeoutMs;
    while(now()<deadline) {
      const result=await request(urlFor(name),'GET');
      if(result.status===404 && stage==='delete') return true;
      if(result.status===404) throw new Error('ACI container group disappeared before lifecycle completed');
      const state=result.body?.properties?.provisioningState;
      if(predicate(result.body)) return result.body;
      if(['Failed','Canceled','Deleted'].includes(state)) throw new Error(`ACI container group lifecycle failed (${state})`);
      await sleep(Math.min(pollIntervalMs,Math.max(1,deadline-now())));
    }
    throw new Error(`ACI container group ${stage} timed out`);
  }
  return {
    async create(name,body) {
      if(!/^thesis-aci-(p1|p2)-[a-f0-9]{24}$/.test(name||'')) throw new Error('invalid ACI container group name');
      const current=await request(urlFor(name),'GET');
      if(current.status!==404) throw new Error('ACI container group already exists; refusing replay');
      await request(urlFor(name),'PUT',body);
      const group=await poll(name,value=>value?.properties?.provisioningState==='Succeeded' && RFC1918(value?.properties?.ipAddress?.ip),createTimeoutMs,'create');
      return {name,resourceId:group.id,privateIp:group.properties.ipAddress.ip,provisioningState:group.properties.provisioningState};
    },
    async delete(name) {
      if(!/^thesis-aci-(p1|p2)-[a-f0-9]{24}$/.test(name||'')) throw new Error('invalid ACI container group name');
      const current=await request(urlFor(name),'GET');
      if(current.status===404) return {name,deleted:true,alreadyAbsent:true};
      await request(urlFor(name),'DELETE');
      await poll(name,()=>false,deleteTimeoutMs,'delete');
      return {name,deleted:true,alreadyAbsent:false};
    }
  };
}

export function createAciTrialAdapter({fixtureAdapter,groupClient,groupBodyForTrial,controllerToken,fetchImpl=fetch,timeoutMs=30000,
  readinessTimeoutMs=180000,pollIntervalMs=2000,sessionAnalog}) {
  if(!fixtureAdapter || typeof fixtureAdapter.reset!=='function' || typeof fixtureAdapter.collect!=='function' ||
    !groupClient || typeof groupClient.create!=='function' || typeof groupClient.delete!=='function' || typeof groupBodyForTrial!=='function' ||
    typeof controllerToken!=='string' || controllerToken.length<16 || typeof fetchImpl!=='function') throw new Error('invalid ACI trial adapter configuration');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000 || !Number.isInteger(readinessTimeoutMs)||readinessTimeoutMs<1000 || readinessTimeoutMs>300000 || !Number.isInteger(pollIntervalMs)||pollIntervalMs<100 || pollIntervalMs>10000) throw new Error('invalid ACI adapter timing');
  if(sessionAnalog!==undefined && typeof sessionAnalog!=='function') throw new Error('invalid ACI session analogue dependency');
  const groups=new Map(),claimed=new Set();
  const ANALOG_SCENARIOS=new Set(['U6','U8']);
  const isAnalogTrial=trial=>ANALOG_SCENARIOS.has(trial?.scenario);
  function sanitizeAnalogEvidence(value,depth=0) {
    if(depth>10) return '[depth-limited]';
    if(value===null || typeof value==='boolean' || typeof value==='number') return value;
    if(typeof value==='string') return value.slice(0,2048);
    if(Array.isArray(value)) return value.slice(0,500).map(item=>sanitizeAnalogEvidence(item,depth+1));
    if(typeof value==='object') {
      const safe={};
      for(const [key,item] of Object.entries(value)) {
        if(!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) || /(token|secret|password|credential|authorization|securevalue|sas)/i.test(key)) continue;
        safe[key]=sanitizeAnalogEvidence(item,depth+1);
      }
      return safe;
    }
    return undefined;
  }
  async function call(url,options) {
    let response;
    try {response=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});} catch {throw new Error('ACI private agent request failed');}
    let result; try {result=await response.json();} catch {result={};}
    if(!response.ok) throw new Error(`ACI private agent HTTP ${response.status}`);
    return result;
  }
  async function createWorkloadContext(trial,fixture) {
    const name=aciGroupName(trial.runId,trial.profile);
    let group;
    try {group=await groupClient.create(name,await groupBodyForTrial(trial,fixture));}
    catch(error) {throw new Error(`ACI container group create outcome requires reconciliation (${error instanceof Error?error.message:'Error'})`);}
    if(group?.name!==name || !RFC1918(group?.privateIp) || group.provisioningState!=='Succeeded') throw new Error('ACI container group returned invalid private endpoint');
    groups.set(trial.runId,group);
    const endpoint=`http://${group.privateIp}:8080`;
    const deadline=Date.now()+readinessTimeoutMs;
    let ready=false;
    while(Date.now()<deadline) {
      try {
        const health=await call(`${endpoint}/health`,{method:'GET'});
        if(health?.ready===true) {ready=true;break;}
        throw new Error('invalid ACI health response');
      } catch(error) {
        if(error.message==='invalid ACI health response') throw error;
        const remaining=deadline-Date.now(); if(remaining>0) await new Promise(resolve=>setTimeout(resolve,Math.min(pollIntervalMs,remaining)));
      }
    }
    if(!ready) throw new Error('ACI private agent readiness timed out');
    return {name,privateIp:group.privateIp,endpoint,trial};
  }
  async function executeInContext(context,trial,fixture,{operationId}={}) {
    const operation=trial.scenario;
    if(operationId!==undefined && !/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error('invalid ACI interaction operation ID');
    const headers={'content-type':'application/json','x-trial-key':controllerToken};
    if(operationId) headers['x-ms-client-request-id']=operationId;
    const output=await call(`${context.endpoint}/run`,{method:'POST',headers,
      body:JSON.stringify({runId:trial.runId,scenario:operation,...(operationId?{requestId:operationId}:{}),
        ...(operation==='U5'&&typeof fixture?.u5Marker==='string'?{u5Marker:fixture.u5Marker}:{})})});
    if(output?.runId!==trial.runId || output?.scenario!==operation) throw new Error('ACI workload response did not match the claimed operation');
    return {...output,aciContainerGroup:context.name,aciPrivateIp:context.privateIp,...(operationId?{operationId}: {})};
  }
  return {
    // The runner must delete deterministic group names after execute/reset
    // failures, verifier indeterminacy, or timeouts. This also reconciles a
    // create request whose response was ambiguous without retrying the trial.
    cleanupOnFailure:true,
    async reset(trial) {
      // U6/U8 fixture setup belongs wholly to the explicitly injected analog.
      // In its absence this is an inert sentinel: no legacy fixture or Azure
      // resource operation is attempted, and execute will fail closed.
      if(isAnalogTrial(trial)) return {scope:'aci_session_analog',runId:trial.runId,scenario:trial.scenario};
      return fixtureAdapter.reset(trial);
    },
    async execute(trial,fixture) {
      if(!/^[A-Za-z0-9_-]{1,150}$/.test(trial?.runId||'') || !['P1','P2'].includes(trial.profile) || !/^(U[1-8]|L[12])$/.test(trial.scenario||'')) throw new Error('invalid ACI trial');
      if(claimed.has(trial.runId)) throw new Error('ACI run ID already claimed');
      claimed.add(trial.runId);
      if(isAnalogTrial(trial)) {
        if(!sessionAnalog) throw new Error(`ACI ${trial.scenario} session analogue is not configured`);
        let analogResult;
        try {analogResult=await sessionAnalog(trial);}
        catch(error) {
          // trial-runner persists this separately as partialEvidence. Preserve
          // the candidate analogue's already-sanitized progress on failure.
          if(error && typeof error==='object' && error.partialEvidence!==undefined)
            error.partialEvidence=sanitizeAnalogEvidence(error.partialEvidence);
          throw error;
        }
        if(!analogResult || typeof analogResult!=='object' || !analogResult.evidence ||
          analogResult.evidence.runId!==trial.runId || analogResult.evidence.scenario!==trial.scenario)
          throw new Error('ACI session analogue result did not match the claimed row');
        return {runId:trial.runId,scenario:trial.scenario,aciSessionAnalog:analogResult};
      }
      const context=await createWorkloadContext(trial,fixture);
      return executeInContext(context,trial,fixture);
    },
    /**
     * Open one ACI workload group for the live prompt-injection pair. Only the
     * U1 protected read followed by the U5 collector send is allowed. The
     * ordinary execute() API remains one-shot and unchanged for deterministic
     * trials. Each operation receives its own request correlation ID.
     */
    async beginInjectionPair(trial,fixture) {
      if(!/^[A-Za-z0-9_-]{1,150}$/.test(trial?.runId||'') || trial?.profile!=='P1' || trial?.scenario!=='U1')
        throw new Error('ACI prompt-injection pair must start from a P1 U1 trial');
      if(claimed.has(trial.runId)) throw new Error('ACI run ID already claimed');
      claimed.add(trial.runId);
      const context=await createWorkloadContext(trial,fixture);
      const operations=['U1','U5'];
      const completed=[];
      let closed=false;
      return Object.freeze({
        async executeOperation(scenario) {
          if(closed) throw new Error('ACI injection pair session is closed');
          const expected=operations[completed.length];
          if(scenario!==expected) throw new Error(`ACI injection pair operation order violation; expected ${expected||'no more operations'}`);
          const operationId=randomUUID();
          const operationTrial={...trial,scenario};
          const output=await executeInContext(context,operationTrial,fixture,{operationId});
          completed.push({scenario,operationId});
          return output;
        },
        observations:()=>completed.map(item=>({...item})),
        close() {closed=true;}
      });
    },
    collect:(trial,fixture,output,timing)=>{
      if(isAnalogTrial(trial)) {
        const result=output?.aciSessionAnalog;
        if(!result || result.evidence?.runId!==trial.runId || result.evidence?.scenario!==trial.scenario)
          throw new Error('ACI session analogue evidence is missing or mismatched');
        return {aciSessionAnalog:{classification:result.classification,evidence:sanitizeAnalogEvidence(result.evidence)}};
      }
      return fixtureAdapter.collect(trial,fixture,output,timing);
    },
    async cleanup(trial) {
      // The candidate analogue owns its auxiliary groups, identities and
      // marker cleanup. Never infer or delete the ordinary deterministic
      // workload group for U6/U8; those rows do not create one here.
      if(isAnalogTrial(trial)) return {scope:'aci_session_analog',cleanupDelegated:true,normalGroupSkipped:true};
      const group=groups.get(trial.runId)??{name:aciGroupName(trial.runId,trial.profile)};
      const result=await groupClient.delete(group.name);
      if(result?.deleted!==true) throw new Error('ACI container group deletion not confirmed');
      groups.delete(trial.runId);
      return {groupName:group.name,deleted:true,alreadyAbsent:result.alreadyAbsent===true};
    }
  };
}
