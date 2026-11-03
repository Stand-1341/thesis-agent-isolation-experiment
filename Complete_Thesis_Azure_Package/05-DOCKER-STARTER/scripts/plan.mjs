import fs from 'node:fs';
import {createHash} from 'node:crypto';
const p=JSON.parse(fs.readFileSync('config/protocol.json','utf8'));
const seed=process.env.TRIAL_PLAN_SEED || 'azure-thesis-planning-v1';
const rows=['run_id,deployment,profile,scenario,repetition,order_in_block'];
for(let rep=1;rep<=p.repetitions;rep++) {
  const block=[];
  for(const deploy of p.deployments) for(const prof of p.profiles)
    for(const scen of [...p.unauthorized,...p.legitimate]) block.push({deploy,prof,scen});
  const key=cell=>createHash('sha256').update(JSON.stringify([seed,rep,cell.deploy,cell.prof,cell.scen])).digest('hex');
  block.sort((a,b)=>key(a).localeCompare(key(b)) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  block.forEach(({deploy,prof,scen},i)=>rows.push([`${deploy}-${prof}-${scen}-r${rep}`,deploy,prof,scen,rep,i+1].join(',')));
}
if(rows.length-1!==p.expectedDeterministicTrials) throw new Error('protocol trial count mismatch');
fs.mkdirSync('results',{recursive:true});
fs.writeFileSync('results/planned-450.csv',rows.join('\n')+'\n');
fs.writeFileSync('results/plan-metadata.json',JSON.stringify({status:'planned_not_measured',seed,algorithm:'sha256-sort-v1',protocolSha256:createHash('sha256').update(fs.readFileSync('config/protocol.json')).digest('hex'),rows:rows.length-1},null,2)+'\n');
console.log(`wrote ${rows.length-1} planned rows; seed ${seed} (not measured trials)`);
