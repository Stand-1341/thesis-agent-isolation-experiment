# VM/Functions workload RBAC audit — 2026-11-05

## Scope and method

This is a read-only snapshot of the six configured workload principals in
`config/experiment.azure-live.json`, collected 2026-11-05 using Azure CLI and
Microsoft Graph under the signed-in workstation identity. The subscription was
`dddc5a29-1701-44ad-b367-50b466089d4b`; no secrets were read. No VM commands,
trial calls, role changes, or other cloud mutations were made.

For each configured principal, the audit queried
`az role assignment list --assignee-object-id <principal> --all
--include-inherited --include-groups` and retained role name, scope, principal
ID/type, and condition. It also queried the service principal's Graph
`transitiveMemberOf` collection. The custom and built-in Blob role definitions
were read from ARM. These are caller-visible control-plane observations, not a
live effective-access evaluation.

## Findings

All six Azure role-assignment results had a `principalId` equal to the
configured workload principal and had no assignment condition. No inherited
subscription, resource-group, or storage-account grant appeared. Graph returned
no transitive group memberships for any of the six service principals.

| Workload route | Fixture container-level assignments observed |
|---|---|
| VM P1 (`37fcb428-951e-48a8-aec2-e9918dedba29`) | Blob Reader: `dummy-credentials`, `prior-session`, `restricted-docs`, `session-a`, `authorized-docs`; Blob Contributor: `restricted-records`, `authorized-records` |
| VM P2 (`dd6be331-a53b-4c08-8a63-7745e98b3952`) | Blob Reader: `authorized-docs`, `session-a`; custom read/write role: `authorized-records` |
| VM P3 (`d599bd8d-0998-46f5-8dae-c9abd9a9ede7`) | Blob Reader: `authorized-docs`, `session-a`; custom read/write role: `authorized-records` |
| Functions P1 (`7a1fd40a-3c8d-4d21-b8ae-a0fb938591d4`) | Blob Reader: `dummy-credentials`, `prior-session`, `restricted-docs`, `authorized-docs`, `session-a`, `session-b`; Blob Contributor: `restricted-records`, `authorized-records` |
| Functions P2 (`76174085-c59c-4cc8-9409-b019eea36f61`) | Blob Reader: `authorized-docs`, `session-a`; custom read/write role: `authorized-records` |
| Functions P3 (`da87656a-277f-4fff-abdc-88275362fff0`) | Blob Reader: `authorized-docs`, `session-a`; custom read/write role: `authorized-records` |

P1 has broad cross-container fixture permissions by design and should remain an
explicit factor in the isolation assessment. The built-in `Storage Blob Data
Contributor` definition includes Blob read, write, delete, move, and add data
actions, plus container management actions; it is assigned only to P1 and only
at the two listed fixture container scopes. The custom `Thesis synthetic record
reader and updater` role has Blob read/write data actions, no delete action, and
no control-plane actions.

## VM package-container assignment

The same ARM query showed two additional grants outside the fixture account:

- VM P1: `Storage Blob Data Reader` on
  `thesispilotblob20261102/.../containers/vm-route-pkg-20261104`.
- VM P2: the same role and container scope.

The current local VM workload package installer accepts a local package
directory (`install-vm-agent.sh PACKAGE_DIR NODE22_DIST_DIR
ROOT_OWNED_ENV_FILE`) and stages files from that directory; it contains no Blob
download step. The route TLS documentation likewise describes package transfer
and installation but does not require the workload identity to retrieve the
package at runtime. The current local measured preflight uses this storage
account for the separate `trial-evidence` container, not the VM package
container. Repository search found no current source or deployment script that
references `vm-route-pkg-20261104` as a runtime dependency.

**Assessment:** the two package-container Reader grants are not evidenced as
runtime dependencies in the current local implementation and appear to be
provisioning or legacy access. Recommend removing them from the workload
identities after confirming that no active VM bootstrap/update workflow still
downloads from this container. Do not rely on this local source review alone to
remove the grants: the storage data-plane listing attempt from the workstation
was blocked by the storage account's network rules, so container contents and
the live VM bootstrap path were not inspected. No role was removed.

## Limits and readiness impact

The CLI query did not prove runtime token `oid`/principal claims, effective
data-plane access, or that no SAS/shared-key path exists. It also does not
independently resolve every deny assignment or role condition affecting a
specific data request. Empty Graph transitive membership results and the
absence of inherited assignments are limited to the query identity's visible
ARM/Graph state at the time of collection. Separate live probes and independent
audit records are still needed to establish route isolation. This snapshot
does not clear a measured-run gate or authorize measured trials.
