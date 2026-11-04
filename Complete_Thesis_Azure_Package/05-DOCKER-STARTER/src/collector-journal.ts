/** Single-process local recovery journal. Filesystem controls must protect it externally. */
import {open,type FileHandle} from 'node:fs/promises';
export type JournalEntry={type:'reset';runId:string;nonce:string}|{type:'collect';runId:string;at:string;marker?:string;requestId?:string;markerSha256?:string}|{type:'restricted';runId:string;at:string};
export type CollectorFixture={nonce:string;received:string[];receivedFingerprints?:string[];contacts:number;events:{runId:string;operation:'collect'|'restricted';at:string;marker?:string;requestId?:string;markerSha256?:string}[]};
const validId=(id:unknown)=>typeof id==='string' && /^[A-Za-z0-9_-]{1,150}$/.test(id);
const marker=(value:unknown)=>typeof value==='string' && /^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(value);
export function applyCollectorEntry(fixtures:Map<string,CollectorFixture>,entry:JournalEntry) {
  if(!entry || !validId(entry.runId)) throw new Error('invalid collector journal record');
  if(entry.type==='reset') {
    if(!marker(entry.nonce) || fixtures.has(entry.runId)) throw new Error('invalid collector reset journal record');
    fixtures.set(entry.runId,{nonce:entry.nonce,received:[],contacts:0,events:[]});return;
  }
  const fixture=fixtures.get(entry.runId);
  if(!fixture || !Number.isFinite(Date.parse(entry.at))) throw new Error('invalid collector event journal record');
  if(entry.type==='collect') {
    if(entry.requestId!==undefined) {
      const markerSha256=entry.markerSha256;
      if(!/^[A-Za-z0-9_-]{12,100}$/.test(entry.requestId)||typeof markerSha256!=='string'||!/^sha256:[a-f0-9]{64}$/.test(markerSha256))
        throw new Error('invalid correlated collector journal record');
      fixture.receivedFingerprints??=[];
      fixture.receivedFingerprints.push(markerSha256);
      fixture.events.push({runId:entry.runId,operation:'collect',at:entry.at,requestId:entry.requestId,markerSha256});return;
    }
    const markerValue=entry.marker;
    if(typeof markerValue!=='string'||!marker(markerValue)) throw new Error('invalid collector marker journal record');
    fixture.received.push(markerValue);fixture.events.push({runId:entry.runId,operation:'collect',at:entry.at,marker:markerValue});return;
  }
  if(entry.type==='restricted') {fixture.contacts++;fixture.events.push({runId:entry.runId,operation:'restricted',at:entry.at});return;}
  throw new Error('unknown collector journal record');
}
export async function openCollectorJournal(path:string,fixtures:Map<string,CollectorFixture>) {
  const file:FileHandle=await open(path,'a+',0o600);
  try {
    const contents=await file.readFile('utf8');
    if(contents && !contents.endsWith('\n')) throw new Error('incomplete collector journal');
    for(const line of contents.split('\n')) if(line) applyCollectorEntry(fixtures,JSON.parse(line) as JournalEntry);
  } catch(error) {await file.close();throw error;}
  return {async append(entry:JournalEntry) {await file.writeFile(JSON.stringify(entry)+'\n','utf8');await file.sync();},close:()=>file.close()};
}
