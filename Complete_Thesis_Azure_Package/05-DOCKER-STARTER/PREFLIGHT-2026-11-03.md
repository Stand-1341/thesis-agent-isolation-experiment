# Deployment preflight report — 2026-11-03

## Result

**BLOCKED — no deployment or experiment trials were started.** This report records a local structural preflight of the frozen 450-row schedule and `config/experiment.example.json`. It did not contact Azure, prove the Azure readiness gates, test endpoint reachability, or validate live telemetry.

The schedule digest was `39bb833e0a3af2c7bcbd9c7460119cbac97c324cf07bda4ebcc3b10cfd532298`.

| Scope result | Rows | Meaning |
| --- | ---: | --- |
| Measurable by the current scope rules | 320 | Structurally in scope; this does not mean cloud validation passed. |
| Not applicable | 60 | U6/U8 on the VM and Functions deployments; these can be recorded as N/A without invoking the workload. |
| Unsupported | 70 | The runner refuses to claim or execute these rows. |

The 70 unsupported rows are:

- **50 custom-session P3 rows:** the current session-pool design cannot provide the study's selective egress restriction with independently attributable denial evidence.
- **10 VM P3 U5/U7 rows** and **10 Functions P3 U5/U7 rows:** no independent network-denial telemetry capability is configured for those deployment routes.

The example configuration also refers to **24 credential environment variables** that were not present during this check. The check printed their names only; it did not read or reveal credential values. The four readiness gates—protocol frozen, deployment validated, isolation validated, and verifier validated—remain unverified. A structural preflight cannot establish them.

## How to reproduce

From `Complete_Thesis_Azure_Package/05-DOCKER-STARTER`:

```powershell
npm run check:deploy
```

This runs `node scripts/run-experiment-cli.mjs --config config/experiment.example.json --dry-run`. The dry run validates the config shape and frozen matrix digest, selects the planned rows, and reports applicability, unsupported scope, and missing credential variable names. It does not load runtime adapter/verifier modules or connect to Azure. Exit code **4** is expected here because this structural report is not deployment readiness and the required credentials/scope support are missing.

To verify the local runner implementation and tests separately:

```powershell
npm run verify
```

At the time of this report, build and tests passed: **156 tests, 156 passed**. That verifies local code behavior only, not Azure deployment or isolation.

## Required before a valid full run

1. Resolve the unsupported P3 network-evidence design. In particular, select and pilot a supported design for custom sessions, and configure independently attributable denial telemetry for VM and Functions U5/U7.
2. Create and validate the real deployment config, including nine distinct workload identities/routes and the required credential variables. Do not place secret values in this repository.
3. Deploy and exercise the selected Azure routes and injected runtime adapters/verifiers. The example config is not a deployable config.
4. Collect evidence that each readiness gate and every required pilot assertion passes, then freeze the approved protocol and schedule.
5. Rerun preflight and review the resulting report before starting trials. The runner will reject unsupported P3 rows before any run ID is claimed.

No trial evidence or outcome is reported by this preflight.
