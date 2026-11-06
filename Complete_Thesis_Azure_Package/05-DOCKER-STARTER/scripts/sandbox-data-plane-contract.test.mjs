import assert from 'node:assert/strict';
import test from 'node:test';

import {DATA_PLANE_CONTRACT} from './aca-sandbox-data-plane.mjs';
import {SANDBOX_DATA_PLANE_SCOPE} from './sandbox-first-light.mjs';

/**
 * These values are a vendor contract, not a local choice. They were read directly from
 * the official SDK source:
 *
 *   azure-containerapps-sandbox 0.1.0b4 — azure/containerapps/sandbox/_helpers.py
 *     DATA_PLANE_SCOPE       = "https://dynamicsessions.io/.default"
 *     DATA_PLANE_BASE        = "https://management.azuredevcompute.io"
 *     DATA_PLANE_API_VERSION = "2026-02-01-preview"
 *     endpoint_for_region()  = f"https://management.{region}.azuredevcompute.io"
 *
 * The audience being the Dynamic Sessions one is the single most surprising thing in this
 * client and the most likely thing for a future reader to "fix" into a 401. If the SDK
 * changes these, this test is the tripwire.
 */
const VERIFIED = {
  scope: 'https://dynamicsessions.io/.default',
  apiVersion: '2026-02-01-preview',
  base: 'https://management.azuredevcompute.io'
};

test('data plane contract matches the verified vendor SDK constants', () => {
  assert.equal(DATA_PLANE_CONTRACT.scope, VERIFIED.scope);
  assert.equal(DATA_PLANE_CONTRACT.apiVersion, VERIFIED.apiVersion);
  assert.equal(DATA_PLANE_CONTRACT.base, VERIFIED.base);
  assert.match(DATA_PLANE_CONTRACT.verifiedAgainst, /azure-containerapps-sandbox/);
});

test('the first-light client uses the same audience as the shared client', () => {
  assert.equal(SANDBOX_DATA_PLANE_SCOPE, DATA_PLANE_CONTRACT.scope);
});

test('the contract is frozen so a caller cannot rewrite the audience at runtime', () => {
  assert.equal(Object.isFrozen(DATA_PLANE_CONTRACT), true);
  assert.throws(() => { 'use strict'; DATA_PLANE_CONTRACT.scope = 'https://example.com/.default'; },
    TypeError);
  assert.equal(DATA_PLANE_CONTRACT.scope, VERIFIED.scope);
});
