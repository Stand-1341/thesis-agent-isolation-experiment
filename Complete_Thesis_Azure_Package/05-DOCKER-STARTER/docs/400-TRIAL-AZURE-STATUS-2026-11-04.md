# Historical: 400-trial Azure status (revision 2)

> Superseded on 2026-11-04 by `300-TRIAL-AZURE-STATUS-2026-11-04.md` and `azure-proposed-v1-rev3`. Do not use this file as current deployment or trial instructions.

**Checked:** 2026-11-04 19:00 UTC
**Scope:** deterministic Azure study plan, revision 2. This is separate from the 50-condition GPT-5 mini ACI pilot.

## Frozen plan and local runner checks

- Matrix: `../03-PLANNED-TRIAL-MATRIX-400-REV2.csv`; SHA-256 `d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863`.
- `config/protocol.json` declares 400 rows: 320 unauthorized and 80 legitimate, across five blocks. Its status remains `planning_not_validated`.
- The eight planned routes are VM P1/P2/P3 (150 rows), Functions Flex P1/P2/P3 (150 rows), and custom ACA sessions P1/P2 (100 rows). The session P3 cells were withdrawn in revision 2.
- Targeted protocol/CLI tests passed **21/21**. This validates local schedule and CLI behavior, not Azure deployment readiness.
- Live structural dry-run command:
  `node scripts/run-experiment-cli.mjs --config config/experiment.example.json --deps scripts/deps-live.mjs --dry-run --json`
- Result: 400 selected, 320 structurally measurable, 60 declared not applicable, 20 unsupported; status `structural_only_not_ready`. It executed no trial.

## Current Azure inventory

Read-only subscription inventory found two running VMs (`thesis-controller-pilot` and `thesis-p3-targets`), one running Function App (`thesis-flex-pilot-20261103`), no other Function Apps, no ACA managed environments or session pools, and no active ACI groups. The running VMs are the controller and shared research/collector targets; neither is a validated VM P1/P2/P3 workload route. The Function App is the P1 pilot app; the P2/P3 apps are absent. No custom ACA session P1/P2 endpoints are deployed.

The only experiment config present is `config/experiment.example.json`; it contains replacement URLs and placeholder principal IDs. `config/experiment.json` is absent.

## Preflight blockers

- **20 unsupported rows:** VM P3 U5/U7 (10 each) and Functions P3 U5/U7 (10 each) lack independent network-denial evidence. The live dependency inputs are missing: `THESIS_DENIAL_DESTINATION_IP`, `THESIS_FIXTURE_BLOB_ENDPOINT`, `THESIS_LOG_ANALYTICS_WORKSPACE_ID`, and `THESIS_VM_TARGET_RESOURCE_ID`.
- **13 route/admin credentials** are missing from the current process environment: `THESIS_COLLECTOR_ADMIN_KEY`, `THESIS_RESOURCE_ADMIN_KEY`, `THESIS_VM_P1_CONTROLLER_KEY`, `THESIS_VM_P2_CONTROLLER_KEY`, `THESIS_VM_P3_CONTROLLER_KEY`, `THESIS_FN_P1_CONTROLLER_KEY`, `THESIS_FN_P1_FUNCTION_KEY`, `THESIS_FN_P2_CONTROLLER_KEY`, `THESIS_FN_P2_FUNCTION_KEY`, `THESIS_FN_P3_CONTROLLER_KEY`, `THESIS_FN_P3_FUNCTION_KEY`, `THESIS_SESSION_P1_CONTROLLER_KEY`, and `THESIS_SESSION_P2_CONTROLLER_KEY`.
- All four measured-run assertions remain unverified: `protocolFrozen`, `deploymentValidated`, `isolationValidated`, and `verifierValidated`. The CLI flags are operator assertions; supplying them without evidence would not validate the study.
- The measured evidence container has no locked immutability policy or legal hold. Department-approved retention remains unknown; the user's indefinite-retention preference is not evidence of institutional approval.
- No real route-by-route config, full pilot validation, independent evidence-protection result, or actual measured result exists.

## Run state and spend

No 400-trial row was launched. The only commands run for this audit were local tests, structural preflight, and read-only Azure inventory. Both VMs were left running; no Azure resource was deallocated or created in this audit. A read-only Cost Management query at 2026-11-04 18:57 UTC reported **$84.8099 USD month-to-date**; by service it reported Microsoft.App $56.0242, Network $20.5998, Compute $4.3896, ACR $3.7460, ContainerInstance $0.0126, and roughly $0.0375 across remaining services. Cost data can lag. The $125 monthly budget is an alert budget, not a hard spending cap or remaining-credit balance.

**Conclusion:** the 400-trial run is not ready to deploy. Do not start it by asserting the four gates or by treating the example config as live. The remaining work requires provisioning and validating the missing seven route deployments, completing P3 denial telemetry and evidence custody, populating the exact route config and credentials, and passing the four gates from evidence.
