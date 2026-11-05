"""Independently re-query the exact saved Functions P3 U7 execution window.

Run on the controller with its audit managed identity. Reads the local pilot
envelope, validates its SHA-256, and emits only the exact network tuple fields.
"""
import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CLIENT_ID = "85b40cb2-af3c-4fe5-b2e0-464abafeb9ea"
WORKSPACE_ID = "e5bd1dbf-98ea-4a32-985a-caa6e0f5965e"
RUN_ID = "pilot-functions-p3-u7-20261105a"
RECORD = Path("/opt/thesis-aci-runner-20261104/results/non-counted-pilot-functions-p3-u7-20261105/pilot-functions-p3-u7-20261105a.json")


def read_json(url, *, headers=None, body=None, timeout=60):
    request = urllib.request.Request(url, data=body, headers=headers or {}, method="POST" if body else "GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


try:
    envelope = json.loads(RECORD.read_text(encoding="utf-8"))
    payload = envelope.get("payload")
    if not isinstance(payload, str) or hashlib.sha256(payload.encode()).hexdigest() != envelope.get("sha256"):
        print(json.dumps({"error": "pilot_evidence_integrity_check_failed"}))
        raise SystemExit(2)
    record = json.loads(payload)
    if record.get("runId") != RUN_ID or record.get("classification") != "confirmed_network_denial" or record.get("mode") != "non_counted_pilot":
        print(json.dumps({"error": "pilot_record_identity_or_classification_mismatch"}))
        raise SystemExit(2)
    start = record.get("executionStartedAt")
    end = record.get("executionFinishedAt")
    if not isinstance(start, str) or not isinstance(end, str):
        print(json.dumps({"error": "pilot_execution_window_missing"}))
        raise SystemExit(2)
    query = f'''AzureDiagnostics
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where Category == "AzureFirewallNetworkRule"
| extend SourceIP = extract(@"(?i)(?:TCP|UDP) request from ([0-9.]+):([0-9]+) to ", 1, msg_s),
         SourcePort = toint(extract(@"(?i)(?:TCP|UDP) request from ([0-9.]+):([0-9]+) to ", 2, msg_s)),
         DestinationIP = extract(@"(?i) to ([0-9.]+):([0-9]+)\\. Action:", 1, msg_s),
         DestinationPort = toint(extract(@"(?i) to ([0-9.]+):([0-9]+)\\. Action:", 2, msg_s)),
         Action = extract(@"(?i)Action:\\s*(Allow|Deny)\\.", 1, msg_s),
         RuleName = extract(@"(?i)Rule:\\s*([A-Za-z0-9_-]+)(?:\\.|$)", 1, msg_s)
| where ipv4_is_in_range(SourceIP, "10.48.6.0/24") and DestinationIP == "10.48.9.5" and DestinationPort == 8443
| where Action in ("Allow", "Deny")
| project TimeGenerated, SourceIP, SourcePort, DestinationIP, DestinationPort, Action, RuleName
| take 100'''
    params = urllib.parse.urlencode({"api-version": "2018-02-01", "resource": "https://api.loganalytics.io", "client_id": CLIENT_ID})
    identity = read_json("http://169.254.169.254/metadata/identity/oauth2/token?" + params,
                         headers={"Metadata": "true"}, timeout=15)
    token = identity.get("access_token")
    if not isinstance(token, str) or not token:
        print(json.dumps({"error": "managed_identity_token_missing"}))
        raise SystemExit(3)
    body = json.dumps({"query": query}).encode()
    result = read_json(f"https://api.loganalytics.azure.com/v1/workspaces/{WORKSPACE_ID}/query",
                       headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, body=body)
    table = (result.get("tables") or [{}])[0]
    columns = [item.get("name") for item in table.get("columns", [])]
    rows = [dict(zip(columns, row)) for row in table.get("rows", [])]
    fields = ("TimeGenerated", "SourceIP", "SourcePort", "DestinationIP", "DestinationPort", "Action", "RuleName")
    print(json.dumps({"runId": RUN_ID, "executionStartedAt": start, "executionFinishedAt": end,
                      "count": len(rows), "events": [{key: row.get(key) for key in fields} for row in rows]}, separators=(",", ":")))
except urllib.error.HTTPError as error:
    print(json.dumps({"error": "query_http_error", "status": error.code}))
    raise SystemExit(4)
except Exception as error:
    print(json.dumps({"error": type(error).__name__}))
    raise SystemExit(5)
