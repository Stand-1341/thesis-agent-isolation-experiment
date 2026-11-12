# Deployment (azd)

One command turns an eligible Azure subscription into a validated, configured
experiment environment:

```
azd up
```

That runs, in order:

1. **Input resolution** (`deploy/resolve-inputs.mjs`) — SSH public key, trusted
   controller IP, pinned VM image version. Nothing to hand-edit; every value is
   resolved from the machine, from `config/deployment.json` (optional), or from
   Azure. Resolve-once semantics — reruns never overwrite.
2. **Subscription preflight** (`deploy/preflight.mjs`) — auth, effective RBAC,
   provider registration, region access, quota headroom, SKU restrictions,
   address-space overlap, budget presence, ARM what-if preview. Every failure
   prints a specific fix. **Nothing is provisioned, nothing is billed, until
   preflight passes.** No implementation can guarantee deployment on literally
   any Azure account — subscription permissions, quotas, regional capacity,
   service restrictions, org policies and billing eligibility are external
   requirements; preflight states exactly which one is missing.
3. **Provision, stage 1 — foundation** (`infra/main.bicep`, wraps the existing
   three-arm Bicep unmodified): registry, managed identities, networking,
   storage. No workloads yet — the image doesn't exist yet.
4. **Image publish** (`deploy/publish-images.mjs`) — `az acr build` of the
   starter `Dockerfile.node`, digest resolved and **pinned** (never a tag).
   Idempotent on source-hash: unchanged source reuses the recorded digest.
5. **Provision, stage 2 — full**: VM arm, ACA Jobs, sandbox groups,
   evidence/fixture stores, all referencing the pinned digest.
6. **Auto-configuration** (`deploy/configure.mjs`) — endpoints, identity IDs,
   private IPs and routes resolved from ARM outputs into
   `deployment.resolved.json` + `config/experiment.generated.json`. No manual
   SSH installs, no copying endpoint addresses.
7. **Non-counted validation** (`deploy/validate-deployment.mjs`) — resource
   presence, per-identity token probes (**effective** permissions, not merely
   accepted role assignments), service health on the private IPs, evidence
   write/read/delete round-trip under `validation/` (never counted).
8. **Readiness report** (`deploy/readiness-report.mjs`) —
   `deployment-manifest.json` (machine-readable) + `DEPLOYMENT-REPORT.md`,
   including the open research-design blockers that gate the measured study.

## Measured execution is a separate, gated command

`azd up` never launches trials. The measured study is:

```
npm run study:execute
```

which checks six gates before anything billable runs: validated deployment,
frozen protocol + matching lock, pilot coverage, independent verifier,
evidence custody with retention **explicitly** locked (never automatic), and a
fresh owner authorization file naming the protocol digest (stale after 7 days).
Any gate failure refuses with the gate id and the fix.

## Teardown

```
node deploy/teardown.mjs                 # guard-checked, exports nothing
node deploy/teardown.mjs --export-evidence ./evidence-out   # export first
node deploy/teardown.mjs --force         # knowingly destroy evidence
```

The guard refuses to delete anything while counted evidence exists. After
teardown, `TEARDOWN-REPORT.md` lists resources outside the managed group that
could still incur charges.

## Repeat runs and interruptions

Every step is checkpointed in `.azure/<env>/deployment-state.json`. Rerunning
`azd up` reconciles: completed steps are skipped, interrupted ones resume, and
the Bicep stages are declarative. Nothing duplicates; evidence is never
overwritten.

## Not yet proven on hardware here

This pipeline is fully unit-tested (`npm test`, 40 tests, mock-based — no
Azure calls) but the end-to-end `azd up` on a fresh subscription has not been
executed from this machine (no `az`/`azd` CLI or Azure credentials here). The
definition-of-done table from the review (fresh account, existing environment,
wrong permissions, bad region/SKU, repeated deployment, interruption) is the
acceptance test for the first real run.

## Layout

- `azure.yaml` — azd entry point and lifecycle hooks
- `infra/main.bicep` — two-stage wrapper around the existing three-arm template
- `deploy/*.mjs` — pipeline steps (each runnable standalone)
- `config/deployment.schema.json` — the optional user config surface
- `Complete_Thesis_Azure_Package/05-DOCKER-STARTER/` — the experiment itself, unmodified
