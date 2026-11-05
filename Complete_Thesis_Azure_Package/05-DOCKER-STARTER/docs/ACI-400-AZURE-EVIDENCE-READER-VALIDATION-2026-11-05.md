# ACI 400 Azure evidence-reader validation

Read-only validation was run through Azure Run Command on `thesis-controller-pilot` in `RG-THESIS-RESEARCH-PILOT-EUS`. Tokens and content were suppressed.

## Confirmed

- The controller's audit managed identity acquired a Storage token whose `oid` matched the configured audit principal.
- `thesispilotblob20261102.blob.core.windows.net` resolved on the VM to private IP `10.48.4.6`, and the account's private endpoint connection is `Approved`.
- The audit identity listed the configured `trial-evidence` container successfully (HTTP 200).
- The audit identity read the Azure Activity Log endpoint successfully (HTTP 200). The bounded 15-minute query returned zero events; this verifies endpoint access only and proves no ACI lifecycle history.
- A Log Analytics `print 1` query succeeded (HTTP 200, one result table). This verifies workspace query access only; it does not validate StorageBlobLogs completeness or operation correlation.
- Azure Resource Manager reported the `trial-evidence` immutability policy as `Locked` for 146,000 days with protected append writes disabled.
- The existing non-counted retention smoke succeeded: synthetic preflight PUT 201; separate evidence-reader GET 200 and exact readback; overwrite and delete both returned 409 `BlobImmutableDueToPolicy`.

The smoke created the immutable synthetic object [retention smoke record](https://thesispilotblob20261102.blob.core.windows.net/trial-evidence/preflight/retention-smoke-1145152e-78f3-4b59-b810-8156dc3fa40c.json). It remains in the container by design.

## Still unresolved

- A Microsoft Graph service-principal inventory request from the controller failed during TLS setup. Credential, owner, and group-path review is therefore not validated from this host.
- The bounded Activity Log query returned no rows, and no ACI group was created or deleted in this check. Historical group attachment/deletion claims remain unavailable until actual per-group ARM observations are persisted under the locked policy and corroborated with applicable Activity Log events.
- No 400-study trial or ACI lifecycle callback was executed. The 146,000-day policy and storage read/write path do not establish protocol, method, deployment, isolation, or trial-verifier readiness.
- The controller config's `THESIS_EVIDENCE_RETENTION_APPROVED` is `false`. The 400-study reader uses the narrow owner-directed basis documented in [ACI-400-OWNER-DIRECTED-RETENTION.md](ACI-400-OWNER-DIRECTED-RETENTION.md); this does not assert institutional approval and does not change the separate P1 pilot basis.
