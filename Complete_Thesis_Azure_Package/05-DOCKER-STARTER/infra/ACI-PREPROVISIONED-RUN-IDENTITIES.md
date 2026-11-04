# Pre-provisioned ACI run identities

This is a candidate least-privilege bootstrap for the separate ACI U6/U8 Blob analogue. It has **not** been deployed. The controller cannot create or update UAIs. The bootstrap is deliberately two phase because Azure-generated UAI principal IDs are not available at deployment start.

Phase 1 creates the deterministic UAIs only. A trusted bootstrap identity then reads each actual UAI principal ID from ARM. Phase 2 supplies those observed IDs in the exact frozen-schedule manifest and creates the Blob role grants plus controller permissions. The phase-2 controller permissions are scoped per identity for attach/delete; at `session-b` and `prior-session`, a single conditioned role-assignment operator per container can delete/create only Blob Data Contributor assignments for the exact observed run UAI principal IDs. Source/cleanup UAIs get Blob Data Contributor only at their exact synthetic marker container. Probe UAIs get no direct Blob role. This avoids granting controller attach permissions over the resource group or unconditioned role-assignment administration.

The bootstrap deployment principal needs permission to create UAIs and the custom role definition, and write role assignments at the two marker containers and the individual UAI scopes. Keep that identity separate from the controller. This template set does not deploy ACI groups, firewall/NAT, app code, or trial services.

## Build identity names from frozen bytes

Run against the exact 50-row frozen schedule CSV and its already-published SHA-256. This hashes the original bytes, fails on mismatch, selects only U6/U8 rows, and creates three identity names per such row. It does not rewrite or re-hash the schedule.

```powershell
node .\\scripts\\create-aci-identity-manifest.mjs --schedule .\\path\\to\\frozen-50-row.csv --sha256 <EXACT_FROZEN_SCHEDULE_SHA256> --out .\\infra\\aci-identity-manifest.json
```

## Phase 1 preview and bootstrap creation

Prepare an ARM parameters file with `identitySpecs` set to `$manifest.identitySpecs`, then preview phase 1:

```powershell
$manifest = Get-Content .\\infra\\aci-identity-manifest.json -Raw | ConvertFrom-Json
$phase1 = @{ '$schema'='https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion='1.0.0.0'; parameters=@{ identitySpecs=@{ value=@($manifest.identitySpecs) } } }
$phase1 | ConvertTo-Json -Depth 30 | Set-Content .\\infra\\aci-identities-phase1.parameters.json
az bicep build --file .\\infra\\aci-create-run-identities.bicep --stdout | Out-Null
az deployment group what-if --resource-group <PILOT-RESOURCE-GROUP> --template-file .\\infra\\aci-create-run-identities.bicep --parameters @infra\\aci-identities-phase1.parameters.json
```

After an authorized phase-1 deployment, retrieve the exact identities and principal IDs. This outputs non-secret object IDs:

```powershell
az identity list --resource-group <PILOT-RESOURCE-GROUP> --query "[?tags.managedBy=='thesis-aci-pilot-bootstrap'].{name:name,principalId:principalId}" -o json | Set-Content .\\infra\\aci-identity-principals.json
node .\\scripts\\create-aci-identity-manifest.mjs --schedule .\\path\\to\\frozen-50-row.csv --sha256 <EXACT_FROZEN_SCHEDULE_SHA256> --principal-ids .\\infra\\aci-identity-principals.json --out .\\infra\\aci-identity-manifest-with-principals.json
```

The second command fails unless the Azure inventory contains exactly one principal ID for every identity name in the hash-verified manifest. Keep the schedule hash unchanged.

## Phase 2 what-if only

```powershell
$manifest = Get-Content .\\infra\\aci-identity-manifest-with-principals.json -Raw | ConvertFrom-Json
$parameters = @{ '$schema'='https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion='1.0.0.0'; parameters=@{ controllerPrincipalId=@{ value='<CONTROLLER-MANAGED-IDENTITY-PRINCIPAL-ID>' }; fixtureStorageAccountName=@{ value='<FIXTURE-STORAGE-ACCOUNT>' }; identitySpecs=@{ value=@($manifest.identitySpecs) } } }
$parameters | ConvertTo-Json -Depth 40 | Set-Content .\\infra\\aci-identities-phase2.parameters.json
az bicep build --file .\\infra\\aci-preprovisioned-run-identities.bicep --stdout | Out-Null
az deployment group what-if --resource-group <PILOT-RESOURCE-GROUP> --template-file .\\infra\\aci-preprovisioned-run-identities.bicep --parameters @infra\\aci-identities-phase2.parameters.json
```

Review the what-if output for the expected UAI count, only `session-b`/`prior-session` Blob scopes, only Blob Data Contributor grants, per-UAI controller scopes, and no unrelated resource changes. A local build is not Azure authorization validation. Do not deploy phase 2 until the schedule hash, principal inventory, role scopes/conditions, token path, and method approval have been reviewed.

## Runtime adapter

Construct `createAciPreprovisionedIdentityProvider` with subscription/resource group/tenant/location, controller principal ID, the `identityLifecycleRoleDefinitionId` deployment output, an ARM token callback, and a separately authenticated `observeEffectiveAssignments` callback. That observer must prove inherited, group, custom-role, data-action, and indirect credential resolution. The adapter fails closed if evidence is incomplete; it never fabricates inherited-access completeness.

ACI groups must attach the returned UAI resource ID and use that UAI's managed identity token endpoint. The controller must not request tokens for the run UAIs. Verify actual Storage requester object IDs for source, probe, and cleanup before any counted experiment. This candidate adapter does not complete the 50-row pilot or establish study readiness.

## Local checks

```powershell
node --test .\\scripts\\aci-preprovisioned-identity-provider.test.mjs .\\scripts\\aci-preprovisioned-identity-template.test.mjs
az bicep build --file .\\infra\\aci-create-run-identities.bicep --stdout
az bicep build --file .\\infra\\aci-preprovisioned-run-identities.bicep --stdout
```