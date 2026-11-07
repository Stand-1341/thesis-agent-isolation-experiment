import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

import {
  COMPONENT_FLAGS, cidrsOverlap, parseArgs, parseCidr, renderParameters, reservedCollision, RESERVED_RANGES
} from './render-parameters.mjs';

const BASE = JSON.parse(await readFile(
  new URL('../infra/azure-supported-three-arm.parameters.example.json', import.meta.url), 'utf8'));

const DIGEST = `@sha256:${'a'.repeat(64)}`;
const GOOD = {
  base: BASE, region: 'centralus',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTests',
  vmImageVersion: '22.04.202611050',
  registryName: 'thesiscr1234', imageDigest: DIGEST,
  controllerIp: '76.78.187.165/32', enable: []
};

test('a complete input set renders with no problems', () => {
  const {problems, parameters} = renderParameters(GOOD);
  assert.deepEqual(problems, []);
  assert.equal(parameters.location.value, 'centralus');
  assert.equal(parameters.trustedControllerPublicIp.value, '76.78.187.165/32');
  assert.equal(parameters.agentImageP1.value,
    `thesiscr1234.azurecr.io/thesis/agent@sha256:${'a'.repeat(64)}`);
  assert.equal(parameters.agentImageP2.value, parameters.agentImageP1.value);
  assert.equal(parameters.agentImageP3.value, parameters.agentImageP1.value);
});

test('every optional component is off unless explicitly enabled', () => {
  const {parameters} = renderParameters(GOOD);
  for (const keys of Object.values(COMPONENT_FLAGS)) {
    for (const key of keys) assert.equal(parameters[key].value, false, `${key} must default off`);
  }
  const on = renderParameters({...GOOD, enable: ['sandbox-groups']}).parameters;
  assert.equal(on.deploySandboxGroups.value, true);
  assert.equal(on.deployVmArm.value, false);
});

test('a tag instead of a digest is refused', () => {
  const {problems} = renderParameters({...GOOD, imageDigest: 'v1'});
  assert.ok(problems.some(p => /content digest/.test(p)));
});

test('the documentation-range controller IP is refused', () => {
  const {problems} = renderParameters({...GOOD, controllerIp: '203.0.113.10/32'});
  assert.ok(problems.some(p => /documentation range/.test(p)));
});

test('a forgotten placeholder anywhere blocks the render', () => {
  const {problems} = renderParameters({...GOOD, vmImageVersion: 'REPLACE-with-current-pinned'});
  assert.ok(problems.some(p => /placeholder/.test(p)));
});

test('the fixture store cannot be enabled without a record-update role', () => {
  const {problems} = renderParameters({...GOOD, enable: ['fixtures']});
  assert.ok(problems.some(p => /createRecordUpdateRole|recordUpdateRoleId/.test(p)));
  const fixed = renderParameters({...GOOD, enable: ['fixtures'], recordUpdateRoleId: '/subscriptions/x/roleDefinitions/y'});
  assert.deepEqual(fixed.problems, []);
});

test('the vault secret reader requires a vault name', () => {
  const {problems} = renderParameters({...GOOD, enable: ['vault-secret']});
  assert.ok(problems.some(p => /vaultName/.test(p)));
});

test('unknown --enable values are rejected rather than ignored', () => {
  const {problems} = renderParameters({...GOOD, enable: ['sandbox-groups', 'everything']});
  assert.ok(problems.some(p => /unknown --enable/.test(p)));
});

test('CIDR overlap maths is correct at the boundaries', () => {
  assert.equal(cidrsOverlap('10.48.0.0/24', '10.48.0.0/24'), true);
  assert.equal(cidrsOverlap('10.48.0.0/24', '10.48.1.0/24'), false);
  assert.equal(cidrsOverlap('10.48.0.0/16', '10.48.9.0/24'), true);
  assert.equal(cidrsOverlap('192.168.0.0/24', '192.168.0.128/25'), true);
  assert.throws(() => parseCidr('10.48.0.0'), /not a CIDR/);
  assert.throws(() => parseCidr('10.48.999.0/24'), /not a CIDR/);
});

test('reserved sandbox ranges are detected, and the shipped 10.48 plan is clean', () => {
  assert.deepEqual(RESERVED_RANGES.map(r => r.name), ['192.168.0.0/24', '100.65.0.0/23']);
  assert.equal(reservedCollision('192.168.0.0/24'), '192.168.0.0/24');
  assert.equal(reservedCollision('100.65.1.0/24'), '100.65.0.0/23');
  assert.equal(reservedCollision('10.48.0.0/24'), undefined);
  const {problems} = renderParameters(GOOD);
  assert.ok(!problems.some(p => /reserved/.test(p)), 'the example plan must not collide');
});

test('a network that collides with a reserved range is refused, not warned', () => {
  const collided = structuredClone(BASE);
  collided.parameters.researchSourcePrefixes.value = ['192.168.0.0/24'];
  const {problems} = renderParameters({...GOOD, base: collided});
  assert.ok(problems.some(p => /overlaps sandbox-reserved range/.test(p)));

  const privateIp = structuredClone(BASE);
  privateIp.parameters.collectorPrivateIp.value = '100.65.0.9';
  const second = renderParameters({...GOOD, base: privateIp});
  assert.ok(second.problems.some(p => /falls inside sandbox-reserved range/.test(p)));
});

test('a non-central region is rendered but flagged for the config check', () => {
  const {problems, filled} = renderParameters({...GOOD, region: 'eastus'});
  assert.deepEqual(problems, []);
  assert.ok(filled.some(f => /eastus/.test(f)));
});

test('parseArgs rejects unknown flags and positional arguments', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  assert.throws(() => parseArgs(['oops']), /positional/);
  assert.throws(() => parseArgs(['--region']), /requires a value/);
  assert.deepEqual(parseArgs(['--enable', 'sandbox-groups,vm']).enable, ['sandbox-groups', 'vm']);
});
