# Deploy it yourself

A checklist of exactly what you need, in the order you need it, so you can stand up the
cloud side without anyone else's help.

Two paths. **Do Path A first.** It is cheap, it proves the part most likely to be broken,
and Path B depends on facts Path A establishes.

| | Path A — one sandbox | Path B — full three-arm composition |
| --- | --- | --- |
| What it creates | 1 resource group, 1 sandbox group, 1 role assignment | VNet, subnets, ACA environment, optional VM / firewall / storage / sandbox groups |
| Needs a container registry | No | Yes |
| Needs the Bicep parameter file | No | Yes |
| Cost | Cents | Real money, and it runs until you delete it |
| Proves | sandbox data plane, egress telemetry, teardown | nothing on its own — see `PRE-DEPLOYMENT-BUILD-PLAN.md` |

---

## 0. What you need before anything

**Access**
- An Azure subscription where you can create resource groups.
- Rights to create role assignments at resource-group scope (Owner, or User Access
  Administrator plus Contributor). Path B may need subscription scope if
  `createRecordUpdateRole` is involved.
- The subscription ID and tenant ID. Neither is recorded anywhere in this repository.

**Tools**
- A browser. That is genuinely enough for Path A.
- For Path A from a terminal: Python 3.10+ and `uv`. No `az` needed.
- For Path B: Azure CLI (`az`), and Bicep CLI `0.48.1` (pinned by
  `docs/AZURE-OPERATOR-HANDOFF.md` §8 with release URL and SHA-256).

**This repository**
- Clone it, then `cd Complete_Thesis_Azure_Package/05-DOCKER-STARTER`.
- `npm install` — needed for `npm run azure:inventory` and `npm run sandbox:first-light`.

---

## 0.5 If the subscription is brand new

A fresh subscription is a different obstacle course from an established one. Four things
behave differently, and three of them fail in ways that look like a broken template.

**`centralus` is supported — but nothing in this repository points at it.** ACA Sandboxes is
available in 40 regions including `centralus`, `eastus`, `eastus2`, `westus2` and `westus3`.
It is **not** in Azure Government, Azure China, or Azure Germany. A sandbox group is bound to
one region and snapshots do not move between regions.

Every shipped example is pinned to Eastern US, so if you are deploying to `centralus` you
must change these yourself. They are not merely cosmetic:

| File | Current | What to do |
| --- | --- | --- |
| `infra/azure-supported-three-arm.parameters.example.json` | `"location": "eastus"` | Set to `centralus` in **your** parameter copy |
| `config/experiment.azure-three-arm.example.json` | `deployments.azure_container_apps_sandboxes.region: "eastus2"` | Set to `centralus` to match where the sandbox groups actually are |
| `config/experiment.450-three-architecture.example.json` | three `region: "eastus"` entries | Only if you use this superseded config |
| `infra/controller-vm-pilot.parameters.example.json` | `"location": "eastus"` | Only if you use the controller-only template |

The config validator checks that a deployment region is a well-formed region slug. It does
**not** check that it matches reality, so a stale `eastus2` will pass validation and then
send data-plane calls to a region where you have no sandbox group. That surfaces as a 404
or a confusing 401, not as a config error.

**Do not deploy `infra/vm-p3-centralus-pilot.bicep` on a new account.** Despite the name, it
is a Central US *spoke* that routes all hub, research and internet traffic through an
**existing East US Azure Firewall** — its defaults name `vnet-thesis-pilot-eus` and
`thesis-p3-fw`. Those belong to a different subscription. On a clean account it will fail on
missing resources, and it is deliberately excluded from the three-arm composition.

**Every resource provider will read `NotRegistered`.** That is normal for a new
subscription and it is not a fault. Most providers register automatically on first
deployment, but check before blaming the template:

```sh
AZURE_DEVICE_CODE_AUTH=1 AZURE_SUBSCRIPTION_ID=<guid> AZURE_REGION=<region> npm run azure:inventory
```

Look at `providerRegistration`. The inventory deliberately does **not** auto-register
anything — it is a read-only tool. If `Microsoft.App` is still `NotRegistered` after a
deployment attempt, that is your first error, and it is not the Bicep's fault.

**Pay-as-you-go defaults are lower than enterprise, and quota is only one of three gates.**
Azure publishes no single guaranteed default, but a new pay-as-you-go subscription commonly
lands in the 10–20 vCPU per region range rather than the ~350 that Enterprise Agreement
subscriptions default to. Two tiers apply independently: total regional vCPUs, and vCPUs
per VM family.

Your three-arm plan is small — `Standard_F1as_v7` is 1 vCPU, so a controller plus a P3
target is 2 — which fits comfortably inside a fresh PAYG allocation. The risk is not the
CPU count, it is the other two gates:

Azure evaluates three separate things and **all three** must pass: quota (your permission to
request), capacity (hardware actually present in that region and zone), and SKU restriction
(your offer type may not be allowed that VM family *at all*, even with quota free).

This is why `vmVmSize` in the parameter file (`Standard_F1as_v7`) is a genuine risk on a
new account even if the region is healthy. If the VM arm fails to deploy with a SKU or
offer error, that is not a template bug — pick an available size. Check what your
subscription can actually see before editing the parameter file:

```sh
az vm list-skus --location centralus --resource-type virtualMachines \
  --query "[?name=='Standard_F1as_v7'].{name:name, restrictions:restrictions}" -o json
```

An empty `restrictions` array means the offer type allows it; any entries mean it is blocked
for reasons that have nothing to do with quota.

**Sandbox quota is 300 concurrent active cores per region per subscription** by default,
plus 100,000 sandboxes per group and an API rate limit of 3,000 requests per minute. Your
study does not approach this (an M sandbox is 1 core, so 300 concurrent sandboxes before
you hit the ceiling), but check rather than assume:

```sh
AZURE_DEVICE_CODE_AUTH=1 AZURE_SUBSCRIPTION_ID=<guid> AZURE_REGION=<region> npm run azure:inventory
```

The `Microsoft.App` regional usage in that output **is** the Sandbox Cores quota — it is
the same endpoint the vendor documentation points you at
(`/providers/Microsoft.App/locations/{region}/usages?api-version=2024-03-01`). One command
covers it.

### Reserved address ranges — read this before designing the network

Two IPv4 ranges are reserved for sandbox internal networking:

| Range | Addresses |
| --- | --- |
| `192.168.0.0/24` | `192.168.0.0` – `192.168.0.255` |
| `100.65.0.0/23` | `100.65.0.0` – `100.65.1.255` |

Anything sandboxes must reach through a VNet connection cannot live in those ranges —
including private endpoints, private container registries, custom DNS servers, resources
over peering, and on-premises connectivity.

**This is the nastiest failure mode in the whole setup:** a VNet connection can provision
successfully and requests to those addresses still fail. An egress allow rule does not
remove the restriction.

The example parameter plan uses `10.48.x.x`, which does not overlap, so it is safe as
written. Do not "tidy" it toward `192.168.x.x`, and do not use `100.64.0.0/10` for anything.

### If this is a free-trial offer

Some services and SKUs cannot be deployed at all on trial offers, independent of quota.
And the cost model punishes leaving things up: `deployP3Firewall` brings Azure Firewall
plus two public IPs plus policy plus route tables, billed hourly for as long as it exists.
On trial credit that is a fast way to spend the whole balance on an idle network appliance.

Start with Path A. It costs cents and it tells you whether the sandbox surface works on
this account before you commit a credit balance to it.

---

## 1. Learn your own subscription (free, read-only)

Do this first. It tells you which region has capacity, what is already deployed, and
whether your quota can hold the study. Nothing is created.

```sh
cd Complete_Thesis_Azure_Package/05-DOCKER-STARTER
npm install
AZURE_DEVICE_CODE_AUTH=1 npm run azure:inventory
```

It prints a sign-in URL and a one-time code. Open it anywhere, sign in, and it lists the
subscriptions your account can see. Then pick one and read it:

```sh
AZURE_DEVICE_CODE_AUTH=1 AZURE_SUBSCRIPTION_ID=<guid> AZURE_REGION=eastus npm run azure:inventory
```

Exit `0` gives you resources, provider registration states, and regional quota. Exit `2`
means partial — a region or provider read failed, read the payload. Exit `4` is identity.

Keep the JSON. `providerRegistration` and regional usage are two of the owner inputs the
study needs and cannot invent.

---

## 2. Path A — one real sandbox

### 2a. Create the resource group and sandbox group

**Fastest, and the one that verifies itself — the `aca` CLI.** It runs on top of `az login`
and `sandboxgroup create` attempts to grant your signed-in user the Data Owner role for you.

```sh
curl -fsSL https://aka.ms/aca-cli-install | sh
az login
SUB=$(az account show --query id -o tsv)
az group create --name <your-rg> --location <region>
aca sandboxgroup create -g <your-rg> --name <your-sandbox-group> \
  --location <region> -s "$SUB" --set-config
aca doctor
```

`aca doctor` is the cheapest possible pre-flight: it tells you whether data-plane access
actually resolves before you spend anything. **Run it before step 2c.** If it reports
missing access, the role assignment has not propagated — or `sandboxgroup create` could
not grant it, in which case do it manually (below).

**Or portal.** Open [sandboxes.azure.com/sandbox-groups](https://sandboxes.azure.com/sandbox-groups),
select **Create**, choose your subscription, a resource group, a name, and a region.
Copy the name you chose; you need it in step 2c.

**Or terminal**, using the official Python SDK exactly as the vendor quickstart shows:

```sh
uv venv && uv pip install azure-containerapps-sandbox azure-mgmt-resource azure-mgmt-authorization
```

```python
import os, uuid
from azure.identity import DefaultAzureCredential
from azure.mgmt.resource import ResourceManagementClient
from azure.mgmt.authorization import AuthorizationManagementClient
from azure.containerapps.sandbox import SandboxGroupManagementClient

credential = DefaultAzureCredential()
sub  = os.environ["AZURE_SUBSCRIPTION_ID"]
rg   = os.environ["AZURE_RESOURCE_GROUP"]
group= os.environ["AZURE_SANDBOX_GROUP"]
region = os.environ["AZURE_REGION"]

ResourceManagementClient(credential, sub).resource_groups.create_or_update(rg, {"location": region})
SandboxGroupManagementClient(credential, subscription_id=sub, resource_group=rg).create_group(group, location=region)

ROLE = "c24cf47c-5077-412d-a19c-45202126392c"  # Container Apps SandboxGroup Data Owner
scope = f"/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.App/sandboxGroups/{group}"
AuthorizationManagementClient(credential, sub).role_assignments.create(
    scope=scope, role_assignment_name=str(uuid.uuid4()),
    parameters={"properties": {
        "roleDefinitionId": f"/subscriptions/{sub}/providers/Microsoft.Authorization/roleDefinitions/{ROLE}",
        "principalId": os.environ["AZURE_PRINCIPAL_ID"],
        "principalType": "User"}})
```

### 2b. Wait, then verify

**Role assignments take 30 to 60 seconds to propagate.** A 403 right after assigning is
expected, not a failure.

### 2c. Run first light

```sh
AZURE_SUBSCRIPTION_ID=<guid> AZURE_REGION=eastus AZURE_DEVICE_CODE_AUTH=1 \
  npm run sandbox:first-light -- \
  --execute \
  --resource-group <your-rg> \
  --sandbox-group <your-sandbox-group> \
  --probe-url https://example.com \
  --out first-light.json
```

`--execute` is mandatory. Without it the command only validates inputs and exits `5` —
that is deliberate, because this creates billable resources.

**Read the exit code before you read the JSON.**

| Exit | Meaning |
| --- | --- |
| `0` | Chain ran and at least one egress decision came back. Best case. |
| `2` | Chain ran but attributed no evidence. Look at `observation.dimensions.observability`. |
| `3` | Created, but execute / egress read / delete failed. **Check the sandbox is gone.** |
| `4` | Identity failure. Nothing was created. |
| `5` | Usage error. |

### 2d. What a good run looks like

In `first-light.json`:
- `chain.confirmed: true` — created, executed, read, deleted.
- `egress.decisionCount` greater than 0 and `egress.attributable: true`.
- `observation.dimensions.observability.status: "observed"`.
- `observation.dimensions.containment.status: "unobserved"` — correct. One sandbox running
  `curl` proves nothing about containment, and the record says so instead of flattering you.

If `observability` is `unobserved` while the chain completed, you have a working sandbox
with an unproven sensor. That is a real result, not a failure — but it is not evidence, and
it happens when no `telemetryConfig` was supplied. See
`PRE-DEPLOYMENT-BUILD-PLAN.md` §8.1.

### 2e. If it 401s

The data-plane audience is `https://dynamicsessions.io/.default`. That is the Dynamic
Sessions audience and it looks wrong for the Sandboxes plane, and it is correct: the vendor
SDK hardcodes it. `scripts/sandbox-data-plane-contract.test.mjs` pins it. Do not "fix" it.

The audience is recorded in every observation record as `dataPlaneAudience`, so check that
value before assuming something else broke. Then check the role assignment propagated, and
that the region you used actually has the sandbox service.

---

## 3. Path B — the full composition

Only after Path A works and §1 tells you the region has quota.

### 3a. Build and pin the image

There is no registry yet, and the template wants three digests, not tags.

```sh
az group create --name <shared-rg> --location eastus
az acr create --resource-group <shared-rg> --name <unique-acr-name> --sku Basic
az acr build --registry <unique-acr-name> --image thesis-agent:v1 --file Dockerfile.node .
az acr show --name <unique-acr-name> --query "id" -o tsv
```

Then read back the **content digest**, which is not the tag:

```sh
az acr repository show-manifests --name <unique-acr-name> --repository thesis-agent --detail \
  --query "[0].digest" -o tsv
```

### 3b. Copy the parameter file and fill it in

Never deploy the `.example.json` directly — it is a template with five placeholders and
every optional component switched off.

**Render it instead of editing it.** The renderer fills the placeholders, enforces the
constraints that otherwise fail at deploy time or, worse, at request time, and refuses to
emit a file that still contains a placeholder:

```sh
node scripts/render-parameters.mjs \
  --region centralus \
  --ssh-key ~/.ssh/id_ed25519.pub \
  --vm-image-version <resolved version> \
  --registry <acrname> \
  --digest @sha256:<64-hex> \
  --controller-ip <your-egress-ip>/32 \
  --enable sandbox-groups
```

It writes `infra/azure-supported-three-arm.parameters.json` (gitignored). Exit `4` prints
every blocking problem instead of guessing; fix and re-run until it exits `0`.

It refuses, specifically:

- a **tag** where a content digest is required (`v1` silently drifts; `@sha256:` does not)
- a **documentation-range** controller IP (`203.0.113.x`, `198.51.100.x`) — that range
  exists in examples precisely because it is not routable
- any surviving `REPLACE`/`<...>` placeholder anywhere in the document
- a CIDR or private IP that overlaps a **sandbox-reserved range** (`192.168.0.0/24`,
  `100.65.0.0/23`) — this is the one that provisions cleanly and then cannot reach anything
- `--enable fixtures` without `createRecordUpdateRole=true` or an existing
  `recordUpdateRoleId`
- `--enable vault-secret` without a `vaultName`
- unknown `--enable` values, and image references missing a digest

`--enable` takes a comma list from: `sandbox-groups`, `vm`, `p3-firewall`, `nsg`,
`evidence-store`, `fixtures`, `registry-pe`, `registry-metadata`, `research-host`,
`vault-secret`. Everything omitted stays off. Verify the result against the template:

```sh
python3 - <<'PY'
import json,re
src=open('infra/azure-supported-three-arm.bicep').read()
decls={m.group(1):m.group(3) is not None
       for m in re.finditer(r'^param\s+(\w+)\s+[\w\[\]?]+\s*(=[^\n]*)?$',src,re.M)}
params=json.load(open('infra/azure-supported-three-arm.parameters.json'))['parameters']
print('missing required:',[n for n,d in decls.items() if not d and n not in params] or 'none')
print('extras:',[n for n in params if n not in decls] or 'none')
PY
```

Both must print `none`. If you prefer to fill it by hand, this is the full list; note that
the identity parameters are largely not yours to fill — the template creates its own
managed identities.

```sh
cp infra/azure-supported-three-arm.parameters.example.json infra/azure-supported-three-arm.parameters.json
```

`infra/azure-supported-three-arm.parameters.json` is gitignored. Fill in:

**Required — placeholders that must be replaced**

| Parameter | Replace with |
| --- | --- |
| `sshPublicKey` | Your real public key (`~/.ssh/id_ed25519.pub`) |
| `agentImageP1` / `P2` / `P3` | `<acr>.azurecr.io/thesis/agent@sha256:<64-hex>` from 3a |
| `vmImageVersion` | The current pinned Ubuntu 22.04 image version for your region |

**Required — real values**

| Parameter | Notes |
| --- | --- |
| `location` | Your chosen region, lowercase |
| `trustedControllerPublicIp` | Where your controller runs from, `/32`. `203.0.113.x` is a documentation range and will lock you out. |
| `controllerSourcePrefixes`, `researchSourcePrefixes`, `collectorSourcePrefixes`, `operatorSourcePrefixes` | Real CIDRs. The example `10.48.x.x` plan must be reconciled or subnet creation fails. |
| `researchServicePrivateIp`, `collectorPrivateIp`, `evidenceEndpointPrivateIp`, `fixtureEndpointPrivateIp` | Must not collide with anything in your plan |

**Turn on deliberately — each is `false` by default**

| Flag | Turn on when |
| --- | --- |
| `deployVmArm` | You have an SSH key and an image version |
| `deploySandboxGroups` | You want the three sandbox groups wired to the environment |
| `deployP3Firewall` | You want the P3 deny path. Largest cost line. |
| `deployEvidenceStore` | You have a real retention period decided |
| `deploySyntheticFixtures` | You also set `createRecordUpdateRole:true` **or** an existing `recordUpdateRoleId`. Neither is set by default, and deploying the fixture store without one produces an incomplete composition. |
| `deployResearchHost`, `deployEnvironmentNsg`, `deployRegistryPrivateEndpoint`, `deployRegistryMetadataReader`, `linkVaultSecretReader` | Per your design. `linkVaultSecretReader` also needs `vaultName`. |

**Identity object IDs**

The template grants roles to named identities. Every principal object ID has to come from
your tenant — they cannot be guessed:
- `sandboxControlIdentity` client ID (gets SandboxGroup Data Owner on each group)
- workload / evidence-verifier / session-registry-reader object IDs, which must be distinct
  principals. The validators reject reuse.

### 3c. Compile before you deploy

Catches typos for free:

```sh
bicep build --stdout infra/azure-supported-three-arm.bicep > /dev/null && echo OK
bicep lint infra/azure-supported-three-arm.bicep
```

Six `use-resource-symbol-reference` warnings on `vm-p3-network-controls.bicep` are expected
and accepted — those `reference()` calls deliberately preserve existing routes.

### 3d. Deploy

The template is resource-group scoped, so the group must already exist.

```sh
az deployment group create \
  --resource-group <target-rg> \
  --template-file infra/azure-supported-three-arm.bicep \
  --parameters infra/azure-supported-three-arm.parameters.json \
  --name thesis-three-arm-$(date +%Y%m%d-%H%M%S)
```

This has **never been deployed**. Expect first-run failures. Read them; do not retry blindly.

### 3e. Verify after deploy

```sh
# what actually exists
AZURE_DEVICE_CODE_AUTH=1 AZURE_SUBSCRIPTION_ID=<guid> AZURE_REGION=<region> npm run azure:inventory

# does the local runner accept the deployment shape
node scripts/preflight-three-architecture.mjs \
  --config config/experiment.azure-three-arm.example.json \
  --protocol config/protocol-450-three-arm-supported-v2.json
```

Preflight will still exit `4` with eight pending gates. That is correct — infrastructure
existing is not the same as gates being closed.

---

## 4. Cost traps

- **The ACA environment deploys unconditionally.** It is the one component with no
  condition, and it comes up whatever flags you set. You cannot deploy "just a sandbox
  group" through this template without it.
- **`deployP3Firewall`** brings Azure Firewall plus two public IPs plus policy plus route
  tables. Usually the largest line item, and billed while it exists.
- **Sandboxes are free when stopped** (scale to zero), but a sandbox left `Running` bills
  compute. `sandbox-first-light` deletes the one it creates; do not leave your own running.
- **Everything you deploy keeps costing until you delete it.** Nothing in this repo sets
  auto-delete on infrastructure.

Teardown:

```sh
az group delete --name <target-rg> --yes --no-wait
```

---

## 5. What this gets you, and what it does not

Deploying successfully proves: the resources exist, the template is valid, your identities
and role assignments resolve.

It does not prove: that the three arms behave differently, that any containment claim is
true, that the study is valid, or that quota and cost are acceptable for 450 rows. Those
come from the per-arm pilots and the measured run, and every one of them is still gated —
see `PRE-DEPLOYMENT-BUILD-PLAN.md` §6 and `AZURE-OPERATOR-HANDOFF.md` §9.
