# Central US P3 VM deployment (2026-11-04/05)

## Status

The P3 route was deployed in Central US after East US reached its 4-vCPU
regional quota. It uses a separate VM and a non-overlapping VNet spoke and
leaves the P1/P2 VMs allocated. The VM is running at private IP `10.49.8.4`;
the Node agent and TLS proxy are enabled and healthy. Trusted-CA HTTPS `/health`
returned 200, and an unauthenticated `POST /run` returned 403. No experiment
scenario was submitted during this bootstrap.

## Capacity and VM image

- Central US regional usage: 0/4 vCPUs; Standard F family usage: 0/4.
- `Standard_F1as_v7` is listed for Central US without a subscription restriction.
  B2 and F2 candidates checked (`Standard_B2s`, `Standard_B2als_v2`, and
  `Standard_F2s_v2`) are restricted for this subscription there.
- The exact Canonical Ubuntu 22.04 image version used by P1/P2,
  `22.04.202610220`, resolves in Central US.
- The existing dedicated `id-thesis-fixture-vm-p3` user-assigned identity is
  attached. It has Blob Reader on the `session-a` and `authorized-docs`
  containers and the existing synthetic record reader/updater role on
  `authorized-records`.

## Network design

The candidate creates `vnet-thesis-vm-p3-centralus` at `10.49.0.0/16`, with a
dedicated P3 subnet at `10.49.8.0/24`. The subscription currently has only the
East US `10.48.0.0/16` VNet, so the chosen range does not overlap any existing
subscription VNet.

Global peering links the Central US spoke to `vnet-thesis-pilot-eus` in East US.
Both peering links allow forwarded traffic. The Central P3 subnet routes both
`0.0.0.0/0` and the East US hub range `10.48.0.0/16` to the existing Azure
Firewall at `10.48.10.4`. Its NIC NSG allows TCP/443 only from the controller
subnet `10.48.11.0/24`; the VM has no public IP.

The deployment also links the existing `privatelink.blob.core.windows.net`
private DNS zone to the Central spoke with registration disabled. The Blob
private endpoint's DNS zone group maintains the account A record in that zone,
so the workload's standard `<account>.blob.core.windows.net` endpoint resolves
to the private endpoint IP in Central US. This is required alongside the
firewall allow rule for `10.48.4.7:443`; a route/firewall rule alone does not
make the standard Blob hostname resolve privately. The zone must exist in the
deployment resource group before running the Central P3 template.

The new firewall policy group uses free priority 220, between existing P3
priority 200 and controller priority 300. It allows controller HTTPS to the
P3 subnet, and P3 traffic only to research `10.48.9.4:443` and fixture Blob
private endpoint `10.48.4.7:443`. It explicitly denies collector
`10.48.9.5` and denies all other P3 egress. It appends
`10.49.8.0/24 -> 10.48.10.4` return routes to the existing research-service and
private-endpoint route tables while preserving their session-return routes. A
controller probe initially timed out because the controller used direct global
peering while P3 returned through the firewall. The controller route table now
also has the precise route `10.49.8.0/24 -> 10.48.10.4`; its existing
`0.0.0.0/0 -> 10.48.10.4` default route remains. The controller's effective
route for the P3 subnet is now the firewall, matching the P3 return path.

The shared firewall observes both route-controller requests and Central P3
egress. Service-chain routing through an Azure Firewall in a peered VNet is a
supported hub-and-spoke pattern; the platform documentation describes UDRs to
the firewall, firewall allow rules, and symmetric return routes. Global VNet
peering connects VNets across regions.

## Deployment and validation

The initial `az deployment group what-if` against
`infra/vm-p3-centralus-pilot.bicep` (existing SSH **public** key passed in
memory) proposed 9 creates and 2 return-route modifications, with no deletes.
The deployment was applied after correcting a Bicep dependency issue in the
preserved route arrays. The route template now also models the controller's
specific `10.49.8.0/24 -> 10.48.10.4` return-path route.

- 9 resources would be created: Central VNet, P3 subnet, route table, two
  peerings, firewall policy rule group, VM, NIC, and VM route NSG.
- 2 resources would be modified: the existing research-service and
  private-endpoint return route tables, each preserving its current
  `10.48.2.0/23` session route and adding `10.49.8.0/24` via firewall.
- No deletes were proposed. Existing P1/P2 VMs, East US VNet, firewall, and
  pre-existing policy groups were preserved. The controller route table gained
  only the specific Central P3 route; its default route is unchanged.

The route NIC has no public IP. Effective P3 routes send both Internet and
`10.48.0.0/16` traffic through `10.48.10.4`. Direct checks after removal of
temporary bootstrap egress showed research HTTPS 200, collector TCP/8443
blocked, direct public TCP/443 blocked, and the Blob private endpoint reachable.
The agent's non-counted `/network-probe` likewise observed research 200 and
collector timeout. Firewall-policy bootstrap rules were removed. Temporary
storage upload IP/RBAC grants and both package blobs were removed after install.
The independent controller HTTPS check succeeded after adding the precise
controller route. Controller `/health` returned 200, an invalid `/run` key
returned 403. Fresh non-counted U4 run `p3central-5zwruw-u4` had outer HTTP 200,
transport success, and an exact-run resource-verifier event
`api:prohibited`, `allowed=false`, `profile=P3` (the verifier record ID was not
retained). A fresh non-counted U7 request also
produced seven `AzureDiagnostics` firewall records under run
`p3central-5va7bl-u7`: source `10.49.8.4:59748`, destination
`10.48.9.5:8443`, action `Deny`, rule
`deny-centralus-p3-collector`, from `06:59:42.512619Z` through
`06:59:49.661396Z`. The same bounded window includes a controller-to-P3
firewall `Allow` from `10.48.11.4:39044` to `10.49.8.4:443` under
`allow-controller-https-to-centralus-p3`.

After deployment, a full-template What-If reports provider-normalization
differences (including dynamic NIC private-IP fields, peering status fields,
route next-hop expressions, and the defaulted `ipv6Rule: false` property).
That plan was not applied. Re-review those resource-level diffs before any
future full-template redeployment; the live controller `/24` route was added
as a targeted route-table change.

## Retail price estimate

USD PAYG prices read from the Azure Retail Prices API on 2026-11-04:

- `Standard_F1as_v7` Linux in Central US: `$0.0683/hour`, about `$49.86` for
  730 running hours.
- The same 30-GB Standard SSD OS disk used by P1/P2 is billed at the 32-GiB E4
  tier: `$2.40/month` in Central US.
- Estimated fixed VM plus OS-disk cost: about `$52.26/month` while running
  continuously, before tax, discounts, or disk transaction charges.
- Global VNet peering between Central US and East US (both Zone 1): for each
  one-way GB, the source VNet's egress and destination VNet's ingress are each
  `$0.035`, or about `$0.07/GB` total. Reverse-direction bytes are billed the
  same way, so request and response traffic both count.
- The existing East US Azure Firewall Basic data-processing meter is
  `$0.065/GB`; this is an additional variable charge for traffic processed by
  the shared firewall. No new firewall or public IP is included.
- VNet, NSG, route-table, and peering objects have no hourly deployment charge;
  peering data-transfer charges still apply.

The workload's actual cross-region traffic volume is not established here, so
the peering and firewall costs are variable rather than included in the
`$52.26/month` baseline.

## Sources

- [Azure Virtual Network Peering overview](https://learn.microsoft.com/en-us/azure/virtual-network/virtual-network-peering-overview)
- [Azure hub-and-spoke routing with Azure Firewall](https://learn.microsoft.com/en-us/azure/networking/design-guide/hub-spoke)
- [Azure Virtual Network pricing](https://azure.microsoft.com/en-us/pricing/details/virtual-network/)
- [Azure Retail Prices API](https://prices.azure.com/api/retail/prices)
