import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderResearchProxy} from './render-research-proxy.mjs';
test('proxy rendering requires distinct controlled private listener addresses',async()=>{
 const template=await readFile(new URL('../infra/research-proxy.nginx.template',import.meta.url),'utf8');
 const config=renderResearchProxy(template,{researchIp:'10.48.9.4',collectorIp:'10.48.9.5',restrictedIp:'10.48.9.6'});
 assert.match(config,/listen 10\.48\.9\.4:443 ssl;/);assert.match(config,/listen 10\.48\.9\.5:8443 ssl;/);
 assert.match(config,/listen 10\.48\.9\.6:9443 ssl;/);assert.match(config,/proxy_pass http:\/\/127\.0\.0\.1:9001/);
 assert.throws(()=>renderResearchProxy(template,{researchIp:'10.48.9.4',collectorIp:'10.48.9.4',restrictedIp:'10.48.9.6'}),/distinct/);
 assert.throws(()=>renderResearchProxy(template,{researchIp:'8.8.8.8',collectorIp:'10.48.9.5',restrictedIp:'10.48.9.6'}),/distinct/);
 assert.throws(()=>renderResearchProxy(template+template,{researchIp:'10.48.9.4',collectorIp:'10.48.9.5',restrictedIp:'10.48.9.6'}),/template/);
});
