# Thesis experiment workspace

This private repository contains the experiment protocol, Azure deployment
templates, source code, tests, and the latest status notes.

## Readiness

**Not ready for measured trials.** The revision-2 400-row matrix is a planned schedule,
not a result set. Local tests and deployment smoke checks have passed, but the
full Azure pilot has not.

Revision 2 withdraws P3 for Azure Container Apps custom sessions because its
binary egress control cannot meet the study's selective-containment requirement.
The remaining active P3 network cells are on VM and Functions; they still need
independent, attributable denial telemetry and a passing pilot before they are
measurable.

Other open gates include end-to-end validation of all eight active
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
python3 scripts/validate_supplied_plan.py
```

Passing local checks do not qualify the cloud experiment for execution. Keep
the runner gated until every pilot acceptance item is verified.
