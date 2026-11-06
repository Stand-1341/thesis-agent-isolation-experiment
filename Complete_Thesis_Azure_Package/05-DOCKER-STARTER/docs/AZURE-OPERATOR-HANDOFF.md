# Azure operator handoff — three-arm architecture (read-only)

**Date: 2026-11-06. Ground truth: this worktree** (`05-DOCKER-STARTER`, branch `azure/supported-runnable-architecture`). Environment-variable names, validator constraints and commands below are taken from the current `scripts/deps-live.mjs`, `scripts/experiment-config.mjs`, `scripts/azure-inventory.mjs` / `azure-inventory-client.mjs`, `scripts/run-experiment-cli.mjs` and `scripts/denial-reader.mjs`; no credential values are included.

**What this is:** the exact inputs an operator (subscription owner) must supply, the read-only checks to run, and the order of work, before *anything* may run against Azure for the selected three-arm architecture (Azure Linux VM + ACA Jobs on a Consumption workload profile + ACA Sandboxes; decision record: [`AZURE-SUPPORTED-THREE-ARM-ARCHITECTURE.md`](AZURE-SUPPORTED-THREE-ARM-ARCHITECTURE.md)).

**What this is not:** deployment approval, a price quote, a quota report, or a claim that any pilot passed. No cloud resource write, deployment, Docker/server run, install, commit or push was performed while producing this document. The direct GET-only inventory command was rerun and returned `identity_unavailable` before any subscription data could be read. This document contains **no** resource names, object IDs, IP-plan values, endpoints or credentials from any live config file — only environment-variable *names*, shapes and validator rules.

---

## 1. Current state in one paragraph

The selected schedule is `config/protocol-450-three-arm-supported-v2.json` with its separate `config/protocol-450-three-arm-supported-v2-freeze-lock.json` and exact-byte matrix `config/plan-450-three-arm-supported-v2.csv`: 450 rows (3 arms × 3 profiles × 10 scenarios × 5 blocks), 360 unauthorized and 90 legitimate, 90 rows per block. The prior `protocol-360-three-arm-supported-v1` remains frozen but is superseded for scheduling; the legacy 450-row VM+Functions+session-pool plan remains unchanged and is inspected only with its own planning protocol. Local ACA Jobs/Sandbox adapter/client components, session-capability-based U6/U8 scope, and distinct VM/Jobs/Sandbox denial-evidence paths exist. The generic trial runner now **consumes the v2 schedule structurally**: its dry run resolves the declared matrix from the correct package root, verifies the exact frozen bytes, accepts the ACA deployment names, and consumes the v2 per-deployment `azure_blob_external_namespace` declaration, so its structural scope matches this handoff's preflight (440 measurable / 0 N/A / 10 unsupported once VM and Sandbox denial capabilities are advertised). The runner's dry run still executes nothing, and the v2 candidate's measured flag remains `false` — no offline result clears owner/live gates. A separately locked 66-row non-counted v2 pilot plan exists (P1 U1-U8/L1/L2 and P2/P3 U5-U8/L1/L2 on each arm); it has not been executed and closes no gate. U6/U8's 90 scheduled measured rows remain gated pending per-arm fixture pilots. These are structural/local facts, not live validation. The direct ARM read-only inventory was rerun and exited `4` (`identity_unavailable`): resources, quota, region capacity, provider registration and charges remain **unknown, not empty**; no subscription data was obtained and no Azure write was made. The preflight emits `three_architecture_preflight_v3` and always exits `4` for a valid candidate because pilot, subscription and owner gates remain open.

---

## 2. Fact classes — keep these separate in every report

| Class | Meaning | Examples |
|---|---|---|
| **Documentation fact** | Stated by a linked Microsoft source (verified live 2026-11-05 unless noted) | Consumption profiles are serverless; UDR only in workload-profiles environments; `NetworkEgressDecisions` per outbound request; documented quota categories |
| **Local test** | Verified offline in this repo by a test run | Preflight refusal semantics; destination-scoped control-query builders; verifier conjunction rules (unit level) |
| **Pilot-required fact** | Only provable by a real, separately recorded, **non-counted** pilot | Jobs actually pinned to Consumption; sandbox token scope/endpoint working in-tenant; no-op platform baseline clean |
| **Subscription-unknown** | Cannot be known without an authorized identity; `identity_unavailable` means unknown, not zero/deleted | Live quota usages; region capacity; provider registration; credit horizon; prior resources; charges |

---

## 3. Documentation facts (with sources)

- **ACA Jobs** — finite-duration, manually startable via ARM; apps and jobs share environment networking/logging; the Start API's execution template is an override whose caller can change image/command/env, so only a trusted controller may hold `Microsoft.App/jobs/start/action` (use an exact custom role, not Operator/Contributor, whose wildcard also matches `listSecrets`): https://learn.microsoft.com/en-us/azure/container-apps/jobs
- **Jobs Start REST** — stable at `2026-07-01`: https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/jobs/start?view=rest-resource-manager-containerapps-2026-07-01
- **Consumption workload profile = the serverless compute model** (per-replica billing): https://learn.microsoft.com/en-us/azure/container-apps/workload-profiles-overview
- **UDR/controlled egress only in the default workload-profiles environment** (legacy Consumption-only excluded): https://learn.microsoft.com/en-us/azure/container-apps/user-defined-routes
- **ACA and Functions are on the VNet flow-log incompatibility list** — hence firewall evidence for the Jobs arm: https://learn.microsoft.com/en-us/azure/network-watcher/vnet-flow-logs-overview
- **Sandboxes** — first-class `Microsoft.App/SandboxGroups` resource, OCI disk images, per-request egress decisions: https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview , https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-egress-policies , https://sandboxes.azure.com/docs/sandboxes/telemetry
- **Sandbox identity** — group identity inherited by all sandboxes in the group; `identitySettings`; Data Owner role for data-plane control: https://sandboxes.azure.com/docs/sandboxes/identity
- **Quotas and limits (documented categories/defaults, NOT live values)**: https://learn.microsoft.com/en-us/azure/container-apps/quotas and https://sandboxes.azure.com/docs/sandboxes/limits/ — "Sandboxes and Express are limited to 2,000 cores" vs the separate default "300 concurrent active cores per region/subscription" are different constructs.
- **Pricing** — https://azure.microsoft.com/en-us/pricing/details/container-apps/ (verified live 2026-11-05). Read current numbers there yourself; this repo asserts none.
- **Source-derived implementation detail (not documentation, not live-validated)** — the Microsoft-maintained Sandbox SDK (`azure-containerapps-sandbox` 0.1.0b4, preview; https://pypi.org/project/azure-containerapps-sandbox/) specifies data-plane token scope `https://dynamicsessions.io/.default` and regional endpoint `https://management.<region>.azuredevcompute.io`. Learn documents the data-plane host `management.azuredevcompute.io` but neither the token audience nor the region-qualified form. The repo's client follows the SDK source (`scripts/aca-sandbox-data-plane.mjs` lines 1 and 130); whether both work in your subscription is **pilot-required**, and the data-plane API is preview-tier (`2026-02-01-preview` default).

## 4. Local tests (verified offline in this worktree, 2026-11-06)

- `node --test scripts/preflight-three-architecture.test.mjs` — 15 tests cover legacy-plan preservation, candidate/lock and exact-byte digest validation (including refusal of a self-re-pinned candidate), planning-only refusal, candidate matrix shape, config-dependent U6/U8 scope, per-arm denial capability distinction, open-gate refusal, and actual CLI JSON/exit behavior.
- CLI end-to-end: `node scripts/preflight-three-architecture.mjs --config config/experiment.azure-three-arm.example.json --protocol config/protocol-450-three-arm-supported-v2.json` → exit `4`, report `three_architecture_preflight_v3`, 450 schedule rows / 440 measurable / 0 N/A / 10 unsupported, 90 U6/U8 fixture-gated rows, 30 P3 U5/U7 scheduled rows (10 Jobs rows unsupported), and 8 open gates. This is offline readiness reporting only.
- Runner structural dry run: `node scripts/run-experiment-cli.mjs --config config/experiment.azure-three-arm.example.json --protocol config/protocol-450-three-arm-supported-v2.json --dry-run --json` → exit `4`, JSON report with the exact frozen matrix digest `3e9d2664…40d6`, 450/450 rows, 420 measurable / 0 N/A / 30 unsupported with no `--deps` (every arm's P3 U5/U7 rows honestly report the missing denial capability). With a dependency module advertising the VM and Sandbox denial capabilities, scope is 440 measurable / 0 N/A / 10 unsupported (Jobs P3 U5/U7), matching §9.1. The same command without `--dry-run` exits `3` (`measuredExecutionEnabled: false`) even with all four `--gates` asserted. Structural only; no Azure call, pilot, or measured row.
- `npm test` → exit `0`; TypeScript build plus Node suite: **728/728 pass**. No Docker/server/measured execution. Direct ARM inventory still exits `4` with `identity_unavailable` before any ARM inventory GET; no Azure resource mutation occurred. Environment/workload identity inputs are absent, system-assigned Managed Identity yields `CredentialUnavailableError` (cause `ServerError`), and the read-only IMDS instance-metadata request returned HTTP `404` at 2026-11-06 06:42 CST. This is missing identity on this host, not an Azure CLI dependency.
- Bicep CLI `0.48.1`: all 42 `infra/*.bicep` files build and lint with exit `0`; zero warnings. Build outputs stayed in scratch.
- `scan-doc-commands.py` → 48 Markdown docs scanned, 27 commands checked, 0 unresolved paths/scripts.
- `git diff --check` → clean.
- Verifier conjunction rules (unit level, `scripts/experiment-verifier.mjs`): a P3 `observed_allow` never becomes `unauthorized_success` without the receiver's independent record; `confirmed_network_denial` requires the enforcer record **and** a healthy receiver monitor (`scripts/collector-effect-monitor.mjs`); destination-scoped positive-control queries (`scripts/denial-reader.mjs` `firewallControlQuery` / `vnetFlowControlQuery` reject a missing destination).

---

## 5. Environment variables and credentials

### 5.1 Token provider mode (`scripts/deps-live.mjs`)

| Variable | Values / shape | Notes |
|---|---|---|
| `THESIS_TOKEN_PROVIDER_MODE` | `azure_cli` (default) \| `managed_identity` | Anything else fails construction. `managed_identity` requires the two client IDs in §5.4. |

### 5.2 Always required to build live dependencies

| Variable | Shape (validator) |
|---|---|
| `THESIS_LOG_ANALYTICS_WORKSPACE_ID` | GUID (workspace ID) — regex-checked |
| `THESIS_FIXTURE_BLOB_ENDPOINT` | HTTPS **account root** URL: `https://<lowercase-account>.blob.core.windows.net/`; account host regex 3–24 lowercase alphanumeric, root path `/`, no port, credentials, query or fragment |
| `THESIS_BLOB_RESOURCE_ID` | Non-empty string (Blob account ARM resource ID) |

### 5.3 Network-denial telemetry — VM arm (required when `azure_vm:P3` is selected)

| Variable | Shape | When |
|---|---|---|
| `THESIS_VM_P3_DENIAL_TELEMETRY` | `vnet_flow_log` (default) \| `azure_diagnostics_firewall` | VM P3 selected |
| `THESIS_DENIAL_DESTINATION_IP` | IPv4 | VM (or legacy Flex) P3 selected |
| `THESIS_VM_TARGET_RESOURCE_ID` | Plain ARM resource ID | `vnet_flow_log` (primary scope; SrcIp is blank for internet flows) |
| `THESIS_VM_SOURCE_IP` | IPv4, optional | `vnet_flow_log`, no override |
| `THESIS_VM_P3_FIREWALL_SOURCE_IP` | IPv4 | `azure_diagnostics_firewall` |
| `THESIS_VM_P3_FIREWALL_DESTINATION_PORT` | Integer 1–65535 | `azure_diagnostics_firewall` |
| `THESIS_VM_P3_FIREWALL_DENY_RULE` | `[A-Za-z0-9_-]{1,128}` (named rule) | `azure_diagnostics_firewall` |

Legacy Flex arm (superseded; read only when flex routes are selected): `THESIS_FLEX_SOURCE_IP` (IPv4), `THESIS_FLEX_P3_DENIAL_TELEMETRY` (`firewall` default | `azure_diagnostics_firewall`), `THESIS_FLEX_P3_FIREWALL_SOURCE_CIDR` (IPv4 CIDR), `THESIS_FLEX_P3_FIREWALL_DESTINATION_PORT` (1–65535), `THESIS_FLEX_P3_FIREWALL_DENY_RULE`.

### 5.3a Network-denial telemetry — ACA Jobs P3 (opt-in candidate; pilot not validated)

The following names are read by the current `scripts/deps-live.mjs`; they configure a target-scoped Azure Firewall application-rule reader. Configuration is not proof that the firewall emits attributable records. Without all valid inputs, the Jobs denial capability remains false and P3 U5/U7 remain unsupported.

| Variable | Shape / role |
|---|---|
| `THESIS_JOBS_P3_DENIAL_TELEMETRY` | `none` (default) or `azure_firewall_application_rule` |
| `THESIS_JOBS_P3_FIREWALL_SOURCE_CIDR` | IPv4 CIDR for the Jobs egress source |
| `THESIS_JOBS_P3_FIREWALL_DESTINATION_PORT` | Integer 1–65535 |
| `THESIS_JOBS_P3_FIREWALL_COLLECTOR_FQDN` | DNS hostname for the collector target |
| `THESIS_JOBS_P3_FIREWALL_COLLECTOR_DENY_RULE` | Plain named deny rule |
| `THESIS_JOBS_P3_FIREWALL_RESTRICTED_FQDN` | DNS hostname for the restricted target |
| `THESIS_JOBS_P3_FIREWALL_RESTRICTED_DENY_RULE` | Plain named deny rule |

ACA Jobs/Sandbox routes also require the distinct control/data-plane identity selectors `THESIS_ACA_CONTROL_PLANE_IDENTITY_CLIENT_ID` (Jobs control plane) and `THESIS_ACA_DATA_PLANE_IDENTITY_CLIENT_ID` (Jobs/Sandbox data plane). These are names only; supply no values in this handoff. The Jobs reader is candidate wiring, not an established live capability; a target-attribution pilot and a clean no-op/positive-control baseline remain mandatory. Sandbox denial evidence is a separate `NetworkEgressDecisions` data-plane path, not a Jobs firewall record or VM flow log.

### 5.4 Managed-identity mode additions

| Variable | Shape |
|---|---|
| `THESIS_STORAGE_IDENTITY_CLIENT_ID` | Non-empty (fixture-Blob reader identity client ID) |
| `THESIS_LOGS_IDENTITY_CLIENT_ID` | Non-empty (Log Analytics reader identity client ID) |

### 5.5 Timing

| Variable | Range / default |
|---|---|
| `THESIS_AUDIT_WAIT_MS` | Integer 0–3600000, default 3600000 (ingestion can take up to an hour) |
| `THESIS_AUDIT_POLL_MS` | Integer 1–120000, default 10000 |

### 5.6 Per-deployment verifier keys

`THESIS_<DEPLOYMENT>_RESOURCE_VERIFIER_KEY` and `THESIS_<DEPLOYMENT>_COLLECTOR_VERIFIER_KEY`, with `THESIS_<DEPLOYMENT>_VERIFIER_KEY` as a per-deployment fallback, where `<DEPLOYMENT>` is the upper-cased route deployment name (e.g. `THESIS_AZURE_VM_COLLECTOR_VERIFIER_KEY`). Service-specific wins over shared. These are secrets — supply via the environment, never the config file.

### 5.7 Route credentials (names live in the config file, values in the environment)

Each config route's `credentials` object holds **environment-variable names**, never secrets (validator: `^[A-Z][A-Z0-9_]{2,80}$`). At resolution, values must be ≥8 characters with no line breaks. Allowed fields per kind: `http` → `controller`, `resourceAdmin`, `collectorAdmin` (plus `functionKey` for the superseded Flex kind); `aca_job` / `aca_sandbox` → `resourceAdmin`, `collectorAdmin`.

### 5.8 Measured-mode operator assertions (pilot outcomes, not switches)

Required `=true` in measured mode when their route is selected; each unmet one is listed by name at construction and the run refuses to start. In `--pilot` mode unmet assertions are recorded as provisional notes instead.

| Variable | What must actually have happened first |
|---|---|
| `THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED` | Independent collector evidence established |
| `THESIS_COLLECTOR_DURABILITY_VALIDATED` | Collector journal survived the approved persistent-storage restart check |
| `THESIS_RESOURCE_INDEPENDENTLY_VALIDATED` | Independent resource evidence established |
| `THESIS_CLOCK_SYNC_VALIDATED` | Controller and verifier clocks verified in sync |
| `THESIS_AUDIT_PIPELINE_VALIDATED` | Audit pipeline proven to deliver complete records |
| `THESIS_AUTHORIZATION_VALIDATED` | Authorization outcomes independently confirmed |
| `THESIS_DENIAL_STATUS_TEXT_VALIDATED` | Denial status text independently confirmed |
| `THESIS_NETWORK_NOOP_BASELINE_VALIDATED` | **ACA Jobs P3 no-op baseline is clean and its positive log control is observed** (required when `azure_container_apps_jobs:P3` is selected; see §8) |

### 5.9 Measured evidence store (measured CLI runs)

`THESIS_EVIDENCE_BLOB_CONTAINER_URL`, `THESIS_EVIDENCE_CONTAINER_RESOURCE_ID`, `THESIS_EVIDENCE_RETENTION_DAYS`, `THESIS_EVIDENCE_RETENTION_APPROVED=true`, plus (managed-identity mode) `THESIS_EVIDENCE_IDENTITY_CLIENT_ID` and `THESIS_EVIDENCE_POLICY_READER_IDENTITY_CLIENT_ID`, and the owner-approval trio `THESIS_EVIDENCE_RETENTION_OWNER_APPROVED`, `THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE`, `THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE`. The CLI checks the ARM immutability policy is `Locked` for at least the approved retention days before any claim. Do not lock a policy until a disposable container demonstrated create/read and rejected overwrite/delete.

### 5.10 Read-only inventory identity (`scripts/azure-inventory.mjs`)

`AZURE_TENANT_ID` + `AZURE_CLIENT_ID` + (`AZURE_FEDERATED_TOKEN_FILE` **or** `AZURE_CLIENT_SECRET` **or** `AZURE_CLIENT_CERTIFICATE_PATH`), or a managed identity available to the host. Scope used: ARM management plane (`https://management.azure.com/.default`). This path performs **GET only** for resource metadata, `Providers - Get` registration states (API `2021-04-01`), and `Microsoft.App`/`Microsoft.Compute` regional usages. It never invokes Azure CLI or auto-registers a provider.

If the host has no managed identity and no service principal, set `AZURE_DEVICE_CODE_AUTH=1` to sign in interactively as your own user account instead. The command prints a verification URL and one-time code to **stderr** and waits; open it on any device and complete sign-in. The token stays in memory, no secret is written to disk, and no application registration is required, because the library's public sign-in client is used. The permission set is whatever your user already holds, which is typically broader than a purpose-scoped read-only identity — use it to obtain a first inventory, then create a narrowly scoped identity for anything repeatable. Device code is never attempted unless the variable is set.

---

## 6. Three-arm config shape (validator constraints that will reject a bad file)

`scripts/experiment-config.mjs` throws on the first problem, naming the field:

- Top level: `evidenceDirectory` (non-empty), `auditWindowSeconds` integer 60–7200 (default 3600), `routes` array.
- Deployments: `azure_vm` kind `http` (needs `agentUrl`, `resourceUrl`, `collectorUrl`); `azure_container_apps_jobs` kind `aca_job`; `azure_container_apps_sandboxes` kind `aca_sandbox`. All URLs absolute HTTPS (HTTP only for loopback), no embedded credentials, no query/fragment.
- Jobs: `subscriptionId` GUID; `workloadProfileName` must be exactly `Consumption`; `resourceGroup` safe name (≤90 chars, no `..`); `jobNames` distinct safe segments per profile; `agentImage` pinned digest (`…@sha256:` + 64 hex, no tag-only refs); `imagePullIdentityResourceId` full UAI resource ID; `resources.cpu` number 0–16, `resources.memory` `\d+(\.\d+)?(Mi|Gi)`; `apiVersion` stable `YYYY-MM-DD` (default `2026-07-01`); `executionTimeoutMs`/`logWaitMs` 1000–3600000.
- Sandboxes: `subscriptionId` GUID; `region` lowercase region name; `sandboxGroups` and `diskImageIds` distinct safe segments per profile; `agentImage` pinned digest; `imagePullIdentityResourceId` UAI; `resources.cpu` `\d+(m|vCPU)`, `memory`/`disk` `(Mi|Gi)`; `apiVersion` `YYYY-MM-DD-preview` (default `2026-02-01-preview`); `timeoutMs` 1000–3600000.
- Study shape (U7 and U6/U8 scheduled): every arm needs `restrictedUrl` whose host differs from `collectorUrl`, and `sessionDataStore: "azure_blob_external_namespace"`.
- Routes: exactly the nine `deployment:profile` keys; `principalObjectId` GUID unique per route; on three-arm selections each route additionally needs `workloadClientId` + `secretReaderClientId` (GUIDs, all distinct, workload ≠ secret-reader) and `workloadIdentityResourceId` + `secretReaderIdentityResourceId` (full UAIs, all distinct, workload ≠ secret-reader) and a `workloadTokenSecretUri` (`https://<vault>.vault.azure.net/secrets/<name>[/<version>]`).
- The preflight adds its own hard check on top: **any** route from `azure_functions_flex`, `azure_custom_sessions_hyperv` or `azure_container_instances` is a superseded-architecture blocker even if `validateExperimentConfig` alone would accept it.

---

## 7. Order of work

1. **Local only (no Azure):** fresh `npm install && npm run build`, then `npm test`. Compile/lint the selected Bicep composition per §9.5 (offline; no Azure CLI/login/deployment). Then run the preflight (§9.1) and read the refusal report; it should exit `4`.
2. **Owner supplies subscription/tenant/region + read-only identity** (§5.10). Run the inventory (§9.2). Expected: exit `0` with resources, provider-registration and quota sections. If it exits `4`, inspect `identityDiagnostics`; source flags are presence-only, and `CredentialUnavailableError` means no token was acquired. Configure a complete workload/environment identity or run on an Azure host with managed identity; never paste secrets into chat or infer that live resources are absent.
3. **Read-only quota/region/provider checks** (§9.3). Compare against documented limits (§3). Nothing is provisioned.
4. **Owner approves** pilot scope, spending limit, retention, and the non-counted pilot plan.
5. **Local structural implementation is complete, live validation is not:** the selected v2 schedule, scenario-scope capability declarations, ACA Jobs/Sandbox adapter/client components, verifier components, and separate denial-evidence paths exist and have offline tests. The read-only three-arm preflight verifies the candidate against a separate freeze lock, and the generic trial runner now consumes the v2 matrix/metadata contract for structural dry runs (matrix root resolution, ACA deployment names, config-declared per-arm U6/U8 capability); see the `verifier_and_scope_wiring` gate for the measured-path wiring that remains. Neither local modules nor tests constitute a runnable or live-validated study.
6. **Owner-controlled live readiness work remains:** resolve subscription identity/inventory, quota/region/provider status; run separately recorded per-arm pilots and no-op/positive controls; establish per-arm fixture validation; demonstrate independent verifier/receiver-effect behavior and the measured-path adapter/collector-effect wiring those pilots prove; then record owner assertions and explicit measured authorization. Frozen old schedules stay untouched.
7. **Non-counted pilots, per arm** (§8.3): VM first, then Jobs, then Sandboxes. Every record labeled non-counted (`countedAsStudyTrials:false`), originals preserved.
8. **No-op platform baseline for Jobs P3** (§8.2) — a real, separately recorded, non-counted run. Only after it is clean **and** its positive control observed may `THESIS_NETWORK_NOOP_BASELINE_VALIDATED=true`.
9. **Assert remaining gates** (§5.8) only after each underlying check actually passed; set up the measured evidence store (§5.9).
10. **Measured launch is not authorized here.** The current preflight always exits `4`; it cannot grant launch readiness, even after a valid schedule is selected. Any future launch requires a separately reviewed readiness process and explicit owner authorization, not an offline preflight bypass.

---

## 8. No-op baseline and non-counted pilots

### 8.1 Why (evidence rule)

On an ACA Jobs arm whose platform egress shares the Azure Firewall with the study workload, a source-only telemetry query can manufacture `observed_allow` from unrelated platform traffic. Two controls make separation provable: **target-scoped positive-control queries** (exact destination IP/FQDN + port, never source-only — the repo's query builders now enforce this), and a **no-op platform baseline**: a real, separately recorded, non-counted run that measures what platform egress generates with no study probe at all. A firewall `Allow` alone is never an unauthorized success; confirmed prevention needs the enforcer record **plus** a healthy independent receiver monitor showing zero effect in the exact trial window.

### 8.2 No-op baseline procedure (Jobs P3; non-counted; has NOT been run)

1. With the workload-profiles environment and firewall deployed, keep the study job **idle** (no probe execution) and mark an exact window `[t0, t1]` (same length as a trial execution window, plus the audit window — ingestion can lag up to an hour).
2. Run the destination-scoped control query over that window (§9.4) for **each** study target (collector and restricted-service IP/FQDN + port).
3. Record everything: window, query text, row counts, and any platform-attributable records (identify them by rule name/port; do not guess). Store as a separate artifact with `countedAsStudyTrials:false`.
4. **Positive control:** deliberately attempt one *permitted* connection from the same egress path to a study-allowed target, and confirm it appears in the same telemetry under the expected allow rule. A baseline without an observed positive control proves nothing about query scoping.
5. Only if the baseline is clean (no unattributed records hitting the deny-rule scope) **and** the positive control is observed may `THESIS_NETWORK_NOOP_BASELINE_VALIDATED` be set to `true`. If either fails, the platform/workload separation assumption is wrong — stop and re-scope (dedicated environment, single workload, or tighter rules), then repeat.

### 8.3 Non-counted pilot runs (CLI)

The selected v2 pilot uses a separately frozen 66-row plan (`config/protocol-450-three-arm-supported-v2-pilot-v1.json` + its adjacent lock and matrix). P1 contains U1-U8/L1/L2 on each arm; P2/P3 contain U5-U8/L1/L2 on each arm, one attempt per cell. This is a non-counted diagnostic schedule, not the measured 450-row matrix.

Offline structural preview (no dependencies, Azure calls or trial execution):

```bash
node scripts/run-experiment-cli.mjs \
  --config config/experiment.azure-three-arm.example.json \
  --protocol config/protocol-450-three-arm-supported-v2-pilot-v1.json \
  --pilot --dry-run --json
```

Expected: exit `4` with a structural JSON report, 66 planned rows, 60 measurable / 0 N/A / 6 unsupported (without `--deps`, all three arms' P3 U5/U7 pilot rows lack denial capability). The CLI verifies the pilot protocol/matrix against both the separate lock and code-side pins. The measured v2 protocol has no `pilotPlan`; it must not be passed with `--pilot`.

An actual live pilot is an owner-only, potentially billable Azure action and has **not** been run here. Only after the owner has approved and provisioned that arm, they may use an owner-filled config and select one deployment/profile at a time; the command executes the selected pilot rows:

```bash
node scripts/run-experiment-cli.mjs \
  --config <owner-approved-three-arm-config.json> \
  --protocol config/protocol-450-three-arm-supported-v2-pilot-v1.json \
  --deps scripts/deps-live.mjs --pilot \
  --deployment azure_vm --profile P3 \
  --pilot-evidence <absolute-private-non-counted-evidence-directory>
```

The evidence directory must be separate from measured-study evidence and should be outside the repository. Jobs P3 U5/U7 remain blocked until target-specific denial inputs are configured; filtering by arm/profile lets other supported pilot cells run first. Pilot records stay provisional and close no gate by themselves; `--evidence` and measured-study gates are not accepted in pilot mode. This handoff does not run the command.

---

## 9. Exact read-only commands and expected shapes

### 9.1 Preflight (offline, no credentials)

```bash
node scripts/preflight-three-architecture.mjs \
  --config config/experiment.azure-three-arm.example.json \
  --protocol config/protocol-450-three-arm-supported-v2.json
```

Expected **now**: exit `4`; JSON `schema:"three_architecture_preflight_v3"`, `launchEnabled:false`, `ready:false`, selected revision `three-arm-supported-450-v2`, and `selectedProtocol.freezeLock.protocolSha256Verified:true` / `matrixSha256Verified:true`. Protocol/matrix exact-byte hashes are checked against both code-side approved frozen pins and the separately loaded lock; changing the candidate and recalculating its own lock does not authenticate it. The selected schedule is 450 rows, 360 unauthorized + 90 legitimate, 5 blocks × 90; with the example config, scope is 440 measurable / 0 not-applicable / 10 unsupported. U6/U8's 90 rows are scheduled and fixture-pilot-gated; Jobs P3 U5/U7's 10 rows remain unsupported until attributable capability and pilot evidence exist. Eight integration/pilot/owner/subscription gates remain open. Exit `3` means invalid input or failed lock/digest/shape verification. No valid candidate can produce launch approval or exit `0`.

When `--deps` is supplied for capability reporting, the runner imports that trusted local module and invokes its factory in `non_counted_pilot` mode even if all measured gates are passed; it still executes zero rows. This is not a sandbox for arbitrary modules. The default preflight command above supplies no module and performs no Azure request.

For `run-experiment-cli.mjs --dry-run --json`, `dryRun:true` is authoritative: `selectedRows` is planned scope, and no trial/evidence row is executed. The `mode` and `studyCounted` fields describe the selected schedule class, not produced evidence.

### 9.2 Read-only inventory (needs §5.10 identity)

```bash
node scripts/azure-inventory.mjs --subscription <GUID> --region <region>
```

The CLI rejects malformed `--region` / `AZURE_REGION` syntax with exit `5` before token acquisition or ARM reads. This validates only the lowercase region-slug shape; it does not prove Azure recognizes the region or that quota/capacity is available. Unknown argument values are never echoed.

Expected with a valid identity: exit `0`, JSON for the selected `subscriptionId` with relevant ARM resource metadata, a `providerRegistration` map, and `Microsoft.App` / `Microsoft.Compute` regional usage values. `providerRegistration` reads the 10 namespaces used by the selected three-arm composition; if a provider read is denied/failed, the result is partial and includes a sanitized `providerRegistrationErrors` entry. **Last local check (2026-11-06):** exit `4`, `reason: identity_unavailable`; environment/workload credential inputs, `AZURE_CLIENT_ID`, and managed-identity endpoint environment variables were absent. `ManagedIdentityCredential` was the only provider in the chain, but its probe returned `CredentialUnavailableError` (direct probe cause `ServerError`); a separate read-only IMDS instance-metadata request returned HTTP `404`. No token or ARM inventory GET occurred. These results describe this host only: resources, provider registration, quota and region facts remain unknown, not absent. The inventory client uses direct ARM GETs and never invokes Azure CLI or auto-registers a provider.

### 9.3 Provider registration and quota (direct ARM; no Azure CLI)

The command in §9.2 is the supported read-only path and does not require Azure CLI. It obtains provider registration with the documented `Providers - Get` REST operation (`GET /subscriptions/{subscriptionId}/providers/{resourceProviderNamespace}?api-version=2021-04-01`) and quota usage with the two documented regional usage endpoints. It does not call the registration action or write any resource. Inspect each `providerRegistration` state and both usage lists; a failed provider read is reported as partial/unknown, not `NotRegistered`.

Expected usage shape: `{"value":[{"unit":"Count","currentValue":N,"limit":M,"name":{"localizedValue":"…","value":"…"}}, …]}`. Record `currentValue`/`limit` yourself — no live quota value is asserted anywhere in this repo. Provider API: https://learn.microsoft.com/en-us/rest/api/resources/providers/get?view=rest-resources-2021-04-01.

### 9.4 No-op-baseline / control queries (read-only Log Analytics)

For a manual read-only check, open the authorized Log Analytics workspace in Azure Portal and run the KQL below in **Logs**. The selected runtime and pilot clients query Log Analytics directly through Azure Identity; Azure CLI is not required. The query shape is also generated by `scripts/denial-reader.mjs` and consumed by `scripts/deps-live.mjs`.

Target-scoped network-rule control (the shape `scripts/denial-reader.mjs` builds — destination filters are mandatory):

```kql
AZFWNetworkRule
| where TimeGenerated between (datetime(<t0>) .. datetime(<t1>))
| where SourceIp == "<JOB_EGRESS_SOURCE_IP>" and DestinationIp == "<COLLECTOR_IP>" and DestinationPort == <PORT>
| summarize attempts=count(), denies=countif(Action == "Deny"), allows=countif(Action == "Allow")
```

Application-rule variant (FQDN targets): filter `Fqdn =~ "<target-fqdn>"` and `DestinationPort == <port>`, project `Action, Rule, RuleCollection, Policy`. **Never** run a source-only summarize for control purposes; a source-only query is exactly the false-allow failure mode the baseline exists to catch.

### 9.5 Offline Bicep build and lint (no Azure CLI/login)

From `05-DOCKER-STARTER/`, once the standalone Bicep binary is available, build and lint are offline and need no Azure CLI/login. The optional bootstrap download itself requires ordinary internet access; it is pinned to Bicep CLI `0.48.1` and checks the upstream asset SHA-256 from the [GitHub release metadata](https://api.github.com/repos/Azure/bicep/releases/tags/v0.48.1):

The optional evidence and synthetic-fixture Blob stores share a root-owned private DNS zone and VNet link. The composition creates that shared pair when either `deployEvidenceStore` or `deploySyntheticFixtures` is enabled, so either store can be deployed independently; `scripts/azure-supported-three-arm-template.test.mjs` checks both single-store cases. Fixture-only deployment still requires `createRecordUpdateRole=true` or an existing `recordUpdateRoleId`; the example defaults the creation flag to `false`, and creating the role needs subscription-scoped authorization. This is local template wiring evidence, not live DNS or endpoint validation.

```bash
set -euo pipefail
BICEP="${TMPDIR:-/tmp}/bicep"
BICEP_SHA256='b09ec25a9d376c1f8e33ede6ed22b587f915ad68488d5db77a6f9541748c7f6e'
curl -fsSL --retry 2 -o "$BICEP" https://github.com/Azure/bicep/releases/download/v0.48.1/bicep-linux-x64
printf '%s  %s\n' "$BICEP_SHA256" "$BICEP" | sha256sum -c -
chmod 700 "$BICEP"
"$BICEP" build infra/azure-supported-three-arm.bicep --outfile "${TMPDIR:-/tmp}/azure-supported-three-arm.json"
"$BICEP" lint infra/azure-supported-three-arm.bicep
```

Current local result: Bicep CLI `0.48.1` built and linted all 42 files in `infra/*.bicep`, including the selected composition; every command exited `0` with zero warnings. Build outputs stayed in scratch. This compiles only; it does not deploy or validate subscription-specific availability, quota, cost, or runtime behavior.

---

## 10. Open owner/live gates and claims that remain gated

All eight gates in the offline report are open; there are no blanket blockers claiming that the candidate protocol or all Jobs/Sandbox adapter code is absent. The generic-runner structural integration is now done and verified by the runner's own dry run; what remains in the wiring gate is the measured-path portion only the non-counted pilots can prove:

| Gate | Kind | Required closure evidence |
|---|---|---|
| `per_arm_non_counted_pilots` | Non-counted pilots | VM: reconcile image, route/firewall configuration, workload identity, target-scoped controls and attributable P3 telemetry. Jobs: observe Consumption placement, UDR traversal, allowed-target success, attributable firewall denial and separated platform egress. Sandboxes: validate preview token/endpoint, disk image, effective identity, egress decisions and deletion readback. |
| `u6_u8_session_fixture_validation` | Per-arm non-counted pilot | Prove session-a, session-b, and prior-session fixture seed/read and cross-namespace denial on each arm that schedules those rows. |
| `target_scoped_positive_control_and_noop_baseline` | Non-counted pilot | Record target-scoped positive controls and no-op baselines for firewall-shared VM/Jobs paths; only then may the applicable assertion be considered. |
| `receiver_effect_rule` | Non-counted pilot | Demonstrate attributable enforcer evidence plus a healthy independent receiver/resource monitor with no effect in the same execution window. |
| `verifier_and_scope_wiring` | Non-counted pilot | **Local offline wiring verified:** the frozen candidate reaches the runner, and a dependency-construction dry run builds all nine adapters plus the verifier/receiver-monitor coverage without Azure calls. Remaining evidence is live only: provider execution metadata, attributable denial telemetry, and a healthy receiver-effect window on each arm. |
| `measured_mode_operator_assertions` | Owner assertion | Establish every `THESIS_*_VALIDATED` outcome listed in §5.8 before setting it; a variable is not evidence. |
| `live_identity_and_quota_unknown` | Subscription unknown | An authorized read-only inventory must establish identity/resources, regional capacity, provider registration, quota, and charge context. Last inventory was `identity_unavailable`. |
| `owner_measured_freeze` | Owner authorization | Approve scope/cost and issue a separately reviewed, explicit measured-execution authorization after evidence review. |

The report distinguishes local structure from open pilot/subscription/owner gates. Unit tests and source-derived endpoints do not close any live gate.

- No deployment, resource, or identity is established for the three arms. Source/config/adapter wiring exists locally; this is not evidence that any resource exists. No Azure deployment, Docker build, or image push was run for this handoff.
- No live data-plane validation of any kind — including the Sandbox SDK-derived scope `https://dynamicsessions.io/.default` and endpoint `https://management.<region>.azuredevcompute.io` (source-based implementation details, preview API).
- No no-op baseline has been run; no clean-baseline or positive-control pass is claimed.
- No quota, region-availability, provider-registration, credit-horizon or charge fact is known; `identity_unavailable` means unknown, not zero.
- No price or cost estimate is asserted (pricing page linked in §3 for the operator to read).
- No measured trial of any schedule has run. The v2 450-row three-arm revision is the selected schedule; v1 360 is superseded for scheduling, and legacy 300/400/450 artifacts remain frozen. No-op/positive-control baseline, per-arm non-counted pilots (including U6/U8 fixture validation), owner assertions, live identity/quota/region/provider checks, and explicit measured authorization remain open. The preflight refuses launch and cannot approve one offline.
