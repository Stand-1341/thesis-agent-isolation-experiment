# Thesis experiment workspace

This private repository contains the thesis protocol, Azure deployment
templates, source code, tests, and operator notes.

## Current scope and deployment (November 2026)

The active deployment revision is the frozen 450-row v3 matrix:

- traditional VM (`azure_vm`)
- Functions Flex (`azure_functions_flex`)
- ACA Sandboxes (`azure_container_apps_sandboxes`)

It schedules all ten scenarios, including U6/U8 as gated external-namespace
fixtures and P3 U5/U7 on every arm. The measured protocol remains frozen with
`measuredExecutionEnabled: false`; deployment prepares and validates the
environment but does not authorize or start measured trials.

The deployment is a two-stage `azd up` pipeline. It resolves inputs, runs
subscription preflight, provisions foundation resources, seeds Key Vault
secrets, publishes the pinned agent image, provisions the full workload stage,
publishes identical Functions packages, creates Sandbox disk images, installs
and starts the private research host, then emits validation and readiness
artifacts. See [DEPLOYMENT.md](DEPLOYMENT.md) for the exact operator workflow
and current caveats.

A successful deployment is not a completed study. Measured execution is
separately gated by pilot evidence, externally attributable P3 network-denial
telemetry, U6/U8 fixture validation, locked evidence retention, independent
verification, budget monitoring, and a fresh owner authorization bound to the
exact protocol digest.

## Status

See [DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md) for the dated Azure snapshot and
remaining deployment/study work. Do not interpret a template deployment,
structural preflight, or local test pass as evidence that measured trials ran.

For schedule inspection:

```sh
cd Complete_Thesis_Azure_Package/05-DOCKER-STARTER
node scripts/inspect-three-architecture-plan.mjs
```

The measured-results analysis guide explains how to summarize exported records
without treating missing or indeterminate rows as results.

## Contents

- `Complete_Thesis_Azure_Package/`: thesis materials, study plan, Azure guide,
  deployment templates, experiment runner, verifier, and tests.
- `deploy/`: azd pipeline hooks and deployment orchestration.
- `infra/`: two-stage azd entry template and parameters.
- `DEPLOYMENT.md`: canonical deployment instructions.
- `DEPLOYMENT-STATUS.md`: dated live status and remaining work.
- `EXPERIMENT-STATUS.md`: chronological experiment observations.

Generated results, local credentials, Azure CLI state, local tool installs,
screenshots, caches, and dependencies are excluded. No measured-trial results
are present.

## Local checks

From the repository root:

```powershell
npm.cmd test
```

From `Complete_Thesis_Azure_Package/05-DOCKER-STARTER`:

```powershell
npm.cmd test
```

Passing local checks do not qualify the cloud experiment for execution. Keep the
measured runner gated until every pilot acceptance item is verified.
