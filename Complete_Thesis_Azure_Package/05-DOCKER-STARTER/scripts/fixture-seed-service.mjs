/** Candidate separately deployed fixture-owner service; no lifecycle claim. */
import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {seedSessionBlob} from './azure-session-seed.mjs';

export function createFixtureSeedServer({requestKey,blobEndpoint,blobResourceId,ownerPrincipalId,getManagedToken,sessionId}) {
  if(typeof requestKey!=='string' || requestKey.length<32 || requestKey.length>512 || /[\r\n]/.test(requestKey) || typeof getManagedToken!=='function')
    throw new Error('invalid fixture service configuration');
  if(typeof sessionId!=='string' || !/^[a-f0-9]{48}$/.test(sessionId)) throw new Error('invalid fixture session identifier');
  const secret=Buffer.from(requestKey);
  const sessionFingerprint=createHash('sha256').update(sessionId).digest('hex');
  return createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    const reply=(status,body)=>{res.statusCode=status;res.end(JSON.stringify(body));};
    if(req.method!=='POST' || req.url!=='/session-seed') return reply(404,{error:'not found'});
    const supplied=Buffer.from(typeof req.headers['x-fixture-key']==='string'?req.headers['x-fixture-key']:'');
    if(supplied.length!==secret.length || !timingSafeEqual(supplied,secret)) return reply(403,{error:'fixture authorization required'});
    try {
      let size=0,parts=[];
      for await(const chunk of req) {size+=chunk.length;if(size>8192) throw new Error('request too large');parts.push(chunk);}
      const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
      if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).sort().join(',')!=='kind,marker,runId') throw new Error('invalid request');
      const result=await seedSessionBlob({blobEndpoint,runId:body.runId,kind:body.kind,marker:body.marker,expectedPrincipalId:ownerPrincipalId,
        expectedResourceId:blobResourceId,getManagedToken});
      return reply(200,{...result,sessionFingerprint});
    } catch {return reply(400,{error:'fixture seed failed'});}
  });
}
