# ACI P1 controller runner transfer and remote preflight

- Checked: 2026-11-04 18:48 UTC.
- Host: `thesis-controller-pilot` in `RG-THESIS-RESEARCH-PILOT-EUS`; the VM remains running.
- Installed bundle: `/opt/thesis-aci-runner-20261104`.
- Transfer package SHA-256: `c43e753a14f779ebab3f414b919a95ad7b503e9672f65e619b7519535cfbf17c` (239,932 bytes).
- The VM downloaded the bundle through its user-assigned managed identity from a private, temporary Blob container. Its SHA-256 matched before extraction. `npm ci --omit=dev --no-audit --no-fund` completed using the committed lockfile.
- Runtime verification on the VM returned Node.js `v22.23.4` and npm `10.9.9`.
- Remote `node scripts/run-aci-live-injection-50.mjs --dry-run` recognized the frozen 50-condition schedule and exact hash `b63e949f035ee278ebc932404d48445e667c096ff679f8ef32e14d41e7de26eb`; it returned `runnable=false`, `executionStarted=false`, and 8 blockers as expected.
- Temporary container `aci-runner-src-20261104` and its two container-scoped Blob roles were deleted after transfer. The container scope has no remaining role assignments. The fixture storage account has zero IP firewall rules. No ACI group, condition, GPT-5 mini request, or trial was started by this transfer/preflight.

## Remaining remote preflight blockers

The runner still requires evidence-backed passes for live U1 resource-audit verification, live U5 collector-audit verification, operation correlation, independently protected evidence, approved retention, complete credential validation, and cost controls. It also requires department approval of the requested retention and a locked 146,000-day Azure WORM policy. The current readiness record keeps these gates false; this transfer did not change them.
