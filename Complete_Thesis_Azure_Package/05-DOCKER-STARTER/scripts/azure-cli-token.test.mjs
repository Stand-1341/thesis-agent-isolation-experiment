import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAzureCliStorageTokenProvider,createAzureCliLogsTokenProvider,createAzureCliSessionsTokenProvider} from './azure-cli-token.mjs';

test('uses a fixed storage scope and isolates errors from credential output',async()=>{
  let invocation;
  const run=async(file,args,options)=>{invocation={file,args,options};return {stdout:'fake.token.value\n'};};
  const provider=createAzureCliStorageTokenProvider({azureConfigDirectory:'C:/safe-profile',run,platform:'win32'});
  assert.equal(await provider(),'fake.token.value');
  assert.equal(invocation.file,'powershell.exe');
  assert.equal(invocation.options.env.AZURE_CONFIG_DIR,'C:/safe-profile');
  assert.match(invocation.args.at(-1),/https:\/\/storage\.azure\.com\//);
  const failing=createAzureCliStorageTokenProvider({run:async()=>{throw new Error('secret in stderr');},platform:'linux'});
  await assert.rejects(failing(),error=>error.message==='Azure CLI token acquisition failed');
  await createAzureCliLogsTokenProvider({run,platform:'win32'})();
  assert.match(invocation.args.at(-1),/https:\/\/api\.loganalytics\.io/);
  await createAzureCliSessionsTokenProvider({run,platform:'win32'})();
  assert.match(invocation.args.at(-1),/https:\/\/dynamicsessions\.io/);
});
