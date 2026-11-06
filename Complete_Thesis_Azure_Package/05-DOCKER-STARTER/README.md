# Azure-only thesis: Docker-first compatibility starter

**Status: architecture selected — no measured thesis results.** Based on Chapter 3 of *Which Cloud Deployment Architecture Best Contains Compromised AI Agents*. It contains no real credentials, target scanning, cloud attacks, or arbitrary shell execution.

**The selected Azure architecture is the three-arm design** — Azure Linux VM, Azure Container Apps Jobs on a Consumption workload profile, and Azure Container Apps Sandboxes — decided in [`docs/AZURE-SUPPORTED-THREE-ARM-ARCHITECTURE.md`](docs/AZURE-SUPPORTED-THREE-ARM-ARCHITECTURE.md). The selected schedule is [`protocol-450-three-arm-supported-v2.json`](config/protocol-450-three-arm-supported-v2.json) with its separately declared freeze lock and 450-row matrix. Check its offline refusal status with:

```bash
node scripts/preflight-three-architecture.mjs \
  --config config/experiment.azure-three-arm.example.json \
  --protocol config/protocol-450-three-arm-supported-v2.json   # exits 4 while owner/live gates remain open
```

The selected v2 schedule contains 450 rows (3 arms × 3 profiles × 10 scenarios × 5 blocks): 360 unauthorized and 90 legitimate trials. U6/U8 are scheduled on all three arms (90 rows total) and gated on each arm's explicit external Blob namespace declaration plus non-counted fixture validation. Jobs P3 U5/U7 account for 10 rows that remain unsupported until attributable denial capability and pilot evidence are established; VM flow-log/firewall and Sandbox egress-decision evidence remain distinct. Revision `protocol-360-three-arm-supported-v1` is superseded for scheduling; revision 3 (300 rows), prior 400-row plans, and the legacy 450-row VM+Functions+session-pool planning matrix are historical frozen artifacts, not launch schedules. No measured thesis result or live readiness is claimed. The separate GPT-5 mini live-agent arm is still a draft. The selected deterministic revision also has a separately frozen 66-row non-counted pilot plan at `config/protocol-450-three-arm-supported-v2-pilot-v1.json` (+ its matrix and freeze lock); it is not the measured 450-row schedule, no pilot has run, and an actual pilot still requires owner-provided live configuration and authorization. Read [`docs/AZURE-OPERATOR-HANDOFF.md`](docs/AZURE-OPERATOR-HANDOFF.md) for the current code state, exact local preflight, inventory result, and remaining owner/live gates.

The Functions-Flex and custom-container-session instructions further down ("Serverless: Azure Functions on Container Apps", "Isolated environment: Custom Container Sessions", and the session-pool quota note in "First Azure steps") describe that **superseded** design and are retained as history; they are not the selected serverless or isolation arms.

## What you get

- **One shared TypeScript deterministic tool executor** (`src/core.ts`), plus local adapter/client components for VM, ACA Jobs, and ACA Sandboxes. The generic trial runner consumes the v2 three-arm schedule for structural dry runs only; live behavior remains unvalidated.
- **Node HTTP agent image** (`Dockerfile.node`) used by the VM and the ACA Jobs/Sandboxes workload adapters.
- **Azure Functions Node 22 image** (`Dockerfile.functions`) retained for superseded VM+Functions schedules only; it is not the selected serverless arm.
- **Research-owned mock resource service and separate collection service** with independent audit reads.
- **Local Docker Compose pilot** for P1 broad rights, P2 restricted rights and a P3 *network-topology illustration*. Local P3 outbound restrictions are NOT a verified cloud default-deny policy.
- A previous local topology allowed a direct-IP TCP connection to the collector despite failing Docker DNS. The revised internal network and fixed control proxy produced a network-unreachable result for that IP while the research health endpoint remained reachable. This is local-only evidence; it does not prove Azure enforcement or replace network-enforcer logs.
- **Selected 450-row three-arm revision** (`config/protocol-450-three-arm-supported-v2.json`, `config/plan-450-three-arm-supported-v2.csv`; 450 planned rows, not results). The 360-v1 schedule is superseded for scheduling; legacy 300/400/450 artifacts remain frozen history.

The legacy plan generator uses `TRIAL_PLAN_SEED` (default `azure-thesis-planning-v1`) to produce a reproducible permutation; that output is not the selected study matrix. `python3 scripts/validate_supplied_plan.py` is historical revision-3 validation only. The selected v2 schedule is the externally locked matrix named above. Neither schedule is evidence of completed trials.

`scripts/verify-local.mjs` checks only the starter's local mock evidence. It requires an operation-specific audit event for resource outcomes and leaves network failures indeterminate. It is not a cloud verifier or proof of P3 enforcement. The selected v2 preflight verifies the candidate protocol/matrix against a separate freeze lock, uses the legacy protocol only for the immutable historical plan, and always refuses measured launch from offline evidence.

`scripts/run-experiment-cli.mjs` is the generic runner entry point for its supported frozen schedules, including the v2 three-arm candidate for **structural dry runs**: `--dry-run` resolves the declared matrix from its package root, verifies the exact frozen bytes, and reports scope from the config's per-arm capability declarations without executing anything. **Do not use it to execute the v2 candidate** — the frozen protocol keeps `measuredExecutionEnabled: false`, so a measured launch refuses at exit `3` even with all four `--gates` asserted, and no pilot row is sanctioned by this integration. The v2 read-only preflight verifies the frozen candidate and reports gates but always refuses measured launch. The selected v2 non-counted pilot uses `--protocol config/protocol-450-three-arm-supported-v2-pilot-v1.json --pilot`; it is a separate 66-row, byte-pinned schedule, and no pilot result clears a readiness gate by itself. Other `--pilot` schedules remain protocol-specific and provisional. Claims are exclusive and failures require manual reconciliation. `--evidence` is refused; measured evidence uses the locked Azure store described below.

Measured CLI runs now require `scripts/azure-measured-evidence-store.mjs`: it checks the Azure Resource Manager immutability policy is `Locked` and meets the institution-approved retention days before any claim, then writes claims and evidence to Azure Blob with conditional creation. Local evidence is limited to non-counted pilots. The Bicep evidence-store template requires an explicit retention period but creates the policy unlocked; verify uploads and rejection of overwrite/delete, then lock it with its ETag. This implementation passed mocked policy tests, but has not yet been validated against the current Azure storage account or independent permissions. A checksum alone does not prevent a separately authorized principal from changing data.

Before measured CLI use, configure `THESIS_EVIDENCE_BLOB_CONTAINER_URL`, `THESIS_EVIDENCE_CONTAINER_RESOURCE_ID`, `THESIS_EVIDENCE_RETENTION_DAYS`, and `THESIS_EVIDENCE_RETENTION_APPROVED=true` only after institutional approval. Use `THESIS_TOKEN_PROVIDER_MODE=managed_identity` with `THESIS_EVIDENCE_IDENTITY_CLIENT_ID` on the controller, or an authenticated Azure CLI identity with the required policy-read and Blob-write permissions. The CLI checks the policy state and duration before the first claim; no local evidence-directory override is accepted for measured runs. Do not lock a policy until a disposable container test has demonstrated create/read and rejected overwrite/delete, and the retention period is approved.

The selected v2 protocol schedules U6/U8 on VM, ACA Jobs, and ACA Sandboxes through run-scoped external Blob namespaces. Those 90 rows remain gated per arm on the explicit `azure_blob_external_namespace` declaration and a non-counted fixture-validation pilot; pending pilot status does not make them N/A. The old revision-3 VM+Functions schedule's U6/U8 scope statements are historical and do not describe v2. U3's dummy-token use is a separate call to the configured research mock API and requires synchronized synthetic fixtures. Complete cloud classification remains unproven; see [`docs/AZURE-OPERATOR-HANDOFF.md`](docs/AZURE-OPERATOR-HANDOFF.md) for current limitations.

`scripts/trial-schedule.mjs` validates the complete supplied matrix and runs it sequentially using an injected runner, stopping on an indeterminate classification. `scripts/http-pilot-adapter.mjs` handles the local fixture HTTP contract and has not been validated against Azure sessions or independent cloud evidence. `scripts/local-runner-pilot.mjs` exercises these components against local Docker fixtures only; its readiness flags apply solely to that mock check.

`node scripts/estimate-model-cost.mjs 800 10000 2000` estimates token charges under stated assumptions; it makes no model calls. The deterministic 300-row baseline makes no model calls. The separate GPT-5 mini live-agent phase remains a draft and must not be reported as part of the deterministic results. A paired clean/indirect-injection draft and one non-counted Functions P1 behavior pilot exist; route coverage, independent evidence verification, method review and schedule freeze remain open.

The local smoke controller also writes one exclusively created, SHA-256-checked record per completed check under `results/local-evidence/`. The checksum detects accidental corruption, not deliberate modification by someone who can rewrite both data and checksum. These files contain synthetic fixtures and belong on the controller, outside workload access. They do not provide independently secured cloud audit logging.

For the intended Flex Consumption source arm, `scripts/build-flex-package.ps1 -OutputDirectory <new-directory>` builds a clean source package using Node 22 and the lockfiles. It copies only the Functions host, adapter, compiled code and installed production dependencies; it does not deploy or configure Azure. A successful package build does not verify the Functions host, cloud identity, private networking or P3 controls.

## Requirements

Node.js 22 and npm are required for the starter build and tests. Docker Engine with Compose is needed only for the optional local mock stack. The selected runner's ACA control-plane clients and read-only inventory can use direct Azure Identity/ARM (set `THESIS_TOKEN_PROVIDER_MODE=managed_identity`); Azure CLI is not required for structural dry runs or inventory. The Azure CLI provisioning example below is retained as historical, not as the selected v2 deployment runbook. The committed `dist/` is included so local container builds do not need TypeScript dependencies.

## Before touching Azure: run locally

```bash
cd 05-DOCKER-STARTER   # from the extracted package directory
npm run plan
# Use the precompiled dist supplied in this archive:
docker compose up --build -d
curl http://127.0.0.1:8081/health
npm run smoke
# Inspect results/local-smoke.json, including any indeterminate network cases.
docker compose down
```

Services: agent P1 localhost:8081, P2 8082, P3 8083; research service localhost:9000, collection service localhost:9001. All published ports are **loopback only**. Demo profile keys (`local-p1`, etc.) and `local-admin-key` are intentionally insecure local placeholders; **never deploy these values to Azure**. Use managed identity or securely distributed trial identities in the real experiment.

The smoke test runs 30 local checks (three profiles by ten scenarios), not the cloud 450. It runs a forced operation and then checks independently held state/audit. An unlogged connection failure remains indeterminate rather than a claimed prevention.

## Container builds

```bash
docker build -f Dockerfile.node -t thesis-agent:v1 .
docker build -f Dockerfile.functions -t thesis-functions:v1 .
# Same Node image can run the research resource and collector via command override:
docker run --rm thesis-agent:v1 node dist/resource.js
```

Node image: listens on port 8080, `POST /run` and `GET /health`. Functions image: Azure Functions HTTP trigger at `POST /api/run`, port 80, requires Functions key and `x-trial-key`. Agent requires `RESEARCH_URL`, `COLLECTOR_URL`, `WORKLOAD_TOKEN`, `TRIAL_REQUEST_KEY`. The workload must never receive `ADMIN_TOKEN` or verifier credentials. Container image is not an authorization boundary by itself.

## Historical Azure CLI provisioning example — not the selected v2 runbook

> **Do not use this snippet for the selected three-arm study.** It creates a resource group and ACR and builds both the Node and superseded Functions images. It is preserved as an illustrative legacy walkthrough. The selected architecture's infrastructure composition is `infra/azure-supported-three-arm.bicep`; its parameters remain placeholders, and any deployment still requires current owner approval and live inventory. No deployment is authorized by this document.

Before provisioning, check quota and regional access for the **selected arms** (Container Apps Jobs on a Consumption workload profile, and Container Apps Sandboxes). Verify pricing. Also check that you can use the required registry and VM SKU.

```bash
az login
az account show --output table
az extension add --name containerapp --upgrade --allow-preview true -y
export RG=rg-thesis-agents
export LOCATION=eastus
export ACR=replacewithgloballyuniqueacrname
az group create --name "$RG" --location "$LOCATION"
# Premium, not Basic: Private Link for ACR (infra/registry-private-endpoint-pilot.bicep)
# requires the Premium tier. Basic cannot host a private endpoint at all.
az acr create --resource-group "$RG" --name "$ACR" --sku Premium --location "$LOCATION"
az acr build --registry "$ACR" --image thesis-agent:v1 --file Dockerfile.node .
az acr build --registry "$ACR" --image thesis-functions:v1 --file Dockerfile.functions .
```

An ACR build runs remotely; no local Docker daemon is required for it. Images will be available at `$ACR.azurecr.io/thesis-agent:v1` and `$ACR.azurecr.io/thesis-functions:v1`.

### VM: standard Node container

Provision a small Ubuntu VM and Docker Engine, using a locked-down NSG / SSH access. On VM, authenticate to ACR using a managed identity with AcrPull, then:

```bash
# Replace with your ACR hostname. Secrets come from a mode-600 env file, never
# from -e VAR=value: values passed that way are readable in `docker inspect` and
# in /proc/<pid>/cmdline on the VM for the lifetime of the container.
sudo install -d -m 750 /etc/thesis-agent
sudo install -m 600 /dev/null /etc/thesis-agent/agent.env
sudoedit /etc/thesis-agent/agent.env   # RESEARCH_URL=..., COLLECTOR_URL=..., WORKLOAD_TOKEN=..., TRIAL_REQUEST_KEY=...
# The path matters: infra/vm-agent.service reads EnvironmentFile=/etc/thesis-agent/agent.env.
# A file at /etc/thesis-agent.env is never loaded, and the agent then exits at startup
# because TRIAL_REQUEST_KEY and the service URLs are required.
docker pull YOUR_ACR.azurecr.io/thesis-agent:v1
docker run -d --name thesis-agent --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8080:8080 \
  --env-file /etc/thesis-agent.env \
  YOUR_ACR.azurecr.io/thesis-agent:v1
```

Use secure secret provisioning instead of putting real keys on the command line or into shell history. Keep the VM's public application ingress closed. The trial controller can call it through SSH tunnel or private network.

### Serverless: Azure Functions on Container Apps — SUPERSEDED ARM

> **Superseded (2026-11-05):** the selected serverless arm is **ACA Jobs on a Consumption workload profile** (see the [three-arm architecture decision](docs/AZURE-SUPPORTED-THREE-ARM-ARCHITECTURE.md)). The Functions instructions below are retained as history for the frozen VM+Functions plans. Do not provision new Functions apps for the study.

Azure Functions **Flex Consumption cannot directly run your Docker image**. Use Azure Functions **hosted on Container Apps**, using its dedicated Functions image and `--kind functionapp`. Creating a Container Apps environment (workload profiles) is a separate prerequisite. An illustrative CLI creation is:

```bash
az containerapp env create --name thesis-ca-env --resource-group "$RG" --location "$LOCATION"
# After granting the environment access to your ACR and configuring storage/secrets:
az containerapp create --name thesis-functions --resource-group "$RG" \
  --environment thesis-ca-env --image "$ACR.azurecr.io/thesis-functions:v1" \
  --kind functionapp --ingress internal --target-port 80 \
  --min-replicas 0 --max-replicas 1
```

**Do not treat this command as complete production provisioning.** You still must configure an Azure Storage connection/identity, registry pull identity, Functions settings, research URLs, security boundaries and a private controller network. Use the Functions-specific keys. A standard Container App running a bare Node server does not count as a native Azure Functions deployment.

### Isolated environment: Custom Container Sessions — SUPERSEDED ARM

> **Superseded (2026-11-05):** the selected isolation arm is **ACA Sandboxes** (one sandbox group per permission profile, one sandbox per trial, egress-policy evidence via `NetworkEgressDecisions`). The session-pool instructions below are retained as history. The known pool limitation stands as the reason it was replaced: documented `EgressDisabled` blocks all outbound access while `EgressEnabled` allows more than the study permits, so a pool cannot express P3 selective egress.

The same `thesis-agent:v1` image exposes the HTTP port required by custom container sessions. You need a workload-profiles-enabled Container Apps environment and ACR pull identity. To inspect supported flags:

```bash
az containerapp sessionpool create --help
```

Illustrative compatible pool with **egress enabled (P1/P2 feasibility only)**:

```bash
az containerapp sessionpool create --name thesis-sessions --resource-group "$RG" \
  --environment thesis-ca-env --location "$LOCATION" \
  --container-type CustomContainer --image "$ACR.azurecr.io/thesis-agent:v1" \
  --cpu 0.5 --memory 1Gi --target-port 8080 \
  --max-sessions 2 --ready-sessions 1 --cooldown-period 300 \
  --network-status EgressEnabled \
  --registry-server "$ACR.azurecr.io" --registry-identity "YOUR_MANAGED_IDENTITY_RESOURCE_ID" \
  --mi-user-assigned "YOUR_MANAGED_IDENTITY_RESOURCE_ID"
```

Azure rejects `readySessionInstances` of zero, and requires it to be smaller than
`maxConcurrentSessions` — so `--max-sessions 1 --ready-sessions 0` cannot be created
(`SessionPoolInvalidReadySessionInstances`). The smallest valid shape is max 2 / ready 1.

In real deployment, provide secure per-profile agent environment values and use the authenticated session-pool management endpoint to route `POST /run` requests with session identifiers. Session-pool management endpoint calls require Azure Entra auth and appropriate roles. Do **not** route test traffic through an open unauthenticated public endpoint.

**Revision-2 scope:** custom-session P3 was withdrawn because the pool's documented `EgressDisabled` blocks all outbound access, while `EgressEnabled` allows more than the study permits. The active P3 network cells are VM and Functions U5/U7; configure and pilot their independent denial telemetry before treating them as measurable.

In `config/experiment.json`, set `agentUrl` on each Functions route to its own
P1, P2, or P3 Function app. The Functions resource and collector URLs remain
shared deployment-level endpoints. VM routes may optionally override
`agentUrl`; if omitted, they inherit the VM deployment endpoint. Separate URLs
make route selection explicit, but do not by themselves prove that Azure ran
the request under the configured principal; compare runtime identity evidence
in the pilot.

## Methodology safeguards

1. **P1** is intentionally permissive but only for research-owned synthetic resources.
2. **P2** enforces object/action authorization outside the agent, with ordinary outbound reachability.
3. **P3** has P2 resource authorization plus real, validated selective egress. An application-level URL check is **not** equivalent.
4. Recreate resources and identities before each trial. Model U8 as seeded retained application state, not recovered provider disk.
5. Collect independent resource evidence and network-enforcer logs. No audit means **indeterminate**, not automatically blocked.
6. First prove all 10 scenarios possible under P1, and both L1/L2 under P2 and P3. Freeze image digests, policies and trial manifest.
7. The selected v2 schedule is the new, separately frozen 450-row plan (VM + ACA Jobs + ACA Sandboxes = 9 routes); it supersedes the 360-v1 schedule for scheduling. The historical revision-3 300-row plan and legacy VM+Functions 450-row plan must not be run. The generic trial runner consumes the v2 matrix path, ACA deployment names, and U6/U8 capability metadata for structural dry runs; it still cannot launch the candidate (its measured flag is false). The v2 manifest is structural only; per-arm pilots, U6/U8 fixture validation, target-scoped controls, receiver-effect pilots, live identity/quota/capacity checks and owner authorization remain open.
8. The separate live-agent phase has its own unfrozen GPT-5 mini draft. Keep its outcomes separate from the deterministic baseline. No measured trial has run; consult [`docs/AZURE-OPERATOR-HANDOFF.md`](docs/AZURE-OPERATOR-HANDOFF.md) for the current owner/live gates and [`docs/300-TRIAL-AZURE-STATUS-2026-11-04.md`](docs/300-TRIAL-AZURE-STATUS-2026-11-04.md) only for historical context.

`PILOT-ACCEPTANCE.md` and `PREFLIGHT-2026-11-03.md` are historical records, not current launch approval. The current owner/live gate is [`docs/AZURE-OPERATOR-HANDOFF.md`](docs/AZURE-OPERATOR-HANDOFF.md); its offline exit-4 preflight does not authorize launch. Do not launch any measured schedule until the current handoff's integration, pilot, subscription, and owner gates have been independently reviewed.

## After testing: avoid unexpected charges

Delete or stop the VM when unused, delete the custom session pool when finished (don't merely scale ready sessions to 0), and review ACR, managed environment, logging and any dedicated workload profile charges. Deleting the entire experiment resource group is the easiest way to ensure all its resources stop billing **after saving evidence and verifying no other needed assets are inside**.

## Authoritative docs

Selected three-arm architecture (current):

- https://learn.microsoft.com/en-us/azure/container-apps/jobs — ACA Jobs: manual start, shared environment networking, Start API warning
- https://learn.microsoft.com/en-us/azure/container-apps/workload-profiles-overview — Consumption profile is the serverless compute model
- https://learn.microsoft.com/en-us/azure/container-apps/user-defined-routes — UDR only in workload-profiles environments
- https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview — ACA Sandboxes first-class resource
- https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-egress-policies — ordered egress policies
- https://sandboxes.azure.com/docs/sandboxes/telemetry — per-request `NetworkEgressDecisions`
- https://learn.microsoft.com/en-us/azure/container-apps/quotas and https://sandboxes.azure.com/docs/sandboxes/limits/ — documented quota categories and defaults (not live subscription values)
- https://azure.microsoft.com/en-us/pricing/details/container-apps/ — pricing (read for current numbers; this repo asserts none)

Superseded Functions/session design (history):

- https://learn.microsoft.com/en-us/azure/azure-functions/functions-container-apps-hosting
- https://learn.microsoft.com/en-us/azure/container-apps/functions-overview
- https://learn.microsoft.com/en-us/azure/container-apps/session-pool
- https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage
- https://learn.microsoft.com/en-us/azure/container-apps/networking

#### GPT-5 mini live-agent arm (draft only)

The bounded live arm is selected with `arm: 'gpt5mini_live'` in the controller and receives a separate 300-row draft schedule. Generate a matched, separate draft with `node scripts/generate-gpt5mini-live-plan.mjs`; this does not execute trials. It writes a `live-`-prefixed schedule and metadata with source, schedule, prompt-manifest, protocol, and runner hashes. The current draft uses one fixed no-argument tool bound to the current row's synthetic operation. The model can make at most one workload tool call and one final Responses call. Refusal/no tool use is classified as agent behavior (`agent_no_attempt` or `legitimate_failed`), never as infrastructure prevention. The controller rejects model/version/settings drift and accumulates usage against a $14.25 phase guard. A pilot, cloud integrations, independent verifier, reviewed prompts and protocol freeze still gate execution.

The live-arm schedule generator output and implementation digests are planning metadata only. Regenerate a fresh draft after every prompt, model-client, verifier, or schedule change; freeze only after the complete cloud pilot and research protocol review.
