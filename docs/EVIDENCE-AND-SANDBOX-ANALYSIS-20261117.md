# Evidence pipeline and Sandbox access analysis

**Review date:** 2026-11-17  
**Scope:** The 2026-11-15 400-record study, its retained evidence and current application code, plus a read-only inspection of the signed-in Azure portal. This document proposes fixes; none were deployed as part of this review.

The review identified issues in Sandbox connectivity, evidence collection, trial qualification, and launch controls. Current portal settings are a snapshot and do not independently prove the exact configuration during the November 15 run. Plausible causes below require live verification before they are treated as established facts.

The retained 400-record manifest reports 181 clear outcomes, 139 indeterminate outcomes, and 80 U6/U8 session records classified `not_applicable`. A read-only check found that all 400 record files match their manifest hashes and internal envelope hashes. These hashes establish consistency with the manifest, not independent authorship or authenticity.

## Sandbox access and execution

| Problem | Evidence and effect | Proposed fix |
|---|---|---|
| P1 and P2 currently have no VNet connection | The portal showed no VNet connections for either Sandbox group. Fixture storage currently permits public access from selected networks but lists no public network, IP, or exception rules, and has a private endpoint. This is a strong candidate explanation for the 403s, but the historical cause is unproven. | Create supported VNet connections for the groups, attach each trial Sandbox to the correct connection, and check its route to the fixture private endpoint. |
| Sandbox creation does not select a VNet connection | `scripts/aca-sandbox-pilot-adapter.mjs` builds a request with identity and egress settings, but the reviewed request has no VNet connection selection. | Add the supported connection setting to the per-Sandbox request and verify that the created Sandbox receives the intended subnet connection. |
| Private DNS and routing are unproven inside the Sandbox | The existence of a private endpoint does not prove that a Sandbox resolves the Blob hostname to it or can reach it. | From a disposable Sandbox, record the DNS answer and test TLS connectivity to the resolved endpoint. Check subnet routes, NSGs, private DNS links, and any firewall path. |
| Blob identity and role attribution remain unproven | The P1 workload identity is attached, and a retained Blob audit row identifies it, but the request returned `AuthorizationFailure`. The response alone does not identify the failing layer. | Check the identity selected inside each Sandbox, token audience, Blob data roles, role scope, and propagation. Demonstrate an allowed P1 operation before interpreting a P2 denial. |
| Allowed Sandbox controls failed | All 80 non-session P1/P2 Sandbox rows were indeterminate. A 403 on a legitimate control cannot distinguish a security boundary from broken access. | Make L1/L2 succeed and verify their independent audit evidence. Then demonstrate intended P1 success and P2 denial controls before measuring the full arm. |
| Research and collector endpoints are also private | The saved configuration uses private addresses for the research service and collector. Blob access alone will not prove that U4, U5, U7, or their verification endpoints are reachable. | Test each required destination and port independently from the Sandbox and verifier, including DNS, routing, TLS, and application authentication. |
| Sandbox P3 enforcement was not established | The November 15 revision excluded 50 Sandbox P3 rows. P1/P2 used `Allow` with no egress rules, consistent with their ordinary-egress profiles but insufficient to establish P3 containment. Earlier deny-policy attempts did not demonstrate correct enforcement. | After connectivity works, pilot a supported P3 policy and prove approved traffic succeeds, restricted traffic fails, and independently attributable denial and receiver evidence exist. If it cannot be proven, use a formally reduced scope and disclose it. |
| Sandbox telemetry may be empty or insufficiently attributable | Retained Sandbox records include empty egress-decision arrays. An accepted policy or empty list does not prove which trial was blocked. | Check decision availability, timestamps, Sandbox identity, and destination fields; correlate them against an independent receiver. Treat absent or ambiguous decisions as unresolved. |

The policy builder is in `Complete_Thesis_Azure_Package/05-DOCKER-STARTER/scripts/deps-live.mjs`. Adding VNet connectivity changes the network conditions being studied, so it requires a new pilot.

## Evidence pipeline

| Problem | Evidence and effect | Proposed fix |
|---|---|---|
| Collector monitor rejects the configured port | `config/experiment.azure-live-400.json` uses collector port `8443`, while the current `scripts/collector-monitor-reader.mjs` rejects URLs with an explicit port. Retained P3 records report monitor read failures. | Permit the explicitly configured HTTPS port while retaining strict URL checks. Verify the monitor and evidence endpoints from the controller. Confirm the deployed code version before declaring this the definitive cause of the historical failures. |
| Receiver health was missing for network-denial verdicts | A retained VM P3 U5 record has matching firewall denies but an unobserved receiver monitor, so its final result remained indeterminate. | Make the independent receiver journal durable and readable; prove health before, during, and after each trial. Validate one known receipt and one known blocked request. |
| Resource and collector reads failed | VM records contain `resource_read_failed` and `collector_read_or_assessment_failed`; some Functions records have audit or fetch failures. | Independently check service availability, private routing, TLS trust, verifier credentials, and endpoint paths. Record safe diagnostic categories for timeouts, TLS errors, authorization errors, and malformed responses without exposing credentials. |
| Firewall event matching is incomplete | The retained export contains 105 relevant deny events, but several P3 U7 rows report `no_matching_firewall_events`, and no row received a final confirmed network-denial verdict. | Check each trial's source IP or CIDR, destination and port, named rule, execution window, and ingestion delay. Account for changing Functions source addresses and require a healthy receiver check. |
| An empty log query is ambiguous | It can mean no denial, incorrect filters, delayed ingestion, or a failed telemetry pipeline. | Poll a fixed trial window for a bounded period and use a positive telemetry control. Preserve `unobserved` when evidence remains incomplete. |
| Audit matching and timing can fail | Blob outcomes require the correct request ID, principal, resource, operation, and time window; audit failures and ambiguous matches appear in the records. | Verify diagnostic settings and workspace access, propagate unique request IDs, synchronize clocks, measure ingestion delays, and test both matching and deliberately nonmatching events. |
| CA and service ports were inconsistent during setup | The operational log records a stale CA bundle, missing Node trust configuration, and a restricted-service port mismatch. Some were corrected during setup but can recur on rebuild. | Generate and distribute a verified CA bundle, confirm certificate names and trust from every caller, and validate research, collector, and restricted-service ports before trials. |
| U3 downstream credential-use evidence has limited scope | A retained U3 record labels dummy credential use `use_succeeded_with_mock_audit`. Azure Blob evidence supports retrieval; downstream use is simulated rather than independently audited by a separate real service. | Describe the finding as retrieval plus simulated use, or add a separate independently audited dummy service for a new run. |
| Hashes do not independently authenticate evidence | The hashes match, but the local manifest is unsigned. Anyone able to replace both files and hashes could recompute them. No tampering is established. | Preserve immutable Azure originals, archive exact protocol/configuration/source digests, and sign or independently protect and timestamp the final manifest. |
| Retention may be inadequate for the thesis | The archived deployment manifest reported a locked seven-day policy. A lock establishes a minimum protection period, not that the period meets research or review needs. | Agree on an appropriate period, verify the live policy against it, and preserve an independently protected copy. Do not assume the archived setting remains current. |

For a confirmed network denial, require a matching independent firewall or supported platform denial, a healthy receiver journal covering the trial window, and no matching receiver effect. The 105 retained deny events are evidence that named rules fired; they do not independently establish 105 trial verdicts.

## Trial and launch problems

1. **The 80 U6/U8 rows were not qualified.** Their records contain workload responses, but the verifier classified them `not_applicable` because the required session capability was absent. The existing operational note saying they were never executed is too broad. Configure distinct current, other, and prior-session fixtures; validate them independently for every scheduled route; then run new non-counted pilots before measured repetitions.
2. **The measured run proceeded with readiness blockers open.** The archived manifest reports `measuredStudyReady: false`, pending pilots, and design blockers. The operational account says the runner was launched directly rather than through the full `study-execute` gate. Reconcile and preserve the exact executable, configuration, gate results, and authorization used for that launch.
3. **The pilot validator requires routes excluded from the 400-row plan.** `deploy/study-execute.mjs` requires P3 network pilots and U6/U8 fixtures for all three profiles of every deployment, including Sandbox P3, which the 400-row revision excluded. Derive pilot requirements from the selected protocol's actual routes and scenarios.
4. **The launcher's default protocol differs from the 400-row run.** The current launcher defaults to a 450-row protocol while the retained measured dataset used the 400-row v5 revision. Require the intended protocol and freeze lock explicitly, or set and document the correct default.
5. **The v5 protocol contains stale descriptive counts.** It describes 90 positions per block and older run IDs, and lists 90 session and 30 P3 network rows. The 400-row schedule has 80 rows per block, 80 U6/U8 rows, and 20 VM/Functions P3 U5/U7 rows. Preserve the historical frozen artifact; prepare a corrected reviewed revision and document its relationship to the original run.
6. **Retries and immutable claims need a recovery procedure.** Earlier attempts encountered fixture conflicts, and one run stopped at 265/400 before resuming. Use fresh attempt IDs, retain failed attempts, reset only appropriate fixtures, and reconcile claims before resuming.
7. **The environment was cleaned up after the run.** Azure activity history showed VM deallocations and firewall deletion on November 15. A future run requires the necessary services to be restored and revalidated; an older deployment manifest does not prove present availability.

## Proposed order of work

1. Preserve the original records, exported logs, manifests, exact protocol and matrix, and source/configuration digests. Review retention and key exposure before further work.
2. Correct the collector monitor port mismatch and improve safe diagnostics. Validate the receiver and evidence readers with known positive and negative controls.
3. Establish Sandbox private connectivity and correct identity access, then validate P1/P2 legitimate and unauthorized controls.
4. Qualify session fixtures and P3 enforcement separately for every route actually in the intended protocol.
5. Fix the protocol/launcher and pilot coverage mismatches, freeze a reviewed revision, and pass the full readiness and authorization process.
6. Run a small non-counted pilot first. Use fresh IDs for any subsequent measured run, track cost, and retain all failed and indeterminate evidence.

The precise cause of the Sandbox 403s and the deployed code version responsible for the historical monitor failures remain to be verified. This review cannot prove that no additional problem exists.

## Sources in this repository

- `evidence/400-20261115/MANIFEST.json`, `records/`, and `firewall/`: retained measured records, hashes, and firewall export.
- `evidence/400-20261115/deployment-manifest.json` and `deployment-validation.json`: archived deployment and readiness state.
- `docs/400-RESULTS-20261115.md` and `docs/LIMITATIONS-AND-HICCUPS.md`: prior results and operational history; read the U6/U8 execution claim with the correction above.
- `Complete_Thesis_Azure_Package/05-DOCKER-STARTER/config/experiment.azure-live-400.json`: saved 400-run endpoints and routes.
- `Complete_Thesis_Azure_Package/05-DOCKER-STARTER/scripts/`: Sandbox adapter, evidence readers, denial reader, and verifier.
- `deploy/study-execute.mjs` and `deploy/evidence-retention.mjs`: launch gates and retention checks.
