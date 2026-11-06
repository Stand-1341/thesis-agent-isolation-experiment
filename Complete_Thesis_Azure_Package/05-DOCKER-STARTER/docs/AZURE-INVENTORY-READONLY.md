# Read-only Azure inventory (no Azure CLI)

This starter includes a direct Azure Resource Manager inventory command. It does not invoke `az`, Azure PowerShell, or any write operation.

## Run

```sh
npm run azure:inventory
```

When no subscription is supplied, the command always lists only the subscriptions visible to the identity, even if exactly one is visible. Select one explicitly, then read its relevant resources, required resource-provider registration states, and regional quota usage:

```sh
AZURE_SUBSCRIPTION_ID=<subscription-guid> AZURE_REGION=eastus npm run azure:inventory
```

Or pass `--subscription <GUID> --region <region>` directly. Values are not written to a file by the command; redirect the JSON output only if you intend to retain the inventory.

## Authentication

The command gets an ARM token using the Azure Identity library, in this order when configured:

1. Device code, **only** when `AZURE_DEVICE_CODE_AUTH=1` is explicitly set (see below)
2. Workload identity (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE`)
3. Environment credential (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and a client secret or certificate path)
4. Managed identity (system-assigned, or user-assigned selected by `AZURE_CLIENT_ID`)

Azure CLI credentials are deliberately not part of the chain. Prefer a read-only managed identity or workload identity. Never put a token, secret, certificate private key, or connection string in the JSON config or command arguments.

### Signing in as yourself without a secret

The least-risk way to unblock a host that has no managed or workload identity is to authenticate interactively as your own user account. Set `AZURE_DEVICE_CODE_AUTH=1`:

```sh
AZURE_DEVICE_CODE_AUTH=1 AZURE_SUBSCRIPTION_ID=<subscription-guid> AZURE_REGION=eastus npm run azure:inventory
```

The command prints a verification URL and a one-time code to **stderr** and waits. Open the URL on any device, enter the code, and complete sign-in with the account that already holds the required read access. The access token is held in memory only; it is not written to disk, and no secret or app registration is created.

Three properties of this path matter:

- It uses the public sign-in client identity that the Azure Identity library ships with, so there is no application registration to create or maintain.
- The permission set is whatever your user already has. That may be broader than a purpose-scoped read-only identity, so use it for inventory only and prefer a scoped identity for anything repeatable.
- The instruction output is written to stderr specifically so the JSON on stdout stays parseable. Do not merge the streams with `2>&1` if you are piping into a JSON consumer.

Device code is never attempted unless you set the variable; an unset environment keeps the non-interactive chain above unchanged.

On `identity_unavailable`, `identityDiagnostics` reports only source-input presence flags (including `deviceCodeAuthRequested`), the sanitized Azure Identity error class/code, and the next supported setup step. These flags do not prove that a configured credential can acquire a token or has the required RBAC; no token, secret, or credential path is returned.

The identity needs read access to the subscription resource inventory, provider-registration GETs for the selected resource-provider namespaces, and the selected providers' regional usage endpoints. An authorization failure is reported as an unavailable/partial read, not as an empty inventory or deleted resources.

## Read endpoints

- `GET https://management.azure.com/subscriptions?api-version=2022-12-01`
- `GET https://management.azure.com/subscriptions/{subscriptionId}/resources?api-version=2021-04-01`
- `GET https://management.azure.com/subscriptions/{subscriptionId}/providers/{resourceProviderNamespace}?api-version=2021-04-01` for registration states of the 10 provider namespaces used by the three-arm composition
- `GET https://management.azure.com/subscriptions/{subscriptionId}/providers/Microsoft.App/locations/{region}/usages?api-version=2024-03-01`
- `GET https://management.azure.com/subscriptions/{subscriptionId}/providers/Microsoft.Compute/locations/{region}/usages?api-version=2024-07-01`

The resource output is intentionally limited to relevant resource metadata (resource ID, name, type, location, resource group, and SKU when present). It omits `properties` and tags. The `providerRegistration` map contains only namespace and `registrationState`; provider resource types and metadata are omitted. Quota output preserves the values Azure returns; the script does not substitute documented defaults for live limits.

## Output status and current limitation

- Exit `0`: complete read, or help text.
- Exit `2`: partial result (for example, a region was not supplied, or one quota provider read failed) or subscription selection is required.
- Exit `4`: Azure identity or ARM read unavailable.
- Exit `5`: invalid command-line input.

`--region` and `AZURE_REGION` are checked for lowercase region-slug syntax before token acquisition or any ARM GET. This is format validation only; it does not confirm that Azure recognizes the region, that the subscription supports it, or that capacity/quota is available there. Unknown-option diagnostics report only the option name (or “positional argument”), never the supplied value.

At local verification on 2026-11-06, the direct inventory invocation exited `4` with `identity_unavailable` and `credentialErrorName: CredentialUnavailableError`. `environmentCredentialConfigured=false`, `workloadIdentityConfigured=false`, `azureClientIdEnvironmentPresent=false`, and `managedIdentityEndpointEnvironmentPresent=false`; `managedIdentityCredentialInChain=true`. Because no environment/workload credential was configured, Managed Identity was the only provider in this host's chain. A direct `ManagedIdentityCredential` probe failed with a `ServerError` cause, and a read-only Azure IMDS instance-metadata request returned HTTP `404`; no token or ARM inventory GET was obtained. This is a missing identity source on this host—not proof that resources or providers are absent, not evidence that charges stopped, and not an Azure CLI limitation. Diagnostics expose only presence flags and allowlisted error identifiers, never credential values or paths. The historical facts in the repository's root `AZURE-QUOTA-DIAGNOSTIC.md` are dated records, not a current inventory.

## Microsoft references

- [Providers - Get, API 2021-04-01](https://learn.microsoft.com/en-us/rest/api/resources/providers/get?view=rest-resources-2021-04-01) — `registrationState` read for the resource-provider namespaces this Bicep composition may use
- [Container Apps Usages - List, API 2024-03-01](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/usages/list?view=rest-resource-manager-containerapps-2024-03-01)
- [Compute Usage - List, API 2024-07-01](https://learn.microsoft.com/en-us/rest/api/compute/usage/list?view=rest-compute-2024-07-01)
- [Azure Container Apps quotas](https://learn.microsoft.com/en-us/azure/container-apps/quotas)
- [ACA Sandboxes limits and quota query](https://sandboxes.azure.com/docs/sandboxes/limits/)
