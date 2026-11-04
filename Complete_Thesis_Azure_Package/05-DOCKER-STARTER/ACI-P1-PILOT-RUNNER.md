# ACI P1 first-50 pilot runner

`npm run run:aci-p1-pilot -- --dry-run` validates the separate, hashed 50-row ACI P1 draft. It never executes rows. The checked-in protocol is deliberately blocked and the report lists its open gates.

The pilot is isolated from the thesis's frozen 400-row matrix. If it is later approved, the protocol must be changed to `approved_for_non_counted_pilot`, `runPermitted: true`, and `countedAsStudyTrials: false`; U6 and U8 must each be marked `validated` with an evidence reference. A separate readiness JSON must include:

- `approvals.status: "approved"`, plus evidence references for the method decision and reviewer;
- `scheduleSha256` equal to the exact draft CSV digest and `countedAsStudyTrials: false`;
- passed, evidence-referenced gates for `methodApproval`, `deploymentValidated`, `isolationValidated`, `verifierValidated`, `independentEvidenceProtection`, `u6Validated`, `u8Validated`, and `credentialsValidated`.

The CLI checks the above before importing the dependency module or claiming any row. The dependency module must export an ACI adapter, independent verifier, and exclusive evidence store with `claim` and `save`. Rows run sequentially and halt at the first incomplete or indeterminate result. All rows are recorded as `non_counted_pilot`; this command cannot collect thesis-counted data.

Example structural check:

```powershell
npm run run:aci-p1-pilot -- --dry-run
```

Execution syntax is intentionally not a deployment shortcut. It becomes available only after the protocol, approval record, ACI end-to-end validation, and dependency module are real and reviewed:

```powershell
npm run run:aci-p1-pilot -- --run --readiness .\config\aci-p1-readiness.json --deps .\config\aci-p1-deps.mjs
```

Do not create or assert readiness references to force a launch. They must identify actual, reviewable evidence. ACI changes the thesis's original platform/method, so the pilot must not be treated as thesis results without the institution's method decision.
