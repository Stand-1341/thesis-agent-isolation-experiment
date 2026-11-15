import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {buildResearchHostBootstrapCommand,ensureResearchHostCa,resolveOpenSslExecutable,runResearchHostBootstrap,
  secureWindowsPrivateDirectory,secureWindowsPrivateFile,validateResearchHostCa} from './research-host-bootstrap.mjs';

const values={AZURE_NAME_PREFIX:'th3arm',THESIS_RESEARCH_CA_CERT:'C:/secure/ca.crt',THESIS_RESEARCH_CA_KEY:'C:/secure/ca.key'};
const outputs={workloadTokenVaultName:{value:'thesisvault123'},bootstrapLockBlobUrl:{value:'https://lockaccount.blob.core.windows.net/bootstrap-locks/three-arm-secret-bootstrap.lock'}};

test('bootstrap command uses foundation outputs and external CA paths without reading or printing key material',()=>{
  const command=buildResearchHostBootstrapCommand({values,outputs,scriptPath:'seed.mjs'});
  assert.deepEqual(command.slice(1),['seed.mjs','--vault','thesisvault123','--prefix','th3arm','--lock-blob-url',outputs.bootstrapLockBlobUrl.value,
    '--host-tls-ca-key-file',values.THESIS_RESEARCH_CA_KEY,'--ca-cert-file',values.THESIS_RESEARCH_CA_CERT]);
  assert.doesNotMatch(command.join(' '),/PRIVATE KEY|secret-value/i);
});

test('bootstrap refuses to launch when foundation outputs or CA input paths are missing',()=>{
  assert.throws(()=>buildResearchHostBootstrapCommand({values,outputs:{...outputs,bootstrapLockBlobUrl:undefined}}),/lock Blob URL/);
  assert.throws(()=>buildResearchHostBootstrapCommand({values:{...values,THESIS_RESEARCH_CA_KEY:''},outputs}),/CA certificate and private-key paths/);
});

test('postprovision bootstrap retries only RBAC propagation 403 and then reports counts-only helper success',async()=>{
  const calls=[],waits=[];
  const result=await runResearchHostBootstrap({env:values,outputs,
    validateCa:async args=>{assert.deepEqual(args,{caCertificatePath:values.THESIS_RESEARCH_CA_CERT,caPrivateKeyPath:values.THESIS_RESEARCH_CA_KEY});return {certificateSha256:'a'.repeat(64),caCertificatePath:path.resolve(values.THESIS_RESEARCH_CA_CERT),caPrivateKeyPath:path.resolve(values.THESIS_RESEARCH_CA_KEY)};},
    run:async command=>{calls.push(command);if(calls.length===1){const error=new Error('role assignment pending');error.stderr='HTTP 403';throw error;}return {exitCode:0,stdout:'created 14 entries'};},
    sleep:async delay=>waits.push(delay),scriptPath:'seed.mjs',cwd:'starter'});
  assert.equal(calls.length,2);
  assert.deepEqual(waits,[2000]);
  assert.equal(result.certificateSha256,'a'.repeat(64));
  assert.doesNotMatch(JSON.stringify(calls),/PRIVATE KEY|secret-value/i);
});

test('postprovision bootstrap does not retry conflicts or expose command output',async()=>{
  let calls=0;
  await assert.rejects(runResearchHostBootstrap({env:values,outputs,
    validateCa:async()=>({certificateSha256:'b'.repeat(64),caCertificatePath:path.resolve(values.THESIS_RESEARCH_CA_CERT),caPrivateKeyPath:path.resolve(values.THESIS_RESEARCH_CA_KEY)}),
    run:async()=>{calls++;const error=new Error('conflicting existing secret');error.stderr='refusing overwrite';throw error;},
    sleep:async()=>assert.fail('non-403 errors must not be retried'),scriptPath:'seed.mjs',cwd:'starter'}),/no secret value was displayed/);
  assert.equal(calls,1);
});

test('CA validator rejects repository paths before reading private material',async()=>{
  await assert.rejects(validateResearchHostCa({caCertificatePath:'inside/cert.pem',caPrivateKeyPath:'inside/key.pem',
    repositoryRoot:process.cwd(),resolve:async value=>value,stat:async()=>({isFile:()=>true,isSymbolicLink:()=>false}),read:async()=>assert.fail('repository path must be rejected first')}),/outside the repository/);
});

test('missing CA pair is generated outside the repository and subsequent runs reuse it',async t=>{
  const home=await mkdtemp(path.join(tmpdir(),'research-ca-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const commands=[];
  const exec=async command=>{
    commands.push(command);
    const outIndex=command.indexOf('-out');
    if(outIndex>=0) await writeFile(command[outIndex+1],command[1]==='genpkey'?'private-test-material':'public-test-certificate');
    return {exitCode:0};
  };
  const validate=async({caCertificatePath,caPrivateKeyPath})=>({caCertificatePath,caPrivateKeyPath,certificateSha256:'c'.repeat(64)});
  const first=await ensureResearchHostCa({home,repositoryRoot:process.cwd(),exec,validate,platform:'linux',openSslResolver:async()=>'/usr/bin/openssl'});
  assert.equal(first.created,true);
  assert.ok(first.caCertificatePath.startsWith(home));
  assert.ok(first.caPrivateKeyPath.startsWith(home));
  assert.equal(await readFile(first.caPrivateKeyPath,'utf8'),'private-test-material');
  assert.equal(commands.length,4);
  const reused=await ensureResearchHostCa({home,repositoryRoot:process.cwd(),exec:async()=>assert.fail('existing CA must not be replaced'),validate,platform:'linux'});
  assert.equal(reused.created,false);
});

test('Windows OpenSSL discovery finds Git-for-Windows when PATH has no openssl',async()=>{
  const found=await resolveOpenSslExecutable({platform:'win32',env:{ProgramFiles:'C:\\Program Files'},
    run:async()=>{throw new Error('where: not found');},
    accessFile:async file=>{if(file.endsWith('Git\\usr\\bin\\openssl.exe'))return true;throw new Error('not present');}});
  assert.equal(found,'C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
});

test('Windows CA private-key ACL is replaced and verified by user SID before key reads',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ca-acl-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const keyPath=path.join(dir,'ca.key'); await writeFile(keyPath,'opaque-private-key');
  const sid='S-1-5-21-123-456-789-1001';
  const commands=[];
  const exec=async(command,options={})=>{
    commands.push(command);
    if(command[0]==='whoami.exe') return {stdout:`"WORKGROUP\\user","${sid}"`};
    if(command.includes('/save')) {await writeFile(command[command.indexOf('/save')+1],`probe D:PAI(A;;FA;;;${sid})(A;;FA;;;S-1-5-18)`);return {stdout:'saved'};}
    return {stdout:'processed'};
  };
  await secureWindowsPrivateFile(keyPath,{exec});
  assert.ok(commands.some(command=>command[0]==='icacls.exe'&&command.includes('/inheritance:r')));
  assert.ok(commands.some(command=>command[0]==='icacls.exe'&&command.some(arg=>arg===`*${sid}:(F)`)));
  assert.ok(commands.some(command=>command[0]==='icacls.exe'&&command.some(arg=>arg==='*S-1-5-18:(F)')));
  assert.ok(commands.some(command=>command[0]==='icacls.exe'&&command.some(arg=>arg==='/setowner')));
});

test('Windows key ACL verification fails closed if any other principal retains access',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ca-acl-broad-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const keyPath=path.join(dir,'ca.key'); await writeFile(keyPath,'opaque-private-key');
  const sid='S-1-5-21-123-456-789-1001';
  const exec=async command=>{
    if(command[0]==='whoami.exe') return {stdout:`"WORKGROUP\\user","${sid}"`};
    if(command.includes('/save')) {await writeFile(command[command.indexOf('/save')+1],`probe D:PAI(A;;FA;;;${sid})(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-545)`);return {stdout:'saved'};}
    return {stdout:'processed'};
  };
  await assert.rejects(secureWindowsPrivateFile(keyPath,{exec}),/Windows ACL is broader/);
});

test('Windows CA staging directory is ACL-hardened before key generation',async t=>{
  const parent=await mkdtemp(path.join(tmpdir(),'ca-stage-acl-'));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  const staging=path.join(parent,'staging');const {mkdir}=await import('node:fs/promises');await mkdir(staging);
  const sid='S-1-5-21-123-456-789-1001',commands=[];
  const exec=async command=>{commands.push(command);if(command[0]==='whoami.exe')return{stdout:`"WORKGROUP\\user","${sid}"`};
    if(command.includes('/save')) {await writeFile(command[command.indexOf('/save')+1],`staging D:PAI(A;OICI;FA;;;${sid})(A;OICI;FA;;;S-1-5-18)`);return{stdout:'saved'};}return{stdout:'processed'};};
  await secureWindowsPrivateDirectory(staging,{exec});
  assert.ok(commands.findIndex(command=>command[0]==='icacls.exe'&&command.includes('/inheritance:r'))<commands.length-1);
  assert.ok(commands.some(command=>command[0]==='icacls.exe'&&command.some(arg=>arg===`*${sid}:(OI)(CI)F`)));
});

test('automatic CA generation refuses a partial existing pair and any repository destination',async t=>{
  const home=await mkdtemp(path.join(tmpdir(),'research-ca-partial-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const caDir=path.join(home,'ca');
  const {mkdir,writeFile:write}=await import('node:fs/promises');
  await mkdir(caDir);
  await write(path.join(caDir,'ca.key'),'existing');
  await assert.rejects(ensureResearchHostCa({home,caCertificatePath:path.join(caDir,'ca.crt'),caPrivateKeyPath:path.join(caDir,'ca.key'),
    repositoryRoot:process.cwd(),exec:async()=>assert.fail('must fail before generation')}),/only one research CA output exists/);
  await assert.rejects(ensureResearchHostCa({home,caCertificatePath:path.join(process.cwd(),'ca.crt'),caPrivateKeyPath:path.join(process.cwd(),'ca.key'),
    repositoryRoot:process.cwd(),exec:async()=>assert.fail('repository target must fail before generation')}),/outside the repository/);
});

test('foundation creates the reachable vault and operator-only Blob lease path before full-stage seeding',async()=>{
  const main=await readFile(new URL('../infra/main.bicep',import.meta.url),'utf8');
  const prerequisites=await readFile(new URL('../infra/bootstrap-prerequisites.bicep',import.meta.url),'utf8');
  const p3Nsg=await readFile(new URL('../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/p3-nsg-pilot.bicep',import.meta.url),'utf8');
  const threeArm=await readFile(new URL('../Complete_Thesis_Azure_Package/05-DOCKER-STARTER/infra/azure-supported-three-arm.bicep',import.meta.url),'utf8');
  const postprovision=await readFile(new URL('./postprovision.mjs',import.meta.url),'utf8');
  assert.match(main,/module bootstrap '\.\/bootstrap-prerequisites\.bicep'/);
  assert.match(main,/effectiveWorkloadTokenVaultName = .*bootstrap\.outputs\.vaultName/);
  assert.match(postprovision,/await bootstrapStep\(\{env:values\}\)[\s\S]*?publishCode = await publish/);
  assert.match(prerequisites,/enableRbacAuthorization: true/);
  assert.match(prerequisites,/publicNetworkAccess: 'Enabled'[\s\S]*?defaultAction: 'Allow'/);
  assert.match(prerequisites,/Key Vault Secrets Officer/);
  assert.match(prerequisites,/scope: lockContainer/);
  assert.match(prerequisites,/defaultAction: 'Deny'[\s\S]*?value: first\(split\(operatorPublicIp, '\/'\)\)/);
  assert.match(threeArm,/destinationAddresses: platformAllowServiceTags/);
  assert.match(threeArm,/  'AzureKeyVault'/);
  assert.match(p3Nsg,/destinationAddressPrefix: 'AzureKeyVault'[\s\S]*?destinationPortRange: '443'/);
});
