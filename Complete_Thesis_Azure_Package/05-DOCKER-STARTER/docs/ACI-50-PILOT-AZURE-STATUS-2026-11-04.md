# GPT-5 mini ACI 50-condition pilot status

**Checked:** 2026-11-04 18:48 UTC
**Scope:** separate, non-counted GPT-5 mini indirect prompt-injection pilot; 50 conditions in 25 matched clean/attack pairs. It is separate from both the thesis's 450 deterministic trials and the older deterministic ACI 50-row draft.

## Verified progress

- The frozen live-model schedule has SHA-256 `b63e949f035ee278ebc932404d48445e667c096ff679f8ef32e14d41e7de26eb`.
- Owner approval of the separate, non-counted GPT-5 mini 50-condition extension is now recorded with the frozen schedule hash in [ACI-P1-LIVE-INJECTION-50-OWNER-APPROVAL.md](ACI-P1-LIVE-INJECTION-50-OWNER-APPROVAL.md). The protocol is marked `approved_for_non_counted_pilot`; the 450 deterministic study remains separate.
- The full local verification command completed successfully: build passed and **363 tests passed, 0 failed**.
- Azure GPT-5 mini `2025-08-07` is deployed in `rg-thesis-experiment-eus` with Global Standard capacity 25.
- From the running `thesis-controller-pilot` VM, its user-assigned managed identity obtained a token and completed an Azure OpenAI Responses API request. Azure returned HTTP 200, `status=completed`, and one model-generated function call. The function was a harmless probe and was not executed. Evidence: [ACI-P1-GPT5-MINI-IDENTITY-SMOKE-2026-11-04.md](ACI-P1-GPT5-MINI-IDENTITY-SMOKE-2026-11-04.md).
- The runner records a $0.25 maximum per condition and $12.50 model-only cap for all 50. Azure compute, networking, logging, and storage charges are outside that cap.
- The updated ACI image passed a non-trial deployment smoke: private health, P1 workload-identity Blob read, fixture cleanup, and confirmed group deletion. Evidence: [ACI-P1-DEPLOYMENT-HEALTH-SMOKE-2026-11-04.md](ACI-P1-DEPLOYMENT-HEALTH-SMOKE-2026-11-04.md). This passes deployment health only; U1/U5 audit verification remains open.
- Azure currently reports **no ACI trial container groups running**. The temporary health-smoke group was deleted. No live-pilot condition has run.
- The controller VM and research/collector VM are **running**. The controller VM was already running; the research/collector VM was started because the Functions diagnostics showed both services were offline. They remain running as requested. No VM was deallocated.
- Non-container checks passed: Functions P1 network diagnostics; route authentication and invalid-scenario rejection before execution; research and collector HTTPS `/health` checks. Details: [NON-CONTAINER-APP-SMOKES-2026-11-04.md](NON-CONTAINER-APP-SMOKES-2026-11-04.md).
- The targeted non-container test suite passed **63/63**. Full project verification passed **363/363**.
- U5 local assessment now fails closed when operation request IDs are missing; it no longer accepts legacy raw-marker-only evidence. The focused collector assessment/verifier tests passed **3/3**, and the full build/test suite passed **363/363** after this change. This does not prove the live Azure audit correlation path.
- Controller managed identity successfully read the six required ACI pilot secret names from Key Vault and validated each value's enabled/nonempty shape without displaying or retaining any value. Pinned Node.js `v22.23.4` and npm `10.9.9` are installed on the controller VM. The runner package was transferred with a verified SHA-256 and its lockfile dependencies installed; the remote dry-run remains fail-closed with eight blockers. Details: [controller runner transfer and preflight](ACI-P1-CONTROLLER-RUNNER-TRANSFER-2026-11-04.md).
- Created `id-thesis-evidence-writer` as a separate managed identity. Current read-only Azure RBAC inventory shows it has `Storage Blob Data Contributor` on `trial-evidence`, and `id-thesis-evidence-reader` has `Storage Blob Data Reader` there. The container still has no immutability policy or legal hold, so writes through the measured evidence store remain blocked until retention is approved and immutability is configured and independently checked.

## Still blocking the 50-condition run

- The image is now pushed and health-tested, but the ACI P1 U1 protected-read and U5 collector routes have not been run end-to-end against the updated image with the independent Azure verifiers. The deployment smoke does not prove those two routes, matched-pair behavior, or prompt-injection scoring.
- Controller configuration, all separated identities, and evidence-container access have not been validated together through the new runner from Azure. Secret values must remain hidden.
- The controller runner now imports and preflights remotely, but its execution configuration and evidence store have not passed the pilot gates.
- The trial-evidence immutability policy is currently `Deleted` with a zero-day retention period. The evidence store cannot yet pass the runner's independently protected, locked-retention requirement.
- The user requested indefinite retention, but the approved department retention schedule has not been established. The university records policy assigns this schedule to the department. Do not assert an indefinite Azure WORM retention or legal hold without that schedule.
- The readiness record remains fail-closed. Protocol freeze, owner method approval, ACI deployment health, and GPT-5 mini identity now have evidence. U1/U5 independent verification, operation-correlation validation, protected evidence, retention approval, credentials, and full cost verification remain open.

## Current cost evidence

The last reliable Cost Management snapshot was **$84.8099 USD month-to-date at 2026-11-04 18:57 UTC**; billing can lag. A later usage query returned no usable amounts, so it does not establish a newer total or refreshed credit balance. The VM, NAT Gateway, Firewall, storage, and other provisioned resources remain allocated; no ACI groups are active.

## Run status

`node scripts/run-aci-live-injection-50.mjs --dry-run` reports `runnable: false` and `executionStarted: false` both locally and from the controller VM. Azure inventory confirms no active ACI groups. No LLM condition, pilot pair, or thesis trial has run. The successful single model tool-call smoke and ACI deployment health smoke are infrastructure evidence, not experiment results.

## 20:18 UTC follow-up

- The model-only spend guard is now recorded as a passed configuration gate, backed by the fixed $0.25/condition and $12.50/phase limits in the protocol and runner. This does not cap infrastructure charges. See [ACI-P1-50-COST-CAP-2026-11-04.md](ACI-P1-50-COST-CAP-2026-11-04.md).
- The controller bundle was missing the public research-service CA file. I copied `certs/thesis-pilot-ca.pem` to `/opt/thesis-aci-runner-20261104/certs/thesis-pilot-ca.pem` through Azure VM Run Command and verified its SHA-256 matches the local certificate. With `NODE_EXTRA_CA_CERTS` set, the controller's read-only credential smoke returned **accepted** for research admin, collector admin, and both independent service-verifier credentials. No secret values were displayed.
- Via the controller's managed identity, the six required Key Vault names were confirmed enabled; each value was fetched only in memory and passed the configured length/character-shape check. The ACI controller key and workload token have not yet been exercised in a newly created ACI group, so the complete credential gate remains false.
- The evidence writer and reader currently have container-scoped Blob Contributor/Reader assignments. The container itself still has no immutability policy or legal hold.
- The current local dry run reports seven remaining blockers: U1 verification, U5 verification, operation-correlation proof, independent evidence protection, department-approved retention, full ACI credential validation, and matching the requested retention to a locked 146,000-day policy. It still reports `executionStarted: false`; no model condition or ACI group was started.
