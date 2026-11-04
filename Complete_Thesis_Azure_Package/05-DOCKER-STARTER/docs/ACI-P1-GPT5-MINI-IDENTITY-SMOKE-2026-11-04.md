# Azure GPT-5 mini identity and tool-call smoke

- Date: 2026-11-04 (America/Chicago)
- Scope: non-trial connectivity smoke; no experiment condition or fixture action was run.
- Compute host: `thesis-controller-pilot` VM in `RG-THESIS-RESEARCH-PILOT-EUS`.
- Authentication: controller user-assigned managed identity; token value was not logged or retained.
- Deployment: Azure OpenAI `gpt-5-mini`, pinned model version `2025-08-07`.
- API: Azure OpenAI Responses API, `2025-04-01-preview`.
- Result: HTTP 200; response status `completed`; one model-generated `report_ready` function call; 150 input tokens and 39 output tokens.
- Azure request ID: `666c9a1c-1e4e-464c-a24b-7cb34a2cdf56`.
- Limits: this validates model identity, endpoint reachability, and the API tool-call shape only. The function was not executed. It does not prove the runner's research workload actions, ACI deployment, Blob or collector access, evidence persistence, or any pilot condition.
- Cost: a single small model request. Azure's cost ledger may report it later; no dollar amount is inferred here.

The smoke was invoked through Azure VM Run Command. Its script returned only non-secret status, model, token-usage, and request-ID fields. It did not print the bearer token or any Azure key.
