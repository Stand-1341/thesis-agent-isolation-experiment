# ACI Blob session analogue independent verifier

The verifier in `scripts/aci-blob-session-independent-verifier.mjs` supports only U6/U8 on the ACI P1 analogue. It never consumes the candidate `classification` field. It asks independent readers for the exact Blob audit rows, locked evidence snapshots, current method approval, and ARM/activity lifecycle snapshot; it checks their provenance and recomputes effective Blob read/write permission from the protected role/deny assignment and transitive-group snapshot. Missing, ambiguous, unresolved, changed, or unsupported observations produce `indeterminate`.

## Current blocker

The current analogue evidence contains `markerFingerprint` and adapter-reported per-operation fingerprints, but no protected evidence reference proving the actual marker bytes read by the verifier and, for an HTTP 200, returned to the probe. A hash echoed by the workload is not an independent observation. Therefore every current U6/U8 record must remain `indeterminate` under this verifier, even if the audit log says `GetBlob` returned 200 or 403.

To support a positive classification, the evidence producer must create a separately retained, immutable `azure_blob_marker_content_proof_v1` snapshot and include `evidence.markerContentProof = { evidenceReference, snapshotFingerprint }`. It must bind the run/scenario, container resource ID, exact object URI, marker fingerprint, and exact seed/read/probe request IDs and principals. For a 200 probe, the independent proof must include the probe response content fingerprint. For a 403 probe, it must prove both the seeded marker and the independent verifier's successful read. The verifier intentionally does not use the raw marker content or accept a fingerprint supplied only by the trial adapter.

## Lifecycle evidence contract

The callback `readAciLifecycleEvidence` must return a provenance-wrapped, fingerprint-checked `azure_aci_arm_activity_snapshot_v1` with group and identity records. Group records need the complete attached principal IDs, provisioning state, creation/deletion times, and timestamped observed states so the verifier can establish the U6 active-group window or U8 prior-group absence before new identity creation. Identity records need object ID, ARM resource ID, creation/deletion times, and independent confirmation that role assignments were removed. The current analogue's `group_ready` event names/IDs alone do not prove that independent lifecycle.

## Audit resource IDs

`StorageBlobLogs._ResourceId` identifies the Storage Account, not the blob container. The verifier derives the account ARM ID from the candidate container ARM ID and separately correlates the exact `Uri`, `ClientRequestId`, requester principal, operation, status, OAuth authentication type, and event time. Audit readers must return exactly one correlated row plus query provenance; an unscoped list or duplicate event is incomplete.

## Method and credential scope

The method callback must re-read an approved decision for the exact scenario, run, and prohibited operation. Access snapshots must explicitly resolve inheritance, transitive group membership, custom roles, data actions, conditions, deny assignments, and indirect credential paths. The verifier rejects unresolved condition/credential paths and does not infer effective access from a role name. Production credentials used by the independent readers still require separately audited review; this module itself makes no Azure calls.
