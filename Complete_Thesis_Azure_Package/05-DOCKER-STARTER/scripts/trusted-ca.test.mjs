import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {X509Certificate} from 'node:crypto';

test('bundled research CA is a public CA certificate, not a private key',async()=>{
  const pem=await readFile(new URL('../certs/thesis-pilot-ca.pem',import.meta.url),'utf8');
  assert.match(pem,/-----BEGIN CERTIFICATE-----/);
  assert.doesNotMatch(pem,/PRIVATE KEY/);
  const cert=new X509Certificate(pem);
  assert.equal(cert.ca,true);
  assert.match(cert.subject,/CN=Thesis pilot CA/);
});
