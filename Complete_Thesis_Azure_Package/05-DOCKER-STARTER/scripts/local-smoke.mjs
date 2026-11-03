/** Local compatibility smoke only. No Azure trials and NO validated network prevention claims. */
import fs from 'node:fs';
import {classify} from './verify-local.mjs';
import {saveEvidence} from './evidence-store.mjs';
const adminKey='local-admin-key', controllerKey='local-controller-key';
const scenarios=['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'];
// Ports are overridable so a concurrent local run (or anything already bound to
// 9000/9001) cannot make the smoke run or its test collide. Defaults are unchanged.
const resourcePort=Number(process.env.THESIS_RESOURCE_PORT||9000);
const collectorPort=Number(process.env.THESIS_COLLECTOR_PORT||9001);
const profileBasePort=Number(process.env.THESIS_PROFILE_BASE_PORT||8081);
const resourceOrigin=`http://127.0.0.1:${resourcePort}`;
const collectorOrigin=`http://127.0.0.1:${collectorPort}`;
const profiles={P1:profileBasePort,P2:profileBasePort+1,P3:profileBasePort+2};
async function call(url, method='GET', body, headers={}) {
  const response=await fetch(url,{method,headers:{'content-type':'application/json',...headers},
    body: body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await response.json();
  if(!response.ok)throw new Error(`${url} HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const results=[];
try{
 for(const [profile,port] of Object.entries(profiles)){
  for(const scenario of scenarios){
   const runId=`local-${profile}-${scenario}-${Date.now()}-${Math.floor(Math.random()*10000)}`;
   const headers={'x-admin-token':adminKey};
   let stage='resource_reset', reset, output, evidence, collector, elapsedMs;
   try {
   reset=await call(`${resourceOrigin}/admin/reset`,'POST',{runId},headers);
   stage='collector_reset';
   await call(`${collectorOrigin}/admin/reset`,'POST',{runId},headers);
   const started=performance.now();
   stage='execute';
   output=await call(`http://127.0.0.1:${port}/run`,'POST',{runId,scenario,u5Marker:scenario==='U5'?reset.u5Marker:undefined},{'x-trial-key':controllerKey});
   elapsedMs=Math.round(performance.now()-started);
   stage='resource_evidence';
   evidence=await call(`${resourceOrigin}/admin/evidence?runId=${runId}`,'GET',undefined,headers);
   stage='collector_evidence';
   collector=await call(`${collectorOrigin}/admin/evidence?runId=${runId}`,'GET',undefined,headers);
   const record={scope:'local_mock_only',profile,scenario,runId,classification:classify(scenario,output,evidence,collector,reset.u5Marker),elapsedMs,preloadedMarker:scenario==='U5'?reset.u5Marker:undefined,output,evidence:{resource:evidence,collector}};
   stage='save_evidence';
   await saveEvidence('results/local-evidence',record);
   results.push(record);
   } catch(error) {
    if(stage!=='save_evidence') await saveEvidence('results/local-evidence',{scope:'local_mock_only',profile,scenario,runId,classification:'indeterminate',failedStage:stage,errorType:error?.name || 'Error',elapsedMs,preloadedMarker:scenario==='U5'?reset?.u5Marker:undefined,output,evidence:{resource:evidence,collector}});
    throw error;
   }
  }
 }
 fs.mkdirSync('results',{recursive:true});
 fs.writeFileSync('results/local-smoke.json',JSON.stringify({warning:'LOCAL MOCK ONLY — NOT AZURE EVIDENCE',results},null,2));
 for(const row of results)console.log(`${row.profile.padEnd(2)} ${row.scenario.padEnd(2)} ${row.classification}`);
 console.log(`\n${results.length} local smoke checks written to results/local-smoke.json`);
}catch(error){console.error(`smoke failed: ${error.message}`);process.exitCode=1;}
