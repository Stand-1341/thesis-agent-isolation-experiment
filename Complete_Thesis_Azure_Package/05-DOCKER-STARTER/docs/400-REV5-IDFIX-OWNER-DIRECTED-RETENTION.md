# Owner-directed retention for the Rev5 IDFIX restart

## Owner direction and scope

On 2026-11-05, the study owner directed a restart after the prior matrix's
`planned_run_id` profile labels were found to conflict with the row's actual
`permission_profile`. The corrected schedule assigns new IDs from each row's
actual deployment, profile, scenario, and order. This record applies the owner
retention direction documented in
[`400-REV4-OWNER-DIRECTED-RETENTION.md`](400-REV4-OWNER-DIRECTED-RETENTION.md)
to this exact corrected restart:

- Protocol revision: `azure-proposed-v1-rev5-vm-functions-idfix`.
- Matrix: `03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V4-IDFIX.csv`.
- Matrix SHA-256: `2bd601c4de01900c318857901b36578b62fff95385f33f2e34a2c05b78a4bee5`.

The Rev4 protocol, matrix, prior claims, and evidence remain preserved under
their original IDs. Rev5 IDFIX uses fresh IDs and does not replay or count prior
claims. This owner direction does not claim institutional, records-office,
departmental, IRB, or external approval.

## Storage and limits

Evidence remains in the private Azure `trial-evidence` container. The measured
runner separately checks its live Locked immutability policy against the
configured 146,000-day minimum before creating the evidence store. This finite
Azure retention period is the configured implementation of the owner's
retention direction; it is not literally indefinite.

This retention basis does not validate protocol, deployment, isolation,
verifier, credential, or scenario-coverage gates. Its runtime acceptance is
limited to the exact Rev5 IDFIX revision, matrix digest, owner direction, and
settings below.

## Runtime scope

- `THESIS_EVIDENCE_RETENTION_OWNER_APPROVED=true`
- `THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_SCOPE=rev5_idfix_owner_directed_measured_study`
- `THESIS_EVIDENCE_RETENTION_OWNER_APPROVAL_REFERENCE=file:docs/400-REV5-IDFIX-OWNER-DIRECTED-RETENTION.md`
