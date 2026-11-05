"""Read selected non-secret fields from the saved Functions P3 U7 pilot record."""
import hashlib
import json
from pathlib import Path

RUN_ID = "pilot-functions-p3-u7-20261105a"
RECORD = Path("/opt/thesis-aci-runner-20261104/results/non-counted-pilot-functions-p3-u7-20261105/pilot-functions-p3-u7-20261105a.json")
envelope = json.loads(RECORD.read_text(encoding="utf-8"))
payload = envelope.get("payload")
if not isinstance(payload, str) or hashlib.sha256(payload.encode()).hexdigest() != envelope.get("sha256"):
    print(json.dumps({"error": "pilot_evidence_integrity_check_failed"}))
    raise SystemExit(2)
record = json.loads(payload)
if record.get("runId") != RUN_ID or record.get("mode") != "non_counted_pilot":
    print(json.dumps({"error": "pilot_record_identity_mismatch"}))
    raise SystemExit(2)
output = record.get("output") or {}
verification = record.get("verificationEvidence") or {}
evidence = verification.get("evidence") or {}
print(json.dumps({
    "runId": record.get("runId"),
    "mode": record.get("mode"),
    "classification": record.get("classification"),
    "executionStartedAt": record.get("executionStartedAt"),
    "executionFinishedAt": record.get("executionFinishedAt"),
    "transportOk": output.get("transportOk"),
    "httpStatus": output.get("status"),
    "agentOutputKeys": sorted(output.keys()),
    "verificationSource": evidence.get("source"),
    "deniedRecords": evidence.get("deniedRecords"),
    "denialRule": (evidence.get("first") or {}).get("ruleName"),
}, separators=(",", ":")))
