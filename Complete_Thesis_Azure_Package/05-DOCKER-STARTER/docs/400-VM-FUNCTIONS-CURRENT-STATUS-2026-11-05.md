# Current status — 400-row VM/Functions candidate — 2026-11-05

## Scope and authority

This checkpoint supersedes the VM/Functions readiness statements in
`400-TRIAL-AZURE-STATUS-2026-11-05.md`, which predates the current owner-directed
candidate. The active candidate is
`config/protocol-400-rev4-vm-functions-draft.json`: VM and Azure Functions Flex,
profiles P1/P2/P3, 400 planned rows, with no ACA or ACI arm. U6/U8 are outside
scope because these are sessionless routes. The candidate remains a draft;
`measuredExecutionEnabled` is false and no counted trial has started.

## Pilot progress

- **Completed non-counted batch:** the latest operator update reports 17 pilot
  results verified. These are pilot observations only and do not count toward
  the 400 planned trials. A run-level record for this complete 17-result set is
  not yet present in the local package, so this checkpoint does not infer its
  route/scenario breakdown or classifications.
- **Most recent 11-row pilot attempt:** per the latest operator update, this
  attempt stopped after U1 and U2 succeeded and U3 was indeterminate because
  the query returned `TypeError`. No subsequent rows in that attempt are
  represented as completed.
- **Fresh retry:** the operator reports that the nine-row retry is running.
  Its results are pending; no outcome is inferred here.
- Existing local pilot artifacts include VM P1/P2 non-counted route evidence
  and individual non-counted P3 U5/U7 firewall-denial observations for VM and
  Functions. Each P3 observation is limited to its saved execution window and
  does not establish full-route isolation or measured readiness.

The counts and outcomes in the first three bullets are recorded from the
operator-provided progress update for this checkpoint. They are not represented
as independently re-read Azure results in this document.

## Current readiness

The local rev4 protocol keeps all four measured-run gates pending:

| Gate | Current status |
|---|---|
| `protocolFrozen` | Pending. The protocol and matrix are drafts; no freeze lock for measured execution is evidenced. |
| `deploymentValidated` | Pending for the complete candidate. The local identity/RBAC snapshot records ARM attachment and configuration agreement for six route principals, but explicitly does not prove runtime identity claims or end-to-end route validation. |
| `isolationValidated` | Pending. The six route identities and endpoints are configured, and pilot observations cover selected cases. No local evidence bundle establishes effective least-privilege access, actual runtime identity attribution, and route/network separation across every included route. |
| `verifierValidated` | Pending globally. Existing pilot verification is scoped to selected operations; the recent U3 query `TypeError` also leaves that observation indeterminate until the fresh retry and verifier path resolve it. |

The rev4 measured launcher requires the exact pinned 400-row matrix and protocol,
a matching freeze lock, all four gates validated, six route dependencies
constructed, no unsupported rows, and six verifier assertion flags. Those are
guard conditions; they do not themselves constitute evidence that the gates
passed.

## Isolation evidence still needed

To clear `isolationValidated`, retain an independent, reviewable evidence set
covering all six VM/Functions P1/P2/P3 routes:

1. Confirm each route's actual runtime token principal matches its dedicated
   workload identity, using independently recorded audit principal IDs. For
   Functions, distinguish the workload UAI from the system identity used for
   host storage.
2. Verify effective fixture permissions at the intended scopes, including
   successful permitted operations and denied prohibited operations with
   matching independent audit records. Resolve inherited assignments,
   group paths, and other broad grants that could undermine profile separation.
3. Verify network paths for each route. Show approved research and fixture
   paths work, and P3 U5/U7 collector paths are denied by the configured
   enforcement point with matching independent telemetry. Existing single-run
   P3 denial records are supporting observations, not complete route coverage.
4. Check route credentials, endpoints, and evidence correlation for cross-route
   binding or fixture contamination. Keep controller, workload, and verifier
   identities separated.

## Evidence pointers and limits

- Candidate protocol and matrix digest: `config/protocol-400-rev4-vm-functions-draft.json`.
- Six configured endpoints and principal IDs: `config/experiment.azure-live.json`.
- ARM identity/RBAC snapshot and its explicit limits: `docs/VM-FUNCTIONS-IDENTITY-RBAC-SNAPSHOT-2026-11-05.md`.
- Selected VM P1/P2 non-counted results: `docs/VM-P1-P2-NONCOUNTED-ROUTE-EVIDENCE-2026-11-05.md`.
- Non-counted Functions P3 U5/U7 denial observations: `docs/FUNCTIONS-P3-U5-NONCOUNTED-PILOT-2026-11-05.json` and `docs/FUNCTIONS-P3-U7-NONCOUNTED-PILOT-2026-11-05.json`.
- VM P3 U5 late-ingestion reassessment: `docs/P3-U5-RETROSPECTIVE-REASSESSMENT-2026-11-05.json`.

No Azure/controller command was run to prepare this checkpoint, and no cloud
state was changed.
