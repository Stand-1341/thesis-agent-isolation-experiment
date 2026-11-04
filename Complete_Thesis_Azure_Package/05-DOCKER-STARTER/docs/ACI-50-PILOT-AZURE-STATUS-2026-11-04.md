# ACI 50-row pilot: Azure setup status

**Checked:** 2026-11-04 16:39 UTC  
**Scope:** Approved, sequential, non-counted 50-row ACI P1 technical pilot only. This is not the 450-row study run.

## Completed

- The schedule bytes match the recorded SHA-256: `63bda5ee7af173cfaa704970c114b2aedab7aa9ce3381dbd7149008dbe0d552f`.
- Azure deployment `thesis-aci-50-uai-phase1-20261104` succeeded and created 30 no-compute-cost run-scoped managed identities for the 10 U6/U8 rows.
- Azure deployment `thesis-aci-50-uai-phase2-fixed-20261104` succeeded. It grants the controller attach/delete rights only at the individual run-identity scopes, with conditioned role-assignment cleanup. Source/cleanup identities have Blob Data Contributor only at their scenario's synthetic marker container; probe identities have no Blob data role.
- Read-only Azure RBAC inspection confirmed all 30 identities have the expected lifecycle and conditioned controller grants, the exact 20 source/cleanup Blob grants, and no Blob grants for the 10 probes. The two container-scoped controller conditions each contain only the 10 source/cleanup principals for that scenario and the Blob Data Contributor role.
- The local implementation now has a two-phase, schedule-bound identity bootstrap and protected marker-content evidence path. `npm run verify` passed: **344 tests passed, 0 failed**. The three identity Bicep templates compile.
- No ACI trial container groups are active. The controller VM remains running as directed; it is billable.

## Still blocks starting any of the 50 rows

- The runner's latest dry-run reports `runnable: false` and `executionStarted: false` for all 50 rows.
- U6 and U8 production callbacks and live scenario validation are incomplete. The independent identity reviewer, ACI lifecycle observer, and lifecycle audit evidence adapter still need real Azure validation and permissions.
- The `trial-evidence` Blob container's immutability policy is `Deleted` with a zero-day period. There is no locked evidence policy, and version-pinned independent evidence read/write has not been proven in Azure.
- Required readiness evidence is missing for deployment, isolation, verifier, independent evidence protection, U6, U8, and credentials. Do not mark these gates passed from local tests or an ARM what-if.
- The evidence adapter requires the institution-approved evidence retention period. The repository has no approved value. Grambling State University's general records policy says each department sets and obtains approval for its own retention schedule; it does not give this study a universal duration ([policy 20100](https://www.gram.edu/faculty/policies/docs/20100%20Record%20Retention%20Policy.pdf)). The seven-year term in the research-misconduct policy applies to misconduct proceedings, not automatically to this experiment ([policy 81007](https://www.gram.edu/faculty/policies/docs/81007%20Research%20Misconduct%20Procedures%20Policy.pdf)).

## Cost snapshot

Azure's `thesis-experiment-budget` reports **$84.23 spent against its $125 budget** at the time checked. This is budget consumption, not the remaining Azure credit balance; cost data can lag. No cost estimate for the 50-row run is claimed here.

## Model scope

The current 50-row ACI schedule is a deterministic technical pilot and does not call GPT-5 mini. Any live-model interaction must be recorded as a separate model pilot unless its prompt/tool method is explicitly added to and approved for this 50-row protocol. No model call or experiment row ran during this setup work.
