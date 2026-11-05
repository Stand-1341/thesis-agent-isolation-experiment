# VM workload Key Vault boundary review — 2026-11-05

## Finding

The Key Vault grants on VM P1/P2 workload principals are not required by the VM workload architecture found in this package and create an invalid trust boundary for `vm-p1-controller-key` / `vm-p2-controller-key`.

The current VM agent reads `WORKLOAD_TOKEN` and `TRIAL_REQUEST_KEY` from its root-owned mode-600 environment file. `infra/install-vm-agent.sh` enforces those values locally; `infra/vm-agent.env.example` says to provide workload-only and distinct controller-request values. In managed Blob mode, the agent gets Blob tokens directly from its attached managed identity through `ManagedIdentityCredential` (`src/agent.ts`, `scripts/azure-managed-token.mjs`). No VM agent source path reads Key Vault, and no code/package reference to `vm-p1-workload-token` or `vm-p2-workload-token` was found. The route's `WORKLOAD_TOKEN` is used as the dummy research-service credential; it is provisioned into the agent environment rather than fetched by the agent from Key Vault.

The VM/Functions controller preflight uses the separate controller UAI client ID `011128da-854a-43e6-ba75-461be5958b1b` to read its secret map, including `vm-p1-controller-key` and `vm-p2-controller-key`, then supplies those values to the runner in memory (`scripts/run-keyvault-vmfns-rev4-preflight.mjs`, `scripts/run-keyvault-measured-preflight.mjs`). The intended split is therefore controller reads Key Vault and workload uses its own assigned workload UAI for Blob. `infra/CONTROLLER-PILOT.md` also explicitly states that no workload should receive controller identities. The actual controller UAI has `Key Vault Secrets User` at the vault scope, consistent with that design.

## Live read-only evidence

On 2026-11-05, `az role assignment list --all --assignee` showed:

- VM P1 principal `37fcb428-951e-48a8-aec2-e9918dedba29`: `Key Vault Secrets User` at secret scopes `vm-p1-workload-token` and `vm-p1-controller-key`.
- VM P2 principal `dd6be331-a53b-4c08-8a63-7745e98b3952`: `Key Vault Secrets User` at secret scope `vm-p2-controller-key`.
- Controller UAI principal `9ac3ec70-30f4-4ea1-9f56-d97468e13a50`: `Key Vault Secrets User` at the `thesisexpkv20261103` vault scope.

No secret value was read. Current Bicep source `infra/controller-pilot-secrets-vault.json` provisions the controller UAI's intended vault reader assignment. `infra/fixture-identities-pilot.bicep` creates the workload identities without Key Vault assignments. The direct route-principal Key Vault assignments do not appear as intended assignments in those templates.

## Recommendation

Remove the three direct secret-scoped Key Vault role assignments from the VM P1/P2 workload principals (`vm-p1-workload-token`, `vm-p1-controller-key`, `vm-p2-controller-key`). Keep Key Vault reads on the separate controller UAI only. Continue provisioning each VM's workload-only token and distinct route request key through the root-owned mode-600 VM environment path; do not give workload identities Key Vault read access as a bootstrap shortcut. If a future design changes to runtime secret retrieval, use a separate narrowly scoped bootstrap identity and document the boundary before granting it.

After an authorized cleanup, re-query role assignments for both workload principals and confirm only expected Blob scopes remain. This recommendation is based on package architecture and the current direct-assignment snapshot; it does not claim inherited assignments or effective access were exhaustively resolved. No Azure change was made during this review.

## Remediation performed 2026-11-05

Removed the three direct VM P1/P2 secret-scoped Key Vault Secrets User assignments listed above. Azure role assignment readback returned no direct Key Vault Secrets User grants for either VM workload principal, and confirmed the separate controller identity retains its vault-scoped grant. This direct-assignment check does not establish inherited effective access.
