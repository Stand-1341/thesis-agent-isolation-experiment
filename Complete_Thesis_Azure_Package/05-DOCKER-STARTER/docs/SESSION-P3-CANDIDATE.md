# Isolated-session P3 candidate

The current ACA dynamic-session P3 route remains unsupported. Microsoft's
[session pool documentation](https://learn.microsoft.com/en-us/azure/container-apps/session-pool)
describes the pool's network setting as `EgressEnabled` or `EgressDisabled`;
the disabled setting does not by itself permit the research service while
blocking the collector.

[Azure Container Apps Sandboxes](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview)
are a separate service that Microsoft describes as offering sandbox egress
policies, CIDR and domain rules, VNet integration and lifecycle management. It
is a candidate for investigation, not a tested replacement for the thesis's
microVM/session arm. This repository does not yet deploy or operate a Sandbox.
The actual isolation mechanism, regional availability, subscription quota,
credit coverage, policy enforcement, supported audit telemetry and method
equivalence must be independently established before choosing that arm.

## Pilot telemetry correlation

`scripts/session-p3-pilot-evidence.mjs` is a non-counted offline pilot review
helper. It matches a supplied single-session network tuple against supplied
firewall denial rows within a maximum 120-second execution window. Supply a
JSON file with `probe` and `rows`; see the accompanying test for the exact
fields. Run:

```powershell
node scripts/session-p3-pilot-evidence.mjs PATH-TO-LOCAL-PILOT-EVIDENCE.json
```

The reader obtaining firewall rows must be independent from the workload. The
helper does not authenticate rows, verify their source, prove exclusive
attribution of the network tuple, or prove that approved endpoints remain
reachable. A match is not a measured-trial classification or an authorization
to run the original 450-row plan. The existing session P3 scope gate remains
blocked. Check research reachability, denied destinations, redirects, network
policies, session lifecycle and attribution in real cloud pilots before any
readiness decision.
