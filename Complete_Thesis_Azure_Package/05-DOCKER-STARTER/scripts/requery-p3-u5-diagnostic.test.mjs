import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {azureDiagnosticsFirewallQuery} from './denial-reader.mjs';

test('saved P3 U5 read-only helper uses the generated exact-window firewall query',async()=>{
  const source=await readFile(new URL('./requery-p3-u5-diagnostic.py',import.meta.url),'utf8');
  const embedded=source.match(/QUERY = r'''([\s\S]*?)'''/)?.[1];
  assert.ok(embedded,'fixed bounded query is present');
  const generated=azureDiagnosticsFirewallQuery({srcIp:'10.49.8.4',destinationIp:'10.48.9.5',destinationPort:8443,
    t0:'2026-11-05T08:52:47.792Z',t1:'2026-11-05T08:52:55.897Z'});
  assert.equal(embedded,generated);
  assert.match(source,/access_token/);
  assert.doesNotMatch(source,/print\([^\n]*access_token/);
  assert.match(source,/"RuleName"/);
});
