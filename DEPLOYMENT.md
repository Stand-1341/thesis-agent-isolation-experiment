# Deployment (azd)

This is the operator guide for the current v3 three-arm deployment:

- `azure_vm`
- `azure_functions_flex`
- `azure_container_apps_sandboxes`

The legacy `aca_jobs` composition is retained only for v2 compatibility. The
default is `SERVERLESS_RUNTIME=functions_flex`.

## What `azd up` does

`azd up` is a deployment pipeline, not an experiment runner. It performs:

1. **Input resolution** (`deploy/resolve-inputs.mjs`) — creates or validates the
   external RSA-3072 research CA, resolves the SSH public key, operator egress
   `/32`, pinned Ubuntu image version, VM sizes, source prefixes, CA paths, and
   the operator principal ID. The CA files must remain outside the repository.
2. **Preflight** (`deploy/preflight.mjs`) — auth, RBAC, provider registration,
   region availability, VM/Microsoft.App quota, SKU restrictions, address-space
   overlap, budget presence, Azure Policy review, and an ARM what-if preview.
   Nothing is provisioned until this passes.
3. **Foundation** (`infra/main.bicep`, `stage=foundation`) — registry, network,
   identities, Log Analytics, bootstrap Key Vault, lock-only Storage account,
   and other foundation resources.
4. **Secret bootstrap** (`deploy/research-host-bootstrap.mjs`) — seeds the
   route/admin/verifier/host-CA secrets in the dedicated Key Vault under a Blob
   lease. It prints counts and names only.
5. **Agent image** (`deploy/publish-images.mjs`) — builds and pushes the pinned
   agent image and records its immutable digest.
6. **Post-foundation preview** (`deploy/preflight.mjs`) — runs a full-stage ARM
   what-if, including exact child previews if ARM short-circuits nested modules.
7. **Full deployment** (`infra/main.bicep`, `stage=full`) — VM arm, Functions
   Flex apps and networking, Sandbox groups, evidence/fixture stores, research
   host, and full-stage role assignments.
8. **Configuration** (`deploy/configure.mjs`) — resolves ARM outputs into
   `.azure/<env>/deployment.resolved.json` and the generated experiment config.
9. **Functions publication** (`deploy/publish-functions.mjs`) — builds the
   deterministic Functions package, deploys it to all three apps, verifies the
   expected triggers, and stores each Function key in Key Vault.
10. **Sandbox bootstrap** (`deploy/bootstrap-sandboxes.mjs`) — creates pinned
    disk images, applies per-profile runtime/identity/egress policy, runs a
    sandbox smoke test, and persists the disk image IDs.
11. **Research-host bootstrap** (`deploy/research-host-setup.mjs`) — prepares
    the data disk, installs the verified research package and Node runtime,
    retrieves host CA and service credentials through the host managed identity,
    configures nginx/private TLS, starts `thesis-research` and
    `thesis-collector`, and verifies all three health endpoints.
12. **Validation and readiness** (`deploy/postup.mjs`) — always writes the
    deployment validation and readiness artifacts. A failed validation still
    emits `deployment-manifest.json` and `DEPLOYMENT-REPORT.md`; the hook then
    returns the validation failure code.

## Prerequisites

- Azure CLI authenticated as a principal that can deploy the resource group,
  create role assignments, and read the subscription resources used by
  preflight.
- `azd`, Node.js 22+, npm, Docker, and OpenSSL on the deployment workstation.
- An Azure budget. Set `AZURE_BUDGET_NAME`; the deployment does not create a
  budget automatically.
- A subscription with the required resource providers registered and enough
  vCPU/Microsoft.App quota in the selected region.
- Outbound access from the research host to Ubuntu package repositories and
  `nodejs.org` for the first host bootstrap. This is used once to install
  `nginx`/`openssl` and the pinned Node runtime. The host package itself is
  transferred over Azure VM Run Command.
- The operator's public egress address as an exact IPv4 `/32`. It is used for
  the bootstrap lock, evidence-store validation, and operator access rules.

## First deployment

```powershell
azd env new thesis-study
azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
azd env set AZURE_LOCATION centralus
azd env set AZURE_RESOURCE_GROUP <resource-group-name>
azd env set AZURE_NAME_PREFIX <lowercase-prefix>
azd env set SERVERLESS_RUNTIME functions_flex
azd env set PROVISION_STAGE foundation
azd env set AZURE_OPERATOR_PRINCIPAL_ID <operator-object-id>
azd env set AZURE_BUDGET_NAME <budget-name>
azd up
```

`AZURE_OPERATOR_PRINCIPAL_ID` must identify the signed-in operator principal.
For a user, obtain it with:

```powershell
az ad signed-in-user show --query id -o tsv
```

The workstation egress `/32` and SSH public key are resolved automatically.
Set `THESIS_RESEARCH_CA_CERT` and `THESIS_RESEARCH_CA_KEY` together only if you
are reusing an existing CA pair outside the repository. Do not set one without
the other.

To skip the budget presence gate after an explicit operator decision, set
`AZD_PREFLIGHT_SKIP_BUDGET=1`. To accept residual Azure Policy risk after
reviewing the assignments, set `AZD_PREFLIGHT_ALLOW_POLICY_ASSIGNMENTS=1`.
Neither switch changes what the deployment template does.

## Expected outputs

After a successful run:

```text
.azure/<env>/deployment.resolved.json
.azure/<env>/deployment-validation.json
.azure/<env>/deployment-manifest.json
.azure/<env>/DEPLOYMENT-REPORT.md
.azure/<env>/functions-publish.json
.azure/<env>/sandbox-bootstrap.json
.azure/<env>/research-host-setup.json
Complete_Thesis_Azure_Package/05-DOCKER-STARTER/config/experiment.generated.json
```

`deployment-manifest.json` records whether validation passed, whether the
Functions package and Sandbox disk images are ready, the research-host state,
the evidence-retention result, pending pilot evidence, and the remaining
research-design blockers.

## Validation gates

Deployment validation is non-counted and runs no study trials.

- **V1 resource presence** — VMs, Functions apps, sandbox groups, evidence
  stores, fixture store, research host, and image-pull identity must exist.
- **V2/V3 identity evidence** — VM data-plane probes run as the workload
  identity. Non-VM exact-route proof is accepted when an integrity-indexed
  pilot record exists; otherwise it is reported as `pilot-evidence-pending`.
- **V4 service health** — all three private listeners are checked from the
  deployed research host with the host CA.
- **V5 evidence path** — a non-counted write/read/delete round-trip against the
  evidence container. The operator receives only the exact container-scoped
  Blob Data Contributor role and the exact `/32` network rule needed for this
  check.

Pending pilot evidence is a study-readiness blocker, not a deployment failure.
The readiness report distinguishes the two.

## Measured execution is separate

`azd up` never starts study trials. The v3 protocol is frozen with
`measuredExecutionEnabled: false`; that is intentional.

Measured execution also requires:

- the selected protocol and freeze lock both enable measured execution;
- a verified non-counted pilot index covering every selected route;
- the Functions/Flex P3 network-denial inputs and pilot evidence;
- the U6/U8 external-namespace fixture validation;
- a locked evidence-retention policy;
- a fresh owner authorization file naming the exact protocol SHA-256 digest;
- independent dependency and verifier preflight.

The current v3 measured gate cannot be opened by the deployment itself. The
deployment prepares the environment and reports what is still missing. Do not
edit the protocol, freeze lock, or readiness flags to force a measured run.

## Reruns and interruption recovery

Every step is idempotent or checkpointed in
`.azure/<env>/deployment-state.json`:

- the CA pair is reused and revalidated;
- Key Vault secrets are preserved, never overwritten with different values;
- the image digest is reused when source is unchanged;
- the Functions package has a recorded digest and verified trigger state;
- the Sandbox bootstrap preserves disk-image records;
- the research-host bootstrap reuses the installed package only when its
  manifest digest matches and refuses a silent replacement.

Rerun `azd up` after fixing an interruption. Do not delete state files to force
progress.

## Troubleshooting

### Preflight fails on Azure Policy

Review the assignments. If you accept the residual risk, set
`AZD_PREFLIGHT_ALLOW_POLICY_ASSIGNMENTS=1` and rerun. This is an explicit
operator decision, not an automatic bypass.

### Full-stage what-if reports old ACA Jobs resources as `Ignore`

This is expected during a v2-to-v3 transition. The gate permits only exact
legacy Jobs resources and exact storage-container role assignments that ARM
reports as `Unsupported`. Any other ignored or unsupported resource remains
fatal.

### Functions publication fails

Check that the Function apps exist and SCM access is allowed. The publisher
requires the pinned agent digest and external CA certificate path. A successful
publication verifies `thesisNetworkProbe`, `thesisSessionSeed`, and `thesisRun`
before writing the Function key to Key Vault.

### Sandbox bootstrap fails with 403

The operator needs `Container Apps SandboxGroup Data Owner` on each sandbox
group. The full template grants it to the operator principal at group scope.
Allow RBAC propagation and rerun `azd up`.

### Research-host bootstrap fails

Check:

- the data disk is attached as LUN 0;
- the host can reach Ubuntu repositories and `nodejs.org`;
- the host secret-reader identity has the scoped Key Vault roles;
- `/etc/thesis-research` does not contain a conflicting previous installation;
- `az vm run-command` is permitted by policy.

The setup is intentionally fail-closed on package, CA, environment-file, or
service-identity conflicts. Reconcile the host rather than deleting the state
silently.

### Validation V5 fails

Confirm the operator principal has `Storage Blob Data Contributor` on the
exact evidence container and the deployment workstation public IP is present
as the exact evidence-store rule. Allow for role propagation, then rerun:

```powershell
node deploy/validate-deployment.mjs
node deploy/readiness-report.mjs
```

## Teardown

```powershell
node deploy/teardown.mjs
node deploy/teardown.mjs --export-evidence ./evidence-out
node deploy/teardown.mjs --force
```

The guard refuses to delete while counted evidence exists. After teardown,
`TEARDOWN-REPORT.md` lists resources outside the managed group that may still
incur charges.

## Layout

- `azure.yaml` — azd lifecycle hooks
- `infra/main.bicep` — two-stage deployment wrapper
- `deploy/*.mjs` — pipeline steps, each runnable standalone
- `config/deployment.schema.json` — optional user configuration
- `Complete_Thesis_Azure_Package/05-DOCKER-STARTER/` — the experiment package
