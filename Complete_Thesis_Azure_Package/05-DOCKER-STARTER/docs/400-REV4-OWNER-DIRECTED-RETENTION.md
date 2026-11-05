# Owner-directed retention for rev4 measured evidence

## Owner direction

On 2026-11-05, the study owner directed that experiment results be retained
indefinitely and said not to wait for an institutional retention schedule. This
records the owner's direction only; it does not claim institutional, records
office, departmental, IRB, or external approval.

## Scope

This basis applies to measured evidence produced under protocol
`azure-proposed-v1-rev4-aci-draft` and matrix SHA-256
`1d21c879f34d35d965d258cd427d2e2e0c25538ccb4eec0147f3d9169d5481d4`. It covers
the selected, validated routes from that protocol. ACI deployment or execution
is not implied; a route must independently pass deployment, isolation, verifier,
and readiness checks before it can be selected.

The study owner later directed preparation of the 400-row VM/Functions-only
candidate after removing ACA and stopping ACI. The same retention direction
covers that exact candidate protocol
`azure-proposed-v1-rev4-vm-functions-only-draft` and matrix SHA-256
`2ecce88dab8e7a61fa457ee6e27e5c6551a0035528aacd51d6e7502c6c0b0abe`. This
candidate remains pending protocol freeze and readiness validation. The runtime
acceptance is bound to its exact revision, digest, and owner-direction record;
a changed matrix requires a new review. This documents owner direction only,
not institutional or external approval.

The Azure `trial-evidence` container is Locked for 146,000 days, its maximum
configured retention period, with protected append writes disabled. Results
must remain in that immutable store. This finite Azure period is the strongest
available implementation of the owner's indefinite-retention direction; it is
not represented as literally infinite retention.

## Runtime guard

The measured runner accepts this basis only when all three explicit settings
match:

- `THESIS_EVIDENCE_RETENTION_OWNER_APPROVED=true`
- `THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE=rev4_owner_directed_measured_study`
- `THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE=file:docs/400-REV4-OWNER-DIRECTED-RETENTION.md`

The runner separately verifies the exact rev4 protocol revision and matrix
digest, the configured minimum retention period, and the live Azure Locked
policy. These settings do not satisfy protocol, deployment, isolation, verifier,
credential, or scenario-coverage gates.
