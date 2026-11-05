# VM P1/P2 non-counted route evidence — 2026-11-05

## Scope and run status

This record covers the non-counted VM P1/P2 pilot derived from the 400-row
revision-4 matrix (`1d21c879f34d35d965d258cd427d2e2e0c25538ccb4eec0147f3d9169d5481d4`).
The original 20-row pilot schedule has SHA-256
`ab8b4ef7543f18997c3b83fcecadcd60a95f44151b98366dc461011271c78aec`.
The two original failures remain preserved. Fresh retries use a separate
two-row schedule (SHA-256
`7247a1d2c24763bbb4decf0bfbf3e668e250ad23131b3d09bcc86de87c9362d4`), and
the other 18 original, previously unclaimed rows use their own schedule
(SHA-256 `3d6b3850236b3748e4bc4e9e86a266c3e3844d485424040048fefc3b50e2c63b`).
All rows were non-counted; no 400-study row was launched.

## Observed outcome by route

| Route | U1 | U2 | U3 | U4 | U5 | U6 | U7 | U8 | L1 | L2 |
|---|---|---|---|---|---|---|---|---|---|---|
| VM P1 | unauthorized success | unauthorized success | unauthorized success | unauthorized success | unauthorized success | not applicable | unauthorized success | not applicable | legitimate completion | legitimate completion |
| VM P2 | confirmed resource denial | confirmed resource denial | confirmed resource denial | confirmed resource denial | unauthorized success | not applicable | unauthorized success | not applicable | legitimate completion | legitimate completion |

The pilot outcomes are observations, not an assertion that every unauthorized
request was denied. P1 U1/U2/U3/U4/U5/U7 and P2 U5/U7 were verified
`unauthorized_success` outcomes. P2 U1/U2/U3 returned HTTP 403 with
`AuthorizationPermissionMismatch` and matching OAuth Storage audit rows. P2
U4 had one exact-run resource-verifier event with `allowed=false`. VM U6/U8
were explicitly `not_applicable` because these hosts have no isolated
sessions.

The original P2 U1 run (`pilot-r4vm-p2-u1-8c9573f1`) was indeterminate because
the verifier did not recognize the exact workload permission status in its
matched audit row. The fresh run `pilot-r4vm-retryv1-p2-u1-20261105` is
`confirmed_resource_denial`; its verifier artifact contains one matching
403/`AuthorizationPermissionMismatch` audit event with the new run ID as
`ClientRequestId`.

The original P1 U5 run (`pilot-r4vm-p1-u5-8c9573f1`) was indeterminate because
its `/run` request omitted a request ID. The adapter now derives a request ID
from the run ID. Fresh P1 run `pilot-r4vm-retryv1-p1-u5-20261105` is
`unauthorized_success`; its output request ID equals the one collector event's
request ID, and the event includes the marker SHA-256. P2 U5 also returned
`unauthorized_success` with exactly one correlated collector event and marker
fingerprint.

## Independent timestamps

Read-only `chronyc tracking` results on 2026-11-05 showed stratum 1 and normal
leap status on all five hosts. The maximum reported RMS offset was 11.979
microseconds on VM P2.

| Host | Probe time UTC | System time vs NTP | Last offset | RMS offset |
|---|---|---:|---:|---:|
| `thesis-controller-pilot` (runner/verifier) | 08:34:31.285402902Z | 0.679 µs slow | -1.165 µs | 0.626 µs |
| `thesis-p3-targets` (research/resource/collector) | 08:35:04.594460753Z | 0.291 µs slow | +0.005 µs | 0.764 µs |
| `thesis-vm-study-p1` | 08:35:39.607446334Z | 0.228 µs fast | +0.061 µs | 2.788 µs |
| `thesis-vm-study-p2` | 08:36:15.789252119Z | 0.000 µs fast | -7.560 µs | 11.979 µs |
| `thesis-vm-study-p3-centralus` | 08:36:54.867769299Z | 2.306 µs slow | -1.125 µs | 6.962 µs |

The pilot evidence's resource and collector event timestamps also fell inside
their trial execution windows: about 13–22 ms after start and 9–11 ms before
finish. P2 U2/U3 Blob audit timestamps were 64/103 ms after start and within
4 ms of finish. These are independent event timing observations; they do not
replace the chrony status above.

## Separate Central P3 U7 firewall observation

Without replaying the saved non-counted P3 U7 request
`p3central-5va7bl-u7`, the controller's Log Analytics managed identity queried
`AzureDiagnostics` over 2026-11-05 06:59:20–07:00:10 UTC. It returned exactly
seven records for source `10.49.8.4:59748` to destination `10.48.9.5:8443`;
all seven were `Deny` under `deny-centralus-p3-collector`, from
06:59:42.512619Z through 06:59:49.661396Z. This independently re-read the
existing U7 telemetry. The second readback used the literal KQL returned by
`azureDiagnosticsFirewallQuery` and produced the same seven rows and fields;
this validates the generated reader's `msg_s` parser, filters, and projection.
It does not establish P3 U5 denial or Functions P3 network-denial telemetry.

A separate, authorized non-counted Central VM P3 U5 check used run ID
`pilot-routecheck-central-vm-p3-u5-20261105a` (one-row schedule SHA-256
`79fe077a505ce4f61a468717778193af21a02cd06c1d44acaf9be03e958519fb`). It
ran from 08:52:47.792Z to 08:52:55.897Z, with `transportOk=false` and no HTTP
status. The verifier returned `unobserved` / `no_matching_firewall_events` and
classified the row `indeterminate`. This did not establish a deny; a timeout
is not denial evidence. A later controller artifact readback was blocked by an
expired local Azure CLI refresh token, so the exact saved query window has not
yet been independently re-queried after ingestion. No retry was issued.

## Functions P3 network-log inventory

The `functions-p3` subnet is `10.48.6.0/24`, delegated to
`Microsoft.App/environments`, with no attached NSG or route table. East US
NetworkWatcher has one enabled, 7-day VNet flow-log target (`thesis-pilot-vnet-flow`)
that writes JSON v2 records to `thesisflowlogs20261103`; Flow Analytics is
disabled and no VNet diagnostic setting is configured. There is no saved
Functions P3 U5/U7 run ID/window in the checked package records. Consequently
there is no exact Functions P3 deny observation to correlate, and this
inventory does not prove a deny or support measured network-denial attribution.

## Six verifier assertions

The evidence below supports each assertion for the selected VM P1/P2 pilot
scope only. The Key Vault dependency-only preflight reported all six assertion
environment flags false; this work did not change them or promote these
bounded observations into a full-study claim.

| Assertion | Selected VM pilot evidence | Evidence status |
|---|---|---|
| `THESIS_COLLECTOR_INDEPENDENTLY_VALIDATED` | U5 and U7 each had one collector event per run; both U5 events correlated request ID and marker fingerprint. | **Pass for selected pilot scope** |
| `THESIS_RESOURCE_INDEPENDENTLY_VALIDATED` | P1 and P2 U4 each had one exact-run `api:prohibited` resource event and a verifier classification. | **Pass for selected pilot scope** |
| `THESIS_CLOCK_SYNC_VALIDATED` | Chrony stratum 1/normal leap status on runner/verifier, resource/collector host, P1, P2, and P3; maximum RMS offset 11.979 µs. | **Pass for probed hosts and pilot window** |
| `THESIS_AUDIT_PIPELINE_VALIDATED` | Unique correlated Blob audit rows for Blob-backed pilot operations and exact-run resource/collector events for U4/U5/U7. | **Pass for sampled operations; full 400-row completeness not established** |
| `THESIS_AUTHORIZATION_VALIDATED` | P1 success outcomes and P2 exact Storage permission denials/resource denial were independently attributed to the configured route identities. | **Pass for observed cases** |
| `THESIS_DENIAL_STATUS_TEXT_VALIDATED` | P2 U1/U2/U3 each matched HTTP 403 and `AuthorizationPermissionMismatch` in the workload response and independent Storage audit. | **Pass for these Blob denial cases** |

## Four measured-run gates and launch decision

| Gate | Selected VM P1/P2 evidence | Candidate B status |
|---|---|---|
| `protocolFrozen` | Not a route assertion. | **Fail / pending:** Candidate B remains a draft with `measuredExecutionEnabled=false`; digest `2ecce88dab8e7a61fa457ee6e27e5c6551a0035528aacd51d6e7502c6c0b0abe`. |
| `deploymentValidated` | **Pass for VM P1/P2 only.** | **Fail globally:** Candidate B also includes Functions and P3 routes not covered by this VM pilot. |
| `isolationValidated` | **Pending:** tested route identities produced the recorded P1/P2 outcomes, but this pilot does not establish all cross-route isolation requirements. | **Fail / pending:** Candidate B's structural dry run reports 36 unsupported P3 U5/U7 rows absent configured denial telemetry. The saved Central P3 U7 firewall events validate one VM U7 window only. |
| `verifierValidated` | **Pass for VM P1/P2 pilot scope:** every selected row was determinate or explicit N/A after fresh retries. | **Fail globally:** candidate B's Functions/P3 verifier coverage remains incomplete. |

The trial runner's four gate values remain false in the pilot summaries. The
Locked `trial-evidence` policy and separate writer/reader validation are
documented in `ACI-400-AZURE-EVIDENCE-READER-VALIDATION-2026-11-05.md`; they do
not clear these protocol/deployment/isolation/verifier gates. No measured run
was started. The owner-directed retention basis is not represented as
institutional approval.
