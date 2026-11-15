# Azure deployment status

**Snapshot:** 2026-11-14/15 live Azure query  
**Subscription:** `a0129b37-1075-48a4-82f9-bbc6d96d8eb3`  
**Resource group:** `rg-thesis-study-central-a0129b37`  
**Environment:** `thesis-study`

## Current outcome

The full ARM deployment `thesis-three-arm-full` is **Succeeded**. All compute,
network, storage, identity, firewall, Functions, Sandbox-group, and research-host
resources are provisioned.

The post-provision hook is **not complete**. Functions P1 and P2 packages are
published and trigger-verified. Functions P3 package publication failed because
the P3 Function host is not resolving its platform/storage endpoints through
the P3 firewall:
 
- P3 main and SCM endpoints time out.
- Firewall `p3-default-deny` records show P3 subnet `10.48.6.235` being denied
  to destinations including `20.44.13.224:443`, `52.182.143.192:443`, and
  `185.125.190.106:443`.
- P1/P2 SCM endpoints answer correctly.

## Valid now

- Azure resource deployment: valid and succeeded.
- Generated experiment config: 9 routes resolved.
- Key Vault/bootstrap/image checkpoints: valid.
- Functions P1 package: published and trigger-verified.
- Functions P2 package: published and trigger-verified.
- P3 firewall rule groups: applied.
- Evidence, fixture, registry private endpoints: provisioned; DNS/round-trip
  validation not yet run.
- Sandbox groups: provisioned; disk-image bootstrap not yet run.
- Research host VM and data disk: provisioned; host software/TLS/services not
  yet installed.

## Not valid yet

- P3 Functions app: unreachable; no package.
- Sandbox disk-image/runtime bootstrap: not run.
- Research-host bootstrap: not run.
- Deployment validation V1–V5: not run.
- Deployment/reporting manifest: not emitted.
- Evidence retention policy: not locked.
- Pilot evidence, P3 denial telemetry, U6/U8 fixtures: not established.
- Measured execution: not authorized and not run.

## Why the official experiment is not running

The frozen v3 protocol requires all three arms, including Functions P3, and has
`measuredExecutionEnabled: false`. Running a subset would be a separate
non-counted smoke/pilot, not the measured experiment. The current route data is
therefore preparation only.

## Next fixes

1. Add the exact missing Functions P3 platform egress endpoints/service tags to
   the P3 allowlist, based on live firewall denials.
2. Republish the P3 Functions package and verify its triggers.
3. Run Sandbox bootstrap.
4. Run research-host bootstrap.
5. Run V1–V5 validation and emit readiness.
6. Resolve evidence retention, pilot evidence, and owner authorization before
   any measured study launch.
