# Candidate controller RBAC for ACI U6/U8

`aci-run-scoped-controller-rbac.bicep` is a local, un-deployed RBAC candidate. It does not grant study readiness, does not run a trial, and does not create any user-assigned identities.

## What it grants

- A custom UAI lifecycle role containing only `read`, `write`, and `delete` for user-assigned identities, assigned at the ACI pilot resource-group scope.
- `CanNotDelete` locks on every existing stable UAI name supplied in `protectedIdentityNames`. The controller role does not include lock management.
- The built-in Role Based Access Control Administrator role at only the `session-b` and `prior-session` Blob container scopes.
- An Azure RBAC condition on those two role assignments. For `roleAssignments/write`, the requested role ID must be exactly Storage Blob Data Contributor. For `roleAssignments/delete`, the existing role ID must be exactly Storage Blob Data Contributor. Both paths require `PrincipalType` `ServicePrincipal`.

The role condition follows Microsoft's documented split between `@Request` attributes for assignment creation and `@Resource` attributes for assignment deletion. The built-in role also has control-plane read permissions at those container scopes; it grants no Blob `dataActions` itself. The condition does not limit the service-principal principal ID to a particular run UAI, so controller compromise could grant this one data role to another service principal at either marker container.

## Blocker: dynamic identity attachment

The template deliberately does **not** grant `Microsoft.ManagedIdentity/userAssignedIdentities/assign/action`. That permission is required when an ACI group attaches a user-assigned identity. Microsoft's published role-assignment condition attributes/examples document constraints for role ID and principal type, but do not define a verified name or resource-ID attribute that could restrict `assign/action` to only the UAIs created by a run. Granting Managed Identity Operator at the whole pilot RG would let the controller attach existing static identities, so this template avoids that broader grant.

The UAI lifecycle custom role is resource-group scoped, as requested. Azure RBAC cannot restrict its `write`/`delete` actions to the `aci-<run-hash>-<role>` naming pattern with a verified condition. The template locks named existing identities, but an omitted stable identity or a newly added non-ephemeral identity would still be within the role's scope. Supply every current non-ephemeral UAI name and keep the identity inventory current.

**Do not deploy the experiment runner using this template alone.** A trusted identity broker or an approved redesign is needed to grant Managed Identity Operator at the exact newly-created UAI resource scope, and the Blob identity-specific token path must be validated. Another option is an institution-approved isolated UAI resource group, but that changes the requested scope.

## Static checks

From the starter directory, run:

```powershell
node --test scripts/aci-run-scoped-controller-rbac-template.test.mjs
az bicep build --file infra/aci-run-scoped-controller-rbac.bicep --stdout
```

Before any deployment, list actual UAI names and provide every stable identity in `protectedIdentityNames`. Preview with `az deployment group what-if` using the exact pilot resource group, controller principal ID, and fixture Storage account. Review the role scopes and conditions in the what-if output. The template has not been deployed or evaluated against live Azure state.

References:

- [Azure role-assignment condition examples](https://learn.microsoft.com/en-us/azure/role-based-access-control/delegate-role-assignments-examples)
- [Add conditions with ARM templates](https://learn.microsoft.com/en-us/azure/role-based-access-control/conditions-role-assignments-template)
- [Authorization actions and condition attributes](https://learn.microsoft.com/en-us/azure/role-based-access-control/conditions-authorization-actions-attributes)
- [Role Based Access Control Administrator built-in role](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/privileged)
