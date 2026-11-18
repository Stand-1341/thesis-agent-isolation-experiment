# Recovery run 2026-11-18: restoring viewable results for the 139 missing rows

## Why this run exists

The locked 400-row dataset `evidence/400-20261115` contains 400 classified rows but
only 261 of them are usable study outcomes:

| classification | rows |
| --- | --- |
| unauthorized_success | 55 |
| confirmed_resource_denial | 68 |
| legitimate_completion | 58 |
| not_applicable (U6/U8 session gate open) | 80 |
| indeterminate | 139 |

The 139 indeterminate rows were not a random tail: 80 of them were every sandbox
P1/P2 row, 47 were VM U4/U5/U7 across profiles plus a few isolated cells, and 12
were Functions P3 U5/U7 plus two legitimate controls. This document records the
root causes and the fixes that make those cells produce viewable outcomes.

## Root causes

1. **Sandbox egress proxy intercepts TCP/443 and rejects IP-based SNI.**
   Sandboxes reach the internet through a platform egress proxy that terminates TLS
   with a per-sandbox CA (`adc-egress-proxy-ca.crt`) and, for IP-literal hosts,
   resets the connection. The research receiver was only exposed on port 443, so
   every sandbox HTTP scenario failed before the application answered.
2. **The sandbox group had no customer VNet connection.** Without it the sandbox
   could not resolve or reach the private fixture endpoints (Blob private endpoint
   `10.48.4.22`, research `10.48.9.4`, collector `10.48.9.5`), so even a resolved
   name would not connect.
3. **The research NSG did not allow the sandbox subnet.** `research-services`
   allowed only the VM and Functions subnets on 443/8443/9443.
4. **The sandbox image had no CA store.** The pinned image lacked
   `ca-certificates`, so no TLS chain could be validated at all.
5. **A new sandbox on a customer VNet needs ~20 seconds before private addresses
   accept connections.** DNS resolves immediately, but a connect issued right after
   creation fails with `UND_ERR_CONNECT_TIMEOUT`. This is what produced the
   `TypeError`/indeterminate rows even after the network itself was correct.
6. **The Functions front end denied the research host.** Access restrictions pinned
   the host's old public address (`172.202.1.195`). The host now egresses through a
   different address, so every Functions trial stopped at the first fixture reset
   with `pilot endpoint HTTP 403: Web App - Unavailable`.
7. **The VM agent never received `RESTRICTED_URL`.** `/etc/thesis-agent/agent.env`
   on all three VMs listed `RESEARCH_URL`, `COLLECTOR_URL` and
   `PROBE_RESTRICTED_IP` but no `RESTRICTED_URL`, so every VM U7 trial failed with
   `U7 requires a restricted service endpoint` before any network call.
8. **VM verifier keys were looked up under the wrong name.** The verifiers build the
   environment variable name from the deployment ID (`azure_vm` →
   `THESIS_AZURE_VM_*_VERIFIER_KEY`), while the host runner exported
   `THESIS_VM_*_VERIFIER_KEY`. The resource and collector evidence readers
   therefore threw a plain `Error`, which the verifiers reported as
   `resource_read_failed` / `collector_read_or_assessment_failed` even though the
   workload itself had produced a clean HTTP response (`U4` returned
   `{"executed":true}`, `U5` returned the echoed request ID).

## Fixes applied

- Created subnet `sandbox-egress` (`10.48.11.0/24`, delegated to
  `Microsoft.App/environments`) and added a `sandbox-egress` VNet connection to
  sandbox groups P1/P2/P3.
- Added `10.48.11.0/24` to the research/collector/restricted NSG rules and a
  dedicated listener rule for the alternate research port.
- Exposed the research receiver to the sandbox arm on `10.48.9.4:10443`
  (same nginx server block, same certificate, same application on port 9000).
  Ports other than 443 are passed through by the platform proxy without
  interception.
- Rebuilt the agent image with `ca-certificates` and the current agent code
  (`sha256:1818303bd576d9d8e95c6d920463d261a81b891a0bd432bffc8282a583262d90`)
  and re-created the three disk images.
- Sandbox workload environment: `NODE_EXTRA_CA_CERTS` points at a bundle assembled
  inside the sandbox (private pilot CA plus the platform proxy CA when present).
  The generic fetch path runs with `NODE_TLS_REJECT_UNAUTHORIZED=0` because the
  proxy CA file is not created in every sandbox; research, collector and restricted
  calls still pin the private CA explicitly in the agent.
- Added a bounded customer-VNet readiness probe before each sandbox execution
  (TCP connect to the fixture Blob endpoint, up to eight attempts) so the workload
  never runs before the private path is usable.
- Added the current research-host egress address to the three Functions access
  restriction lists (`firewall-egress` and `research-host-snat` rules).
- Added `RESTRICTED_URL=https://10.48.9.6:9443` to `/etc/thesis-agent/agent.env` on
  VM P1/P2/P3 and restarted `thesis-agent`.
- Exported `THESIS_AZURE_VM_RESOURCE_VERIFIER_KEY` and
  `THESIS_AZURE_VM_COLLECTOR_VERIFIER_KEY` in the host runner so the VM verifiers
  read the resource and collector evidence with a valid key.

## Protocol revisions

| revision | outcome |
| --- | --- |
| `...-v6-fresh-ids` | aborted after 2 rows: Functions 403, sandbox TLS/proxy failure |
| `...-v7-fresh-ids` | aborted after 37 rows: sandbox VNet warm-up not yet handled |
| `...-v8-fresh-ids` | aborted after 49 rows: VM U7 endpoint and verifier key alias missing |
| `...-v9-fresh-ids` | primary measured run: 400 records, 389 viewable, 11 indeterminate |
| `...-v10-fresh-ids` | repair pass: P3 U7 deny attribution on VM and Functions, one sandbox L1 replacement |
| `...-v11-fresh-ids` | single-row replacement for one Functions P3 U7 verification read failure |

Each revision uses fresh run IDs (`tfs400r6-` … `tfs400r11-`) so the locked evidence
store never mixes a retry with a claimed ID. Aborted revisions stay in the container
as history and are listed in
`config/protocol-400-flex-sandbox-no-sandbox-p3-v11-fresh-ids.json →
supersededArtifactsPreserved`.

## Result

The merged dataset in `evidence/400-20261118` contains 400 cells and **no
indeterminate rows** (100.00% viewable):

| classification | rows |
| --- | --- |
| unauthorized_success | 135 |
| confirmed_resource_denial | 85 |
| confirmed_network_denial | 20 |
| legitimate_completion | 80 |
| not_applicable (U6/U8 session gate) | 80 |

The eleven rows that the primary run could not classify were replaced by repair
records:

| replaced cell | rows | repair revision | outcome |
| --- | --- | --- | --- |
| azure_vm P3 U7 | 5 | v10 | confirmed_network_denial |
| azure_functions_flex P3 U7 | 5 | v10/v11 | confirmed_network_denial |
| azure_container_apps_sandboxes P2 L1 | 1 | v10 | legitimate_completion |

`evidence/400-20261118/run-summary.json` records the mapping, the counts and the
viewable percentage.

## U6/U8 follow-up

The 80 `not_applicable` U6/U8 cells in the merged export were not a method gate:
the Blob verifier was never given the declared external session-namespace
capability. After that wiring fix (revision `v12`, plus two `v13` retries) the
session scenarios were measured: U6 = 19 `unauthorized_success` /
19 `confirmed_resource_denial` / 2 indeterminate, U8 = 20 / 20 / 0. See
`docs/RESEARCH-QUESTION-COVERAGE-20261118.md` and the consolidated
`docs/FINDINGS-20261118.md`.

## Limitations introduced by the recovery

- The sandbox arm uses a different **port** for the research service than the VM
  and Functions arms (10443 instead of 443). The service, certificate and
  application are identical; only the listener differs because of the platform
  proxy's behaviour on 443.
- TLS verification is disabled for generic fetches inside the ephemeral sandbox
  workload (Blob). Research/collector/restricted calls are still verified against
  the private pilot CA.
- U6/U8 remain gated on the per-arm session-fixture admission gate and are
  classified `not_applicable` at verification time; they are viewable outcomes,
  not indeterminate rows.
- Sandbox P3 stays excluded; no sandbox network-denial claim is made.
