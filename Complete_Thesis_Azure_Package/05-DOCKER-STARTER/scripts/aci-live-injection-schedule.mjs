import {createHash} from 'node:crypto';

export const ACI_LIVE_INJECTION_HEADER='planned_run_id,pair_id,block,order_in_block,condition_order,deployment,permission_profile,scenario_id,variant,status,result,verified_evidence_ref';
const uint32=0x1_0000_0000;
function indexFor(seed,counter,upper) {
  const limit=uint32-(uint32%upper);
  for(let retry=0;;retry++) {
    const bytes=createHash('sha256').update(`${seed}|pair-order|${counter}|${retry}`,'utf8').digest();
    const value=bytes.readUInt32BE(0);
    if(value<limit) return value%upper;
  }
}

/** Fifty fixed conditions: 25 matched clean/attack pairs, with counterbalanced within-pair order. */
export function generateAciLiveInjectionSchedule(seed) {
  if(typeof seed!=='string'||!/^[a-z0-9][a-z0-9-]{5,80}$/i.test(seed)) throw new Error('invalid ACI live-injection seed');
  const pairNumbers=Array.from({length:25},(_,i)=>i+1);
  for(let i=pairNumbers.length-1,counter=0;i>0;i--,counter++) {
    const j=indexFor(seed,counter,i+1);[pairNumbers[i],pairNumbers[j]]=[pairNumbers[j],pairNumbers[i]];
  }
  const direction=[...Array(13).fill('attack'),...Array(12).fill('clean')];
  for(let i=direction.length-1,counter=100;i>0;i--,counter++) {
    const j=indexFor(seed,counter,i+1);[direction[i],direction[j]]=[direction[j],direction[i]];
  }
  const rows=[];
  for(let sequence=0;sequence<pairNumbers.length;sequence++) {
    const pairNo=pairNumbers[sequence],pairId=`aci-live-pi-p${String(pairNo).padStart(2,'0')}`;
    const first=direction[sequence],variants=first==='attack'?['attack','clean']:['clean','attack'];
    for(let within=0;within<2;within++) {
      const conditionOrder=sequence*2+within+1,variant=variants[within];
      rows.push({planned_run_id:`pilot-live-aci-p1-p${String(pairNo).padStart(2,'0')}-${variant}`,
        pair_id:pairId,block:String(Math.floor(sequence/5)+1),order_in_block:String((sequence%5)*2+within+1),
        condition_order:String(conditionOrder),deployment:'azure_container_instances',permission_profile:'P1',
        scenario_id:'U1_U5_PROMPT_INJECTION',variant,status:'NOT RUN',result:'',verified_evidence_ref:''});
    }
  }
  return Buffer.from(`${ACI_LIVE_INJECTION_HEADER}\n${rows.map(row=>Object.values(row).join(',')).join('\n')}\n`,'utf8');
}

export function parseAciLiveInjectionSchedule(bytes) {
  if(!Buffer.isBuffer(bytes)) throw new Error('ACI live-injection schedule must be bytes');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('ACI live-injection schedule is not valid UTF-8');}
  if(text.charCodeAt(0)===0xfeff) text=text.slice(1);
  if(/[\0'"\r]/.test(text.replace(/\r?\n/g,''))) throw new Error('ACI live-injection CSV contains unsafe characters');
  const lines=text.split(/\r?\n/);if(lines.at(-1)==='') lines.pop();
  if(lines.shift()!==ACI_LIVE_INJECTION_HEADER) throw new Error('ACI live-injection schedule header mismatch');
  const keys=ACI_LIVE_INJECTION_HEADER.split(',');
  const rows=lines.map((line,index)=>{const values=line.split(',');if(values.length!==keys.length)throw new Error(`invalid ACI live-injection row ${index+1}`);return Object.fromEntries(keys.map((key,i)=>[key,values[i]]));});
  return rows;
}

export function validateAciLiveInjectionSchedule({bytes,protocol}) {
  if(protocol?.protocolId!=='aci-p1-live-injection-50-v1'||protocol?.countedAsStudyTrials!==false||
    protocol?.deployment!=='azure_container_instances'||protocol?.permissionProfile!=='P1'||
    protocol?.conditions!==50||protocol?.pairs!==25||protocol?.blocks!==5||protocol?.conditionsPerBlock!==10||
    protocol?.randomization!=='sha256-pair-order-and-counterbalanced-v1') throw new Error('ACI live-injection protocol metadata mismatch');
  if(!/^[a-f0-9]{64}$/.test(protocol.scheduleSha256||'')||createHash('sha256').update(bytes).digest('hex')!==protocol.scheduleSha256)
    throw new Error('ACI live-injection schedule digest mismatch');
  const expected=generateAciLiveInjectionSchedule(protocol.seed);
  if(!expected.equals(bytes)) throw new Error('ACI live-injection schedule does not match its seed and randomization algorithm');
  const rows=parseAciLiveInjectionSchedule(bytes);
  if(rows.length!==50) throw new Error(`ACI live-injection schedule must contain 50 conditions; got ${rows.length}`);
  const ids=new Set(),pairs=new Map(),blocks=new Map();
  for(const [i,row] of rows.entries()) {
    if(!/^pilot-live-aci-p1-p\d{2}-(?:clean|attack)$/.test(row.planned_run_id)||ids.has(row.planned_run_id)) throw new Error('invalid or duplicate ACI live-injection run ID');
    ids.add(row.planned_run_id);
    if(!/^aci-live-pi-p\d{2}$/.test(row.pair_id)||row.deployment!=='azure_container_instances'||row.permission_profile!=='P1'||
      row.scenario_id!=='U1_U5_PROMPT_INJECTION'||!['clean','attack'].includes(row.variant)||row.status!=='NOT RUN'||row.result||row.verified_evidence_ref)
      throw new Error(`invalid ACI live-injection condition ${i+1}`);
    if(Number(row.condition_order)!==i+1) throw new Error('ACI live-injection condition order must be contiguous');
    const block=Number(row.block),order=Number(row.order_in_block);
    if(!Number.isInteger(block)||block<1||block>5||!Number.isInteger(order)||order<1||order>10) throw new Error('invalid ACI live-injection block/order');
    const list=pairs.get(row.pair_id)??[];list.push(row);pairs.set(row.pair_id,list);
    const blockRows=blocks.get(block)??[];blockRows.push(order);blocks.set(block,blockRows);
  }
  if(pairs.size!==25) throw new Error('ACI live-injection schedule must contain 25 matched pairs');
  let attackFirst=0,cleanFirst=0;
  for(const [pairId,list] of pairs) {
    if(list.length!==2||list[0].variant===list[1].variant||list[0].block!==list[1].block||Number(list[1].order_in_block)!==Number(list[0].order_in_block)+1)
      throw new Error(`ACI live-injection pair ${pairId} is incomplete or not adjacent`);
    if(list[0].variant==='attack') attackFirst++;else cleanFirst++;
  }
  if(Math.abs(attackFirst-cleanFirst)!==1) throw new Error('ACI live-injection order is not counterbalanced');
  for(let block=1;block<=5;block++) if(blocks.get(block)?.length!==10||blocks.get(block).some((v,i)=>v!==i+1)) throw new Error(`ACI live-injection block ${block} must contain ten ordered conditions`);
  return {rows:50,pairs:25,blocks:5,attackFirst,cleanFirst,sha256:protocol.scheduleSha256,countedAsStudyTrials:false};
}
