# Azure Container Instances replacement arm — method overhaul draft

**Status: implementation draft, not an approved or measured protocol.** This
replaces the unavailable Azure Container Apps custom-session arm with a
container-group lifecycle based on Azure Container Instances (ACI). It is a
method change; revision 2 and its frozen 400-row digest remain untouched.

## Why this route

The current subscription has no Azure Container Apps E-series quota. Its live
East US ACI usage API, queried 2026-11-04, reports Standard Cores 0/4 and
Container Groups 0/100. ACI therefore has room for a small sequential pilot
without an E16 request. The Standard Cores limit is regional and constrains
concurrent compute; it does not mean 400 trial runs have already been
authorized or validated. Microsoft also publishes container-group create rate
limits, so the runner must stay sequential and obey returned throttling.

## Proposed treatment and lifecycle

- Replace the two revision-2 `azure_custom_sessions_hyperv` P1/P2 routes with
  `azure_container_instances` P1/P2 routes. Keep VM P1/P2/P3 and Functions
  P1/P2/P3 unchanged unless a separately reviewed change is required.
- A controller creates one short-lived private ACI container group for each
  trial using the immutable agent image digest, route-specific workload UAI,
  and a separate ACR pull UAI. It waits for `Running` and `/health`, invokes
  exactly one trial, gathers independent evidence, then deletes the group and
  verifies terminal deletion before the next row. Ambiguous create, execution,
  or delete outcomes halt the schedule; never retry the same run ID.
- Each group receives only the route credentials and minimal settings needed
  for one task. The controller and evidence-reader identities are not assigned
  to the workload. ACI UAI token acquisition must be tested against the real
  workload code and role assignments before use.
- U6/U8 must be redesigned around a controlled prior-group artifact and
  independently observed cross-group state. ACI has no ACA session identifier,
  pool manager, or session-retirement API. Do not reuse the ACA session
  lifecycle verifier or call the ACI group lifecycle equivalent without new
  validation.
- The revised deterministic matrix must be newly generated, reviewed, and
  frozen with a new digest. Preserve the 450-row historical matrix and revision
  2 400-row plan; neither is rewritten to claim it used ACI.

## Network and evidence design

- ACI VNet deployment requires a dedicated `Microsoft.ContainerInstance/
  containerGroups` delegated subnet. Microsoft recommends at least `/24` for
  repeated group creation. The candidate free range is `10.48.13.0/24` in the
  existing East US VNet; recheck for overlap immediately before deployment.
- Container groups in a VNet have private IPs. The candidate ACI subnet must
  allow only the controller path to TCP/8080 inbound. DNS must be configured
  explicitly because ACI doesn't inherit VNet DNS settings.
- P1/P2 ACI groups keep their intended permission-profile difference at Azure
  RBAC. The P3 session cells were already withdrawn from revision 2 and remain
  out of scope. Do not treat an ACI P1/P2 firewall route as validated P3
  containment.
- Azure lists ACI as unsupported for Virtual Network Flow Logs. Network-denial
  attribution therefore cannot depend on VNet Flow Logs. If a future approved
  method adds ACI P3, the existing Azure Firewall can be used as the candidate
  enforcement and log source, but selective rules, return paths, operation
  correlation, and independent log reads must all pass a pilot first.
- The current subscription has consumed its Standard public-IP quota (3/3),
  and no unattached public IP is available for a new NAT Gateway. The candidate
  pilot uses the existing Azure Firewall and its existing UDR pattern, which
  Microsoft documents for ACI static egress. However, the current ACI VNet
  overview now states NAT Gateway is the only supported outbound configuration.
  These Microsoft pages conflict; deployment preflight and a non-counted smoke
  group must resolve whether this subscription accepts and supports the existing
  Firewall path. If Azure requires a NAT Gateway, stop and request one additional
  Standard public IP or choose another approved method. Do not delete or reassign
  the Firewall IPs. The subnet template adds symmetric return routes to the
  already-associated private-endpoint and research-service route tables. The
  pilot firewall policy permits broad ACI P1/P2 egress, matching their
  permissive network baseline; it cannot be reused as an ACI P3 treatment.

## Gates before deployment and measured runs

1. Review this method change with the thesis advisor/required review authority,
   especially the new unit of isolation, U6/U8 interpretation, and exclusion of
   session P3.
2. Confirm the actual image digest, ACR pull identity, distinct P1/P2 workload
   identities, RBAC scopes, controller's narrowly scoped ACI create/delete
   role, private target URLs, and Key Vault-backed settings.
3. Deploy the dedicated subnet and one bounded non-counted P1 smoke group.
   Verify image pull, private IP, health, controller-only ingress, fixture
   access, Blob authorization, independent collector evidence, and cleanup.
4. Repeat for P2; verify the expected RBAC deny and legitimate operations.
   Test interruption at each ACI lifecycle step and prove evidence is retained
   without a duplicate execution.
5. Validate evidence immutability/independent custody and all existing VM and
   Functions route gates. Recompute the new ACI matrix and cost estimate, then
   freeze the protocol only after approval and all pilot checks pass.

**Current state:** no ACI container group is deployed. The ACI usage quota is
available for a small pilot. A no-change preflight for a new NAT Gateway failed
because Standard public IP quota is already 3/3. No ACI resource deployment was
attempted. ACI's VNet overview and its Azure Firewall egress tutorial conflict
on the required outbound path; a contained no-counted smoke deployment must
resolve that before proceeding. The local CLI's ACR authorization refresh also
failed on 2026-11-04, and the research/controller VMs are deallocated. No
measured trial has run.

## Microsoft references

- [ACI VNet scenarios and limitations](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-virtual-network-concepts)
- [ACI static outbound through Azure Firewall](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-egress-ip-address)
- [ACI managed identities](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-managed-identity)
- [ACI quotas](https://learn.microsoft.com/en-us/azure/container-instances/container-instances-resource-and-quota-limits)
- [VNet Flow Log incompatible services](https://learn.microsoft.com/en-us/azure/network-watcher/vnet-flow-logs-overview)
