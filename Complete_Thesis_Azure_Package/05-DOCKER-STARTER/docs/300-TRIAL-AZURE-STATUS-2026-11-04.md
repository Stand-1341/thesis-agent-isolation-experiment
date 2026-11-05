# 300-trial Azure experiment status

**Checked:** 2026-11-04 19:48 UTC
**Protocol:** `azure-proposed-v1-rev3` (`planning_not_validated`)
**Subscription:** authenticated; read-only inventory only during this check.

## Revised design

- The active deterministic schedule is `../03-PLANNED-TRIAL-MATRIX-300-REV3.csv`, SHA-256 `a6bc3ffe78d677d25e07452e06cfc437062fdd9e8322b4c834d31118337ccc7e`.
- It has 300 scheduled rows across VM and Functions P1/P2/P3: five blocks of 60, 50 rows per deployment/profile cell, 240 unauthorized and 60 legitimate.
- The 100 ACA P1/P2 rows from the prior 400-row revision were withdrawn at the study owner's direction. The previous 400-row matrix is preserved unchanged.
- U6/U8 are explicitly out of scope for sessionless VM/Functions routes (60 schedule rows). These are not prevention results.
- Current structural classification: 220 measurable, 60 not applicable, 20 unsupported. Even after P3 telemetry is fixed, at most 240 rows are in-scope for these six routes.
- The GPT-5 mini live-agent entry is still a separate draft arm; it is not invoked by the deterministic runner and has not been frozen or counted as these 300 trials.

## Local checks completed

- `npm test`: **362 passed, 0 failed**.
- `python scripts/test_supplied_plan.py`: **3 passed**.
- `git diff --check`: passed.
- Schedule generators verify the 300-row and 60-row non-counted pilot digests without writing files.
- Structural dry-run: `node scripts/run-experiment-cli.mjs --config config/experiment.example.json --dry-run --json` correctly refuses readiness and executes no trial.

## Live Azure inventory

Read-only Azure CLI inventory on the selected subscription found two running private VMs (`thesis-controller-pilot`, `thesis-p3-targets`, both `Standard_F1as_v7`), one running Functions Flex P1 pilot app (`thesis-flex-pilot-20261103`), no ACI groups, and no ACA session environment/pool. Functions P2/P3 and validated workload routes for VM P1/P2/P3 are absent. The existing VMs are support/target hosts, not validated experiment routes. A firewall, storage, registry, identities, VNets and other pilot resources remain provisioned; nothing was deleted or deallocated in this check.

## Why the 300-row run is still blocked

1. **Six live routes are not deployed and bound.** The example config still contains placeholder hostnames and principal IDs; `config/experiment.json` is absent.
2. **20 P3 rows lack independent deny evidence.** VM and Functions P3 U5/U7 need correlated enforcement evidence, not just a failed connection.
3. **Credentials and dependencies are missing.** Preflight lists 11 credential variables; live dependency inputs and endpoints also need real values. Secret values must not be committed.
4. **All four measured-run gates are unverified:** `protocolFrozen`, `deploymentValidated`, `isolationValidated`, and `verifierValidated`. CLI flags cannot substitute for evidence.
5. **Protected evidence custody is not proven for this revision.** Retention preference alone does not establish institution-approved retention or a locked evidence policy.
6. **No current 60-row live route pilot has passed.** The prior Functions P1 attempts include indeterminate records; they are not evidence that all six routes work.
7. **The LLM arm is separate and draft.** Do not report GPT-5 mini interaction results as part of the 300 deterministic rows.

## Cost and run state

No measured trial was launched; no container group is active. Both VMs and the existing pilot resources remain allocated. The last reliable cost snapshot in the historical revision-2 report was **$84.8099 month-to-date at 2026-11-04 18:57 UTC**; billing can lag. The usage query in this check returned records without usable cost amounts, so it does not establish a newer total or remaining credit. The $125 budget is an alert threshold, not a hard spending cap.

**Conclusion:** the revision-3 files and local runner are consistent, but the Azure study is not deploy-ready. Deploying now would not enable the full 300-row run; the routes, P3 evidence, secrets, protected evidence policy, pilot, and four readiness gates must be completed and evidenced first.

## Checkpoint: 2026-11-05 00:29 UTC

- Updated `/opt/thesis-research/dist/resource.js`, `collector.js`, and `collector-journal.js` on `thesis-p3-targets` to the checked-out build, verified their SHA-256 hashes, and restarted both systemd services. Both services are active; the controller receives `{"ready":true}` from each health endpoint.
- The first diagnostic attempts exposed a controller trust-store issue: shell `curl` could validate the private TLS certificate, while Node `fetch` timed out. Running Node with `NODE_EXTRA_CA_CERTS=/opt/thesis-aci-runner-20261104/certs/thesis-pilot-ca.pem` fixed it.
- A fresh, non-counted ACI P1 U1/U5 synthetic diagnostic then passed both operations with HTTP 200, matching request IDs, and matching collector correlation. Its ACI group was deleted. It made no GPT-5 mini call and is not a study trial.
- Final Azure inventory shows no ACI groups running. The two support VMs remain running; no resources were deallocated.
- The revision-3 measured preflight remains blocked exactly as listed above. No measured trial has started. The latest diagnostic does not validate the 300-row VM/Functions routes or clear the four measured-run gates.
- To reproduce the diagnostic from the controller, set `NODE_EXTRA_CA_CERTS` to the installed pilot CA before starting Node. Do not treat an HTTP 200 health response from `curl` alone as proof that Node trusts the private certificate.
