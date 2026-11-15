# Selected three-arm secret bootstrap

`infra/main.bicep` creates a dedicated RBAC-enabled Key Vault and a separate
lock-only Blob account/container in the foundation stage. Before running
`azd up`, `deploy/resolve-inputs.mjs` creates a matching RSA-3072 CA pair under
the current user's home directory when neither `THESIS_RESEARCH_CA_CERT` nor
`THESIS_RESEARCH_CA_KEY` is set. OpenSSL is required for first-time generation.
Both files stay outside the repository.

After foundation completes, `deploy/postprovision.mjs` calls
`provision-three-arm-secrets.mjs` before image publication or the full stage.
The seeder creates the nine route-specific workload-token secret names, four
research/collector admin and verifier secret names, and the host TLS CA key
secret. It generates seven independent credentials in
memory: one each for P1, P2, P3, resource admin, collector admin, resource
verifier, and collector verifier. For each profile, the same workload token is
placed under the VM, ACA Jobs, and ACA Sandboxes secret names. This matches the
research service's `P1_TOKEN`, `P2_TOKEN`, and `P3_TOKEN` authorization model
while retaining the nine separately scoped Key Vault secret resources.

The foundation template creates a dedicated lock-only storage account and
container. The operator receives `Key Vault Secrets Officer` scoped to this
dedicated vault and `Storage Blob Data Contributor` scoped to only the lock
container. The postprovision hook obtains the vault name and lock Blob URL from
ARM outputs and invokes the helper using Azure CLI OAuth; secret values never
appear in arguments or environment variables.

```powershell
node ./infra/provision-three-arm-secrets.mjs --vault <foundation-vault-name> --prefix <bicep-namePrefix> --lock-blob-url <foundation-lock-blob-url> --host-tls-ca-key-file <protected-ca-key-path> --ca-cert-file <public-ca-cert-path>
```

For a fixed operator configuration, set
`THESIS_THREE_ARM_SECRET_LOCK_BLOB_URL`; then the flag can be omitted. If both
are supplied, they must match exactly. One source is required, so the lock URL
cannot be inferred from other deployment values.

The emitted lock URL is an HTTPS Azure Blob endpoint of the form
`https://<account>.blob.core.windows.net/<container>/<blob>` (or the matching
Azure Government/China DNS suffix), without query parameters or SAS. The exact
same URL must be configured for every cooperating invocation. The signed-in
principal gets separate Key Vault and Storage data-plane roles from foundation.
The helper obtains bearer tokens from Azure CLI; neither token is printed. The
lock storage endpoint is allowlisted to the operator's exact public IPv4 `/32`.

The helper reads existing values only in memory. It preserves valid values,
fills missing names, and never replaces an existing value. If route names for a
profile contain different values, or credentials are invalid or shared across
profile/service groups, it stops without trying to repair or overwrite the
conflict. The Key Vault Set Secret API documents that setting an existing name
creates a new secret version and does not document a create-only conditional
header. The helper therefore holds an Azure Blob lease across the complete
Key Vault read/write pass. It creates the lock blob using Blob Storage's
documented `If-None-Match: *` condition, then acquires an infinite lease. The
lease serializes only cooperating bootstrap processes using this exact same
lock URL; it does not block independent Key Vault writers. After seeding, the
helper rereads every secret and fails if it detects a changed value. This
post-write check can detect interference during the pass but cannot prevent or
detect an independent write that happens after verification. The helper
releases its lease in a `finally` path after success or failure. The lock blob
is empty and never stores secret material. The helper reports counts only; it
never writes plaintext credentials to a file or prints them. Blob's conditional
create and lease details are documented in [Put Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob) and [Lease Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/lease-blob).

The lease is infinite so a long credential pass cannot lose its lock. If the
process is killed or the machine loses power, the lease can remain active. Do
not break it until an operator confirms no bootstrap process is still running
and checks whether the Key Vault pass partially completed. Then an authorized
operator can use the Blob `Lease Blob` REST operation with
`x-ms-lease-action: break` (no lease ID is required) and wait for the break to
complete before rerunning. Breaking an active lease can allow two bootstrap
processes to overlap. If lease release fails, the helper reports that operator
recovery may be required and does not attempt an automatic break.

The service environment mapping is:

| Key Vault secret | Research/collector service environment |
| --- | --- |
| `<prefix>-vm-p1-workload-token`, `<prefix>-job-p1-workload-token`, `<prefix>-sbx-p1-workload-token` | `P1_TOKEN` on research service |
| Same three names with `p2` | `P2_TOKEN` on research service |
| Same three names with `p3` | `P3_TOKEN` on research service |
| `resource-admin-key` | `ADMIN_TOKEN` on research service |
| `collector-admin-key` | `ADMIN_TOKEN` on collector service |
| `functions-p1-resource-verifier-key` | `VERIFIER_TOKEN` on research service |
| `functions-p1-collector-verifier-key` | `VERIFIER_TOKEN` on collector service |

The Key Vault public endpoint is enabled so workload and host identities can
reach it. Entra RBAC limits the operator to this dedicated vault, while
workload and host identities receive reader assignments on only their named
secrets. This is public network reachability rather than a private endpoint;
review that exposure for the deployment. Azure Firewall already permits the
`AzureKeyVault` service tag, and the P3 Jobs NSG permits TCP/443 to that tag.
The research-host subnet has default outbound NSG behavior and no default route
through the P3 firewall, so its identity can reach the public endpoint. These
are template-level paths; live DNS, routing, and reachability still require
validation.

The host module grants its attached identity `Key Vault Secrets User` on only
the 14 preseeded secret resources; it does not create secret values.

When `deployResearchHost` is enabled, the host module attaches a dedicated
user-assigned identity and grants it `Key Vault Secrets User` on only these 14
secret resources. It receives no vault-wide role and is not the route workload
identity. The host identity client ID is emitted as
`researchHostSecretReaderClientId`.

The current `azd up` pipeline automates host installation through
`deploy/research-host-setup.mjs`. It builds and verifies the research package,
transfers it over Azure VM Run Command, formats/mounts the empty data disk,
installs the pinned Node runtime and nginx, retrieves the CA key and service
credentials through the host identity, configures private TLS, starts the
services, and verifies all three `/health` endpoints. If an operator needs to
run the credential installer manually for reconciliation, the command remains:

```sh
/opt/thesis-runtime/node/bin/node /opt/thesis-research/infra/install-three-arm-service-secrets.mjs \
  --vault-url https://<existing-vault-name>.vault.azure.net/ \
  --identity-client-id <researchHostSecretReaderClientId> \
  --prefix <bicep-namePrefix>
```

The installer retrieves values in memory over the explicit managed identity,
validates that all three route entries per profile match, and creates only
root-owned `0600` environment files under the pre-staged `0700` directory. It
never replaces an existing file; a mismatch requires operator reconciliation.
Do not put values in command arguments, shell history, logs, Git, or chat.

The exported `provisionThreeArmSecrets` function accepts a fetch-compatible
Key Vault API adapter, a credential generator, and an exclusive lock adapter.
The CLI uses `withAzureBlobLeaseLock`; unit tests mock both services, so naming,
consistency, contention, release, and redaction behavior can be tested without
Azure access. The focused test command is:

```powershell
node --test ./infra/provision-three-arm-secrets.test.mjs ./infra/install-research-host-ca-key.test.mjs
```

The lock adapter has its own tests:

```powershell
node --test ./infra/azure-blob-lease-lock.test.mjs
```
