# Read-only route identity and RBAC snapshot — 2026-11-05

## Scope and method

Read-only Azure CLI ARM queries were made using the signed-in workstation identity; no controller VM command, trial, secret read, or Azure mutation was performed. Subscription ID: `dddc5a29-1701-44ad-b367-50b466089d4b`. Route principals were taken from `config/experiment.azure-live.json`. VM identity attachments, Function App identity attachments, and `az role assignment list --all --assignee <principal>` results were compared. For the three Function Apps, `AZURE_CLIENT_ID` was read in-process and only presence/match booleans were printed; app-setting values were not retained in this report.

## Identity binding observations

All three VM route principal IDs match the attached user-assigned identity principal IDs for `thesis-vm-study-p1`, `thesis-vm-study-p2`, and `thesis-vm-study-p3-centralus`. The VM P1/P2/P3 VMs each list only their corresponding workload UAI in the returned user-assigned identity set. The P3 Central VM is separately in Central US.

All three Function App route principal IDs match the corresponding attached user-assigned identity principal IDs for `thesis-flex-pilot-20261103`, `thesis-flex-p2-20261105`, and `thesis-flex-p3-20261105`. Each app's `AZURE_CLIENT_ID` setting was present and matched that assigned UAI's client ID. The Function Apps also have separate system-assigned principal IDs; route config points to the UAI principals, not those system-assigned IDs.

This establishes ARM attachment/configuration agreement at query time. It does not prove runtime token claims or effective isolation by itself.

## Direct Blob role assignments observed

All listed roles below were returned for the route principal at `thesisfixture20261103` container scopes. The custom role `Thesis synthetic record reader and updater` was read from ARM and has only Blob `read` and `write` data actions (no control-plane actions, no delete action).

| Route | Direct Blob scopes and roles observed |
|---|---|
| VM P1 | Reader: `dummy-credentials`, `prior-session`, `restricted-docs`, `session-a`, `session-b`, `authorized-docs`; Contributor: `restricted-records`, `authorized-records` |
| VM P2 | Reader: `authorized-docs`, `session-a`; custom read/write role: `authorized-records` |
| VM P3 | Reader: `session-a`, `authorized-docs`; custom read/write role: `authorized-records` |
| Functions P1 | Reader: `prior-session`, `dummy-credentials`, `restricted-docs`, `authorized-docs`, `session-a`, `session-b`; Contributor: `restricted-records`, `authorized-records` |
| Functions P2 | Reader: `session-a`, `authorized-docs`; custom read/write role: `authorized-records` |
| Functions P3 | Reader: `session-a`, `authorized-docs`; custom read/write role: `authorized-records` |

VM P1 also has direct `Key Vault Secrets User` assignments scoped to secrets named `vm-p1-workload-token` and `vm-p1-controller-key`; VM P2 has the same role on `vm-p2-controller-key`. These are workload-principal assignments and should be explicitly justified against the intended trust boundary. No secret values were fetched. The role-list query showed no other roles for the VM/Functions route principals in its returned result sets; these results alone do not resolve inherited group paths or deny assignments.

## Assessment and limits

- ARM identity attachment and Function `AZURE_CLIENT_ID` configuration match all six configured route principals at query time.
- Route-scoped Blob role assignments exist. P1 identities have broad cross-container reader/contributor grants; P2/P3 identities show narrower fixture container grants in the returned direct assignment sets.
- No claim of effective authorization, cross-route isolation, denial behavior, or full-study verifier readiness is made. This audit did not independently resolve transitive group memberships, all inherited assignments, deny assignments, role conditions, data-plane token identity, or live Blob authorization behavior for all six routes. VM P1/P2 non-counted workload evidence is separately documented in `VM-P1-P2-NONCOUNTED-ROUTE-EVIDENCE-2026-11-05.md`; it does not extend to all six routes.
- This snapshot does not clear any of the four measured-run gates or authorize a counted run.

Additional direct assignment: VM P1 and VM P2 each also have `Storage Blob Data Reader` on the temporary `thesispilotblob20261102/vm-route-pkg-20261104` package container. This is outside the fixture scopes in the table and was not checked for package cleanup or runtime use in this audit.
