# Private VM route TLS setup

Each VM route terminates TLS on its own private IP with nginx. The agent stays
on loopback HTTP port 8080; clients use `https://<route-private-ip>/`. The
route NIC NSG continues to allow TCP/443 only from the experiment controller
subnet. The TLS private key is generated on that route VM and remains there.

## Per-route certificate issuance

1. Install the VM workload package and nginx on the route VM. The systemd unit
   must set `BIND_ADDRESS=127.0.0.1`; the TLS installer refuses to proceed if
   the service could accept cleartext traffic on a non-loopback interface.
2. Run `/usr/local/sbin/create-vm-agent-csr.sh <route-private-ip>` as root on
   that VM. This creates `/etc/thesis-agent/tls/agent.key` (root-only) and
   `/etc/thesis-agent/tls/agent.csr`. Transfer only the CSR to the research
   host; never transfer the private key.
3. Use Azure Run Command to send the public helper
   `infra/sign-vm-agent-csr.sh` to the research host and run it as root with
   `<csr-file> <route-private-ip> <output-cert>`. Only the CSR and helper text
   cross that boundary. The CA key stays in `/etc/thesis-research/tls/ca.key`;
   the helper emits only a signed certificate. It adds the exact route IP as
   an IP SAN, verifies the chain and expiry, and serializes issuance with a
   lock.
4. Transfer the signed certificate back to the same route VM as
   `/etc/thesis-agent/tls/agent.crt`, owned by root with mode `0600`. The
   private key remains at `/etc/thesis-agent/tls/agent.key` with mode `0600`.
5. Run `/usr/local/sbin/install-vm-agent-tls.sh <route-private-ip>
   /etc/thesis-agent/tls/agent.crt /etc/thesis-agent/tls/agent.key
   /opt/thesis-agent/vm-agent-nginx.template` as root on the route VM. It checks
   the trusted CA chain, exact IP SAN, certificate lifetime, and key match,
   then stages an nginx site and confirms `nginx -t`. It does not start or
   reload either service; the route operator should activate them only after
   the workload configuration and local health check are ready.

The bundled `certs/thesis-pilot-ca.pem` is the public trust anchor used by the
VM Node workload and client packages. Do not copy the CA private key, include
route private keys in workload packages, or print either key. Reissue a route
certificate when its VM IP changes. The signed leaf lasts 300 days and is
rejected by the installer within 30 days of expiry.

## Route package integration

The route package builder must include `infra/vm-agent-nginx.template` and the
three helper scripts as package assets. The package manifest must hash the
template and scripts; it must never contain a route certificate or key. The
agent service unit needs `Environment=BIND_ADDRESS=127.0.0.1`, and the route
startup workflow should stage the TLS site before enabling nginx. The existing
CA trust environment (`NODE_EXTRA_CA_CERTS`) lets the agent validate the
research and collector HTTPS endpoints.

TLS configuration and a successful `/health` request establish transport
connectivity only. They do not establish route identity binding, P1/P2
authorization, P3 containment, or independent evidence readiness.
