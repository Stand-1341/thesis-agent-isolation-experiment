# ACI P1 GPT-5 mini pilot credential validation — 2026-11-05

**Scope:** read-only managed-identity token checks plus credentials exercised by the separate U1/U5 synthetic diagnostic. No model condition or measured trial was run by this check.

## Results

- Eight requested managed-identity tokens were acquired successfully, with token values suppressed: controller ARM, controller Key Vault, controller Azure AI Services, fixture-verifier Storage, audit-reader Storage, audit-reader Log Analytics, evidence-writer Storage, and evidence-writer ARM.
- The controller used its managed identity to read the six required ACI Key Vault secrets in memory. The fresh synthetic diagnostic exercised the resource-admin key, collector-admin key, controller key, workload token, and collector-verifier key without displaying any secret values. The resource-verifier secret was fetched and shape-checked, but this U1/U5 path did not use it.
- The previous Azure GPT-5 mini identity smoke completed an HTTP 200 Responses API call and received one tool-call-shaped response; it is documented in [the model identity smoke](ACI-P1-GPT5-MINI-IDENTITY-SMOKE-2026-11-04.md).
- Azure RBAC currently assigns the evidence writer `Storage Blob Data Contributor` and the audit reader `Storage Blob Data Reader` on `trial-evidence`.

## Limits

The evidence writer did not write a blob and the audit reader did not read a trial-evidence object in this smoke. The actual container still reports an immutability policy state of `Deleted` with a zero-day period, so the runner correctly refuses to construct its protected evidence store. Credential validation does not pass the evidence-protection or retention gates.
