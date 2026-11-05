#!/usr/bin/env node
/** Read-only inventory of evidence blob names and sizes before retention changes. */
import {execFileSync} from 'node:child_process';

const env=process.env;
const containerUrl=env.THESIS_EVIDENCE_BLOB_CONTAINER_URL;
const clientId=env.THESIS_EVIDENCE_READER_IDENTITY_CLIENT_ID;
if(!containerUrl||!clientId) throw new Error('evidence container URL and independent evidence-reader identity are required');
const endpoint=new URL(containerUrl);
if(endpoint.protocol!=='https:'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password)
  throw new Error('invalid evidence container URL');
const tokenUrl=new URL('http://169.254.169.254/metadata/identity/oauth2/token');
tokenUrl.searchParams.set('api-version','2018-02-01');tokenUrl.searchParams.set('resource','https://storage.azure.com/');
tokenUrl.searchParams.set('client_id',clientId);
let token;
try { token=JSON.parse(execFileSync('curl',['-fsS','--max-time','10','-H','Metadata:true',tokenUrl.href],{encoding:'utf8',windowsHide:true})); }
catch { throw new Error('independent evidence-reader token request failed'); }
if(typeof token?.access_token!=='string'||!token.access_token) throw new Error('independent evidence-reader Storage token unavailable');
const unescapeXml=value=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const blobs=[];
let marker='';
do {
  const url=new URL(endpoint.href);
  url.searchParams.set('restype','container');url.searchParams.set('comp','list');url.searchParams.set('maxresults','5000');
  if(marker) url.searchParams.set('marker',marker);
  const response=await fetch(url,{headers:{authorization:`Bearer ${token.access_token}`,'x-ms-version':'2023-11-03',
    'x-ms-date':new Date().toUTCString()},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error(`evidence inventory HTTP ${response.status}; code=${response.headers.get('x-ms-error-code')??'unknown'}`);
  const xml=await response.text();
  for(const block of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
    const body=block[1],name=unescapeXml(body.match(/<Name>([\s\S]*?)<\/Name>/)?.[1]??'');
    const size=Number(body.match(/<Content-Length>(\d+)<\/Content-Length>/)?.[1]??0);
    const modified=body.match(/<Last-Modified>([\s\S]*?)<\/Last-Modified>/)?.[1];
    blobs.push({name,size,modified});
  }
  marker=unescapeXml(xml.match(/<NextMarker>([\s\S]*?)<\/NextMarker>/)?.[1]??'');
} while(marker);
const prefixes={};
for(const blob of blobs) {const prefix=blob.name.split('/')[0]||'(root)';prefixes[prefix]=(prefixes[prefix]??0)+1;}
const report={scope:'read_only_evidence_container_inventory_not_trial',container:endpoint.pathname.slice(1),
  blobCount:blobs.length,totalBytes:blobs.reduce((sum,blob)=>sum+blob.size,0),
  latestLastModified:blobs.map(blob=>blob.modified).filter(Boolean).sort().at(-1)??null,
  topLevelPrefixes:prefixes,blobNamesDisplayed:false,blobContentsRead:false};
console.log(JSON.stringify(report));
