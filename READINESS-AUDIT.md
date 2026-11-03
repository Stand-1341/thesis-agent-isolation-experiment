# Readiness audit — 2026-11-03

Pre-deployment review of this repository against current Microsoft Azure
documentation. **Nothing was deployed and no Azure API was called by this
review.** Every claim below is either the output of a command run against this
tree or a documentation citation.

Scope: 8 commits from `698d853` to `59d82ea` on top of the original snapshot
`6634c33`. Seven independent review passes (Azure docs conformance, Bicep,
containers, application code, security, study artifacts, test integrity) plus a
maintainer pass that applied the fixes.

---

## 1. Verdict

**The repository is internally consistent and CI-green. The experiment is not
deployable, and no code change can make it so.**

Two blockers sit outside the repository:

1. **The subscription cannot create a second session pool.** One pool was created
   earlier and is reported `Succeeded` with one ready instance; every attempt to
   create or replace another fails with
   `MaxNumberOfGlobalSessionPoolsInSubExceeded` while regional usage reports zero
   pools. Microsoft documents the quota as *subscription and region* scoped and
   reversible only through the Azure Quota Management System or a support case —
   there is no template, CLI or ARM fix. Whether a deleted pool releases quota is
   undocumented, and the error code itself appears nowhere in Microsoft's
   documentation, which is the strongest argument for a support case.

2. **P3 selective egress is not a capability of custom container sessions.**
   `sessionNetworkConfiguration.status` is a binary switch, `EgressDisabled`
   blocks the approved research service as well as everything else, and
   `EgressEnabled` is documented as *internet access* — nothing states that
   session traffic traverses the environment's infrastructure subnet, which is
   why a UDR, NSG or firewall on that subnet has no documented effect on it. The
   recorded cloud behaviour (a session reached a public IP with no attributable
   denial record) is consistent with that gap, not with a misconfiguration. Azure
   Container Apps *Sandboxes* documents per-destination egress rules;
   session pools do not.

150 of the 450 planned trials — the entire sessions arm — have no valid
configuration today. The live pool does not change that: the blocker is the
network model, not the resource existing.

**Live infrastructure is billing right now.** The most recent `EXPERIMENT-STATUS.md`
entry records the research VM `Running`, the session pool up with one ready
instance, a Premium registry holding a pushed probe image, private endpoints, a
firewall, a Log Analytics workspace and a Network Watcher VNet flow log, with
"pilot infrastructure continues to incur charges". `README-FIRST.txt` used to
claim that no cloud resources had been created; that was false and has been
corrected here. The remaining 300 (VM, Functions) are unaffected by both
blockers and can produce P1/P2 evidence.

**Deadline: the subscription credit expires 2026-11-28 02:41:46 UTC.** At the
date of this audit that is 24 days away. A quota case that takes two weeks
consumes most of the remaining runway. Decide the P3 re-scope *before* spending
a quota increase on the diagnostic pool.

---

## 2. What this audit changed

| Commit | Effect |
|---|---|
| `698d853` | The frozen 450-row matrix was stored with LF endings while every recorded digest was computed over its CRLF bytes. On a clone without `core.autocrlf` the file hashed to `c990dadb…` instead of the frozen `39bb833e…`, so the integrity gate and the live-plan generator only worked on the machine that created them. Restored the canonical bytes, added `.gitattributes` (`*.csv -text`, `*.docx binary`), made the live-plan test hermetic instead of reading a gitignored fossil draft, replaced hardcoded test ports with ephemeral ones, added real `test`/`verify` scripts, added CI. |
| `1d124d7` | The build guide and starter README both said `az acr create --sku Basic`, but ACR Private Link — which `registry-private-endpoint-pilot.bicep` depends on — is Premium-only. Corrected in the guide, its `.docx`, and the README. |
| `c3e05ef` | `config/protocol.json` described a matrix that does not exist (`vm`/`functions`/`sessions` versus the frozen `azure_vm`/`azure_functions_flex`/`azure_custom_sessions_hyperv`) and still set a 60-second audit window after the verifiers moved to 300. Aligned, and pinned to the frozen CSV by `protocol.test.mjs`. `Dockerfile.functions` now uses the committed lockfile (`npm ci`). `plan.mjs` is labelled as the legacy sketch it is. |
| `bc574f4` | `.gitignore` missed bare `parameters.json`, `.azure/`, `secrets.json`, `credentials`, `service-account.json` and editor backups of `.env`; the starter's own ignore file was five lines; `.dockerignore` left image hygiene entirely to `COPY` discipline. All closed. The README no longer teaches `docker run -e TOKEN=…`, which exposes values through `docker inspect`. |
| `88afd46` | Flex Consumption subnets carried a `Microsoft.Storage` service endpoint, which Microsoft forbids on an integration subnet — VNet integration would fail or come up unattached. Removed from all three Functions subnets; host storage moved to the reference-sample posture (`Allow` + `AzureServices` bypass, shared keys off, blob public access off, identity-only). |
| `10a5035` | Three P0s: a malformed request target crashed the workload process (`new URL()` outside the try in an async handler); the implementation digest never hashed `functions/`, so the Functions adapter could change without moving the digest; `runSchedule` returned a partial array on halt that was indistinguishable from a completed run. All three fixed and covered by tests. |
| `741f022` | Removed an `AzureFirewallDnsProxy` log category that cannot exist on a Basic-tier firewall; recorded in place that the environment has no Dedicated workload profile (so it cannot host the CustomContainer pools the session templates create) and that adding an E16 profile is a billable, quota-bearing decision; documented the session-pool name-pattern contradiction. |
| `59d82ea` | CI: install Bicep into a writable directory. |
| final pass | `trial-schedule.test.mjs` spawned a binary literally named `python`, which stock Debian/Ubuntu does not provide — the structural check failed before reaching the digest assertion. It now probes `python3`/`python`/`py`. `generate-gpt5mini-live-plan.mjs` never created `results/`, so the documented command died ENOENT on a clean tree; it now `mkdir`s first and produces the draft whose digest (`a62ba3dc…`) matches the one already recorded in `EXPERIMENT-STATUS.md`. `validate-flex-config.mjs` accepted TEST-NET and benchmarking ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 198.18.0.0/15, …) as the trusted controller address, producing an ingress rule that locks the operator out. `Dockerfile.managed-audit-probe` was the one image definition missing from the implementation digest. |

### Verified after the changes

```
npm test                         88 passed, 0 failed   (was 78/80 from a clean clone)
bicep build + bicep lint         22/22 templates, exit 0
docker build                     all 5 images, locally and in CI
git sha256 03-PLANNED-…csv       39bb833e0a3af2c7bcbd9c7460119cbac97c324cf07bda4ebcc3b10cfd532298
implementation manifest          f774425fbda4cb9c749d944146482b58fb28a290db5365060c236dbaff4dd824  (139 files)
```

The workload-crash fix was demonstrated before and after with the same request
line: the build at `HEAD~3` exits on `GET //[` with
`TypeError: Invalid URL at Server.<anonymous> (agent.js:37)`; the current build
answers `400` and keeps serving `/health`.

CI (`.github/workflows/ci.yml`) runs on every push and is green: build and test on
Node 22 and 24, committed-`dist` drift check, frozen-digest guard, study
validators, Bicep compile and lint, and one Docker build per image. It never
authenticates to Azure and never deploys.

---

## 3. Decisions this audit deliberately did not make

Each of these changes cost, security posture, or research design. They are
recorded here rather than applied.

1. **Session arm: re-scope or drop P3.** Options: (a) drop P3 as a
   cloud-enforced profile and revise the third condition; (b) move P3 to the VM
   or Functions profile, where UDR plus Azure Firewall *is* documented; (c) wait
   for Sandboxes-style egress rules to reach session pools. Not a code fix.
2. **Dedicated E16 workload profile.** Custom container pools require a
   workload-profiles environment with at least one Dedicated profile. E16 is 16
   reserved vCPU / 128 GiB and needs its own quota on top of the pool quota. Not
   added.
3. **Azure Firewall tier.** Basic cannot do DNS proxy, so there is no DNS-level
   attribution. Standard restores it and roughly doubles the hourly firewall
   cost. The dead category was removed; the upgrade was not made.
4. **Fully private host storage for the Functions arm.** The current posture
   accepts platform-side public endpoints, matching Microsoft's reference sample.
   Closing it needs private endpoints for blob/queue/table plus private DNS zones
   — additional billable resources.
5. **`EXPERIMENT-STATUS.md` publishes live subscription detail** — resource
   group names, storage account names, a managed-identity object ID,
   firewall/private-endpoint addressing, and the fact that the signed-in identity
   holds Owner at subscription scope. It is not an authenticator, but the package
   is meant to be reusable, and the file contradicts the sanitisation stance taken
   in `AZURE-QUOTA-DIAGNOSTIC.md`. Left untouched: it is the research log. If this
   repository is ever shared, redact names and addresses first.
6. **`01-FULL-THESIS-ORIGINAL.docx`** carries the author's name, institution and
   a Grammarly document ID in its metadata. Correct for a thesis; not for an
   anonymised template.

---

## 4. Open technical findings

Ordered by what they can do to the study. Full detail is in the review
directory; this is the part that should not wait.

**Research integrity**

- **No CLI entry point.** `runExperiment` is imported only by its test, so no
  process exit code reflects a halted matrix. The `halted` flag added here is
  only useful once something reads it.
- **Nine route keys are enforced, zero adapters exist.** `trial-adapter-router`
  demands exactly the nine `deployment:profile` routes and rejects extras, but the
  caller must hand-build all nine `{principalObjectId, adapter}` objects. Nothing
  in the package can serve `azure_functions_flex`.
- **`confirmed_network_denial` is never emitted** by any verifier, so a genuine
  P3 denial and missing evidence classify identically.
- **Evidence writes are not atomic.** `open('wx')` then write leaves a 0-byte
  record if the process dies between; the same pattern guards `.claim`.
- **Sessions leak on error.** Cleanup runs only on non-indeterminate success, so
  a hard error leaves the session alive and billable; `cleanup` is optional for
  every route including sessions.
- **`generate-gpt5mini-live-plan.mjs` fails on a clean tree**: it never creates
  `results/`, so the documented command raises ENOENT.

**Security (none require rotation)**

- No credential, key, token or password is committed, in HEAD or in history.
- `src/resource.ts` falls back to published demo tokens (`local-p1`…) when the
  env is absent and binds `0.0.0.0`, so a bare `node dist/resource.js` on a shared
  host serves with public credentials.
- Shared-secret comparisons use `!==`, not constant time, in four places.
- `azure-delegated-token.mjs` decodes a JWT and trusts `aud`/`oid`/`exp` without
  verifying the signature. Azure remains the real authenticator, so this is not an
  auth bypass, but the `oid` assertion guarantees nothing.
- Base images are pinned by mutable tag, not digest.

---

## 5. What is verified and what is not

| Claim | Status |
|---|---|
| Tests pass from a clean clone | **Verified** — 88/88, and in CI on Node 22 and 24 |
| Frozen matrix digest matches the committed bytes | **Verified** — locally and by the CI digest guard |
| All 22 Bicep templates compile and lint | **Verified** — locally and in CI |
| All five Docker images build | **Verified** — locally and in CI |
| The workload survives a malformed request | **Verified** — before/after probe |
| Flex integration subnet restrictions, ACR Private Link tier, DNS proxy SKU limits, session egress model | **Verified against learn.microsoft.com**, cited in the review files |
| Whether ARM *rejects* or silently ignores the removed DnsProxy category | **Not verified** — no deployment was attempted |
| Storage `Allow` + `AzureServices` is sufficient for Flex host traffic | **Not verified** — matches Microsoft's reference sample, unproven here |
| Session-pool quota release behaviour after deletion | **Not verified by Microsoft docs**; the observed behaviour is exactly why a support case is needed |
| The Functions container authenticates callers without `AzureWebJobsStorage` | **Verified it does not**, statically; the image has no storage hook |
| Four of the nine deployment routes work end to end | **Not verified** — out of scope; requires deployment |

---

## 6. Reproducing this audit

```sh
cd Complete_Thesis_Azure_Package/05-DOCKER-STARTER
npm ci && npm run build && npm test
python3 scripts/validate_supplied_plan.py && python3 scripts/test_supplied_plan.py
sha256sum ../03-PLANNED-TRIAL-MATRIX-450.csv   # 39bb833e…

for f in infra/*.bicep; do bicep build "$f" --stdout >/dev/null || echo "FAIL $f"; done

for d in Dockerfile.*; do docker build -f "$d" -t "thesis:check" . || echo "FAIL $d"; done
```

Local runs need a Docker daemon the current user can reach.

---

## 7. Primary sources

- Flex Consumption subnet restrictions and VNet integration —
  `learn.microsoft.com/azure/azure-functions/flex-consumption-how-to#subnet-usage-restrictions`
- Flex instance sizes and scale limits —
  `learn.microsoft.com/azure/azure-functions/flex-consumption-plan`
- Flex reference implementation (storage ACLs) —
  `github.com/Azure-Samples/azure-functions-flex-consumption-samples`
- ACR Private Link requires Premium —
  `learn.microsoft.com/azure/container-registry/container-registry-private-link`
- Session pool network configuration, egress semantics —
  `learn.microsoft.com/azure/container-apps/session-pool`,
  `…/sessions-usage`, and the `Microsoft.App/sessionPools@2026-01-01` template
  reference
- Container Apps quotas and the quota-request process —
  `learn.microsoft.com/azure/container-apps/quotas#dynamic-sessions-quotas`,
  `…/quota-requests`
- Azure Firewall Basic limitations (no DNS proxy, no FQDN filtering) —
  `learn.microsoft.com/azure/firewall/features-by-sku#basic-limitations`
- Workload profiles (E16 = 16 vCPU / 128 GiB) —
  `learn.microsoft.com/azure/container-apps/workload-profiles-manage-cli`
