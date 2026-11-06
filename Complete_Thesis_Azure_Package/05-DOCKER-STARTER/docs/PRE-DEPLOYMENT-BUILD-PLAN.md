# What needs to be built before deployment

Status of the selected three-arm architecture (`infra/azure-supported-three-arm.bicep`)
against the work required to actually deploy and run it.

This document describes **work that is not done**. It is not a deployment runbook, not
an approval, and not a quotation. Every fact below was read from the current tree or
produced by the commands named; nothing here is an estimate.

Read this before treating the repository as deployable.

---

## 1. What is actually proven today

Verified by execution, not by inspection:

| Claim | Evidence |
| --- | --- |
| All Bicep compiles | 42 `infra/*.bicep` files, Bicep CLI `0.48.1`, every build exits `0`, no errors |
| One file carries linter warnings | `infra/vm-p3-network-controls.bicep`: 6 × `use-resource-symbol-reference` |
| The schedule is frozen and internally consistent | `config/protocol-450-three-arm-supported-v2.json` + exact-byte matrix, digests verified against `…-freeze-lock.json` |
| All nine routes have local adapter/client code | VM / Jobs / Sandboxes × P1 / P2 / P3 |
| The runner consumes the frozen schedule structurally | `run-experiment-cli.mjs --dry-run` builds all nine routes and the verifier offline |
| The candidate cannot launch a measured run | Preflight exits `4`, `ready:false`, `launchEnabled:false`, measured flag `false` |
| The Node suite passes | `npm test` → 728/728 |

What none of that establishes: that a single Azure resource exists, that any
permission profile behaves as designed, or that any containment claim is true.
All of it is apparatus testing.

---

## 2. Build artifacts that do not exist yet

### 2.1 Container image and its digest

The template takes three pinned image references:

```
agentImageP1 … th3armacr.azurecr.io/thesis/agent@sha256:REPLACE-WITH-PINNED-64-HEX-DIGEST
agentImageP2 … same placeholder
agentImageP3 … same placeholder
```

Required work, in order:

1. Create a container registry (none exists yet; nothing in this repository creates one).
2. Build the agent image. `Dockerfile.node` is the image the VM, ACA Jobs and Sandbox
   adapters all use.
3. Push it and read back the **content digest** — not a tag. The template is written
   against digests deliberately, so a tag will not do.
4. Substitute the same digest into all three parameters unless the three profiles
   genuinely require different images.

`az acr build` can do build-and-push without a local Docker daemon. The historical
walkthrough in `README.md` shows the shape of the command and is explicitly marked as
superseded; do not follow its surrounding resource-creation steps.

### 2.2 Sandbox disk images

Three sandbox disk image names are pre-filled (`agent-p1`, `agent-p2`, `agent-p3`) but
the images themselves are created at runtime by the sandbox data-plane client from a
registry image. This path has **never been executed against Azure**. The preview token,
regional endpoint and disk-image creation flow are all unproven.

### 2.3 SSH key and VM image version

```
sshPublicKey    … ssh-ed25519 AAAA…REPLACE-WITH-REAL-PUBLIC-KEY-MATERIAL
vmImageVersion  … REPLACE-with-current-pinned-Ubuntu-22.04-image-version
```

Both are placeholders. The VM image version must be a real, currently published
Ubuntu 22.04 version string for the target region, not `latest`.

---

## 3. Values only the owner can supply

None of these can be derived from the repository. Each one blocks a different stage.

| Input | Why the repository cannot supply it |
| --- | --- |
| Subscription ID and tenant ID | Nothing in the tree records them; the inventory has never successfully run |
| Target Azure region | Region choice depends on live capacity and quota, both unknown |
| Controller public IP and source CIDRs | Real network plan, not `203.0.113.10/32` (a documentation range) |
| Principal object IDs for every role assignment | These are tenant-specific identity IDs, created outside this repository |
| Log Analytics workspace / DCE / DCR | Required for evidence and denial telemetry; not created by this template |
| Evidence container + retention approval | Measured evidence writes require a locked immutability policy at an institution-approved retention period |
| TLS trust material and endpoint names | Depends on the deployed hostnames |
| Key Vault name and secret references | `vaultName` is `""` and `linkVaultSecretReader` is `false` |
| Credit horizon and spending limit | Billing context for a study that creates real, billable resources |

The private CIDR blocks in the example parameter file (`10.48.x.x`) are a consistent
placeholder plan. They must be reconciled against the real network before deployment,
because overlapping ranges will fail at subnet creation rather than at review.

---

## 4. Flags that must be turned on, and what each one drags in

All eight deployment switches are `false` in `azure-supported-three-arm.parameters.example.json`.
A deployment using that file as-is builds the base virtual network and its subnets, the
`dependencies` module, and the Jobs Container Apps environment (`jobsEnvironment`, the one
environment module with no condition) — and **none of the three experiment arms**. No VM,
no research host, no sandbox group, no firewall, no evidence or fixture store, no registry
private endpoint, no Key Vault link.

The six linter warnings in `infra/vm-p3-network-controls.bicep` are on deliberate
`reference()` calls that read current subnet properties at deploy time so existing routes
and service endpoints are passed through unchanged. They are not a defect to be
mechanically rewritten; changing them to resource-symbol access would alter how this
route-preservation template behaves. Treat them as accepted, not clean.

| Flag | Currently | What turning it on requires |
| --- | --- | --- |
| `deployVmArm` | `false` | Real SSH key, pinned VM image version, workload identity ID, ACR pull permission |
| `deployResearchHost` | `false` | Private IP reconciliation for the mock resource service, TLS material |
| `deployEvidenceStore` | `false` | Storage account name availability, retention days, private endpoint IP, record-update role |
| `deploySyntheticFixtures` | `false` | The same, plus `createRecordUpdateRole:true` **or** an existing `recordUpdateRoleId` — both are currently unset |
| `deploySandboxGroups` | `false` | Preview API access, disk image pipeline, group identity with data-owner permissions |
| `deployP3Firewall` | `false` | Firewall + policy + route tables; this is the largest cost line and the entire P3 deny path |
| `deployEnvironmentNsg` | `false` | Subnet NSG rules that must not contradict the firewall policy |
| `deployRegistryPrivateEndpoint` | `false` | Private DNS wiring and registry metadata reader role |

Note the fixture-store trap: deploying it without `createRecordUpdateRole:true` and
without a pre-existing `recordUpdateRoleId` produces an incomplete composition. Role
creation also needs subscription-level authorization, which is a broader permission
than the rest of the deployment requires.

---

## 5. Gaps that no deployment closes

These are properties of the design, not of the infrastructure. Deploying perfectly
does not remove them.

### 5.1 Jobs P3 is structurally unsupported — 10 rows

`azure_container_apps_jobs:P3` cannot produce independently attributable network
denial evidence. Ten scheduled rows are therefore marked unsupported, not merely
gated. Preflight reports this as a scope blocker.

Consequence: the 3 arms × 3 profiles design has one empty cell. Any comparison across
all three profiles is incomplete on the Jobs arm until either attributable denial
telemetry is established for it, or the study is re-scoped to say so explicitly.

### 5.2 U6/U8 depends on per-arm fixture proof — 90 rows

Ninety scheduled rows (cross-session namespace scenarios) stay gated behind a
per-arm non-counted fixture pilot proving `session-a`, `session-b` and `prior-session`
seed/read behaviour plus cross-namespace denial. These rows are scheduled, not
not-applicable; they will not silently disappear.

### 5.3 The "microVM" arm is vendor-attested, not mechanism-documented

RQ2 asks how effectively VMs, serverless and microVM environments contain the same
behaviour. The vendor does describe the class of isolation, in two places at different
levels of specificity:

- **ACA Sandboxes product documentation** (`sandboxes.azure.com/docs/sandboxes/`) —
  "Isolated microVMs, on demand", and "Strong isolation. Each sandbox runs in its own
  secure boundary with its own kernel. Safe for untrusted code."
- **Microsoft Learn** (`container-apps/sandboxes-overview`, updated 2026-10-16) —
  "Strong isolation: Each sandbox runs in its own secure boundary, safe for untrusted
  code execution." No microVM term, no kernel statement.

So microVM-class isolation with a separate kernel per sandbox is a supportable vendor
claim, sourced from the product documentation rather than from Microsoft Learn.

What is still absent: **no document names a hypervisor or VMM**. There is no Firecracker
comparison to make, and the architecture document's prohibition on framing the result
that way still stands. Consequence for the write-up: the third arm may be described as
a vendor-attested microVM-class boundary with its own kernel, and must not be described
in terms of a specific mechanism. Say which document says what, because the two sources
do not say the same thing.

Data-plane constants **verified, not assumed**. The official SDK
(`azure-containerapps-sandbox` 0.1.0b4, `_helpers.py`) hardcodes:

```
DATA_PLANE_SCOPE       = "https://dynamicsessions.io/.default"
DATA_PLANE_BASE        = "https://management.azuredevcompute.io"
DATA_PLANE_API_VERSION = "2026-02-01-preview"
endpoint_for_region()  -> "https://management.{region}.azuredevcompute.io"
```

This repository uses the same three values. Two things that look like bugs and are not:
the audience is the Dynamic Sessions one, and the API version is still a preview string
even though the product is generally available. `scripts/sandbox-data-plane-contract.test.mjs`
pins all three so a future edit cannot quietly "correct" them into a 401.

What is still unproven is whether a live call succeeds — no request has ever been made.
The contract test proves the values match the vendor SDK, which is a different claim.

### 5.4 No Azure lane has ever executed

Per-arm pilot status, from the preflight:

- VM — code present, capability `established: true`, `pilotValidated: false`
- Jobs — code present, capability `established: false`, `pilotValidated: false`
- Sandboxes — code present, capability `established: true`, `pilotValidated: false`

Nothing on any arm has run. The template has compiled since it was written and has
never been deployed, so first-deployment failures are unproven rather than absent.

---

## 6. Gates that remain after a successful deployment

Preflight currently reports eight pending gates. A deployment closes **none** of them:

- `per_arm_non_counted_pilots` — pilot required
- `u6_u8_session_fixture_validation` — pilot required
- `target_scoped_positive_control_and_noop_baseline` — pilot required
- `receiver_effect_rule` — pilot required (live evidence only)
- `verifier_and_scope_wiring` — pilot required
- `measured_mode_operator_assertions` — owner assertion
- `live_identity_and_quota_unknown` — subscription unknown
- `owner_measured_freeze` — owner assertion

The last two matter most: an identity to read the subscription has never existed on
the working host, so quota, region capacity, provider registration, prior resources
and charges are all **unknown, not zero**. And measured-mode assertions are things the
owner declares after the underlying checks pass — they cannot be inferred, and the
code treats them as outcomes, not switches. `THESIS_NETWORK_NOOP_BASELINE_VALIDATED`
is the clearest example: setting it does not make a baseline valid.

---

## 7. Order of operations

Each phase is separately authorized. Nothing later may be inferred from an earlier phase succeeding.

**Phase 0 — identity and read-only inventory.** Free, creates nothing. Establishes
subscription, region capacity, provider registration, quota and any pre-existing
resources. Everything in section 3 that depends on live state waits for this.
Gate: `live_identity_and_quota_unknown`.

**Phase 1 — registry and image.** Create the registry, build, push, pin digests.
Replaces all three image placeholders. Still no experiment resources.

**Phase 2 — parameter file.** A real parameters file, not the `.example.json`. Every
placeholder resolved, every CIDR reconciled, every `deploy*` flag set deliberately,
identity object IDs filled in. The output of this phase is reviewable text — which is
the point, because it is the last cheap place to catch a mistake.

**Phase 3 — infrastructure deployment.** The first billable step. Authorized
separately, and only after Phase 0 has said what already exists and what it costs.

**Phase 4 — non-counted pilots, per arm.** The no-op baseline, the target-scoped
positive control, per-arm fixture validation, and the receiver-effect demonstration.
These produce pilot records, not study data.

**Phase 5 — measured authorization.** Only after the owner has reviewed the pilot
records and asserted the measured-mode outcomes. The frozen protocol keeps
`measuredExecutionEnabled: false`; the runner refuses measured launch regardless of
what any local test says.

---

## 8. The cheapest path to a first real observation

Phase 1 says "create a registry, build an image, pin digests". That is the right sequence
for the full study and it is **not** required to get one real observation. Two documented
facts remove it from the critical path:

1. Sandboxes can be created from **public prebuilt disk images**. The documented Python
   quickstart creates a sandbox with `begin_create_sandbox(disk="ubuntu")` — no registry,
   no build, no digest.
2. Data-plane access is granted by one built-in role, *Container Apps SandboxGroup Data
   Owner* (`c24cf47c-5077-412d-a19c-45202126392c`), assigned at sandbox-group scope.

So the smallest real unit of this study is: one resource group, one sandbox group, one
role assignment, one sandbox from the public image, one `exec`, one egress-decision read,
one delete. That exercises the sandbox arm end to end — arm creation, command execution,
egress telemetry, teardown readback — for the cost of a sandbox that exists for seconds
at the XS or S tier.

What that single run would settle, honestly: whether the preview data-plane API version
still works, whether the endpoint pattern resolves in the chosen region, whether the
egress-decision surface returns anything attributable, and whether the role assignment
propagates. What it would not settle: anything about the VM or Jobs arms, any measured
row, or any containment claim.

This is implemented as `scripts/sandbox-first-light.mjs` (`npm run sandbox:first-light`).
It refuses to run without `--execute`, creates one sandbox, runs one command, reads egress
decisions, deletes the sandbox and confirms absence, then emits a `sandbox_first_light_v1`
record. It exits `0` only when the whole chain ran **and** at least one attributable egress
decision came back; `2` for a chain that completed without attributing evidence; `3` for a
failed later step; `4` for identity or transport failure; `5` for usage.

Do this before creating a registry. It is the cheapest way to discover that the preview
API has moved.

### 8.1 Observability is opt-in, and the current design can silently have none

The platform exports telemetry only when a sandbox is created with a `telemetryConfig`
attaching at least one endpoint. The documentation is explicit: *"If you omit
`telemetryConfig`, no telemetry is exported."* `NetworkEgressDecisions` — the record that
makes a P3 denial claim possible — is one of the categories that must be named in an
endpoint's `data` array.

Two consequences that the study design has to absorb:

1. **Export and enforcement are independent.** Whether decisions are *exported* is
   controlled only by the `data` array; whether denied requests are *blocked* is
   controlled by the egress policy's enforcement mode. A run can enforce denials and
   export nothing, or export every decision while enforcing nothing. Neither setting
   implies the other, so both must be recorded separately.
2. **A zero decision count is a missing sensor, not clean egress.** If
   `NetworkEgressDecisions` was not configured, or was configured but nothing propagated,
   the correct reading is *unobserved*. Treating an empty result as evidence of
   containment would be the exact error the rest of this design works to avoid.

`scripts/sandbox-first-light.mjs` encodes both rules. It records whether telemetry was
declared, how many decisions came back, and classifies observability as `observed`,
`partial` or `unobserved` accordingly. The record also carries the data-plane audience
(`https://dynamicsessions.io/.default`) so an audience mismatch appears as a diagnosable
401 rather than a mystery.

---

## 9. Summary

Buildable by anyone with the credentials:

- container image, built and digest-pinned
- registry
- resolved parameter file
- sandbox disk images (needs the preview path to work at all)

Owner-only:

- subscription, tenant, region
- principal object IDs and every role assignment
- logging, retention and TLS decisions
- cost approval

Cannot be fixed by deploying anything:

- the 10 unsupported Jobs P3 rows
- the 90 U6/U8 rows awaiting fixture proof
- the unnamed hypervisor behind the sandbox isolation boundary
- the fact that no arm has ever executed

The repository is deploy-shaped. It is not deploy-ready, and deploying it would not
produce a single measured result.
