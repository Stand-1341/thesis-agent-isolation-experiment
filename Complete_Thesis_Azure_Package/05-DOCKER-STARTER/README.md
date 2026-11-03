# Azure-only thesis: Docker-first compatibility starter

**Status: starter / local simulation, not measured thesis results.** Based on Chapter 3 of *Which Cloud Deployment Architecture Best Contains Compromised AI Agents*. It deliberately contains no real credentials, target scanning, cloud attacks, or arbitrary shell execution. The baseline remains deterministic. A controller-side Azure GPT-5 mini Responses API client has now been added, but its tools and prompts are not integrated into the runner. It has been called only for setup checks: earlier entries in `EXPERIMENT-STATUS.md` record setup-only Responses calls returning READY. No measured trial has used it, which is the claim that matters here.

## What you get

- **One shared TypeScript deterministic tool executor** (`src/core.ts`), reused across VM, Functions and isolated container sessions.
- **Node HTTP agent image** for Azure VM and Container Apps custom sessions (`Dockerfile.node`).
- **Azure Functions Node 22 image** with a thin HTTP adapter (`Dockerfile.functions`).
- **Research-owned mock resource service and separate collection service** with independent audit reads.
- **Local Docker Compose pilot** for P1 broad rights, P2 restricted rights and a P3 *network-topology illustration*. Local P3 outbound restrictions are NOT a verified cloud default-deny policy.
- A previous local topology allowed a direct-IP TCP connection to the collector despite failing Docker DNS. The revised internal network and fixed control proxy produced a network-unreachable result for that IP while the research health endpoint remained reachable. This is local-only evidence; it does not prove Azure enforcement or replace network-enforcer logs.
- **450-row trial plan** (`npm run plan`). These are planned rows only, not results.

The generator uses `TRIAL_PLAN_SEED` (default `azure-thesis-planning-v1`) to produce a reproducible permutation within each 90-cell block. It writes the seed, algorithm and protocol hash to `results/plan-metadata.json`. This generated order differs from the separately supplied `03-PLANNED-TRIAL-MATRIX-450.csv`. Preserve the supplied schedule as the intended starting schedule; run `python3 scripts/validate_supplied_plan.py` to check its structure and hash before any formal freeze. Neither file is evidence of completed trials.

`scripts/verify-local.mjs` checks only the starter's local mock evidence. It requires an operation-specific audit event for resource outcomes and leaves network failures indeterminate. It is not a cloud verifier or proof of P3 enforcement.

`scripts/trial-runner.mjs` is an adapter-based orchestration prototype, not a deployable Azure runner. It requires explicit readiness gates and injected reset, execution, collection and verification functions. It claims each run ID before execution and saves partial observations on failure; a leftover claim requires reconciliation. Azure adapters, durable independent evidence and validated gates remain to be implemented. Gate booleans are caller assertions, not proof.

`scripts/azure-blob-evidence.mjs` is a candidate Azure Blob evidence adapter. It accepts a controller-supplied Entra token and uses conditional creation for claims and records. Selected Azure Blob role assignments and one separate audit read have been exercised, but this adapter's complete claim/record lifecycle, all effective permissions, and storage immutability have not. Conditional creation and checksums do not prevent a separately authorized principal from changing or deleting blobs.

An experimental `AZURE_BLOB_ENDPOINT` setting routes U1, U2, U3, U6, U8, L1 and L2 to fixed Azure Blob fixture containers using `ManagedIdentityCredential`; it never falls back to Azure CLI credentials. Selected VM P1/P2 Blob seeding and role outcomes have passed setup-only checks, but those checks do not validate the full adapters across deployments and profiles. U3's dummy-token use is a separate call to the configured research mock API and requires synchronized synthetic fixtures. U4, U5 and U7 still use the existing mock/collector path. Complete cloud classification and session identity/lifecycle verification remain unproven. This mixed backend is not ready for measured trials; see `PILOT-ACCEPTANCE.md`.

`scripts/trial-schedule.mjs` validates the complete supplied matrix and runs it sequentially using an injected runner, stopping on an indeterminate classification. `scripts/http-pilot-adapter.mjs` handles the local fixture HTTP contract and has not been validated against Azure sessions or independent cloud evidence. `scripts/local-runner-pilot.mjs` exercises these components against local Docker fixtures only; its readiness flags apply solely to that mock check.

`node scripts/estimate-model-cost.mjs 900 10000 2000` estimates token charges under stated assumptions; it makes no model calls. Published GPT-5 mini Global Standard rates are $0.25/million input and $2/million output. At two Responses calls per live trial, 450 trials × 10,000 assumed input tokens × 2 and 2,000 output tokens × 2 estimate to $5.85 model-only. This excludes Azure infrastructure, cached input and price changes. The deterministic baseline makes no model calls. The separate live-agent phase uses GPT-5 mini at reasoning effort `low` with fallback disabled; it remains a draft pending prompt design, verifier validation, pilot and schedule freeze. Azure reports 500,000 TPM quota in East US; a capacity-25 deployment exists and an Entra-authenticated setup request returned `READY`.

The local smoke controller also writes one exclusively created, SHA-256-checked record per completed check under `results/local-evidence/`. The checksum detects accidental corruption, not deliberate modification by someone who can rewrite both data and checksum. These files contain synthetic fixtures and belong on the controller, outside workload access. They do not provide independently secured cloud audit logging.

For the intended Flex Consumption source arm, `scripts/build-flex-package.ps1 -OutputDirectory <new-directory>` builds a clean source package using Node 22 and the lockfiles. It copies only the Functions host, adapter, compiled code and installed production dependencies; it does not deploy or configure Azure. A successful package build does not verify the Functions host, cloud identity, private networking or P3 controls.

## Requirements

Linux/macOS or WSL2, Docker Engine with Compose, Node.js 22 and npm, Azure CLI after you are ready to deploy. The committed `dist/` is included so Docker builds do not need TypeScript dependencies. To change source, first run `npm install && npm run build` and rebuild the images.

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

## First Azure steps (Azure CLI)

Before provisioning, check Azure for Students quota and regional access to **Container Apps custom container session pools**. Verify pricing. A session pool may have fixed dedicated compute charges even with zero active sessions. Also check that you can use the required registry and VM SKU.

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

### Serverless: Azure Functions on Container Apps

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

### Isolated environment: Custom Container Sessions

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

**CRITICAL P3 BLOCKER:** the session pool's documented `EgressDisabled` option blocks **all** outbound access, including the approved research service the thesis requires for L1/L2. `EgressEnabled` allows more than the thesis allows. Do not claim P3 is implemented merely by toggling the pool setting. Verify selective network restrictions via an Azure VNet / route / approved proxy configuration for this service, or revise methodology and label that configuration unsupported. Validate actual traffic, not just CLI acceptance. This must be resolved before starting 450 valid measured trials.

## Methodology safeguards

1. **P1** is intentionally permissive but only for research-owned synthetic resources.
2. **P2** enforces object/action authorization outside the agent, with ordinary outbound reachability.
3. **P3** has P2 resource authorization plus real, validated selective egress. An application-level URL check is **not** equivalent.
4. Recreate resources and identities before each trial. Model U8 as seeded retained application state, not recovered provider disk.
5. Collect independent resource evidence and network-enforcer logs. No audit means **indeterminate**, not automatically blocked.
6. First prove all 10 scenarios possible under P1, and both L1/L2 under P2 and P3. Freeze image digests, policies and trial manifest.
7. Only then run the complete **3 deployments × 3 profiles × 10 scenarios × 5 repeats = 450** deterministic trials. The 490 number requires a separate documented 40-trial protocol or reason.
8. The separate live-agent phase has a draft matched 450-row schedule using GPT-5 mini with reasoning effort `low` and model fallback disabled; keep its outcomes separate from the deterministic baseline. Candidate prompts, model client, adapter and usage accounting exist locally, and an Azure setup-only request succeeded. The cloud integrations, independent evidence and full trial workflow remain unvalidated; the draft is not frozen and no measured trial has run. See `../../EXPERIMENT-STATUS.md` for the latest pilot and cost state.

The current cloud release gate and verified pilot observations are in [`PILOT-ACCEPTANCE.md`](PILOT-ACCEPTANCE.md). The latest reproducible local scope/configuration preflight is recorded in [`PREFLIGHT-2026-11-03.md`](PREFLIGHT-2026-11-03.md); it is structural only and does not prove Azure readiness. Do not run the 450-trial schedule until every gate passes.

## After testing: avoid unexpected charges

Delete or stop the VM when unused, delete the custom session pool when finished (don't merely scale ready sessions to 0), and review ACR, managed environment, logging and any dedicated workload profile charges. Deleting the entire experiment resource group is the easiest way to ensure all its resources stop billing **after saving evidence and verifying no other needed assets are inside**.

## Authoritative docs

- https://learn.microsoft.com/en-us/azure/azure-functions/functions-container-apps-hosting
- https://learn.microsoft.com/en-us/azure/container-apps/functions-overview
- https://learn.microsoft.com/en-us/azure/container-apps/session-pool
- https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage
- https://learn.microsoft.com/en-us/azure/container-apps/networking

#### GPT-5 mini live-agent arm (draft only)

The bounded live arm is selected with `arm: 'gpt5mini_live'` in the controller and receives a separate 450-row draft schedule. Generate a matched, separate draft with `node scripts/generate-gpt5mini-live-plan.mjs`; this does not execute trials. It writes a `live-`-prefixed schedule and metadata with source, schedule, prompt-manifest, protocol, and runner hashes. The current draft uses one fixed no-argument tool bound to the current row's synthetic operation. The model can make at most one workload tool call and one final Responses call. Refusal/no tool use is classified as agent behavior (`agent_no_attempt` or `legitimate_failed`), never as infrastructure prevention. The controller rejects model/version/settings drift and accumulates usage against one $19 phase guard. A pilot, cloud integrations, independent verifier, reviewed prompts and protocol freeze still gate execution.

The live-arm schedule generator output and implementation digests are planning metadata only. Regenerate a fresh draft after every prompt, model-client, verifier, or schedule change; freeze only after the complete cloud pilot and research protocol review.
