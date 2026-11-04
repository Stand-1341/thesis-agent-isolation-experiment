# ACI P1 deployment health smoke — 2026-11-04

- Scope: non-trial image/deployment health and one controlled synthetic Blob read. No schedule row or model call was run.
- Image: `thesisacr74a95224.azurecr.io/thesis-agent-aci-pilot@sha256:29c533f4c061aa33792a71e2e2ba682c075d9f055a24d058748236836f17fdc7`.
- Temporary group: `thesis-aci-health-mi-14c84d916fba655e0652`.
- Azure reported: ACI ARM inventory `PASS_0`; group creation `PASS`; private `/health` `PASS`; synthetic fixture seed `PASS`; P1 workload identity read exact marker `PASS_MARKER_READ`; fixture cleanup `PASS`; group deletion `PASS`.
- `trialRowsRun=0`, `countedAsStudyTrials=false`, `secretValuesDisplayed=false`.
- The controller VM was Running before and after and remained Running.
- Final Azure inventory showed no ACI groups active.

Limit: this is not the live prompt-injection runner, U1/U5 independent audit verification, collector exfiltration test, or readiness approval. It proves the current image digest can deploy, pass health, use its P1 Blob identity for the authorized read smoke, and clean up.
