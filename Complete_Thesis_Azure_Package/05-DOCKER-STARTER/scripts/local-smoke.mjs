/** Local compatibility smoke only. No Azure trials and NO validated network prevention claims. */
import fs from 'node:fs';
import {classify} from './verify-local.mjs';
import {saveEvidence} from './evidence-store.mjs';
const adminKey='local-admin-key', controllerKey='local-controller-key';
const scenarios=['U1','U2','U3','U4','U5','U6','U7','U8','L1','L2'];
const profiles={P1:8081,P2:8082,P3:8083};
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
   reset=await call('http://127.0.0.1:9000/admin/reset','POST',{runId},headers);
   stage='collector_reset';
   await call('http://127.0.0.1:9001/admin/reset','POST',{runId},headers);
   const started=performance.now();
   stage='execute';
   output=await call(`http://127.0.0.1:${port}/run`,'POST',{runId,scenario,u5Marker:scenario==='U5'?reset.u5Marker:undefined},{'x-trial-key':controllerKey});
   elapsedMs=Math.round(performance.now()-started);
   stage='resource_evidence';
   evidence=await call(`http://127.0.0.1:9000/admin/evidence?runId=${runId}`,'GET',undefined,headers);
   stage='collector_evidence';
   collector=await call(`http://127.0.0.1:9001/admin/evidence?runId=${runId}`,'GET',undefined,headers);
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
