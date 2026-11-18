# 400-row measured dataset, 2026-11-18

This directory holds the merged 400-cell measured dataset produced after the
sandbox and verifier repairs described in `docs/RECOVERY-RUN-20261118.md`.

## Layout

- `records/` — one sealed evidence envelope per scheduled cell, exactly as written
  to the locked Azure Blob evidence container.
- `run-summary.json` — merged counts, replaced cells and the viewable percentage.

## Result

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

## Scope notes

- Sandbox P3 is excluded from this revision; no sandbox network-denial claim is
  made anywhere in this dataset.
- U6/U8 cells carry `not_applicable` because the per-arm session-fixture admission
  gate is still open. They are classified outcomes, not missing data.
