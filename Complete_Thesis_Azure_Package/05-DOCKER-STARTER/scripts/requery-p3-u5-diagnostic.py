"""Read-only exact-window AzureDiagnostics re-query for the saved Central P3 U5 pilot.

This helper is intended for Azure VM Run Command on the controller. It uses the
controller's audit managed identity and emits only tuple/action/rule/timestamp
fields; it never prints its access token or raw msg_s records.
"""
import json
import urllib.error
import urllib.parse
import urllib.request

CLIENT_ID = "85b40cb2-af3c-4fe5-b2e0-464abafeb9ea"
WORKSPACE_ID = "e5bd1dbf-98ea-4a32-985a-caa6e0f5965e"
QUERY = r'''AzureDiagnostics
| where TimeGenerated between (datetime(2026-11-05T08:52:47.792Z) .. datetime(2026-11-05T08:52:55.897Z))
| where Category == "AzureFirewallNetworkRule"
| extend SourceIP = extract(@"(?i)(?:TCP|UDP) request from ([0-9.]+):([0-9]+) to ", 1, msg_s),
         SourcePort = toint(extract(@"(?i)(?:TCP|UDP) request from ([0-9.]+):([0-9]+) to ", 2, msg_s)),
         DestinationIP = extract(@"(?i) to ([0-9.]+):([0-9]+)\. Action:", 1, msg_s),
         DestinationPort = toint(extract(@"(?i) to ([0-9.]+):([0-9]+)\. Action:", 2, msg_s)),
         Action = extract(@"(?i)Action:\s*(Allow|Deny)\.", 1, msg_s),
         RuleName = extract(@"(?i)Rule:\s*([A-Za-z0-9_-]+)(?:\.|$)", 1, msg_s)
| where SourceIP == "10.49.8.4" and DestinationIP == "10.48.9.5" and DestinationPort == 8443
| where Action in ("Allow", "Deny")
| project TimeGenerated, Category, ResourceId, SourceIP, SourcePort, DestinationIP,
          DestinationPort, Action, RuleName
| take 100'''


def request_json(url, *, headers=None, body=None, timeout=60):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method="POST" if body else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


try:
    params = urllib.parse.urlencode({
        "api-version": "2018-02-01",
        "resource": "https://api.loganalytics.io",
        "client_id": CLIENT_ID,
    })
    identity = request_json(
        "http://169.254.169.254/metadata/identity/oauth2/token?" + params,
        headers={"Metadata": "true"}, timeout=15,
    )
    token = identity.get("access_token")
    if not isinstance(token, str) or not token:
        print(json.dumps({"error": "managed_identity_token_missing"}))
        raise SystemExit(2)
    payload = json.dumps({"query": QUERY}).encode()
    result = request_json(
        f"https://api.loganalytics.azure.com/v1/workspaces/{WORKSPACE_ID}/query",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        body=payload,
    )
    table = (result.get("tables") or [{}])[0]
    columns = [column.get("name") for column in table.get("columns", [])]
    rows = [dict(zip(columns, row)) for row in table.get("rows", [])]
    fields = ("TimeGenerated", "SourceIP", "SourcePort", "DestinationIP", "DestinationPort", "Action", "RuleName")
    print(json.dumps({"count": len(rows), "events": [{key: row.get(key) for key in fields} for row in rows]}, separators=(",", ":")))
except urllib.error.HTTPError as error:
    print(json.dumps({"error": "query_http_error", "status": error.code}))
    raise SystemExit(3)
except Exception as error:
    print(json.dumps({"error": type(error).__name__}))
    raise SystemExit(4)
