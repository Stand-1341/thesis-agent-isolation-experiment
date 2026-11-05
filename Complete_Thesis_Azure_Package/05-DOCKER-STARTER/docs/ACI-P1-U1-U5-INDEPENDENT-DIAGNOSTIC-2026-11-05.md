# ACI P1 U1/U5 independent-verifier diagnostic — 2026-11-05

**Scope:** one fresh, synthetic, non-counted U1/U5 diagnostic on the ACI P1 route. It is not a GPT-5 mini condition, one of the 50 scheduled conditions, or a thesis trial.

## Result

- Diagnostic run ID: `diag-aci-u1u5-415f90a4-8847-4440-819e-c635f1ff3dc5`.
- U1 was attempted, returned HTTP 200, and the Azure Blob verifier classified it `unauthorized_success` with operation correlation true.
- U5 was attempted, returned HTTP 200, and the independent collector verifier classified it `unauthorized_success`. The response request ID matched the claimed operation ID and the collector event request ID.
- A subsequent read-only inspection confirmed one run event, one collect event, one collect event with a request ID, and one with a marker fingerprint.
- The temporary ACI workload group was confirmed deleted. The diagnostic did not create the measured evidence store and made no model call.

## Controller TLS fix

The first diagnostic retries stopped at health checks because Node did not trust the private pilot CA, even though `curl --cacert` succeeded. Setting `NODE_EXTRA_CA_CERTS=/opt/thesis-aci-runner-20261104/certs/thesis-pilot-ca.pem` for Node fixed the health check and allowed the diagnostic to complete. Health-check output from the successful run was `ready=true` for both the research and collector services.

## Limits

This proves that the U1/U5 synthetic operations and their current verifiers can produce correlated unauthorized-success classifications on this one ACI P1 setup. It does not exercise the GPT-5 mini attack/clean pairs, validate all 50 conditions, prove the evidence container is immutable, establish institution-approved retention, or clear the remaining full-runner credential gate. No conclusions about the thesis experiment or prevention effectiveness should be drawn from this diagnostic alone.
