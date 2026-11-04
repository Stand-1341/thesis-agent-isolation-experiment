#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {attachAciIdentityPrincipalIds,buildAciRunIdentityManifest} from './aci-preprovisioned-identity-provider.mjs';

function option(name) {const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;}
const schedulePath=option('--schedule'),sha256=option('--sha256'),outputPath=option('--out'),principalIdsPath=option('--principal-ids');
if(!schedulePath||!sha256||!outputPath) throw new Error('usage: node scripts/create-aci-identity-manifest.mjs --schedule <frozen.csv> --sha256 <frozen-sha256> --out <manifest.json>');
const bytes=await readFile(schedulePath);let manifest=buildAciRunIdentityManifest(bytes,sha256);
if(principalIdsPath) manifest=attachAciIdentityPrincipalIds(manifest,JSON.parse(await readFile(principalIdsPath,'utf8')));
await writeFile(outputPath,`${JSON.stringify(manifest,null,2)}\n`,{flag:'wx'});
console.log(JSON.stringify({path:outputPath,scheduleSha256:manifest.scheduleSha256,identityCount:manifest.identitySpecs.length}));
