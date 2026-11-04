# ACI independent evidence gate

`scripts/aci-evidence-readiness.mjs` is a local fail-closed contract for the ACI pilot. It requires four separate Entra principals (workload, evidence writer, verifier, and audit reader) and recorded observations for locked retention, independent read-back, overwrite denial, delete denial, and audit attribution. The constructor also requires the generic Azure verifier's audit, authorization, clock, and denial-text validation gates and explicitly rejects `pilotMode`.

The helper performs no Azure requests. Passing its validator means only that the supplied record has the required shape. ACI remains blocked until the preflight captures the actual Azure resource IDs, timestamps, run IDs, observed policy state, a read using verifier-only credentials, and independently logged failed overwrite/delete probes. Do not hand-author `passed: true` records or treat unit tests as cloud validation. Preserve raw/redacted provider outputs in the audit bundle and have the independent reader identity retrieve the evidence.

This does not expand verifier scenario coverage. U4/U5/U7 remain unverified until separately implemented and validated; U6/U8 retain their existing scenario status and must not be inferred from this gate. No trial or deployment is authorized by this module.
