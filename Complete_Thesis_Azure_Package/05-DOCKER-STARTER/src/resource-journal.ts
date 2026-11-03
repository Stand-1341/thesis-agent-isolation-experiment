/** Single-process local recovery log, not independently protected audit. */
import {open} from 'node:fs/promises';
export type ResourceEvent={runId:string;operation:string;allowed:boolean;profile:string;at:string};
export type ResourceFixture={protected:string;authorized:string;dummy:string;sessionOther:string;sessionPrevious:string;
 restrictedRecord:string;authorizedRecord:string;prohibitedInvoked:boolean;events:ResourceEvent[]};
export type ResourceEntry={type:'reset';runId:string;fixture:ResourceFixture}|{type:'event';event:ResourceEvent;value?:string};
const id=(x:unknown)=>typeof x==='string' && /^[A-Za-z0-9_-]{1,150}$/.test(x);
const marker=(x:unknown)=>typeof x==='string' && /^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(x);
const operations=new Set(['protected:read','authorized:read','restricted:update','authorized:update','credential:exposure','credential:use','api:prohibited','session:other','session:previous']);
export function applyResourceEntry(fixtures:Map<string,ResourceFixture>,entry:ResourceEntry) {
 if(entry?.type==='reset') {
  const f=entry.fixture;
  if(!id(entry.runId) || fixtures.has(entry.runId) || !f || ![f.protected,f.authorized,f.dummy,f.sessionOther,f.sessionPrevious].every(marker) ||
    f.restrictedRecord!=='initial' || f.authorizedRecord!=='initial' || f.prohibitedInvoked!==false || !Array.isArray(f.events) || f.events.length) throw new Error('invalid resource reset record');
  fixtures.set(entry.runId,f);return;
 }
 if(entry?.type!=='event') throw new Error('invalid resource journal record');
 const e=entry.event,fixture=fixtures.get(e?.runId);
 if(!e || !fixture || !id(e.runId) || !operations.has(e.operation) || typeof e.allowed!=='boolean' || !['P1','P2','P3'].includes(e.profile) || !Number.isFinite(Date.parse(e.at))) throw new Error('invalid resource event');
 if(['restricted:update','authorized:update'].includes(e.operation) && typeof entry.value!=='string') throw new Error('invalid resource update');
 fixture.events.push(e);
 if(e.allowed && e.operation==='restricted:update') fixture.restrictedRecord=entry.value!;
 if(e.allowed && e.operation==='authorized:update') fixture.authorizedRecord=entry.value!;
 if(e.allowed && e.operation==='api:prohibited') fixture.prohibitedInvoked=true;
}
export async function openResourceJournal(path:string,fixtures:Map<string,ResourceFixture>) {
 const file=await open(path,'a+',0o600);
 try {const contents=await file.readFile('utf8');if(contents && !contents.endsWith('\n')) throw new Error('incomplete resource journal');
  for(const line of contents.split('\n')) if(line) applyResourceEntry(fixtures,JSON.parse(line) as ResourceEntry);
 } catch(error) {await file.close();throw error;}
 return {async append(entry:ResourceEntry){await file.writeFile(JSON.stringify(entry)+'\n','utf8');await file.sync();},close:()=>file.close()};
}
