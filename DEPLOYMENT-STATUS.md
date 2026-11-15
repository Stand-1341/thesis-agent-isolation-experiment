# Azure deployment status

**Snapshot:** 2026-11-15 live Azure verification  
**Environment:** `thesis-study`  
**Resource group:** `rg-thesis-study-central-a0129b37`

## Current outcome

The v3 Azure deployment is **complete and validated**.

- Full ARM deployment: **Succeeded**
- Functions Flex P1/P2/P3: deployed, triggers verified, keys secured
- Sandbox disk images P1/P2/P3: created, Ready, runtime smoke passed
- Research host: data disk mounted, TLS installed, services active,
  research/collector/restricted health checks passed
- Deployment validation: **passed** (V1, V4, V5; V2/V3 with exact-route
  pilot evidence pending)
- Readiness manifest: **status validated**

## Runtime state

- Agent image: `th30f2e487acr.azurecr.io/thesis/agent@sha256:87b23a4247c715233baf8518177366417abbdc97afe3e1fdb0096ead3b16f141`
- Functions package: `abcdb557810666979cd3d3a4ead13c44ea6fbad29933f5efc6c58851131e1ba0`
- Sandbox disk images: P1 `b2b632af-4ad5-4551-8f8d-e67c86bbcb3c`,
  P2 `9c2d2ded-5204-4963-9815-52aa47ac6f45`,
  P3 `fecfb27f-61aa-4652-82aa-9e195f9b4a7e`
- Research-host package: `5172bfe26dd8bea740500cf7d027cc462940d84e48d24c399a2e15446fb890f4`

## What remains before the measured experiment

- Seven exact-route non-counted pilot records: VM P3, Functions P1/P2/P3,
  Sandbox P1/P2/P3.
- Independently attributable Functions/Sandbox P3 U5/U7 denial evidence.
- U6/U8 session-fixture validation on all three arms.
- Evidence-retention policy explicitly locked.
- Fresh owner authorization naming the v3 protocol digest.
- A deliberate measured-execution freeze; the current protocol remains
  `measuredExecutionEnabled: false`.

The deployment is ready for non-counted pilot work. It is not yet authorized
for measured trials.
