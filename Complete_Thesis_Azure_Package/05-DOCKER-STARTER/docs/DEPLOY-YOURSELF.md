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

**Fastest — portal.** Open [sandboxes.azure.com/sandbox-groups](https://sandboxes.azure.com/sandbox-groups),
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
