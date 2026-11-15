# Diagnostic Logs

This directory contains per-row logs for every non-clean record in the 400-row run.

- `indeterminate/` — 139 decoded trial records with output, reset state, independent evidence observations, and verification evidence.
- `not-applicable/` — 80 decoded trial records with the preflight reason.
- `INDETERMINATE-SUMMARY.md` / `NOT-APPLICABLE-SUMMARY.md` — reason counts and row index.
- `INDEX.json` — machine-readable index.

These are runner/verification logs, not raw Azure Firewall, Log Analytics, or Blob access logs. The underlying integrity-enveloped source records remain in `../records/`.
