# Azure cost and credit plan (2026-11-01)

## Credit balance

The Microsoft Billing / Consumption credit API reports a current and estimated balance of **USD 200.00**, not estimated, with no pending eligible charges. The active Azure signup credit expires **2026-11-28 02:41:46 UTC**. The Free Trial subscription spending limit is On. Microsoft's free-account terms say the 30-day credit can be used on Azure services, excluding third-party Marketplace purchases. GPT-5 mini is deployed as a Microsoft Azure service and its usage is billed to this subscription. Cost Management currently has no reported rows, which can lag; check it again after usage posts.

## Model-only estimate

Azure Global Standard published rates used by the estimator: $0.25 per million input tokens and $2 per million output tokens. A matched 450-trial live arm with at most two Responses calls per trial, assuming 10,000 input and 2,000 output tokens per call, estimates to **$5.85**. This is a scenario estimate, not a cap or measured charge. The client accumulates exact returned token usage and stops the phase at a $19 software guard. One setup-only call returned READY; the three setup calls together estimate to $0.000169 using listed rates. No trial inference has occurred.

## Pilot infrastructure retail-rate scenario

Microsoft's public Retail Prices API was queried for East US on 2026-11-01. A minimum always-on estimate for the current P3 candidate stack is approximately **$0.60/hour** for one of each: Azure Firewall Basic deployment ($0.395/hour), a Standard static IPv4 address ($0.005/hour), Premium Container Registry ($1.6666/day), a Container Apps environment management hour ($0.10/hour), and one active dynamic session ($0.03/hour). That is about **$4.80 for 8 hours**, **$14.39 for 24 hours**, or **$388.44 for 27 days**. These are retail-list approximations and exclude data processing, storage private endpoints, bandwidth, logs, VM/Functions execution, taxes, and account-specific discounts. The continuously running 27-day stack would exceed the $200 credit.

Do not leave the pilot network/firewall/registry/session resources running idle. Before creating them, assemble the exact final resource list, expected hourly meters, time window, and cleanup command; after each pilot window, delete the billable pilot resources and verify cost/resource state. Do not delete the GPT-5 mini model account as part of that cleanup.
