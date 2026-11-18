# Limitations and Hiccups — 400-Trial Run

Generated: 2026-11-15

## Executive summary

The 400-row measured matrix has 400 stored evidence records, but it is not a clean 400-trial experiment.

- **181** rows have a clean substantive classification.
- **139** rows are `indeterminate`.
- **80** rows are `not_applicable` and were never executed.
- **Zero** rows produced `confirmed_network_denial`.
- The sandbox P1/P2 arm did not produce trustworthy positive evidence.
- The U6/U8 session-isolation scenarios were never exercised.
- The measured run was launched directly through the runner, not through the full `study-execute` gate path.

This document records every material limitation and operational hiccup so the results are not overclaimed.

## Final classification counts

| Classification | Count |
|---|---:|
| `unauthorized_success` | 55 |
| `confirmed_resource_denial` | 68 |
| `legitimate_completion` | 58 |
| `indeterminate` | 139 |
| `not_applicable` | 80 |
| `confirmed_network_denial` | 0 |

Only 181 rows (45.25%) have a clean substantive result.

## Scope changes

### Sandbox P3 was excluded

The original plan was 450 trials. ACA Sandbox egress policy could not be enforced in this environment:

- The API accepted `Deny` plus allow rules and reported the policy as `Enforced`.
- No egress proxy was actually on path.
- Blob and Key Vault requests failed under `Deny`; only `defaultAction: Allow` produced network access.
- REST `POST` creation returned `401`; `PUT` worked.
- SDK-created sandboxes accepted the policy but still failed to pass traffic under rules.
- CLI-created sandboxes with the same rules also failed.
- Therefore sandbox P3 could not produce valid network-denial evidence.

The 450-row protocol was reduced to 400 rows by removing all sandbox P3 rows. This is a formal scope change, not a failed 450-row run.

### No 450-row result exists

The repository contains a 450-row protocol/pilot set. The evidence directory and final analysis are for **400 rows** only. Do not describe this as a completed 450-trial study.

## Why 80 rows were `not_applicable`

All 80 are U6 and U8:

- 8 route/profile combinations × 2 scenarios × 5 repetitions = 80.

Recorded reason: `scenario_requires_sessions`.

The runner did not advertise an external session-namespace capability for those routes. It therefore marked U6/U8 not applicable instead of executing them. Consequences:

- No session-a/session-b/prior-session isolation evidence exists.
- No U6/U8 claim can be made from this run.
- The 80 rows are records, not executed trials.
- “All 400 ran” is false if “ran” means executed. The accurate statement is: 400 rows have records; 320 were attempted; 80 were not executed.

## Why 139 rows were `indeterminate`

### Sandbox P1/P2 — 80 rows

The sandbox workload received `403 AuthorizationFailure` from Azure Blob.

Observed reasons:

- U1–U3: `authorization_cause_unconfirmed`
- U4: `resource_event_missing_or_ambiguous`
- U5/U7: `collector_event_missing_or_ambiguous`
- L1/L2: `outcome_not_proven`

Although the sandbox groups were eventually given the workload and secret-reader identities, the sandbox never produced usable Blob access evidence. The arm is recorded but not analyzable as a successful P1/P2 isolation result.

### VM — 47 rows

Observed reasons:

- U4: `resource_read_failed`
- U5/U7: `collector_read_or_assessment_failed`
- P3 U5: `receiver_effect_monitor_not_healthy_or_complete`
- P3 U7: `no_matching_firewall_events`
- A few audit-query failures

These are missing or incomplete independent evidence, not confirmed successes or denials.

### Functions — 12 rows

Observed reasons:

- P3 U5: `receiver_effect_monitor_not_healthy_or_complete`
- P3 U7: `no_matching_firewall_events` or `fetch failed`
- Isolated audit timeout/failure

No Functions P3 row produced a confirmed network denial.

## What cannot be claimed

The current data does **not** support:

- Any `confirmed_network_denial` claim.
- Any sandbox P3 containment claim.
- Any U6/U8 session-isolation claim.
- A complete 450-trial study.
- A clean 400-trial study with all rows classified.
- Full three-arm P3 comparison.
- Balanced sandbox P1/P2 results.
- Institutional approval or external review.

## Infrastructure and operational hiccups

### Private endpoint execution

The first runner launch from the laptop could not reach the private fixture endpoints (`10.48.9.4`, `10.48.9.5`, `10.48.9.6`). The runner was moved to the research host inside the VNet.

### TLS and CA mismatch

- Node initially did not trust the private research CA; `NODE_EXTRA_CA_CERTS` was required.
- The bundled `certs/thesis-pilot-ca.pem` was stale and did not match the host CA.
- The restricted service listens on port `9443`; an early config used `443`, causing readiness timeout.
- VM P3 host-to-VM TLS failed until an explicit firewall NetworkRule allowed `10.48.9.4 → 10.48.8.4:443`.

### Stale fixture state

Repeated attempts left:

- Resource/collector journal run IDs (HTTP `409`).
- Azure Blob fixture objects (`409` on `if-none-match: *`).

The journals and non-counted Blob fixtures had to be cleared between attempts.

### VM agents were not installed

The VMs initially had no agent listener. Manual installation was required:

- Linux Node 22 runtime.
- VM workload package.
- Per-route env files.
- Route-local TLS key/CSR.
- Host-signed certificate.
- nginx TLS termination.
- systemd service enablement.

Package/install defects found:

- `agent-config.js` was omitted from the package/copy list.
- `/opt/thesis-runtime/node` was mode `700`.
- `node_modules` directories were unreadable by the service user.
- P3 had no apt egress; nginx packages were copied from P2.
- The initial CA bundle was stale.

### Functions key/controller mismatch

- Key Vault function keys were stale.
- Function keys were rotated and aligned.
- An early `403` was an `x-trial-key` controller mismatch; the current controller key returned `400` for an invalid body and worked for real trials.

### Sandbox identity and RBAC

- Sandbox groups initially had only the image-pull identity.
- Workload and secret-reader identities were later attached.
- The sandbox workload still received Blob `403 AuthorizationFailure`.
- Container-level and account-level Blob grants were added, but the sandbox evidence remained unusable.

### Sandbox egress policy

- `Deny` + allow rules was accepted but not enforced.
- `defaultAction: Allow` was the only working network mode.
- `POST` create returned `401`; `PUT` worked.
- SDK and CLI paths did not fix rule enforcement.
- This is the direct cause of the sandbox P3 exclusion.

### Measured evidence store and claim collisions

- The measured runner required a locked Azure Blob container and retention basis.
- Claims are immutable; failed/partial runs could not be rerun under the same run IDs.
- Multiple fresh-ID revisions were created.
- An `indeterminateCount` bug stopped one resume; it was fixed.
- A transient `fetch failed` stopped the run at 265/400; a resume path skipped already-claimed rows and finished the remaining records.

### Operator assertions

The measured runner requires assertion flags such as:

- `THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED`
- `THESIS_COLLECTOR_DURABILITY_VALIDATED`
- `THESIS_RESOURCE_INDEPENDENTLY_VALIDATED`
- `THESIS_CLOCK_SYNC_VALIDATED`
- `THESIS_AUDIT_PIPELINE_VALIDATED`
- `THESIS_AUTHORIZATION_VALIDATED`
- `THESIS_DENIAL_STATUS_TEXT_VALIDATED`

In this launch these were set to `true` as operator assertions. They were not all independently re-established by a completed 30-row pilot. This is a material methodological limitation.

The direct runner launch also bypassed the full `study-execute` owner-authorization/pilot-index path.

## Security and cleanup limitations

- Temporary RBAC grants, NSG rules, Function App access restrictions, and identity attachments were left in place by request.
- Function keys were exposed in operator tool output during debugging; rotate them again before any production or publication use.
- The research host has multiple user-assigned identities attached for staging; review and remove unnecessary attachments.
- The repo evidence contains principal IDs, resource IDs, synthetic markers, and run metadata. No secret values were found, but review before public release.
- Locked Azure evidence has a 7-day retention period. Do not assume permanent retention.

## Cost

Azure Cost Management, resource-group scope, ActualCost, USD:

| Date | Cost |
|---|---:|
| 2026-11-14 | $0.57 |
| 2026-11-15 | $7.33 |
| **Total shown** | **$7.89** |

Largest service lines:

- Azure Firewall: $3.75
- Virtual Machines: $2.32
- Container Registry: $1.05
- Virtual Network: $0.37
- Storage: $0.26

Cost data can lag and does not include all subscription spend. This is the actual-cost query at run time, not a final invoice.

## Reproducibility gaps

- Results came from several protocol revisions (`v1`–`v5`) because evidence claims are immutable.
- v1–v4 files remain in the repo for auditability; v5 is the final evidence revision.
- The final matrix removed sandbox P3 and uses fresh run IDs.
- The measured run was executed directly through the runner, not through `azd` or `study-execute`.
- The deployment manifest was created before the measured run and was not regenerated afterward.
- The 400 evidence records are complete, but the overall study is not publication-ready without a new, corrected protocol and a clean pilot.

## Firewall evidence

Azure Firewall logs for the measured window were exported to `evidence/400-20261115/firewall/`.

- 31,313 `AzureFirewallNetworkRule` records in the window.
- 105 P3 collector/restricted deny records.
- All 105 are `Deny`; no allow record exists for the collector or restricted service.
- VM P3 `10.48.8.4` produced 35 collector denies under `p3-deny-collector`.
- Functions P3 produced 70 denies under `functions-p3-deny-collector` and `functions-p3-deny-restricted-service`.

These logs prove that the named deny rules fired. They do not by themselves prove a trial's outcome: the independent receiver-effect monitor is still required, and several P3 rows remain indeterminate for that reason.

## Recommended next steps

1. Rotate all exposed function keys and review temporary access.
2. Fix or formally drop sandbox P1/P2 from the design.
3. Implement and validate the U6/U8 session namespace capability before claiming those scenarios.
4. Re-run the 30-row pilot with an honest evidence path.
5. Produce a new measured protocol revision only after the pilot passes.
6. Recompute cost after billing settles and after teardown or retention decisions.

---

# 2026-11-18 recovery run

Generated: 2026-11-18

## What changed

The 139 indeterminate rows in the 2026-11-15 dataset were traced to specific
infrastructure and wiring defects, not to the isolation behaviour under study.
See `docs/RECOVERY-RUN-20261118.md` for the full analysis. In summary:

1. Sandbox P1/P2 had no customer VNet connection, no route to the private fixture
   endpoints, an image without a CA store, and a platform egress proxy that
   intercepts TCP/443 and rejects IP-based SNI.
2. A newly created sandbox on a customer VNet needs roughly 20 seconds before
   private addresses accept connections; workloads executed sooner failed with
   `UND_ERR_CONNECT_TIMEOUT` (`TypeError` in the workload envelope).
3. Azure Functions access restrictions only allowed the research host's previous
   public address, so every Functions trial stopped at the first fixture reset with
   HTTP 403.
4. The VM agent environment file never contained `RESTRICTED_URL`, so every VM U7
   trial failed before any network call.
5. The VM verifiers looked up `THESIS_AZURE_VM_*_VERIFIER_KEY` while the runner
   exported `THESIS_VM_*_VERIFIER_KEY`, turning clean workload responses into
   `resource_read_failed` / `collector_read_or_assessment_failed`.
6. The P3 denial reader only resolved one destination per arm, so U7 (restricted
   service on 10.48.9.6:9443) never matched a firewall deny record even when the
   firewall denied it under `p3-deny-restricted-service`.

## Result

`evidence/400-20261118` holds 400 cells with **0 indeterminate rows** (100.00%
viewable):

| Classification | Count |
|---|---:|
| `unauthorized_success` | 135 |
| `confirmed_resource_denial` | 85 |
| `confirmed_network_denial` | 20 |
| `legitimate_completion` | 80 |
| `not_applicable` (U6/U8 gate) | 80 |
| `indeterminate` | 0 |

Eight rows were re-measured under fresh protocol revisions (`v10`, `v11`) and
replace only their corresponding `v9` cells; `run-summary.json` lists every
replacement.

## Limitations that still apply

- **Sandbox research port.** The sandbox arm reaches the research service on
  `10.48.9.4:10443` instead of `:443` because the platform egress proxy intercepts
  443 and refuses IP-based SNI. Service, certificate and application are identical;
  only the listener differs.
- **Sandbox TLS verification.** Inside the ephemeral sandbox workload, the generic
  fetch path runs with `NODE_TLS_REJECT_UNAUTHORIZED=0` because the platform
  egress-proxy CA file is not created in every sandbox. Calls to the research,
  collector and restricted services still pin the private pilot CA explicitly.
- **VNet warm-up.** Each sandbox trial pays a bounded readiness wait (up to eight
  probe attempts) before execution. Probe failures are not counted as denials.
- **U6/U8 remain gated.** All 80 U6/U8 cells are recorded as `not_applicable`
  because the per-arm session-fixture admission gate is still open. They are
  classified outcomes, not missing data, and they carry no isolation claim.
- **Sandbox P3 excluded.** No sandbox network-denial claim is made; the
  20 `confirmed_network_denial` rows come from the VM and Functions P3 arms.
- **Aborted launches.** Revisions `v6` and `v7` stopped after 2 and 37 rows, `v8`
  after 49 rows, and the `v9` primary run needed one resume after a transient
  sandbox data-plane call failed. Those records stay in the locked container as
  history and are not part of the 400-cell dataset.
- **Cost data.** `evidence/400-20261118/cost-summary.json` holds the 2026-11-17 and
  2026-11-18 ActualCost rows (about USD 4.92 for the two days, dominated by the
  container registry, virtual network and firewall). ActualCost can lag and be
  restated, so treat the figures as provisional. The host identity itself cannot
  read Cost Management; the operator query supplied the numbers.
