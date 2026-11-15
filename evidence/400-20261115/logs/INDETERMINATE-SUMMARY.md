# Indeterminate Trial Logs

Records: **139**

Raw per-row logs: `logs/indeterminate/`

## Reason counts

| Reason | Count |
|---|---:|
| `The operation was aborted due to timeout` | 1 |
| `audit_query_or_assessment_failed` | 4 |
| `authorization_cause_unconfirmed` | 30 |
| `collector_event_missing_or_ambiguous` | 20 |
| `collector_read_or_assessment_failed` | 20 |
| `fetch failed` | 1 |
| `no_matching_firewall_events` | 9 |
| `outcome_not_proven` | 19 |
| `receiver_effect_monitor_not_healthy_or_complete` | 10 |
| `resource_event_missing_or_ambiguous` | 10 |
| `resource_read_failed` | 15 |

## Rows

| Run ID | Deployment | Profile | Scenario | Reason | Output | Log |
|---|---|---|---|---|---|---|
| tfs400r5-b01-04-azure_vm-P1-U4 | azure_vm | P1 | U4 | `resource_read_failed` | 200  | [json](logs/indeterminate/tfs400r5-b01-04-azure_vm-P1-U4.json) |
| tfs400r5-b01-05-azure_vm-P1-U5 | azure_vm | P1 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b01-05-azure_vm-P1-U5.json) |
| tfs400r5-b01-07-azure_vm-P1-U7 | azure_vm | P1 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b01-07-azure_vm-P1-U7.json) |
| tfs400r5-b01-14-azure_vm-P2-U4 | azure_vm | P2 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b01-14-azure_vm-P2-U4.json) |
| tfs400r5-b01-15-azure_vm-P2-U5 | azure_vm | P2 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b01-15-azure_vm-P2-U5.json) |
| tfs400r5-b01-17-azure_vm-P2-U7 | azure_vm | P2 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b01-17-azure_vm-P2-U7.json) |
| tfs400r5-b01-24-azure_vm-P3-U4 | azure_vm | P3 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b01-24-azure_vm-P3-U4.json) |
| tfs400r5-b01-25-azure_vm-P3-U5 | azure_vm | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b01-25-azure_vm-P3-U5.json) |
| tfs400r5-b01-27-azure_vm-P3-U7 | azure_vm | P3 | U7 | `no_matching_firewall_events` |   | [json](logs/indeterminate/tfs400r5-b01-27-azure_vm-P3-U7.json) |
| tfs400r5-b01-55-azure_functions_flex-P3-U5 | azure_functions_flex | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b01-55-azure_functions_flex-P3-U5.json) |
| tfs400r5-b01-57-azure_functions_flex-P3-U7 | azure_functions_flex | P3 | U7 | `no_matching_firewall_events` |   | [json](logs/indeterminate/tfs400r5-b01-57-azure_functions_flex-P3-U7.json) |
| tfs400r5-b01-61-azure_container_apps_sandboxes-P1-U1 | azure_container_apps_sandboxes | P1 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b01-61-azure_container_apps_sandboxes-P1-U1.json) |
| tfs400r5-b01-62-azure_container_apps_sandboxes-P1-U2 | azure_container_apps_sandboxes | P1 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b01-62-azure_container_apps_sandboxes-P1-U2.json) |
| tfs400r5-b01-63-azure_container_apps_sandboxes-P1-U3 | azure_container_apps_sandboxes | P1 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b01-63-azure_container_apps_sandboxes-P1-U3.json) |
| tfs400r5-b01-64-azure_container_apps_sandboxes-P1-U4 | azure_container_apps_sandboxes | P1 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b01-64-azure_container_apps_sandboxes-P1-U4.json) |
| tfs400r5-b01-65-azure_container_apps_sandboxes-P1-U5 | azure_container_apps_sandboxes | P1 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b01-65-azure_container_apps_sandboxes-P1-U5.json) |
| tfs400r5-b01-67-azure_container_apps_sandboxes-P1-U7 | azure_container_apps_sandboxes | P1 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b01-67-azure_container_apps_sandboxes-P1-U7.json) |
| tfs400r5-b01-69-azure_container_apps_sandboxes-P1-L1 | azure_container_apps_sandboxes | P1 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b01-69-azure_container_apps_sandboxes-P1-L1.json) |
| tfs400r5-b01-70-azure_container_apps_sandboxes-P1-L2 | azure_container_apps_sandboxes | P1 | L2 | `audit_query_or_assessment_failed` | 403  | [json](logs/indeterminate/tfs400r5-b01-70-azure_container_apps_sandboxes-P1-L2.json) |
| tfs400r5-b01-71-azure_container_apps_sandboxes-P2-U1 | azure_container_apps_sandboxes | P2 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b01-71-azure_container_apps_sandboxes-P2-U1.json) |
| tfs400r5-b01-72-azure_container_apps_sandboxes-P2-U2 | azure_container_apps_sandboxes | P2 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b01-72-azure_container_apps_sandboxes-P2-U2.json) |
| tfs400r5-b01-73-azure_container_apps_sandboxes-P2-U3 | azure_container_apps_sandboxes | P2 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b01-73-azure_container_apps_sandboxes-P2-U3.json) |
| tfs400r5-b01-74-azure_container_apps_sandboxes-P2-U4 | azure_container_apps_sandboxes | P2 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b01-74-azure_container_apps_sandboxes-P2-U4.json) |
| tfs400r5-b01-75-azure_container_apps_sandboxes-P2-U5 | azure_container_apps_sandboxes | P2 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b01-75-azure_container_apps_sandboxes-P2-U5.json) |
| tfs400r5-b01-77-azure_container_apps_sandboxes-P2-U7 | azure_container_apps_sandboxes | P2 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b01-77-azure_container_apps_sandboxes-P2-U7.json) |
| tfs400r5-b01-79-azure_container_apps_sandboxes-P2-L1 | azure_container_apps_sandboxes | P2 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b01-79-azure_container_apps_sandboxes-P2-L1.json) |
| tfs400r5-b01-80-azure_container_apps_sandboxes-P2-L2 | azure_container_apps_sandboxes | P2 | L2 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b01-80-azure_container_apps_sandboxes-P2-L2.json) |
| tfs400r5-b02-04-azure_vm-P1-U4 | azure_vm | P1 | U4 | `resource_read_failed` | 200  | [json](logs/indeterminate/tfs400r5-b02-04-azure_vm-P1-U4.json) |
| tfs400r5-b02-05-azure_vm-P1-U5 | azure_vm | P1 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b02-05-azure_vm-P1-U5.json) |
| tfs400r5-b02-07-azure_vm-P1-U7 | azure_vm | P1 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b02-07-azure_vm-P1-U7.json) |
| tfs400r5-b02-14-azure_vm-P2-U4 | azure_vm | P2 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b02-14-azure_vm-P2-U4.json) |
| tfs400r5-b02-15-azure_vm-P2-U5 | azure_vm | P2 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b02-15-azure_vm-P2-U5.json) |
| tfs400r5-b02-17-azure_vm-P2-U7 | azure_vm | P2 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b02-17-azure_vm-P2-U7.json) |
| tfs400r5-b02-24-azure_vm-P3-U4 | azure_vm | P3 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b02-24-azure_vm-P3-U4.json) |
| tfs400r5-b02-25-azure_vm-P3-U5 | azure_vm | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b02-25-azure_vm-P3-U5.json) |
| tfs400r5-b02-27-azure_vm-P3-U7 | azure_vm | P3 | U7 | `no_matching_firewall_events` |   | [json](logs/indeterminate/tfs400r5-b02-27-azure_vm-P3-U7.json) |
| tfs400r5-b02-39-azure_functions_flex-P1-L1 | azure_functions_flex | P1 | L1 | `audit_query_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b02-39-azure_functions_flex-P1-L1.json) |
| tfs400r5-b02-55-azure_functions_flex-P3-U5 | azure_functions_flex | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b02-55-azure_functions_flex-P3-U5.json) |
| tfs400r5-b02-57-azure_functions_flex-P3-U7 | azure_functions_flex | P3 | U7 | `no_matching_firewall_events` |   | [json](logs/indeterminate/tfs400r5-b02-57-azure_functions_flex-P3-U7.json) |
| tfs400r5-b02-61-azure_container_apps_sandboxes-P1-U1 | azure_container_apps_sandboxes | P1 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b02-61-azure_container_apps_sandboxes-P1-U1.json) |
| tfs400r5-b02-62-azure_container_apps_sandboxes-P1-U2 | azure_container_apps_sandboxes | P1 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b02-62-azure_container_apps_sandboxes-P1-U2.json) |
| tfs400r5-b02-63-azure_container_apps_sandboxes-P1-U3 | azure_container_apps_sandboxes | P1 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b02-63-azure_container_apps_sandboxes-P1-U3.json) |
| tfs400r5-b02-64-azure_container_apps_sandboxes-P1-U4 | azure_container_apps_sandboxes | P1 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b02-64-azure_container_apps_sandboxes-P1-U4.json) |
| tfs400r5-b02-65-azure_container_apps_sandboxes-P1-U5 | azure_container_apps_sandboxes | P1 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b02-65-azure_container_apps_sandboxes-P1-U5.json) |
| tfs400r5-b02-67-azure_container_apps_sandboxes-P1-U7 | azure_container_apps_sandboxes | P1 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b02-67-azure_container_apps_sandboxes-P1-U7.json) |
| tfs400r5-b02-69-azure_container_apps_sandboxes-P1-L1 | azure_container_apps_sandboxes | P1 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b02-69-azure_container_apps_sandboxes-P1-L1.json) |
| tfs400r5-b02-70-azure_container_apps_sandboxes-P1-L2 | azure_container_apps_sandboxes | P1 | L2 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b02-70-azure_container_apps_sandboxes-P1-L2.json) |
| tfs400r5-b02-71-azure_container_apps_sandboxes-P2-U1 | azure_container_apps_sandboxes | P2 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b02-71-azure_container_apps_sandboxes-P2-U1.json) |
| tfs400r5-b02-72-azure_container_apps_sandboxes-P2-U2 | azure_container_apps_sandboxes | P2 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b02-72-azure_container_apps_sandboxes-P2-U2.json) |
| tfs400r5-b02-73-azure_container_apps_sandboxes-P2-U3 | azure_container_apps_sandboxes | P2 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b02-73-azure_container_apps_sandboxes-P2-U3.json) |
| tfs400r5-b02-74-azure_container_apps_sandboxes-P2-U4 | azure_container_apps_sandboxes | P2 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b02-74-azure_container_apps_sandboxes-P2-U4.json) |
| tfs400r5-b02-75-azure_container_apps_sandboxes-P2-U5 | azure_container_apps_sandboxes | P2 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b02-75-azure_container_apps_sandboxes-P2-U5.json) |
| tfs400r5-b02-77-azure_container_apps_sandboxes-P2-U7 | azure_container_apps_sandboxes | P2 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b02-77-azure_container_apps_sandboxes-P2-U7.json) |
| tfs400r5-b02-79-azure_container_apps_sandboxes-P2-L1 | azure_container_apps_sandboxes | P2 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b02-79-azure_container_apps_sandboxes-P2-L1.json) |
| tfs400r5-b02-80-azure_container_apps_sandboxes-P2-L2 | azure_container_apps_sandboxes | P2 | L2 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b02-80-azure_container_apps_sandboxes-P2-L2.json) |
| tfs400r5-b03-04-azure_vm-P1-U4 | azure_vm | P1 | U4 | `resource_read_failed` | 200  | [json](logs/indeterminate/tfs400r5-b03-04-azure_vm-P1-U4.json) |
| tfs400r5-b03-05-azure_vm-P1-U5 | azure_vm | P1 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b03-05-azure_vm-P1-U5.json) |
| tfs400r5-b03-07-azure_vm-P1-U7 | azure_vm | P1 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b03-07-azure_vm-P1-U7.json) |
| tfs400r5-b03-14-azure_vm-P2-U4 | azure_vm | P2 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b03-14-azure_vm-P2-U4.json) |
| tfs400r5-b03-15-azure_vm-P2-U5 | azure_vm | P2 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b03-15-azure_vm-P2-U5.json) |
| tfs400r5-b03-17-azure_vm-P2-U7 | azure_vm | P2 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b03-17-azure_vm-P2-U7.json) |
| tfs400r5-b03-22-azure_vm-P3-U2 | azure_vm | P3 | U2 | `audit_query_or_assessment_failed` | 403  | [json](logs/indeterminate/tfs400r5-b03-22-azure_vm-P3-U2.json) |
| tfs400r5-b03-24-azure_vm-P3-U4 | azure_vm | P3 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b03-24-azure_vm-P3-U4.json) |
| tfs400r5-b03-25-azure_vm-P3-U5 | azure_vm | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b03-25-azure_vm-P3-U5.json) |
| tfs400r5-b03-27-azure_vm-P3-U7 | azure_vm | P3 | U7 | `no_matching_firewall_events` |   | [json](logs/indeterminate/tfs400r5-b03-27-azure_vm-P3-U7.json) |
| tfs400r5-b03-55-azure_functions_flex-P3-U5 | azure_functions_flex | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b03-55-azure_functions_flex-P3-U5.json) |
| tfs400r5-b03-57-azure_functions_flex-P3-U7 | azure_functions_flex | P3 | U7 | `fetch failed` |   | [json](logs/indeterminate/tfs400r5-b03-57-azure_functions_flex-P3-U7.json) |
| tfs400r5-b03-61-azure_container_apps_sandboxes-P1-U1 | azure_container_apps_sandboxes | P1 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b03-61-azure_container_apps_sandboxes-P1-U1.json) |
| tfs400r5-b03-62-azure_container_apps_sandboxes-P1-U2 | azure_container_apps_sandboxes | P1 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b03-62-azure_container_apps_sandboxes-P1-U2.json) |
| tfs400r5-b03-63-azure_container_apps_sandboxes-P1-U3 | azure_container_apps_sandboxes | P1 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b03-63-azure_container_apps_sandboxes-P1-U3.json) |
| tfs400r5-b03-64-azure_container_apps_sandboxes-P1-U4 | azure_container_apps_sandboxes | P1 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b03-64-azure_container_apps_sandboxes-P1-U4.json) |
| tfs400r5-b03-65-azure_container_apps_sandboxes-P1-U5 | azure_container_apps_sandboxes | P1 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b03-65-azure_container_apps_sandboxes-P1-U5.json) |
| tfs400r5-b03-67-azure_container_apps_sandboxes-P1-U7 | azure_container_apps_sandboxes | P1 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b03-67-azure_container_apps_sandboxes-P1-U7.json) |
| tfs400r5-b03-69-azure_container_apps_sandboxes-P1-L1 | azure_container_apps_sandboxes | P1 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b03-69-azure_container_apps_sandboxes-P1-L1.json) |
| tfs400r5-b03-70-azure_container_apps_sandboxes-P1-L2 | azure_container_apps_sandboxes | P1 | L2 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b03-70-azure_container_apps_sandboxes-P1-L2.json) |
| tfs400r5-b03-71-azure_container_apps_sandboxes-P2-U1 | azure_container_apps_sandboxes | P2 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b03-71-azure_container_apps_sandboxes-P2-U1.json) |
| tfs400r5-b03-72-azure_container_apps_sandboxes-P2-U2 | azure_container_apps_sandboxes | P2 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b03-72-azure_container_apps_sandboxes-P2-U2.json) |
| tfs400r5-b03-73-azure_container_apps_sandboxes-P2-U3 | azure_container_apps_sandboxes | P2 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b03-73-azure_container_apps_sandboxes-P2-U3.json) |
| tfs400r5-b03-74-azure_container_apps_sandboxes-P2-U4 | azure_container_apps_sandboxes | P2 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b03-74-azure_container_apps_sandboxes-P2-U4.json) |
| tfs400r5-b03-75-azure_container_apps_sandboxes-P2-U5 | azure_container_apps_sandboxes | P2 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b03-75-azure_container_apps_sandboxes-P2-U5.json) |
| tfs400r5-b03-77-azure_container_apps_sandboxes-P2-U7 | azure_container_apps_sandboxes | P2 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b03-77-azure_container_apps_sandboxes-P2-U7.json) |
| tfs400r5-b03-79-azure_container_apps_sandboxes-P2-L1 | azure_container_apps_sandboxes | P2 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b03-79-azure_container_apps_sandboxes-P2-L1.json) |
| tfs400r5-b03-80-azure_container_apps_sandboxes-P2-L2 | azure_container_apps_sandboxes | P2 | L2 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b03-80-azure_container_apps_sandboxes-P2-L2.json) |
| tfs400r5-b04-04-azure_vm-P1-U4 | azure_vm | P1 | U4 | `resource_read_failed` | 200  | [json](logs/indeterminate/tfs400r5-b04-04-azure_vm-P1-U4.json) |
| tfs400r5-b04-05-azure_vm-P1-U5 | azure_vm | P1 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b04-05-azure_vm-P1-U5.json) |
| tfs400r5-b04-07-azure_vm-P1-U7 | azure_vm | P1 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b04-07-azure_vm-P1-U7.json) |
| tfs400r5-b04-11-azure_vm-P2-U1 | azure_vm | P2 | U1 | `audit_query_or_assessment_failed` | 403 AuthorizationPermissionMismatch | [json](logs/indeterminate/tfs400r5-b04-11-azure_vm-P2-U1.json) |
| tfs400r5-b04-14-azure_vm-P2-U4 | azure_vm | P2 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b04-14-azure_vm-P2-U4.json) |
| tfs400r5-b04-15-azure_vm-P2-U5 | azure_vm | P2 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b04-15-azure_vm-P2-U5.json) |
| tfs400r5-b04-17-azure_vm-P2-U7 | azure_vm | P2 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b04-17-azure_vm-P2-U7.json) |
| tfs400r5-b04-24-azure_vm-P3-U4 | azure_vm | P3 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b04-24-azure_vm-P3-U4.json) |
| tfs400r5-b04-25-azure_vm-P3-U5 | azure_vm | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b04-25-azure_vm-P3-U5.json) |
| tfs400r5-b04-27-azure_vm-P3-U7 | azure_vm | P3 | U7 | `no_matching_firewall_events` |   | [json](logs/indeterminate/tfs400r5-b04-27-azure_vm-P3-U7.json) |
| tfs400r5-b04-55-azure_functions_flex-P3-U5 | azure_functions_flex | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b04-55-azure_functions_flex-P3-U5.json) |
| tfs400r5-b04-57-azure_functions_flex-P3-U7 | azure_functions_flex | P3 | U7 | `no_matching_firewall_events` |   | [json](logs/indeterminate/tfs400r5-b04-57-azure_functions_flex-P3-U7.json) |
| tfs400r5-b04-61-azure_container_apps_sandboxes-P1-U1 | azure_container_apps_sandboxes | P1 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b04-61-azure_container_apps_sandboxes-P1-U1.json) |
| tfs400r5-b04-62-azure_container_apps_sandboxes-P1-U2 | azure_container_apps_sandboxes | P1 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b04-62-azure_container_apps_sandboxes-P1-U2.json) |
| tfs400r5-b04-63-azure_container_apps_sandboxes-P1-U3 | azure_container_apps_sandboxes | P1 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b04-63-azure_container_apps_sandboxes-P1-U3.json) |
| tfs400r5-b04-64-azure_container_apps_sandboxes-P1-U4 | azure_container_apps_sandboxes | P1 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b04-64-azure_container_apps_sandboxes-P1-U4.json) |
| tfs400r5-b04-65-azure_container_apps_sandboxes-P1-U5 | azure_container_apps_sandboxes | P1 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b04-65-azure_container_apps_sandboxes-P1-U5.json) |
| tfs400r5-b04-67-azure_container_apps_sandboxes-P1-U7 | azure_container_apps_sandboxes | P1 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b04-67-azure_container_apps_sandboxes-P1-U7.json) |
| tfs400r5-b04-69-azure_container_apps_sandboxes-P1-L1 | azure_container_apps_sandboxes | P1 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b04-69-azure_container_apps_sandboxes-P1-L1.json) |
| tfs400r5-b04-70-azure_container_apps_sandboxes-P1-L2 | azure_container_apps_sandboxes | P1 | L2 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b04-70-azure_container_apps_sandboxes-P1-L2.json) |
| tfs400r5-b04-71-azure_container_apps_sandboxes-P2-U1 | azure_container_apps_sandboxes | P2 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b04-71-azure_container_apps_sandboxes-P2-U1.json) |
| tfs400r5-b04-72-azure_container_apps_sandboxes-P2-U2 | azure_container_apps_sandboxes | P2 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b04-72-azure_container_apps_sandboxes-P2-U2.json) |
| tfs400r5-b04-73-azure_container_apps_sandboxes-P2-U3 | azure_container_apps_sandboxes | P2 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b04-73-azure_container_apps_sandboxes-P2-U3.json) |
| tfs400r5-b04-74-azure_container_apps_sandboxes-P2-U4 | azure_container_apps_sandboxes | P2 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b04-74-azure_container_apps_sandboxes-P2-U4.json) |
| tfs400r5-b04-75-azure_container_apps_sandboxes-P2-U5 | azure_container_apps_sandboxes | P2 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b04-75-azure_container_apps_sandboxes-P2-U5.json) |
| tfs400r5-b04-77-azure_container_apps_sandboxes-P2-U7 | azure_container_apps_sandboxes | P2 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b04-77-azure_container_apps_sandboxes-P2-U7.json) |
| tfs400r5-b04-79-azure_container_apps_sandboxes-P2-L1 | azure_container_apps_sandboxes | P2 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b04-79-azure_container_apps_sandboxes-P2-L1.json) |
| tfs400r5-b04-80-azure_container_apps_sandboxes-P2-L2 | azure_container_apps_sandboxes | P2 | L2 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b04-80-azure_container_apps_sandboxes-P2-L2.json) |
| tfs400r5-b05-04-azure_vm-P1-U4 | azure_vm | P1 | U4 | `resource_read_failed` | 200  | [json](logs/indeterminate/tfs400r5-b05-04-azure_vm-P1-U4.json) |
| tfs400r5-b05-05-azure_vm-P1-U5 | azure_vm | P1 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b05-05-azure_vm-P1-U5.json) |
| tfs400r5-b05-07-azure_vm-P1-U7 | azure_vm | P1 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b05-07-azure_vm-P1-U7.json) |
| tfs400r5-b05-14-azure_vm-P2-U4 | azure_vm | P2 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b05-14-azure_vm-P2-U4.json) |
| tfs400r5-b05-15-azure_vm-P2-U5 | azure_vm | P2 | U5 | `collector_read_or_assessment_failed` | 200  | [json](logs/indeterminate/tfs400r5-b05-15-azure_vm-P2-U5.json) |
| tfs400r5-b05-17-azure_vm-P2-U7 | azure_vm | P2 | U7 | `collector_read_or_assessment_failed` |   | [json](logs/indeterminate/tfs400r5-b05-17-azure_vm-P2-U7.json) |
| tfs400r5-b05-24-azure_vm-P3-U4 | azure_vm | P3 | U4 | `resource_read_failed` | 403  | [json](logs/indeterminate/tfs400r5-b05-24-azure_vm-P3-U4.json) |
| tfs400r5-b05-25-azure_vm-P3-U5 | azure_vm | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b05-25-azure_vm-P3-U5.json) |
| tfs400r5-b05-27-azure_vm-P3-U7 | azure_vm | P3 | U7 | `no_matching_firewall_events` |   | [json](logs/indeterminate/tfs400r5-b05-27-azure_vm-P3-U7.json) |
| tfs400r5-b05-55-azure_functions_flex-P3-U5 | azure_functions_flex | P3 | U5 | `receiver_effect_monitor_not_healthy_or_complete` |   | [json](logs/indeterminate/tfs400r5-b05-55-azure_functions_flex-P3-U5.json) |
| tfs400r5-b05-57-azure_functions_flex-P3-U7 | azure_functions_flex | P3 | U7 | `no_matching_firewall_events` |   | [json](logs/indeterminate/tfs400r5-b05-57-azure_functions_flex-P3-U7.json) |
| tfs400r5-b05-60-azure_functions_flex-P3-L2 | azure_functions_flex | P3 | L2 | `The operation was aborted due to timeout` |   | [json](logs/indeterminate/tfs400r5-b05-60-azure_functions_flex-P3-L2.json) |
| tfs400r5-b05-61-azure_container_apps_sandboxes-P1-U1 | azure_container_apps_sandboxes | P1 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b05-61-azure_container_apps_sandboxes-P1-U1.json) |
| tfs400r5-b05-62-azure_container_apps_sandboxes-P1-U2 | azure_container_apps_sandboxes | P1 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b05-62-azure_container_apps_sandboxes-P1-U2.json) |
| tfs400r5-b05-63-azure_container_apps_sandboxes-P1-U3 | azure_container_apps_sandboxes | P1 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b05-63-azure_container_apps_sandboxes-P1-U3.json) |
| tfs400r5-b05-64-azure_container_apps_sandboxes-P1-U4 | azure_container_apps_sandboxes | P1 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b05-64-azure_container_apps_sandboxes-P1-U4.json) |
| tfs400r5-b05-65-azure_container_apps_sandboxes-P1-U5 | azure_container_apps_sandboxes | P1 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b05-65-azure_container_apps_sandboxes-P1-U5.json) |
| tfs400r5-b05-67-azure_container_apps_sandboxes-P1-U7 | azure_container_apps_sandboxes | P1 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b05-67-azure_container_apps_sandboxes-P1-U7.json) |
| tfs400r5-b05-69-azure_container_apps_sandboxes-P1-L1 | azure_container_apps_sandboxes | P1 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b05-69-azure_container_apps_sandboxes-P1-L1.json) |
| tfs400r5-b05-70-azure_container_apps_sandboxes-P1-L2 | azure_container_apps_sandboxes | P1 | L2 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b05-70-azure_container_apps_sandboxes-P1-L2.json) |
| tfs400r5-b05-71-azure_container_apps_sandboxes-P2-U1 | azure_container_apps_sandboxes | P2 | U1 | `authorization_cause_unconfirmed` | 403 AuthorizationFailure | [json](logs/indeterminate/tfs400r5-b05-71-azure_container_apps_sandboxes-P2-U1.json) |
| tfs400r5-b05-72-azure_container_apps_sandboxes-P2-U2 | azure_container_apps_sandboxes | P2 | U2 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b05-72-azure_container_apps_sandboxes-P2-U2.json) |
| tfs400r5-b05-73-azure_container_apps_sandboxes-P2-U3 | azure_container_apps_sandboxes | P2 | U3 | `authorization_cause_unconfirmed` | 403  | [json](logs/indeterminate/tfs400r5-b05-73-azure_container_apps_sandboxes-P2-U3.json) |
| tfs400r5-b05-74-azure_container_apps_sandboxes-P2-U4 | azure_container_apps_sandboxes | P2 | U4 | `resource_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b05-74-azure_container_apps_sandboxes-P2-U4.json) |
| tfs400r5-b05-75-azure_container_apps_sandboxes-P2-U5 | azure_container_apps_sandboxes | P2 | U5 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b05-75-azure_container_apps_sandboxes-P2-U5.json) |
| tfs400r5-b05-77-azure_container_apps_sandboxes-P2-U7 | azure_container_apps_sandboxes | P2 | U7 | `collector_event_missing_or_ambiguous` |  ECONNREFUSED | [json](logs/indeterminate/tfs400r5-b05-77-azure_container_apps_sandboxes-P2-U7.json) |
| tfs400r5-b05-79-azure_container_apps_sandboxes-P2-L1 | azure_container_apps_sandboxes | P2 | L1 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b05-79-azure_container_apps_sandboxes-P2-L1.json) |
| tfs400r5-b05-80-azure_container_apps_sandboxes-P2-L2 | azure_container_apps_sandboxes | P2 | L2 | `outcome_not_proven` | 403  | [json](logs/indeterminate/tfs400r5-b05-80-azure_container_apps_sandboxes-P2-L2.json) |
