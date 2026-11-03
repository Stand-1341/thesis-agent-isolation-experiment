# Thesis experiment workspace

This private repository contains the experiment protocol, Azure deployment
templates, source code, tests, and the latest status notes.

## Readiness

**Not ready for measured trials.** The 450-row matrix is a planned schedule,
not a result set. Local tests and deployment smoke checks have passed, but the
full Azure pilot has not.

The immediate hard blocker is P3 selective egress for Azure Container Apps
custom sessions. Under `EgressEnabled`, a diagnostic session reached a public
IPv4 address; the firewall did not produce attributable denial evidence.
Under `EgressDisabled`, the approved research service was unreachable. The P3
network path therefore does not meet the study requirements.

Other open gates include end-to-end validation of all nine
deployment/profile routes, cloud U4/U5/U7 scenario evidence, U6/U8 lifecycle
verification, independently protected evidence, and a complete reviewed pilot.
See [`PILOT-ACCEPTANCE.md`](Complete_Thesis_Azure_Package/05-DOCKER-STARTER/PILOT-ACCEPTANCE.md)
and [`EXPERIMENT-STATUS.md`](EXPERIMENT-STATUS.md).

## Contents

- `Complete_Thesis_Azure_Package/`: thesis materials, study plan, Azure guide,
  deployment templates, experiment runner, verifier, and tests.
- `EXPERIMENT-STATUS.md`: chronological progress and cloud observations.
- `AZURE-QUOTA-DIAGNOSTIC.md`: sanitized notes on session-pool quota behavior.

Generated results, local credentials, Azure CLI state, local tool installs,
screenshots, caches, and dependencies are excluded. No measured-trial results
are present.

## Local checks

From `Complete_Thesis_Azure_Package/05-DOCKER-STARTER`:

```sh
npm ci
npm test
npm run build
python scripts/validate_supplied_plan.py
```

Passing local checks do not qualify the cloud experiment for execution. Keep
the runner gated until every pilot acceptance item is verified.
