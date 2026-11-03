# Cloud pilot acceptance gate

Status as of 2026-11-03: **BLOCKED — do not run the 400 measured trials.**
Revision 2 contains a 400-row planned matrix; there is no evidence that any
measured trial has run.

The runner now has a separate protocol-frozen 80-row non-counted pilot plan
(`../03-PILOT-TRIAL-MATRIX-80.csv`). Run it with `--pilot`; its records go to
`results/non-counted-pilot/`, are labeled `mode: non_counted_pilot`, and are
never included in the 400-row study. `--pilot` does not assert any readiness
gate. Use `--deployment`, `--profile`, and `--limit` to begin with a small pilot
scope. The measured runner rejects custom matrices and still requires all four
gates. Pilot classifications are provisional until the verifier and evidence
assertions below have been established. No cloud pilot has been run yet.

## Required before schedule freeze

- [ ] Approve and freeze the revision-2 400-row deterministic matrix, its byte
  digest, protocol, image digests, prompt/config hashes, and execution order.
- [ ] Deploy and verify all eight revision-2 deployment/profile routes:
  VM P1/P2/P3, Functions P1/P2/P3, and custom sessions P1/P2. The custom-session
  P3 cells were withdrawn from revision 2. Each route
  must use its own workload principal and only the controller/verifier
  identities needed for fixture setup and evidence collection.
- [ ] Demonstrate all 10 scenarios in their intended profile. Verify authorized
  operations work, prohibited operations actually work in P1, P2 resource
  denials occur at Azure RBAC, and P3 network denials occur at the network
  enforcement layer. Do not treat an HTTP error or a failed socket alone as
  proof of the denial layer.
- [ ] Validate setup and teardown for each scenario, including session creation,
  retirement, U6 cross-session state, U8 retained prior-session state, clean
  fixture state, and restart recovery. A partial or ambiguous reset must stop
  the schedule without automatically repeating a run.
- [ ] Validate independent verifier reads for every scenario and deployment,
  including unique audit correlation, control denials, clock windows,
  post-state, and verifier failure behavior. Establish evidence retention and
  independent protection against modification.
- [ ] Run and review a complete, non-counted pilot block. Then verify the trial
  runner, evidence store, usage/cost accounting, abort/recovery behavior, and
  that no trial is silently repeated. Freeze the final protocol and hashes only
  after these checks pass.

## Observed cloud results (setup diagnostics only)

- The trusted session header-audit diagnostic recorded (2026-11-02
  19:17 UTC) `authorizationHeaderPresent=false`,
  `proxyAuthorizationHeaderPresent=false`, no credential-like header names,
  and `controlTokenValuePresent=false`. It did report that the session
  identifier was present in the diagnostic request path. This is a setup-only
  observation from the diagnostic pool; protect identifiers and repeat the
  check against the final session workload before measured trials.

- VM P1/P2 synthetic Blob RBAC: allowed P1 read/update, denied P2 read/update
  with `AuthorizationPermissionMismatch`, allowed P2 authorized operations,
  and denied P2 delete. This covers only selected VM Blob operations.
- A separate managed-identity audit reader matched one controlled Azure Blob
  denial. This does not establish complete evidence protection or complete
  audit coverage.
- Session diagnostic over the restrictive candidate NSG: research HTTP 200,
  fixture Blob HTTP 400, collector connection failed, and direct TCP to
  `1.1.1.1:443` failed. Firewall logs correlated the research and Blob allows,
  but contained no matching collector or public-IP denial record.
- Session diagnostic with the firewall-observation NSG (outbound allowed to
  the forced route): research HTTP 200, fixture Blob HTTP 400, collector
  connection failed, but direct TCP to `1.1.1.1:443` succeeded. The firewall
  produced no matching collector or public-IP record. This is a P3 failure.
- With `EgressDisabled`, all four session probes failed, including the approved
  private research service. That setting cannot satisfy the current P3 study
  design.
- The VNet flow-log reader probe failed with HTTP 403 after temporary access
  setup; no flow-log-based attribution was established. Microsoft documents
  Azure Container Apps as an unsupported VNet flow-log capture target.
- Azure GPT-5 mini passed setup-only inference and a harmless one-tool loop.
  The live-model schedule remains a separate unfrozen draft and is not the
  deterministic 400-trial matrix.

## Remaining blockers

1. **P3 session containment was removed from revision 2.** Session P3 remains
   unsupported and must not be reintroduced without a supported selective
   egress design and attributable deny evidence. The active P3 network trials
   are VM and Functions U5/U7; their network telemetry still requires pilot
   validation.
2. **Deployment matrix:** only selected VM P1/P2 Blob checks and a single
   diagnostic Functions app have been exercised. The eight active routes,
   their actual identities, all profiles, and all three deployment types are
   not validated.
3. **Scenario coverage:** cloud U4 research-service evidence and U5/U7
   collector evidence are not wired and verified across profiles. U6/U8 session
   Blob verifier logic now exists locally, but has not passed an Azure end-to-end
   test.
4. **Evidence integrity:** separate verifier credentials and one exact audit
   match exist. Immutable/independently protected evidence, complete audit
   coverage, and recovery under verifier failure are not established.
5. **Cost and operational controls:** Azure budget alerts are notifications,
   not a hard cap. Consumption and credit reporting can lag. The VM, firewall,
   managed environment/session pool, storage, registry, logging, and flow log
   can incur charges while deployed.

## Execution rule

The runner must remain gated until every required item above is reviewed and
signed off. Any first failed or indeterminate trial halts the schedule for
investigation; no automatic retries. The live GPT-5 mini arm, if approved, is
separate from the deterministic baseline and requires its own frozen plan and
cost cap.
