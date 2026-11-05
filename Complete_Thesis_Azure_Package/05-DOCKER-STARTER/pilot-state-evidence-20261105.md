# Final route coverage pilot evidence (2026-11-05)

Read-only Azure Run Command inspection of `thesis-controller-pilot` in `RG-THESIS-RESEARCH-PILOT-EUS`.

- Pilot process `run-final-route-coverage-pilot-v4.mjs`: not running at inspection time.
- Results directory `results/non-counted-final-route-coverage-20261105-v4`: present.
- U5 and U7 each have a `.claim` envelope and a `.json` payload file.
- Both payloads classify as `confirmed_network_denial`.
- Both have verification verdict `confirmed_deny_firewall`, source `azure_diagnostics_firewall`, and matching rule `deny-centralus-p3-collector`.
- Both report `deniedRecords: 7`; their evidence collector `contacts` count is `0`.
- No explicit `reason` or `matchingRule` field was present; the classification/verdict and `ruleName` are the available reason and matching-rule evidence.

No payload secrets or unrelated values were copied into this note.
