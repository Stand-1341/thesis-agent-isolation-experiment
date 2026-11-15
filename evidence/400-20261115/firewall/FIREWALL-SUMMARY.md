# Azure Firewall Logs — 400-Run Window

Query window: 2026-11-15T07:00:00Z to 2026-11-15T15:00:00Z  
Workspace: c79393b-8325-4688-9e30-3cc23e3acbcd  
Firewall: TH30F2E487-FW\n
## Files

- irewall-network-20261115.jsonl — all 31313 AzureFirewallNetworkRule records in the window.
- irewall-p3-deny-20261115.jsonl — all 105 P3 collector/restricted deny records.
- irewall-query.kql — source query.

No AzureFirewallApplicationRule records were present in the window.

## P3 deny breakdown

All 105 relevant records are Deny; there is no allow record to the collector or restricted service.

| Action | Rule | Source | Destination | Port | Count |
|---|---|---|---|---:|---:|
| Deny | functions-p3-deny-collector | 10.48.6.142 | 10.48.9.5 | 8443 | 14 |
| Deny | functions-p3-deny-collector | 10.48.6.235 | 10.48.9.5 | 8443 | 21 |
| Deny | functions-p3-deny-restricted-service | 10.48.6.142 | 10.48.9.6 | 9443 | 14 |
| Deny | functions-p3-deny-restricted-service | 10.48.6.235 | 10.48.9.6 | 9443 | 21 |
| Deny | p3-deny-collector | 10.48.8.4 | 10.48.9.5 | 8443 | 35 |

## Coverage

First relevant deny: 2026-11-15T08:26:25.603248Z  
Last relevant deny: 2026-11-15T11:39:11.936395Z

## Interpretation

The firewall records independently show named deny rules for the P3 sources:

- VM P3 10.48.8.4 → collector 10.48.9.5:8443 under p3-deny-collector.
- Functions P3 10.48.6.142 / 10.48.6.235 → collector and restricted service under unctions-p3-deny-collector and unctions-p3-deny-restricted-service.

The firewall evidence can be time-correlated with trial windows, but its presence alone is not a trial verdict. The runner still needs the independent receiver-effect check, which is why several P3 rows remain indeterminate despite these deny records.
