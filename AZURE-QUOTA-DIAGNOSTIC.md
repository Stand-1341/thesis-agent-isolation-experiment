# Azure session-pool quota discrepancy

Prepared locally for investigation; no support request has been submitted.

- Subscription: existing Azure for Students subscription (identifier omitted); region: East US.
- The former diagnostic pool `thesis-diag-pool` was deleted after its image update failed. Subscription-wide resource inventory subsequently returned no `Microsoft.App/sessionPools` resources.
- The regional usage API reported `SessionPools` current 0, limit 1, but the replacement deployment failed with `MaxNumberOfGlobalSessionPoolsInSubExceeded`.
- Failed deployment: `session-diagnostic-p3-tls-retry` in `rg-thesis-research-pilot-eus`; timestamp `2026-11-02T05:48:57Z`. Correlation identifiers are omitted from this repository copy.
- Please investigate whether a deleted pool is still counted by subscription-wide enforcement and reconcile the quota if appropriate. Do not include credentials or tokens in diagnostic correspondence.

The experimental pilot cannot resume until a pool can be created and P3 traffic and independent logs are validated. Separately, `thesis-p3-fw` was requested for deletion to reduce idle costs but remained `Deleting` at the last check; please investigate if this remains stuck. VM `thesis-p3-targets` is deallocated. Registry and other retained resources may still incur charges.

A supported retry with one ready instance and maximum two also failed with the same quota error on 2026-11-02 07:29:29 UTC. This distinguishes it from the separate invalid zero-ready test.
