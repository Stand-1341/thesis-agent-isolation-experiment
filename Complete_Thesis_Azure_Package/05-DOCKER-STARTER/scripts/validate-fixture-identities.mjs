/** Validate proposed object IDs only. This does not inspect Azure effective permissions. */
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateFixtureIdentities({p1PrincipalIds,restrictedPrincipalIds,fixtureControllerPrincipalId,verifierPrincipalId,sessionFixtureOwnerPrincipalId}) {
  if (!Array.isArray(p1PrincipalIds) || p1PrincipalIds.length!==3 ||
      !Array.isArray(restrictedPrincipalIds) || restrictedPrincipalIds.length!==6) throw new Error('expected three P1 and six P2/P3 principals');
  const ids=[...p1PrincipalIds,...restrictedPrincipalIds,fixtureControllerPrincipalId,verifierPrincipalId,sessionFixtureOwnerPrincipalId];
  if (!ids.every(id=>typeof id==='string' && guid.test(id))) throw new Error('invalid principal object ID');
  if (new Set(ids.map(id=>id.toLowerCase())).size!==ids.length) throw new Error('all workload, fixture controller, and verifier principals must be distinct');
  return {workloadPrincipals:9,controllerPrincipals:1,verifierPrincipals:1,sessionFixtureOwnerPrincipals:1,
    status:'identity_shape_only_effective_azure_permissions_unverified'};
}
