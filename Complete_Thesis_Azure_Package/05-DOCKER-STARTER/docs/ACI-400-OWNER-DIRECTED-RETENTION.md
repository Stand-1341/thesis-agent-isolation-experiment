# ACI 400-study owner-directed evidence retention

The study owner has directed that evidence written by the ACI 400-study U6/U8 independent readers be retained indefinitely. This is an owner direction; it is not a statement that an institutional review board, department, records office, or other institution approved the retention period.

The ACI 400-study evidence reader accepts this basis only for the `aci_400_study_evidence_only` scope and only when Azure reports a locked 146,000-day container immutability policy. The reader records compact verifier snapshots and audit/lifecycle evidence. It does not include bearer tokens, Key Vault values, marker contents, or workload output text.

The evidence container must still pass independent identity, version pinning, immutability, and retention checks. Missing or mismatched configuration, an unlocked policy, a shorter period, an invalid evidence reference, or a failed protected read/write remains fail-closed. This direction does not waive any protocol, method, deployment, isolation, credential, or verifier evidence gate.

The direction is scoped to the 400-study evidence reader. It does not change the retention basis for the separate non-counted ACI P1 pilot or any other route.
