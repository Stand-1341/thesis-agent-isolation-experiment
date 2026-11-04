# ACI marker-content proof integration contract

`scripts/aci-blob-marker-content-proof.mjs` exports `createAciBlobMarkerContentProofPersister`. It accepts actual response bytes captured at the HTTP boundary and persists a body-free `azure_blob_marker_content_proof_v1` snapshot using an injected protected writer and independent reader. The result is exactly the candidate evidence field expected by the independent verifier:

```js
evidence.markerContentProof = await persistMarkerContentProof({
  runId, scenario, resourceId, objectUri, markerFingerprint,
  sourcePrincipalId, verifierPrincipalId, probePrincipalId,
  seed: {requestId, principalId, capture: seedHttpCapture},
  independentRead: {requestId, principalId, capture: verifierHttpCapture},
  probe: {requestId, principalId, statusCode, capture: probeHttpCapture} // 403: omit capture; provide observedAt
});
```

Each capture is `{bodyBytes: Buffer, statusCode, requestId, principalId, capturedAt, captureBoundary}`. The source seed uses `blob_request_body`, captured from the exact PUT body; the independent read and HTTP 200 probe use `blob_response_body`, captured from each corresponding direct Blob GET response. Captures come from the actual HTTP implementation at the boundary; do not manufacture them from `markerFingerprint` or a later unrelated GET. For a 403, the probe has no content capture. The helper validates the exact synthetic marker payload and exact request/principal/status binding, strips marker bytes from the persisted snapshot, hashes the protected snapshot, writes it, then reloads it and requires a locked retention policy, the configured minimum retention, version ID, independent reader identity, and exact hash/round-trip match.

The production evidence-store adapter supplied to `writeProtectedEvidence` must create an immutable versioned object and return a stable reference. `loadProtectedEvidence` must independently read that version and return `{reference, readerPrincipalId, immutable:true, retentionPolicyState:'Locked', retentionDays, versionId, snapshot, snapshotFingerprint}`. The shared evidence store exposes generic run-level `save/read` methods and does not provide this contract; use the dedicated adapter below rather than treating the generic store's hash envelope as retention proof.

`scripts/azure-versioned-protected-evidence.mjs` now supplies that adapter boundary. It takes the evidence container URL/resource ID, different writer and reader principal IDs, their separate token callbacks, a read-only management-token callback, and an explicit `minimumRetentionDays`. It verifies the configured locked container policy, requires the write response's `x-ms-version-id`, then reloads the pinned version as the distinct reader and checks the version's `x-ms-immutability-policy-mode` and `x-ms-immutability-policy-until-date`. It does not create, extend, or lock a policy.

`scripts/aci-marker-proof-evidence-runtime.mjs` composes the store and persister from the current managed-identity configuration. Supply its `persistMarkerContentProof` to `createAciBlobSessionAzureCallbacks`; give its `loadProtectedEvidence` and `observerPrincipalId` to the independent verifier.

For deployment wiring, pass the institution-approved integer from `THESIS_EVIDENCE_RETENTION_DAYS` as `minimumRetentionDays`; the Azure locked policy must be at least that long. The repository has no local production `.env` value to inspect. The dependency tests use `180` days, but that test fixture is not proof of the approved study retention. The exact outstanding input is the institution-approved number of retention days, plus the already-provisioned locked-policy value and Blob versioning being enabled so Azure returns `x-ms-version-id`.

## Work still required before runtime integration

The source seed and probe route return an internal base64 capture through the private ACI controller channel; controller-side callbacks decode it to an in-memory `Buffer`. The independent marker-reader callback captures its Blob GET response directly. The session analogue calls the persister after the four audit observations and before marker cleanup; only the returned `{evidenceReference,snapshotFingerprint}` is kept in trial evidence. The Azure versioned evidence adapter requires Blob versioning to return `x-ms-version-id`; it reads and validates the locked immutability policy and round-trips the exact version using a separate reader identity. The code remains locally tested only; Azure behavior, policy, identity separation, and 50-row run remain unvalidated.
