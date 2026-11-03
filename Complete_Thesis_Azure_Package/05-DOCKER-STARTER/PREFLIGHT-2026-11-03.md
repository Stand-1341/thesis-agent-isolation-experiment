# Deployment preflight report — 2026-11-03

## Current result

**BLOCKED — no trial execution.** This preflight was run locally against revision 2, using the frozen 400-row schedule and `config/experiment.example.json`. Its digest is `d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863`.

| Scope result | Rows | Meaning |
| --- | ---: | --- |
| Measurable by the declared scope rules | 320 | Structurally in scope; Azure pilot validation is still required. |
| Not applicable | 60 | U6/U8 on VM and Functions, recorded without invoking a workload. |
| Unsupported pending network-denial capability | 20 | VM and Functions P3 U5/U7; the run is refused until `--deps` advertises validated evidence capability. |

The base preflight was run without `--deps`, so its network-capability source was unknown. A second structural pass with `--deps scripts/deps-live.mjs` found three absent live inputs: `THESIS_DENIAL_DESTINATION_IP`, `THESIS_LOG_ANALYTICS_WORKSPACE_ID`, and `THESIS_VM_TARGET_RESOURCE_ID`. The Functions capability also needs `THESIS_FLEX_SOURCE_IP` to be configured. `deps-live.mjs` can advertise VM flow-log and Functions firewall capabilities only when their inputs are available; that declaration is configuration readiness, not proof that deny records arrive. Pilot evidence is still required.

The example config has eight active revision-2 routes and names **23 route credential environment variables**. None were populated in the Codex process during inspection, and there is no local `config/experiment.json`. The values must be supplied securely by the operator; this report does not store them. The four readiness gates and seven live verifier pilot assertions remain unverified.

Read-only Azure inspection confirmed the CLI is signed in to an enabled subscription. The research VM is running with private IPs only and no public IP/FQDN. The Functions app query returned no default host name and showed one system-assigned identity. These facts do not provide the required eight validated routes or independently verified evidence paths. Docker Engine is installed and running.

## Reproduce the structural preflight

From `Complete_Thesis_Azure_Package/05-DOCKER-STARTER`:

```powershell
npm run check:deploy
```

This runs the CLI with the example config and revision-2 matrix. It checks local configuration shape, the declared matrix digest, row applicability, and missing credential variable names. It does not execute trials or prove endpoint reachability, telemetry delivery, or readiness gates. A nonzero exit is expected while the config is a template and readiness is incomplete.

To run it against a real operator-managed config and live dependency module after securely providing required inputs:

```powershell
node scripts/run-experiment-cli.mjs --config config/experiment.json --deps scripts/deps-live.mjs --dry-run
```

To verify runner implementation separately:

```powershell
npm run verify
```

After fixing a Windows file-URL bug in a new CLI test, the current local build and suite passed: **164 tests, 164 passed**. This is software verification, not cloud experiment validation.

## Still required before running the 400-row study

1. Supply a real eight-route configuration with eight distinct active workload principals and the 23 selected-route credentials, kept outside Git.
2. Supply the live dependency inputs, including workspace ID, VM flow-log target, controlled denial destination, and Functions outbound source address. `deps-live.mjs` does not consume a subscription ID, so it is not required as an environment variable. Validate that each query returns complete, correctly attributed records; capability metadata alone is insufficient.
3. Resolve live routes: the VM currently has no public endpoint, and the Functions app returned no default hostname. Provide supported controller-to-workload connectivity and validate each adapter.
4. Run the non-counted pilot, prove the seven verifier assertions and four readiness gates with evidence, protect the evidence independently, and freeze the approved schedule and protocol.
5. Rerun preflight with the real config and `deps-live.mjs`; review it before launching the measured schedule.

No measured trial was run and no trial outcome is reported here.
