/** Verify exact package contents against an externally recorded manifest digest. */
import {createHash,X509Certificate} from 'node:crypto';
import {readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const required=['dist/resource.js','dist/collector.js','dist/resource-journal.js','dist/collector-journal.js','dist/service-config.js','dist/helpers.js',
  'infra/install-three-arm-service-secrets.mjs','infra/install-research-host-ca-key.mjs','infra/bootstrap-research-host-tls.sh','infra/renew-research-host-tls.sh','infra/stage-research-host.sh',
  'certs/thesis-pilot-ca.pem',
  'research-service.service','collector-service.service','research-proxy.nginx.template','check-research-data-disk.sh','package.json'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyResearchPackage(directory,expectedManifestSha256) {
 if(typeof directory!=='string' || !/^[a-f0-9]{64}$/.test(expectedManifestSha256 || '')) throw new Error('package directory and recorded manifest digest required');
 const root=await realpath(directory),actual=[];
 async function walk(dir,prefix='') {
  for(const item of await readdir(dir,{withFileTypes:true})) {
   const name=prefix?`${prefix}/${item.name}`:item.name;
   if(item.isSymbolicLink()) throw new Error('package symlinks are not allowed');
   if(item.isDirectory()) await walk(path.join(dir,item.name),name);
   else if(item.isFile()) actual.push(name);
   else throw new Error('invalid package entry');
  }
 }
 await walk(root);
 if(JSON.stringify(actual.sort())!==JSON.stringify([...required,'manifest.json'].sort())) throw new Error('unexpected package contents');
 const manifestBytes=await readFile(path.join(root,'manifest.json'));
 if(hash(manifestBytes)!==expectedManifestSha256) throw new Error('manifest digest mismatch');
 const manifest=JSON.parse(manifestBytes.toString('utf8'));
 if(manifest.scope!=='research-service-package-only' || !manifest.files || typeof manifest.files!=='object' ||
   JSON.stringify(Object.keys(manifest.files).sort())!==JSON.stringify([...required].sort())) throw new Error('invalid research manifest');
 for(const relative of required) {
  if(!/^[a-f0-9]{64}$/.test(manifest.files[relative] || '') || hash(await readFile(path.join(root,...relative.split('/'))))!==manifest.files[relative])
   throw new Error(`research package checksum mismatch: ${relative}`);
 }
 const caPem=await readFile(path.join(root,'certs','thesis-pilot-ca.pem'),'utf8');
 let ca;
 try { ca=new X509Certificate(caPem); } catch { throw new Error('research package CA certificate is invalid'); }
 if(!ca.ca || /PRIVATE KEY/.test(caPem) || Date.parse(ca.validTo)<=Date.now()+30*24*60*60*1000)
  throw new Error('research package must contain only an unexpired public CA certificate');
 return {scope:'package_integrity_only_not_authenticity_or_installation',manifestSha256:expectedManifestSha256,files:required.length};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
 try {const result=await verifyResearchPackage(process.argv[2],process.argv[3]);console.log(JSON.stringify(result));}
 catch(error) {console.error(error instanceof Error?error.message:'package validation failed');process.exitCode=1;}
}
