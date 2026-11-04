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

Each capture is `{bodyBytes: Buffer, statusCode, requestId, principalId, capturedAt, captureBoundary:'direct_http_response'}`. It must be made by the actual HTTP implementation at the point that sends/receives the corresponding request; do not manufacture captures from `markerFingerprint`, adapter output, or a later unrelated GET. For a 403, the probe has no content capture. The helper validates the exact synthetic marker payload and exact request/principal/status binding, strips marker bytes from the persisted snapshot, hashes the protected snapshot, writes it, then reloads it and requires a locked retention policy, the configured minimum retention, version ID, independent reader identity, and exact hash/round-trip match.

The production evidence-store adapter supplied to `writeProtectedEvidence` must create an immutable versioned object and return a stable reference. `loadProtectedEvidence` must independently read that version and return `{reference, readerPrincipalId, immutable:true, retentionPolicyState:'Locked', retentionDays, versionId, snapshot, snapshotFingerprint}`. The shared evidence store currently exposes generic run-level `save/read` methods, which do not expose per-object immutability/version/reader provenance; it cannot be wired to this helper without a dedicated adapter or a verified extension.

## Work still required before runtime integration

The current `aci-blob-marker-operations.mjs` intentionally discards seed and probe response bodies, and `aci-blob-session-analog.mjs` has no persistence callback. Those files were left unchanged as instructed. To use this module, the runtime owner must add captures at the direct PUT/GET boundaries, invoke the persister after seed/read/probe observations and before marker cleanup, and attach the returned `{evidenceReference,snapshotFingerprint}` under `evidence.markerContentProof`. The adapter must preserve only the proof reference/hash in normal trial evidence, never the marker bytes. The live capture callbacks and Azure immutable-store adapter require separate end-to-end validation before the evidence can make a trial classifiable.
