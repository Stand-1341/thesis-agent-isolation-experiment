import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('Rev4 VM and Functions HTTP operation timeouts match the declared 30-second protocol limit',async()=>{
  const [protocolBytes,configBytes]=await Promise.all([
    readFile(resolve(ROOT,'config/protocol-400-rev4-vm-functions-draft.json'),'utf8'),
    readFile(resolve(ROOT,'config/experiment.azure-live.json'),'utf8')]);
  const protocol=JSON.parse(protocolBytes),config=JSON.parse(configBytes);
  const expectedMs=protocol.operationTimeoutSeconds*1000;
  assert.equal(protocol.operationTimeoutSeconds,30);
  for(const deployment of ['azure_vm','azure_functions_flex'])
    assert.equal(config.deployments[deployment].timeoutMs,expectedMs,`${deployment} timeout must match protocol`);
});
