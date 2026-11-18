# 400-row measured dataset, 2026-11-18

This directory holds the merged 400-cell measured dataset produced after the
sandbox and verifier repairs described in `docs/RECOVERY-RUN-20261118.md`.

## Layout

- `records/` — one sealed evidence envelope per scheduled cell, exactly as written
  to the locked Azure Blob evidence container.
- `run-summary.json` — merged counts, replaced cells and the viewable percentage.
- `cost-summary.json` — ActualCost for 2026-11-17 and 2026-11-18, grouped by
  service (provisional; billing can restate).

## Result (export state before the U6/U8 re-measurement)

| classification | rows |
| --- | --- |
| unauthorized_success | 135 |
| confirmed_resource_denial | 85 |
| confirmed_network_denial | 20 |
| legitimate_completion | 80 |
| not_applicable (U6/U8 session admission gate) | 80 |
| indeterminate | 0 |

400 of 400 cells have a viewable outcome (100.00%).

## Provenance

- Primary run: `three-arm-flex-sandbox-400-v9-sandbox-p3-excluded-fresh-ids`
  (`tfs400r9-*`), matrix SHA-256
  `54b08d4701a8132fec27ea6f1fddb8ee01f31e52729d989964372daf3563e613`.
- Repair runs: `...-v10...` (`tfs400r10-*`) and `...-v11...` (`tfs400r11-*`).
- The repair rows replace only the cells listed in
  `run-summary.json → replacedIndeterminateCells`.
- Every record was written by the measured evidence store after the immutability
  policy check; no pilot record is included.

## U6/U8 follow-up (revision v12, 2026-11-18)

The 80 `not_applicable` rows in this export are a verifier wiring defect, not a
research result: the Blob verifier never received the declared external
session-namespace capability, so it short-circuited every U6/U8 row to
`scenario_requires_sessions`. See
`docs/RESEARCH-QUESTION-COVERAGE-20261118.md` for the analysis.

After the fix, U6/U8 were re-measured under revision
`three-arm-flex-sandbox-400-v12-sandbox-p3-excluded-fresh-ids` (with two `v13`
single-cell repairs):

| Scenario | Rows | unauthorized_success | confirmed_resource_denial | indeterminate |
| --- | ---: | ---: | ---: | ---: |
| U6 | 40 | 19 | 19 | 2 |
| U8 | 40 | 20 | 20 | 0 |

Those records live in the locked evidence container under `tfs400r12-*` and
`tfs400r13-*`. They replace the 80 `not_applicable` cells one-for-one and change no
other cell. The local `records/` directory in this directory is the export taken
before that re-measurement.

## Scope notes

- Sandbox P3 is excluded from this revision; no sandbox network-denial claim is
  made anywhere in this dataset.
- U6/U8 cells were recorded as `not_applicable` in this export because of the
  verifier wiring defect described above. The v12/v13 re-measurement supersedes
  those 80 cells; see `docs/RESEARCH-QUESTION-COVERAGE-20261118.md`.
