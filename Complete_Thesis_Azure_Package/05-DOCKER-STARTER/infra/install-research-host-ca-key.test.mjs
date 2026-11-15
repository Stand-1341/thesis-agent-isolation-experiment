import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {installResearchHostCaKey,validateHostCaPair} from './install-research-host-ca-key.mjs';

const identityClientId='11111111-2222-4333-8444-555555555555';
const namePrefix='th3arm';

test('host CA key installer retrieves only the exact Key Vault secret through the selected UAI and rejects a mismatched key',async()=>{
  const ca=await readFile(new URL('../certs/thesis-pilot-ca.pem',import.meta.url));
  const pair=generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const secretValue=`base64:${Buffer.from(pair.privateKey).toString('base64')}`;
  const urls=[];
  const fetchImpl=async(url,options)=>{
    urls.push({url:String(url),options});
    if(String(url).startsWith('http://169.254.169.254/')) return new Response(JSON.stringify({access_token:'temporary-vault-token'}),{status:200});
    return new Response(JSON.stringify({value:secretValue}),{status:200});
  };
  const fsImpl={readFile:async file=>{assert.equal(file,'ca.pem');return ca;}};
  await assert.rejects(installResearchHostCaKey({vaultUrl:'https://thesis.vault.azure.net',identityClientId,namePrefix,
    caCertificatePath:'ca.pem',tlsDirectory:'/secure/tls',fetchImpl,fsImpl,rootCheck:()=>true}),/does not match the image trust certificate/);
  assert.equal(urls.length,2);
  assert.match(urls[0].url,/client_id=11111111-2222-4333-8444-555555555555/);
  assert.equal(urls[0].options.headers.Metadata,'true');
  assert.match(urls[1].url,/\/secrets\/th3arm-host-tls-ca-private-key\?/);
  assert.equal(urls[1].options.headers.authorization,'Bearer temporary-vault-token');
  assert.doesNotMatch(JSON.stringify(urls),/-----BEGIN PRIVATE KEY-----/);
});

test('host CA pair validator rejects malformed values without disclosing them',async()=>{
  const ca=await readFile(new URL('../certs/thesis-pilot-ca.pem',import.meta.url));
  assert.throws(()=>validateHostCaPair('not-a-key',ca),/Key Vault secret is invalid/);
  assert.throws(()=>validateHostCaPair('base64:!!!!',ca),/Key Vault secret is invalid/);
});
