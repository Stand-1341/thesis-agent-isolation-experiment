import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  buildSandboxBody, main, parseArgs, runFirstLight, summarizeObservation, TELEMETRY_CATEGORIES
} from './sandbox-first-light.mjs';

const SUBSCRIPTION = '01234567-89ab-cdef-0123-456789abcdef';
const TELEMETRY = {metricsIntervalSeconds: 15, endpoints: [
  {kind: 'LogAnalytics', data: ['NetworkEgressDecisions'], dceEndpoint: 'https://dce.test',
    dcrImmutableId: 'dcr-test', tableName: 'Custom-Egress_CL',
    auth: {kind: 'SystemAssignedManagedIdentity'}}
]};

function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async createSandbox(body) { calls.push(['createSandbox', body]); return {sandboxId: 'sbx-1', sandbox: {state: 'Running'}}; },
    async executeShellCommand(id, command) { calls.push(['executeShellCommand', id, command]); return {exitCode: 0, stdout: '200', stderr: ''}; },
    async getEgressDecisions(id) { calls.push(['getEgressDecisions', id]); return [{decision: 'allow'}, {decision: 'deny'}]; },
    async deleteSandbox(id) { calls.push(['deleteSandbox', id]); return undefined; },
    ...overrides
  };
}

test('a validly parsed command still does not imply --execute', () => {
  const options = parseArgs(['--resource-group', 'rg-a', '--sandbox-group', 'grp-a']);
  assert.equal(options.execute, false);
  assert.equal(parseArgs(['--execute']).execute, true);
});

test('parseArgs rejects unknown flags, non-https probes, and bad names', () => {
  assert.throws(() => parseArgs(['--execute', '--deploy']), /unknown argument/);
  assert.throws(() => parseArgs(['--execute', '--probe-url', 'http://example.com']), /must use https/);
  assert.throws(() => parseArgs(['--execute', '--region', 'East US']), /lowercase Azure region/);
  assert.throws(() => parseArgs(['--execute', 'positional']), /positional arguments/);
  assert.throws(() => parseArgs(['--execute', '--resource-group', 'bad/name']), /valid resource group name/);
});

test('the public-image body is a distinct shape from the repo custom-image body', () => {
  assert.deepEqual(buildSandboxBody({publicImage: 'ubuntu'}), {sourcesRef: {publicImage: {name: 'ubuntu'}}});
  assert.ok(TELEMETRY_CATEGORIES.includes('NetworkEgressDecisions'));
});

test('a full chain with observed egress decisions is reported as observed', async () => {
  const client = fakeClient();
  const {record, exitCode} = await runFirstLight({
    subscriptionId: SUBSCRIPTION, region: 'eastus', resourceGroup: 'rg-a', sandboxGroup: 'grp-a',
    sandboxBody: {telemetryConfig: TELEMETRY}, probeUrl: 'https://example.com', client
  });
  assert.equal(exitCode, 0);
  assert.equal(record.lifecycle.created, true);
  assert.equal(record.lifecycle.deletedConfirmed, true);
  assert.equal(record.egress.decisionCount, 2);
  assert.deepEqual(record.egress.verdicts, ['allow', 'deny']);
  assert.equal(record.chain.confirmed, true);
  assert.equal(record.observation.dimensions.observability.status, 'observed');
  assert.equal(record.observation.dimensions.containment.status, 'unobserved');
  assert.equal(record.observation.overall, 'partial');
  assert.deepEqual(client.calls.map(c => c[0]),
    ['createSandbox', 'executeShellCommand', 'getEgressDecisions', 'deleteSandbox']);
});

test('omitting telemetryConfig makes observability unobserved, never clean', async () => {
  const client = fakeClient({async getEgressDecisions() { return []; }});
  const {record, exitCode} = await runFirstLight({
    subscriptionId: SUBSCRIPTION, region: 'eastus', resourceGroup: 'rg-a', sandboxGroup: 'grp-a',
    sandboxBody: {sourcesRef: {publicImage: {name: 'ubuntu'}}}, client
  });
  assert.equal(exitCode, 2);
  assert.equal(record.telemetryConfigDeclared, false);
  assert.equal(record.chain.confirmed, true);
  assert.equal(record.egress.attributable, false);
  assert.equal(record.observation.dimensions.observability.status, 'unobserved');
  assert.match(record.observation.dimensions.observability.detail, /missing sensor, not clean egress/);
});

test('declared export with zero records is still unobserved, not a passing negative', async () => {
  const client = fakeClient({async getEgressDecisions() { return []; }});
  const {record, exitCode} = await runFirstLight({
    subscriptionId: SUBSCRIPTION, region: 'eastus', resourceGroup: 'rg-a', sandboxGroup: 'grp-a',
    sandboxBody: {telemetryConfig: TELEMETRY}, client
  });
  assert.equal(exitCode, 2);
  assert.equal(record.observation.dimensions.observability.status, 'unobserved');
  assert.match(record.observation.dimensions.observability.detail, /not evidence that egress was clean/);
});

test('a failed create exits 4 and records no lifecycle progress', async () => {
  const client = fakeClient({async createSandbox() { throw new Error('Forbidden'); }});
  const {record, exitCode} = await runFirstLight({
    subscriptionId: SUBSCRIPTION, region: 'eastus', resourceGroup: 'rg-a', sandboxGroup: 'grp-a',
    sandboxBody: {}, client
  });
  assert.equal(exitCode, 4);
  assert.equal(record.lifecycle.created, false);
  assert.equal(record.failure.stage, 'create');
});

test('a failed delete keeps controllability partial and never claims absence', async () => {
  const client = fakeClient({async deleteSandbox() { throw new Error('timeout'); }});
  const {record, exitCode} = await runFirstLight({
    subscriptionId: SUBSCRIPTION, region: 'eastus', resourceGroup: 'rg-a', sandboxGroup: 'grp-a',
    sandboxBody: {telemetryConfig: TELEMETRY}, client
  });
  assert.equal(exitCode, 3);
  assert.equal(record.lifecycle.deletedConfirmed, false);
  assert.equal(record.observation.dimensions.controllability.status, 'partial');
});

test('bearer material and JWTs in command output never reach the record', async () => {
  const secretJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  const client = fakeClient({
    async executeShellCommand() {
      return {exitCode: 0, stdout: `token=${secretJwt}`, stderr: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'};
    }
  });
  const {record} = await runFirstLight({
    subscriptionId: SUBSCRIPTION, region: 'eastus', resourceGroup: 'rg-a', sandboxGroup: 'grp-a',
    sandboxBody: {telemetryConfig: TELEMETRY}, client
  });
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(serialized, /REDACTED/);
});

test('an unparsable egress payload is flagged rather than counted as zero', async () => {
  const client = fakeClient({async getEgressDecisions() { return {unexpected: true}; }});
  const {record} = await runFirstLight({
    subscriptionId: SUBSCRIPTION, region: 'eastus', resourceGroup: 'rg-a', sandboxGroup: 'grp-a',
    sandboxBody: {telemetryConfig: TELEMETRY}, client
  });
  assert.equal(record.egress.unparsedShape, true);
  assert.equal(record.observation.dimensions.observability.status, 'unobserved');
});

test('summarizeObservation separates a single run from a containment claim', () => {
  const summary = summarizeObservation({
    lifecycle: {created: true, deletedConfirmed: true},
    execution: {completed: true},
    egress: {decisionCount: 3},
    telemetryConfigDeclared: true
  });
  assert.equal(summary.dimensions.containment.status, 'unobserved');
  assert.equal(summary.dimensions.reproducibility.status, 'partial');
  assert.equal(summary.dimensions.governance.status, 'unobserved');
  assert.equal(summary.overall, 'partial');
});

test('main refuses without --execute before any credential work', async () => {
  let out = ''; let err = '';
  const code = await main({
    argv: ['--resource-group', 'rg-a', '--sandbox-group', 'grp-a'],
    env: {AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_REGION: 'eastus'},
    getToken: async () => { throw new Error('must not be called'); },
    stdout: {write: t => { out += t; }}, stderr: {write: t => { err += t; }}
  });
  assert.equal(code, 5);
  assert.match(err, /--execute is required/);
  assert.equal(out, '');
});

test('main reports missing inputs by name', async () => {
  let err = '';
  const code = await main({
    argv: ['--execute'], env: {},
    getToken: async () => 'token',
    stdout: {write: () => {}}, stderr: {write: t => { err += t; }}
  });
  assert.equal(code, 5);
  assert.match(err, /AZURE_SUBSCRIPTION_ID/);
  assert.match(err, /--resource-group/);
  assert.match(err, /--sandbox-group/);
});

test('--out writes the record owner-only and still prints it when the chain fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'first-light-'));
  const outPath = join(dir, 'first-light.json');
  let out = '';
  const code = await main({
    argv: ['--execute', '--resource-group', 'rg-a', '--sandbox-group', 'grp-a', '--out', outPath],
    env: {AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_REGION: 'eastus'},
    getToken: async () => 'synthetic-token',
    // A throwing transport keeps this offline: the chain is attempted and fails at create.
    fetchImpl: async () => { throw new Error('offline'); },
    stdout: {write: t => { out += t; }}, stderr: {write: () => {}}
  });
  assert.equal(code, 4);
  const written = JSON.parse(await readFile(outPath, 'utf8'));
  assert.equal(written.schema, 'sandbox_first_light_v1');
  assert.equal(written.chain.confirmed, false);
  assert.equal(written.failure.stage, 'create');
  // The same record is printed, so --out cannot hide a result.
  assert.deepEqual(JSON.parse(out), written);
  const mode = (await stat(outPath)).mode & 0o777;
  assert.equal(mode, 0o600, 'observation records are written owner-only');
});
