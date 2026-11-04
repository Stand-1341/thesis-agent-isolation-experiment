# ACI P1 first-50 pilot runner

## Controller-managed deployment health smoke

Run `.\infra\deploy-aci-controller-health-smoke.ps1` from PowerShell to
verify the controller managed identity can create and delete a private ACI
group, attach the ACR-pull and P1 workload identities, pull the digest-pinned
agent image through the ACI NAT path, and reach the agent's private `/health`
endpoint. The script starts the deallocated controller VM if needed, uses
random disposable credentials, deletes the smoke group, and deallocates the VM.
It also seeds a unique synthetic marker in `authorized-docs`, has the P1 agent
read and match that marker using its managed identity, and deletes the marker.
This is an L1-like read-only deployment probe outside the 50-row schedule; it
does not create a trial record or validate the independent verifier/evidence
store. It reports `trialRowsRun: 0` and `countedAsStudyTrials: false`.

`.\infra\validate-aci-controller-runtime.ps1` separately checks that the
controller identity can read the named Key Vault secret and list ACI groups;
it prints statuses only, never secret contents.

`npm run run:aci-p1-pilot -- --dry-run` validates the separate, hashed 50-row ACI P1 draft. It never executes rows. The checked-in protocol is deliberately blocked and the report lists its open gates.

The pilot is isolated from the thesis's frozen 400-row matrix. If it is later approved, the protocol must be changed to `approved_for_non_counted_pilot`, `runPermitted: true`, and `countedAsStudyTrials: false`; U6 and U8 must each be marked `validated` with an evidence reference. A separate readiness JSON must include:

- `approvals.status: "approved"`, plus evidence references for the method decision and reviewer;
- `scheduleSha256` equal to the exact draft CSV digest and `countedAsStudyTrials: false`;
- passed, evidence-referenced gates for `methodApproval`, `deploymentValidated`, `isolationValidated`, `verifierValidated`, `independentEvidenceProtection`, `u6Validated`, `u8Validated`, and `credentialsValidated`.

The CLI checks the above before importing the dependency module or claiming any row. The dependency module must export an ACI adapter, independent verifier, and exclusive evidence store with `claim` and `save`. Rows run sequentially and halt at the first incomplete or indeterminate result. All rows are recorded as `non_counted_pilot`; this command cannot collect thesis-counted data.

The production candidate dependency factory is `scripts/aci-p1-pilot-deps.mjs`. It receives the exact parsed schedule rows from the runner, accepts only ACI/P1, and refuses U6 or U8 before reading configuration or constructing credentials. The checked-in 50-row schedule includes both U6 and U8, so this factory intentionally refuses the current schedule; this is not a readiness pass and does not start Azure requests. The U6/U8 lifecycle analogues and method decision must be completed and independently evidenced before an approved 50-row plan can proceed.

When that method work is complete, the factory requires explicit Azure configuration in the controller process environment. It uses three distinct user-assigned identities: `THESIS_ACI_CONTROLLER_IDENTITY_CLIENT_ID` for ARM/Key Vault and fixture writes, `THESIS_ACI_FIXTURE_VERIFIER_IDENTITY_CLIENT_ID` for independent fixture reads, and `THESIS_ACI_AUDIT_IDENTITY_CLIENT_ID` for Log Analytics. ACI config requires `THESIS_ACI_SUBSCRIPTION_ID`, `THESIS_ACI_RESOURCE_GROUP`, `THESIS_ACI_LOCATION`, `THESIS_ACI_IMAGE_DIGEST_REFERENCE`, `THESIS_ACI_REGISTRY_SERVER`, `THESIS_ACI_PULL_IDENTITY_RESOURCE_ID`, `THESIS_ACI_P1_IDENTITY_RESOURCE_ID`, `THESIS_ACI_P1_IDENTITY_CLIENT_ID`, `THESIS_ACI_SUBNET_ID`, `THESIS_ACI_RESEARCH_URL`, `THESIS_ACI_COLLECTOR_URL`, `THESIS_ACI_P1_PRINCIPAL_OBJECT_ID`, `THESIS_FIXTURE_BLOB_ENDPOINT`, `THESIS_BLOB_RESOURCE_ID`, `THESIS_LOG_ANALYTICS_WORKSPACE_ID`, and `THESIS_KEY_VAULT_URI`. Six Key Vault secret names are specified by `THESIS_ACI_RESOURCE_ADMIN_SECRET_NAME`, `THESIS_ACI_COLLECTOR_ADMIN_SECRET_NAME`, `THESIS_ACI_CONTROLLER_KEY_SECRET_NAME`, `THESIS_ACI_WORKLOAD_TOKEN_SECRET_NAME`, `THESIS_ACI_COLLECTOR_VERIFIER_SECRET_NAME`, and `THESIS_ACI_RESOURCE_VERIFIER_SECRET_NAME`. The existing measured evidence store also requires `THESIS_EVIDENCE_IDENTITY_CLIENT_ID`, `THESIS_EVIDENCE_RETENTION_APPROVED`, `THESIS_EVIDENCE_RETENTION_DAYS`, `THESIS_EVIDENCE_BLOB_CONTAINER_URL`, and `THESIS_EVIDENCE_CONTAINER_RESOURCE_ID`; at runtime it reads Azure's immutability policy and refuses an unlocked or too-short policy. Secret values are fetched in memory from Key Vault and are never logged.

The dependency module wires candidate implementations; it does not validate their cloud behavior. In particular, network isolation, audit completeness, authorization-layer attribution, independent evidence protection, and all readiness gates still require separate real Azure pilot evidence. The default non-counted pilot verifier mode does not flip any assertion to true.

Example structural check:

```powershell
npm run run:aci-p1-pilot -- --dry-run
```

Execution syntax is intentionally not a deployment shortcut. It becomes available only after the protocol, approval record, ACI end-to-end validation, and dependency module are real and reviewed:

```powershell
npm run run:aci-p1-pilot -- --run --readiness .\config\aci-p1-readiness.json --deps .\config\aci-p1-deps.mjs
```

Do not create or assert readiness references to force a launch. They must identify actual, reviewable evidence. ACI changes the thesis's original platform/method, so the pilot must not be treated as thesis results without the institution's method decision.
