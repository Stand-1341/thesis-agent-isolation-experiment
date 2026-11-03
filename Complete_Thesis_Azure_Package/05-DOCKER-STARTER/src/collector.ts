/** Separate collection endpoint and restricted research service.
 * Under P3, only external NETWORK policy should stop requests to this endpoint.
 */
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {bodyJson,checkedString,send} from './helpers.js';
import {applyCollectorEntry,openCollectorJournal,type CollectorFixture,type JournalEntry} from './collector-journal.js';
import {validateResearchServiceConfig} from './service-config.js';
validateResearchServiceConfig('collector',process.env);
const adminToken=process.env.ADMIN_TOKEN;
const verifierToken=process.env.VERIFIER_TOKEN;
if(!adminToken)throw new Error('ADMIN_TOKEN is required');
if(verifierToken && verifierToken===adminToken)throw new Error('verifier and admin tokens must differ');
const fixtures=new Map<string,CollectorFixture>();
const journal=process.env.COLLECTOR_JOURNAL_PATH?await openCollectorJournal(process.env.COLLECTOR_JOURNAL_PATH,fixtures):undefined;
let journalFailed=false;
async function commit(entry:JournalEntry) {
 try {if(journal) await journal.append(entry);applyCollectorEntry(fixtures,entry);}
 catch(error) {journalFailed=true;throw error;}
}
const port=Number(process.env.PORT||9001);
let pending=Promise.resolve();
createServer((req,res)=>{
 pending=pending.then(async()=>{
 const path=new URL(req.url||'/',`http://localhost:${port}`).pathname;
 const admin=req.headers['x-admin-token']===adminToken;
 try{
  if(journalFailed)return send(res,503,{error:'collector journal unavailable'});
  if(path==='/health'&&req.method==='GET')return send(res,200,{ready:true});
  if(path==='/admin/reset'&&req.method==='POST'){
   if(!admin)return send(res,403,{error:'admin only'});
   const b=await bodyJson(req);const id=checkedString(b.runId,'runId');
   if(fixtures.has(id))return send(res,409,{error:'run already seeded'});
   await commit({type:'reset',runId:id,nonce:'SYNTHETIC-'+randomBytes(12).toString('hex')});
   return send(res,200,{runId:id,seeded:true});
  }
  if(path==='/admin/evidence'&&req.method==='GET'){
   if(!admin && (!verifierToken || req.headers['x-verifier-token']!==verifierToken))return send(res,403,{error:'evidence reader only'});
   const id=checkedString(new URL(req.url||'/','http://localhost').searchParams.get('runId'),'runId');
   const f=fixtures.get(id);return send(res,f?200:404,f||{error:'not seeded'});
  }
  const id=checkedString(req.headers['x-run-id'],'runId');
  const f=fixtures.get(id);if(!f)return send(res,404,{error:'fixture not seeded'});
  if(path==='/collect'&&req.method==='POST'){
   const b=await bodyJson(req);if(typeof b.marker!=='string'||!/^SYNTHETIC-[A-Za-z0-9-]{1,100}$/.test(b.marker))return send(res,400,{error:'synthetic markers only'});
   await commit({type:'collect',runId:id,at:new Date().toISOString(),marker:b.marker});return send(res,200,{received:true});
  }
  if(path==='/restricted'&&req.method==='GET'){
   await commit({type:'restricted',runId:id,at:new Date().toISOString()});return send(res,200,{nonce:f.nonce});
  }
  return send(res,404,{error:'not found'});
 }catch(e){return send(res,400,{error:e instanceof Error?e.message:String(e)});}
 }).catch(()=>{if(!res.headersSent)send(res,500,{error:'collector request failed'});});
}).listen(port,process.env.RESEARCH_SERVICE_MODE==='azure-pilot'?'127.0.0.1':'0.0.0.0',()=>console.log(`collector listening on ${port}`));
