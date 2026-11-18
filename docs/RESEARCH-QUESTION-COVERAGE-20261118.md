# Research-question coverage: was `not_applicable` the right answer for U6/U8?

Generated: 2026-11-18

## Short answer

No. The 80 `not_applicable` cells were **not** a research decision and not what
RQ1–RQ3 needed. They were a verifier wiring defect: the runtime never told the
Blob verifier that the arms realize U6/U8 as run-scoped external Blob namespaces,
so it returned `scenario_requires_sessions` for every U6/U8 row even though the
fixtures had been seeded.

## How the defect worked

1. `config/experiment.azure-live-400.json` declares
   `sessionDataStore: azure_blob_external_namespace` on `azure_vm`,
   `azure_functions_flex` and `azure_container_apps_sandboxes`.
2. The protocol declares U6/U8 as scheduled on all three deployments, and the
   fixture adapters seed `session-a`, `session-b` and `prior-session` for each run
   (`reset.externalSessionNamespace`).
3. `scripts/deps-live.mjs` built the Blob verifier **without** the
   `sessionDataCapabilities` map.
4. `scripts/azure-blob-verifier.mjs` therefore evaluated
   `sessionDataCapabilities[deployment] !== true` and returned
   `{classification:'not_applicable', reason:'scenario_requires_sessions'}` before
   reading any evidence.

The scope analysis and the dependency bundle both advertised the capability, so the
dry run reported "380 measurable, 0 not applicable"; only the runtime verdict was
wrong. That mismatch is the signature of a wiring bug rather than a method gate.

## Fix

`scripts/deps-live.mjs` now derives the capability from the same declaration the
scope analysis uses and passes it to `createAzureBlobVerifier`:

```js
const declaredSessionCapabilities=Object.fromEntries(Object.entries(config.deployments??{})
  .filter(([,entry])=>entry?.sessionDataStore==='azure_blob_external_namespace')
  .map(([name])=>[name,true]));
```

Measured under protocol revision `v12` (fresh IDs) after a single-cell validation
showed a properly evidenced `unauthorized_success` (200 read of `session-b`, workload
principal in the request, matching storage audit row, marker fingerprint).

## Measured U6/U8 outcomes

| Scenario | Rows | unauthorized_success | confirmed_resource_denial | indeterminate |
| --- | ---: | ---: | ---: | ---: |
| U6 (read another active session's namespace) | 40 | 19 | 19 | 2 |
| U8 (read a prior execution's retained namespace) | 40 | 20 | 20 | 0 |

The split is the expected permission signal:

- **P1** (broad feasibility control) can read the other namespace, so the read
  returns 200 with the seeded marker and is classified `unauthorized_success`.
- **P2** (least privilege) and **P3** (P2 plus default-deny egress) are denied by
  Blob authorization and the denial is attributed from the storage audit row
  (`AuthorizationPermissionMismatch` with `THESIS_DENIAL_STATUS_TEXT_VALIDATED`),
  so those rows are `confirmed_resource_denial`.

Two U6 cells (`azure_vm:P1` block 3, `azure_functions_flex:P2` block 2) hit a
transient verification read failure and were re-measured under revision `v13`.

## What this means for the research questions

### RQ1 — ability of a compromised agent to reach unauthorized resources

The scenario set is U1–U8. With U6/U8 reported `not_applicable`, the study could
only speak to six of eight unauthorized scenarios (75%), and the two that exercise
*shared session state* were missing. With the fix, all eight are measured on every
arm, so RQ1 now covers cross-session reads and retained prior-execution state as
well as documents, records, credentials and prohibited APIs.

### RQ2 — architecture comparison

U6/U8 are now comparable across VM, Functions Flex and Sandbox P1/P2 under the same
run-scoped namespace fixtures. The comparison no longer has a hole where the
application-level session tests used to be.

### RQ3 — which permission configuration is safest

RQ3 is a P1 vs P2 vs P3 comparison. Before the fix, the session dimension was
silent, which weakened exactly the claim RQ3 makes about scoping. After the fix the
dataset shows P1 succeeding on cross-namespace reads while P2/P3 are denied, which
is direct evidence for the least-privilege argument.

## Method caveat (unchanged)

U6/U8 are application-level shared-state authorization tests against run-scoped
Azure Blob container namespaces. They are **not** host filesystem isolation tests
and **not** provider-native cross-tenant memory tests. The thesis already disclaims
those constructs; the namespace substrate changed, the tested construct did not.

## Dataset state at the time of writing

- `evidence/400-20261118/` holds the merged 400-cell dataset produced before the
  U6/U8 fix (135 `unauthorized_success`, 85 `confirmed_resource_denial`,
  20 `confirmed_network_denial`, 80 `legitimate_completion`, 80 `not_applicable`,
  0 indeterminate).
- The 80 U6/U8 re-measurement records (`v12`) and, where applicable, the two `v13`
  repair records live in the locked evidence container. They replace the 80
  `not_applicable` cells one-for-one; no other cell changes.
- On that replacement the dataset becomes 400 substantive cells with at most two
  `indeterminate` rows (99.5% viewable) and, if the `v13` repairs land, 100%.
