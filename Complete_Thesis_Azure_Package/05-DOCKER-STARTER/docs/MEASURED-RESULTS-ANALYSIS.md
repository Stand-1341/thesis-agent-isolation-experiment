# Analyze measured results

`scripts/analyze-measured-results.mjs` summarizes records for a frozen
schedule by deployment, permission profile and scenario. It works with the
VM/Functions matrix and schedules containing the supported custom-session
deployment label. This is an analysis tool; it does not create a session arm,
start a run, retrieve Azure data, or verify the provenance of exported records.

Export the actual measured trial records as a JSON array to a secure local file.
Each item must be the original runner record with `runId`, `mode`, `arm`,
`classification`, and `trial` metadata, including `trial.planSha256`.
Exclude cleanup records and non-counted pilot records. Preserve the original
evidence separately and follow the approved data handling rules.

From `05-DOCKER-STARTER`, for the corrected VM/Functions revision:

```powershell
node scripts/analyze-measured-results.mjs --matrix ../03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V4-IDFIX.csv --sha256 2bd601c4de01900c318857901b36578b62fff95385f33f2e34a2c05b78a4bee5 --records PATH-TO-MEASURED-RECORDS.json
```

For another revision, use its exact matrix file and independently checked
SHA-256 digest. The CLI currently selects the deterministic measured arm.
It rejects duplicate IDs, records outside the schedule, pilot or other-arm
records, mismatched cell metadata or matrix hashes, and classifications that
do not match the scenario type. Missing, indeterminate, not applicable, and
agent no-attempt outcomes remain separate from determinate classifications.
An empty export is valid and reports every scheduled record missing.

The tool reports classifications recorded by the runner. It does not establish
that they are authentic, independently verified, or complete evidence of the
study. Compare scenario-level cells rather than averaging unequal repetitions
as though they were balanced; interpret missing and indeterminate records
explicitly in any research report.
