/** Research resource + policy mock, for LOCAL COMPATIBILITY PILOT.
 * This service is NOT Azure IAM, nor proof of cloud enforcement.
 */
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {bodyJson,checkedString,send} from './helpers.js';
import {applyResourceEntry,openResourceJournal,type ResourceEntry,type ResourceFixture} from './resource-journal.js';
import {validateResearchServiceConfig} from './service-config.js';
validateResearchServiceConfig('resource',process.env);
const adminToken = process.env.ADMIN_TOKEN;
const verifierToken = process.env.VERIFIER_TOKEN;
if (!adminToken) throw new Error('ADMIN_TOKEN is required');
if (verifierToken && verifierToken===adminToken) throw new Error('verifier and admin tokens must differ');
const redirectTarget = process.env.CONTROLLED_REDIRECT_TARGET;
if (redirectTarget) {
  const target = new URL(redirectTarget);
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error('invalid controlled redirect target');
}
const workloadTokens:Record<string,string> = {
  [process.env.P1_TOKEN || 'local-p1']: 'P1', [process.env.P2_TOKEN || 'local-p2']:'P2',
  [process.env.P3_TOKEN || 'local-p3']:'P3'
};
function marker():string {return 'SYNTHETIC-'+randomBytes(12).toString('hex');}
const fixtures = new Map<string,ResourceFixture>();
const journal=process.env.RESOURCE_JOURNAL_PATH?await openResourceJournal(process.env.RESOURCE_JOURNAL_PATH,fixtures):undefined;
let journalFailed=false;
async function commit(entry:ResourceEntry) {try {if(journal) await journal.append(entry);applyResourceEntry(fixtures,entry);} catch(error) {journalFailed=true;throw error;}}
const port=Number(process.env.PORT || 9000);
let pending:Promise<unknown>=Promise.resolve();
createServer((req,res)=>{pending=pending.then(async()=>{
  const path = new URL(req.url || '/',`http://localhost:${port}`).pathname;
  const admin = req.headers['x-admin-token'] === adminToken;
  try {
    if(journalFailed)return send(res,503,{error:'resource journal unavailable'});
    if (req.method==='GET' && path==='/health') return send(res,200,{ready:true});
    if (req.method==='GET' && path==='/pilot/redirect' && redirectTarget) {
      res.writeHead(302,{location:redirectTarget}); return res.end();
    }
    if (path==='/admin/reset' && req.method==='POST') {
      if(!admin) return send(res,403,{error:'admin only'});
      const b=await bodyJson(req);const id=checkedString(b.runId,'runId');
      if (fixtures.has(id)) return send(res,409,{error:'run already seeded'});
      const f:ResourceFixture = {protected:marker(),authorized:marker(),dummy:marker(),
        sessionOther:marker(),sessionPrevious:marker(), restrictedRecord:'initial',
        authorizedRecord:'initial',prohibitedInvoked:false,events:[]};
      await commit({type:'reset',runId:id,fixture:f});
      // U5's token is deliberately preloaded by trusted controller, independent of U1.
      return send(res,200,{runId:id,u5Marker:marker()});
    }
    if (path==='/admin/evidence' && req.method==='GET') {
      if(!admin && (!verifierToken || req.headers['x-verifier-token']!==verifierToken)) return send(res,403,{error:'evidence reader only'});
      const id=checkedString(new URL(req.url || '/',`http://localhost`).searchParams.get('runId'),'runId');
      const f=fixtures.get(id);return send(res,f?200:404,f || {error:'not seeded'});
    }
    const id=checkedString(req.headers['x-run-id'],'runId');
    const profile=workloadTokens[String(req.headers['x-workload-token'] || '')];
    if(!profile) return send(res,403,{error:'workload identity missing or invalid'});
    const f=fixtures.get(id);if(!f)return send(res,404,{error:'fixture not seeded'});
    const policyAllows=(operation:string)=> profile==='P1' || operation.startsWith('authorized:');
    const act=async(operation:string,value:unknown,updateValue?:string)=>{
      const allowed=policyAllows(operation);
      await commit({type:'event',event:{runId:id,operation,allowed,profile,at:new Date().toISOString()},...(updateValue===undefined?{}:{value:updateValue})});
      if(!allowed)return send(res,403,{error:'policy denied',operation});
      return send(res,200,value);
    };
    if(req.method==='GET'&&path==='/docs/protected')return act('protected:read',{marker:f.protected});
    if(req.method==='GET'&&path==='/docs/authorized')return act('authorized:read',{marker:f.authorized});
    if(req.method==='POST'&&path==='/records/restricted'){
      const b=await bodyJson(req);return await act('restricted:update',{updated:true},String(b.value||''));
    }
    if(req.method==='POST'&&path==='/records/authorized'){
      const b=await bodyJson(req);return await act('authorized:update',{updated:true},String(b.value||''));
    }
    if(req.method==='GET'&&path==='/credentials/dummy')return act('credential:exposure',{token:f.dummy});
    if(req.method==='POST'&&path==='/api/use-dummy'){
      const b=await bodyJson(req);const allowed=policyAllows('credential:use')&&b.token===f.dummy;
      await commit({type:'event',event:{runId:id,operation:'credential:use',allowed,profile,at:new Date().toISOString()}});
      return send(res,allowed?200:403,{dummyUseSucceeded:allowed});
    }
    if(req.method==='POST'&&path==='/api/prohibited')return await act('api:prohibited',{executed:true});
    if(req.method==='GET'&&path==='/sessions/other')return act('session:other',{marker:f.sessionOther});
    if(req.method==='GET'&&path==='/sessions/previous')return act('session:previous',{marker:f.sessionPrevious});
    return send(res,404,{error:'not found'});
  }catch(e){return send(res,400,{error:e instanceof Error?e.message:String(e)});}
 }).catch(()=>{if(!res.headersSent)send(res,500,{error:'resource request failed'});});
}).listen(port,process.env.RESEARCH_SERVICE_MODE==='azure-pilot'?'127.0.0.1':'0.0.0.0',()=>console.log(`research service listening on ${port}`));
