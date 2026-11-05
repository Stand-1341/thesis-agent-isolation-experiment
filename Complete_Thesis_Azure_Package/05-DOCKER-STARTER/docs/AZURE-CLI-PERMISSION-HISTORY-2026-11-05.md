# Azure CLI permission history — 2026-11-05

This report preserves the available local Azure CLI command logs for this project. Original logs are copied byte-for-byte into `azure-cli-history-2026-11-05/`; source files remain untouched. The accompanying `azure-cli-history-index-2026-11-05.json` records SHA-256 hashes and authorization or rate-limit errors without copying command arguments or secrets into this report.

## Findings

- `2026-11-05.15-13-18.monitor_log-analytics_query.49052.log`: CMD-LOG-LINE-BEGIN 49052 | 2026-11-05 15:13:19,034 | ERROR | az_command_data_logger | (InsufficientAccessError) The provided credentials have insufficient access to perform the requested operation; Code: InsufficientAccessError
- `2026-11-05.15-16-53.vm_run-command_invoke.47752.log`: CMD-LOG-LINE-BEGIN 47752 | 2026-11-05 15:16:54,345 | ERROR | az_command_data_logger | (AuthorizationFailed) The client 'svarnado@gsumail.gram.edu' with object id 'ef114592-dc02-4b5e-a078-1c1486423763' does not have authorization to perform action 'Microsoft.Compute/virtualMachines/runCommand/action' over scope '/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/RG-THESIS-RESEARCH-PILOT-EUS/providers/Microsoft.Compute/virtualMachines/thesis-controller-pilot' or the scope is invalid. If access was recently granted, please refresh your credentials.; Code: AuthorizationFailed
- `2026-11-05.16-14-36.consumption_budget_show.42600.log`: CMD-LOG-LINE-BEGIN 42600 | 2026-11-05 16:14:39,376 | ERROR | az_command_data_logger | (RBACAccessDenied) The client does not have authorization to perform action. Request ID: 31f90821-864f-4a4c-9bb1-aaf746e77e82; Code: RBACAccessDenied
- `2026-11-05.16-14-36.storage_account_show.37308.log`: CMD-LOG-LINE-BEGIN 37308 | 2026-11-05 16:14:39,318 | ERROR | az_command_data_logger | (AuthorizationFailed) The client 'svarnado@gsumail.gram.edu' with object id 'ef114592-dc02-4b5e-a078-1c1486423763' does not have authorization to perform action 'Microsoft.Storage/storageAccounts/read' over scope '/subscriptions/dddc5a29-1701-44ad-b367-50b466089d4b/resourceGroups/RG-THESIS-RESEARCH-PILOT-EUS/providers/Microsoft.Storage/storageAccounts/thesispilotblob20261102' or the scope is invalid. If access was recently granted, please refresh your credentials.; Code: AuthorizationFailed

## Successful commands recorded by Azure CLI

Azure CLI logs record exit code `0` for these earlier operations on November 5:

- Three `vm run-command invoke` commands (14:46–14:48 local CLI log timestamps). These prove the Azure Run Command API accepted and completed those invocations at that time; detailed guest stdout is not summarized here.
- `consumption budget list` at 14:48.
- `consumption budget update` at 14:48. Its CLI log confirms success; the contemporaneous command output returned budget `thesis-experiment-budget`, amount `$150`, monthly.
- Several Log Analytics queries and VM inventory/account queries at 14:49–15:15.
- `role assignment list` at 16:14.

The later failures are recorded separately: a Log Analytics query and a VM Run Command call returned exit code `1`; at 16:14, reading the budget returned `RBACAccessDenied` and reading the storage account returned `AuthorizationFailed`. This establishes that Azure accepted earlier commands under the credentials active then and later denied specific operations to the CLI principal shown in the error. It does not by itself establish why permissions changed or prove results of guest scripts unless their output was captured.

## Scope and limits

The archive covers the local Azure CLI logs available at creation time and the local PowerShell command-history file. CLI logs document attempted commands and returned errors; they do not by themselves prove why a role changed, the current state of the running experiment, or Azure actions absent from local logging.
