/** Local source/runtime traceability; deployed-image verification remains separate. */
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const defaultRoot=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function implementationManifest(packageRoot=defaultRoot) {
  async function filesUnder(relative,allowed) {
    const entries=await readdir(resolve(packageRoot,relative),{withFileTypes:true});
    return (await Promise.all(entries.map(async entry=>{
      const name=`${relative}/${entry.name}`;
      if(entry.isSymbolicLink()) throw new Error('implementation manifest does not allow symlinks');
      if(entry.isDirectory()) return filesUnder(name,allowed);
      return entry.isFile() && allowed(name) ? [name] : [];
    }))).flat();
  }
  const root='05-DOCKER-STARTER';
  const files=(await Promise.all([
    filesUnder(`${root}/config`,()=>true),
    filesUnder(`${root}/scripts`,name=>/\.(?:mjs|ps1|py)$/.test(name) && !/\.test\.mjs$/.test(name) && !/\/test_[^/]*\.py$/.test(name)),
    // The Functions adapter is a deployment target for the same trials. Leaving it
    // out let the implementation digest pass while functions/index.mjs, host.json or
    // functions/package.json had changed — the integrity gate could not see the code
    // that runs the azure_functions_flex arm.
    filesUnder(`${root}/functions`,name=>/\.(?:mjs|js|json)$/.test(name)),
    filesUnder(`${root}/src`,name=>/\.(?:ts|mts)$/.test(name)),
    filesUnder(`${root}/dist`,name=>/\.(?:js|mjs)$/.test(name)),
    filesUnder(`${root}/infra`,name=>/\.(?:bicep|sh|service|template)$/.test(name))
  ])).flat().concat(['package.json','package-lock.json','compose.yaml','Dockerfile.node','Dockerfile.functions','Dockerfile.header-audit','Dockerfile.session-diagnostic-job'].map(name=>`${root}/${name}`)).sort();
  const hashes=Object.fromEntries(await Promise.all(files.map(async path=>[path,digest(await readFile(resolve(packageRoot,path)))])));
  return {hashes,sha256:digest(Buffer.from(JSON.stringify(hashes),'utf8'))};
}
export async function verifyImplementationManifest(expectedSha256,packageRoot=defaultRoot) {
  if(!/^[a-f0-9]{64}$/.test(expectedSha256 || '')) throw new Error('frozen implementation digest required');
  const current=await implementationManifest(packageRoot);
  if(current.sha256!==expectedSha256) throw new Error('implementation differs from frozen digest');
  return current.sha256;
}
