# Validation record — 2026-11-03

## Local source checks

- Node.js `node --test scripts/*.test.mjs`: **80 passed, 0 failed**. This
  includes synthetic Azure-audit/session checks; these are not Azure end-to-end
  results.
- `npm run build`: **passed**.
- `python scripts/validate_supplied_plan.py`: **passed** for 450 planned rows
  (360 unauthorized and 90 legitimate). This validates structure and digest;
  it does not mean trials ran.
- Docker Compose network separation and full image/runtime behavior have not
  been independently verified as the 450-trial system.

## Azure setup checks

- Azure GPT-5 mini authenticated setup inference and a harmless single-tool
  loop succeeded. No live experiment call or measured trial is claimed.
- One Azure VM synthetic Blob RBAC setup check showed selected P1 read/update
  allows and P2 restricted read/update/delete denials, with authorized P2
  operations allowed. It does not cover all scenarios or all deployment
  profiles.
- A separately credentialed Log Analytics reader matched one controlled Blob
  denial. Evidence immutability, complete audit coverage, and independent
  administration are still unproven.
- A diagnostic Azure Functions Flex app exists and is Running, but it is not a
  validated P1/P2/P3 deployment matrix. Its current host identity also carries
  scoped host-storage permissions; per-profile workload identities are not
  fully wired and verified.
- Custom session pool diagnostics showed research HTTP 200 and fixture Blob
  HTTP 400 (the expected unauthenticated account-root response). Collector
  failed in one setup probe; public `1.1.1.1:443` failed with the restrictive
  candidate NSG, but neither denial had a matching firewall record.
- When a diagnostic-only NSG allowed egress toward the UDR, direct
  `1.1.1.1:443` succeeded with no matching firewall record. This is a P3
  failure. With the pool set to `EgressDisabled`, all probes failed, including
  the approved research endpoint. Neither configuration is accepted for P3.
- VNet flow-log collection could not be read by the temporary verifier probe;
  no flow-log denial attribution is established. See `PILOT-ACCEPTANCE.md`.

## Result status

**Blocked; no measured trials have run.** The complete Azure deployment matrix,
all-scenario cloud checks, independent verifier coverage, P3 network
containment, evidence integrity controls, and frozen protocol remain
unvalidated. Use `PILOT-ACCEPTANCE.md` as the release gate and
`../../EXPERIMENT-STATUS.md` for the dated cloud/resource and cost log.

Azure budget alerts are not hard spending caps. Azure usage, pending charges,
and credit balances can lag. Deployed VM, firewall, managed environment/session
pool, storage, registry, and logging resources can continue to incur charges.
