# 12 — RUN INPUTS

Everything the runtime demands before a measured trial can execute, and where each
value comes from. Generated from the code, not from memory: every variable below
was extracted from `05-DOCKER-STARTER/scripts/deps-live.mjs` and
`config/experiment.example.json`, and every constraint is one the validator
actually enforces.

**Nothing here deploys anything.** Every `az` command is a read. There is no
`az deployment`, no `az containerapp create`, no mutation of any kind.

Nothing in the codebase blocks a run. What follows is the complete list of things
the code cannot know and will not invent.

---

## 0. Order of operations

1. Copy the template: `cp config/experiment.example.json config/experiment.json`
2. Fill **§1** (the nine endpoints) and **§2** (nine principal object IDs).
3. Fill **§3** (24 credential environment variables) into a mode-600 env file.
4. Fill **§4** (Azure identifiers) into the same env file.
5. Establish **§5** (the seven pilot assertions). These are results, not switches.
6. Verify: `npm run check:deploy -- --config config/experiment.json --deps scripts/deps-live.mjs`
   It names every input still missing. Repeat until it stops naming things.
7. Dry run, then and only then, the measured run.

---

## 1. Config file — nine endpoints

`config/experiment.json` → `deployments.<name>`. All URLs must be **HTTPS**
(the only exception the validator allows is loopback HTTP), must not embed
credentials, and must not carry a query string or fragment.

### `azure_vm` (`kind: "http"`)

| Field | What it is | How to get it |
|---|---|---|
| `agentUrl` | The agent service on the VM | `az vm show -d -g <RG> -n <VM> --query publicFqdn -o tsv` |
| `resourceUrl` | Resource service base URL | Same host, resource listener path |
| `collectorUrl` | Collector service base URL | Same host, collector listener path |
| `timeoutMs` | Per-operation timeout | `15000` |

### `azure_functions_flex` (`kind: "http"`)

| Field | What it is | How to get it |
|---|---|---|
| `agentUrl` | Function app base, **including `/api`** | `https://$(az functionapp show -g <RG> -n <APP> --query defaultHostName -o tsv)/api` |
| `resourceUrl` | Same as the VM deployment's | see above |
| `collectorUrl` | Same as the VM deployment's | see above |
| `timeoutMs` | Per-operation timeout | `30000` |

> Do not synthesise the Functions hostname. Flex hostnames carry a generated
> suffix; read `defaultHostName` and use it verbatim.

### `azure_custom_sessions_hyperv` (`kind: "session"`)

| Field | What it is | How to get it |
|---|---|---|
| `managementEndpoint` | Pool data-plane endpoint | `az containerapp sessionpool show --name <POOL> --resource-group <RG> --query properties.poolManagementEndpoint -o tsv` |
| `poolName` | Existing pool name | `az containerapp sessionpool list -g <RG> --query "[].name" -o tsv` |
| `region` | Pool region | as above |
| `sessionRegistryUrl` | Blob container URL holding the session map | `https://<account>.blob.core.windows.net/<container>` |
| `fixtureBlobEndpoint` | Blob account endpoint | `https://<account>.blob.core.windows.net` |
| `headerIsolationVerified` | Whether the pool proxy strips privileged headers | leave `false` until §5 |
| `timeoutMs` | Per-operation timeout | `30000` |

> **`managementEndpoint` must have five labels:**
> `<pool>.<environment-id>.<region>.azurecontainerapps.io`.
> A two-label guess like `<pool>.<region>.azurecontainerapps.io` is not a real
> hostname and the config validator rejects it at load. The environment ID label
> is the part people drop.

---

## 2. Config file — nine principal object IDs

`config/experiment.json` → `routes[].principalObjectId`. **Every route must have a
distinct principal**; the validator rejects a reused one. Nine GUIDs, one per
`deployment:profile` pair.

The set must be exactly these nine routes — no more, no fewer:

```
azure_vm:P1  azure_vm:P2  azure_vm:P3
azure_functions_flex:P1  azure_functions_flex:P2  azure_functions_flex:P3
azure_custom_sessions_hyperv:P1  azure_custom_sessions_hyperv:P2  azure_custom_sessions_hyperv:P3
```

| Deployment | Where the object ID comes from |
|---|---|
| `azure_vm` | `az vm show -g <RG> -n <VM> --query identity.principalId -o tsv` (one managed identity per profile) |
| `azure_functions_flex` | `az functionapp identity show -g <RG> -n <APP> --query principalId -o tsv` |
| `azure_custom_sessions_hyperv` | `az identity show -g <RG> -n <ID> --query principalId -o tsv` |

---

## 3. Credentials — 24 environment variables

The config names these; it never contains them. Each variable's name is
`THESIS_<DEPLOYMENT>_<PROFILE>_<SLOT>_KEY`. Values go in a **mode-600 env file**,
never in the config and never on a command line.

| Deployment | Profile | Variables |
|---|---|---|
| `azure_vm` | P1 | `THESIS_VM_P1_CONTROLLER_KEY`, `THESIS_VM_P1_RESOURCE_ADMIN_KEY`, `THESIS_VM_P1_COLLECTOR_ADMIN_KEY` |
| `azure_vm` | P2 | `THESIS_VM_P2_CONTROLLER_KEY`, `THESIS_VM_P2_RESOURCE_ADMIN_KEY`, `THESIS_VM_P2_COLLECTOR_ADMIN_KEY` |
| `azure_vm` | P3 | `THESIS_VM_P3_CONTROLLER_KEY`, `THESIS_VM_P3_RESOURCE_ADMIN_KEY`, `THESIS_VM_P3_COLLECTOR_ADMIN_KEY` |
| `azure_functions_flex` | P1 | `THESIS_FN_P1_CONTROLLER_KEY`, `THESIS_FN_P1_RESOURCE_ADMIN_KEY`, `THESIS_FN_P1_COLLECTOR_ADMIN_KEY`, `THESIS_FN_P1_FUNCTION_KEY` |
| `azure_functions_flex` | P2 | `THESIS_FN_P2_CONTROLLER_KEY`, `THESIS_FN_P2_RESOURCE_ADMIN_KEY`, `THESIS_FN_P2_COLLECTOR_ADMIN_KEY`, `THESIS_FN_P2_FUNCTION_KEY` |
| `azure_functions_flex` | P3 | `THESIS_FN_P3_CONTROLLER_KEY`, `THESIS_FN_P3_RESOURCE_ADMIN_KEY`, `THESIS_FN_P3_COLLECTOR_ADMIN_KEY`, `THESIS_FN_P3_FUNCTION_KEY` |
| `azure_custom_sessions_hyperv` | P1 | `THESIS_SESSION_P1_CONTROLLER_KEY` |
| `azure_custom_sessions_hyperv` | P2 | `THESIS_SESSION_P2_CONTROLLER_KEY` |
| `azure_custom_sessions_hyperv` | P3 | `THESIS_SESSION_P3_CONTROLLER_KEY` |

Function keys:

```bash
# host-level default key (per profile if you deployed them separately)
az functionapp keys list -g <RG> -n <APP> --query functionKeys -o json
# per-function key
az functionapp function keys list -g <RG> -n <APP> --function-name <FN> -o json
```

**Constraints the validator enforces:** every value must be at least 8 characters
and must contain no line breaks. A value that short or that contains a newline is
rejected, not truncated.

File permissions:

```bash
install -m 600 /dev/null ~/.thesis-run.env
# fill it, then:
set -a; . ~/.thesis-run.env; set +a
```

---

## 4. Azure identifiers — 13 environment variables (11 required, 2 optional)

Read by `scripts/deps-live.mjs`. All required unless marked optional.

| Variable | What it is | How to get it |
|---|---|---|
| `THESIS_SUBSCRIPTION_ID` | Subscription GUID | `az account show --query id -o tsv` |
| `THESIS_LOG_ANALYTICS_WORKSPACE_ID` | Workspace **customer ID** (a GUID, not the ARM resource ID) | `az monitor log-analytics workspace show -g <RG> -n <WS> --query customerId -o tsv` |
| `THESIS_VM_TARGET_RESOURCE_ID` | Resource ID whose flows the VNet flow log records (the NIC or subnet carrying the workload's egress) | `az vm show -g <RG> -n <VM> --query networkProfile.networkInterfaces[0].id -o tsv` |
| `THESIS_VM_SOURCE_IP` *(optional)* | VM private IP, used only as a fallback scope | `az vm list-ip-addresses -g <RG> -n <VM> -o tsv` |
| `THESIS_FLEX_SOURCE_IP` | Function app outbound IP that the firewall rule attributes | `az functionapp show -g <RG> -n <APP> --query possibleOutboundIpAddresses -o tsv` |
| `THESIS_DENIAL_DESTINATION_IP` | The controlled destination a P3 trial reaches for | An address you control. **Must not** be a TEST-NET, benchmark or special-purpose range — the validator rejects all six reserved ranges, because an ingress rule you cannot match is a lockout |
| `THESIS_BLOB_RESOURCE_ID` | Storage account resource ID used in audit queries | `az storage account show -g <RG> -n <ACCT> --query id -o tsv` |
| `THESIS_BLOB_FIXTURE_CONTAINER_URL` | Fixture container URL | `https://<acct>.blob.core.windows.net/<container>` |
| `THESIS_SESSION_REGISTRY_URL` | Session-map container URL | `https://<acct>.blob.core.windows.net/<container>` |
| `THESIS_SESSION_CONTROL_PRINCIPAL_ID` | Principal that drives the session control plane | `az identity show -g <RG> -n <ID> --query principalId -o tsv` |
| `THESIS_SESSION_FIXTURE_OWNER_PRINCIPAL_ID` | Principal that owns seeded session fixtures | as above |
| `THESIS_AUDIT_WAIT_MS` *(optional)* | How long to wait for audit records | default `3600000` (one hour) |
| `THESIS_AUDIT_POLL_MS` *(optional)* | Poll interval | default `10000` |

`THESIS_VM_TARGET_RESOURCE_ID` is the one people get wrong. `SrcIp` **and**
`DestIp` are both blank in `AzurePublic` and `ExternalPublic` flows, so an
internet-denial query scoped on the VM's IP address matches nothing. The reader
scopes on the resource ID instead.

**Before any measured run, prove the scope works:**

```kusto
NTANetAnalytics
| where TimeGenerated > ago(24h)
| where SubType == "FlowLog" and FlowDirection == "O"
| where TargetResourceId has "<THESIS_VM_TARGET_RESOURCE_ID>"
| summarize total=count(), allowed=countif(FlowStatus in ("A","Allowed")), denied=countif(FlowStatus in ("D","Denied"))
```

If `total` is zero, the resource ID is wrong and every P3 trial will report
`unobserved`. Fix it before spending anything.

---

## 5. Pilot assertions — seven variables, and they are not switches

Each of these is the **outcome of a check you actually ran**. The verifiers refuse
to construct themselves unless the corresponding one is true, and the live deps
module reports all seven with the sentence "each of these is the outcome of a
pilot check, not a configuration switch." Setting one to `true` on the way to a
run is the exact failure the gates exist to prevent.

| Variable | Establish it by |
|---|---|
| `THESIS_CLOCK_SYNC_VALIDATED` | Comparing controller and verifier wall clocks in the same minute and recording the delta |
| `THESIS_AUDIT_PIPELINE_VALIDATED` | Writing one controlled record and proving it becomes queryable **complete** within the window |
| `THESIS_AUTHORIZATION_VALIDATED` | Confirming one allowed and one denied authorization outcome independently of the workload's own claim |
| `THESIS_DENIAL_STATUS_TEXT_VALIDATED` | Reading the exact denial status text back out of the audit log, not from the caller |
| `THESIS_RESOURCE_INDEPENDENTLY_VALIDATED` | Reading resource state that the workload cannot write |
| `THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED` | Reading collector state that the workload cannot write |
| `THESIS_SESSION_HEADER_ISOLATION_VERIFIED` | Proving the session proxy strips privileged headers before the workload sees them |

Until each one passes, a measured run cannot start. That is the design, not an
obstacle.

---

## 6. Verify your work

```bash
cd Complete_Thesis_Azure_Package/05-DOCKER-STARTER

# validates config and routes, prints the plan, executes nothing.
# Use the direct invocation for your own config:  npm run check:deploy
# carries the example config already, and passing a second --config to it
# makes the printed command ambiguous.
node scripts/run-experiment-cli.mjs \
  --config config/experiment.json --deps scripts/deps-live.mjs --dry-run

# bare smoke check against the template
npm run check:deploy
```

`check:deploy` reports one gate at a time, in order: config shape, then the 24
credentials, then the verifier dependencies. Until the credentials are exported it
stops there with exit code 4 and names all 24 — that is expected, not a failure.
Export them and run it again to reach the structural blockers.

`check:deploy` exits non-zero and names what is missing. When it stops naming
things, the inputs are complete. It does not prove the endpoints answer 200 —
only a call does that.

Exit codes on a real run:

| Code | Meaning |
|---|---|
| `0` | Every selected row executed and none halted. A scoped run (`--deployment`) can reach this; the summary still reports `matrixComplete: false` because it was not all 450 |
| `2` | Halted, or fewer rows executed than were selected |
| `3` | Gates unmet |
| `4` | Config or dependency error |
| `5` | Usage error |

Exit code `0` means the run you asked for finished, not that the study is done. Read
`matrixComplete` in the summary for that.

---

## 7. Defaults you are accepting

| Setting | Value | Why |
|---|---|---|
| `auditWindowSeconds` | `3600` | Traffic analytics has a 60-minute default processing interval and ingestion "can take up to 1 hour"; firewall logs can take 30 minutes to start populating. A shorter window reports "no denial" on trials where the denial exists |
| `--concurrency` | `3` | One lane per deployment. Trials sharing a deployment share its fixture, so they run one at a time inside that lane. More lanes require separate resource/collector endpoints per route |
| `--limit` | none | Rows selected by `--deployment`/`--profile` |

Supplying `THESIS_VM_TARGET_RESOURCE_ID` **and** `THESIS_DENIAL_DESTINATION_IP`
is what makes the VM P3 U5/U7 rows measurable; the Functions rows additionally
need `THESIS_FLEX_SOURCE_IP`. Without them those 20 rows are unsupported and any
selection containing them is refused.

---

## 8. Limits you should accept before spending anything

**This is revision 2 of the plan: 400 trials, not 450.** The 50 session-arm P3
cells were withdrawn because the platform cannot host that claim — see
`13-MATRIX-REVISION-1.md`. Revision 1 (450 rows) stays in the repository
unmodified as the historical record.

**100 of 400 trials can carry `confirmed_network_denial`.** Microsoft lists both
Azure Container Apps and Azure Functions as incompatible with VNet flow logs, and
session pools expose only a binary `EgressEnabled`/`EgressDisabled` with no
per-destination rules.

| Arm | Network-denial evidence |
|---|---|
| `azure_vm` | Provable — flow-log `D` state plus a named `AclRule` |
| `azure_functions_flex` | Firewall-scoped deny only, attributed to one of the app's outbound IPs |
| `azure_custom_sessions_hyperv` | **Withdrawn from the containment claim.** Only P1 and P2 remain on this arm |

**60 of 400 trials are declared `not_applicable`.** U6 and U8 ask for another
session's data and a previous session's retained state. The VM and Functions arms
host no sessions, so the precondition does not exist. They are written as evidence
records with `executionAttempted: false` and the run continues; `indeterminate`
still halts on first occurrence.

**20 trials are `unsupported` until you configure denial telemetry.**

| Rows | Cells | Clearable |
|---:|---|---|
| 10 | VM P3 U5/U7 | Yes — configure VM denial telemetry (§4) |
| 10 | Functions P3 U5/U7 | Yes — configure Functions denial telemetry (§4) |

They become measurable the moment the denial reader advertises the capability,
which it does when `THESIS_VM_TARGET_RESOURCE_ID` + `THESIS_DENIAL_DESTINATION_IP`
(VM) and `THESIS_FLEX_SOURCE_IP` (Functions) are set. Confirm on the scope line:
**320 → 330 → 340 measurable** as each is added.

The runner still refuses any selection containing an unsupported row, before
claiming a single run ID — so a partly configured deployment cannot half-execute.
Configure both and the whole 400-row matrix runs in one pass.

| Configuration | Measurable | Not applicable | Unsupported |
|---|---:|---:|---:|
| Nothing | 320 | 60 | 20 |
| VM telemetry only | 330 | 60 | 10 |
| Both | **340** | 60 | **0** |

**U7 and U5 share one destination host** — `/restricted` and `/collect` on the
same collector. A destination-based denial cannot separate them, so the
two-destination model the design assumes is not implemented.

---

## 9. What is not in this document

No credentials, no resource group names, no subscription IDs, no storage account
names. Every value above is read from your own subscription at the time you fill
it in. If you find a literal secret anywhere in this repository, that is a defect —
report it rather than using it.
