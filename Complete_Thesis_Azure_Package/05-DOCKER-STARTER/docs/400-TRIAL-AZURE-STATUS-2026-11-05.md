# 400-trial Azure status — 2026-11-05

**Result:** no counted trial has started. The Azure deployment is not ready for
the 400-row study.

## Target protocol and current drafts

- Revision 2 is preserved at `../03-PLANNED-TRIAL-MATRIX-400-REV2.csv` with
  SHA-256 `d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863`.
  It has 400 rows, 320 unauthorized and 80 legitimate, and includes 100 ACA
  custom-session rows.
- The active protocol is revision 3 with 300 rows and SHA-256
  `a6bc3ffe78d677d25e07452e06cfc437062fdd9e8322b4c834d31118337ccc7e`.
  It removes the ACA cells and has no replacement arm.
- A separate revision-4 ACI draft was generated from revision 2. It keeps the
  300 VM/Functions rows and maps the two 50-row ACA P1/P2 cells to ACI P1/P2.
  Draft matrix SHA-256:
  `1d21c879f34d35d965d258cd427d2e2e0c25538ccb4eec0147f3d9169d5481d4`.
  The draft remains non-runnable and has not replaced the active protocol.
- The ACI arm changes the isolation unit from ACA sessions to per-trial
  container groups. U6/U8 become cross-group Blob-marker analogues and do not
  measure native ACA session memory. The owner method direction is recorded in
  `400-ACI-OWNER-METHOD-DIRECTION.md`; external reviewer approval is not
  claimed.

## Live Azure state

- Azure inventory found two running support VMs (`thesis-controller-pilot` and
  `thesis-p3-targets`, both `Standard_F1as_v7`), one running Functions Flex P1
  pilot app, no ACA environment/pool, and no active ACI container group.
- The monthly budget is $125 with alert thresholds, not an enforced spending
  cap. The latest Cost Management read showed $88.49 spent (billing can lag).
  Both VMs remain running per the owner's instruction.
- The active 300-row structural preflight selected 300 rows: 220 measurable,
  60 not applicable, and 20 unsupported (VM/Functions P3 U5/U7).
- The same preflight found 11 missing credential variables, six placeholder
  route targets/principals, and all four measured-run gates unverified.
  Runtime dependencies were not checked by that command.

## Evidence storage checkpoint

- Before preflight writes, the independent reader listed zero evidence blobs.
- The evidence container has Blob versioning, HTTPS-only access, TLS 1.2,
  shared-key access disabled, and public blob access disabled.
- A separate reader successfully read a synthetic preflight object written by
  the evidence-writer identity. Azure rejected both overwrite and delete with
  `BlobImmutableDueToPolicy` under the unlocked policy.
- The container policy was then independently verified as `Locked` for
  146,000 days (Azure's maximum container retention period). This is a
  user-directed long-retention setting, not institutional approval. The
  validation objects are retained under the same policy. No study result was
  written.

## What still blocks the 400 run

1. The current CLI is bound to revision 3 and its six VM/Functions routes; it
   cannot run the ACI revision-4 draft or route ACI P1/P2.
2. ACI has no active container group. Its P1/P2 trial lifecycle, U6/U8
   analogues, cleanup, and independent verification still need live validation.
3. VM P1/P2/P3 and Functions P2/P3 experiment routes are not deployed and
   validated. The existing controller/target VMs and Functions P1 pilot app
   are support resources, not proof of those six routes.
4. The 20 P3 U5/U7 rows need independently attributable denial evidence.
5. The 400 revision needs its final method, verifier coverage, credentials,
   and four evidence-backed gates (`protocolFrozen`, `deploymentValidated`,
   `isolationValidated`, `verifierValidated`) validated before the runner can
   start.

The 50-condition GPT-5 mini prompt-injection pilot is a separate, non-counted
study arm. No 50-condition run or 400-row measured run has started in this
checkpoint.
