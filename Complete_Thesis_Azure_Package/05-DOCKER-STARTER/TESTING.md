# Validation record — 2026-11-03

## Read-only live deployment smoke check

With a real, non-secret `config/experiment.json` and the referenced route
credentials available as environment variables, run:

```sh
npm run smoke:live -- --config config/experiment.json
```

The config must give each Functions P1/P2/P3 route its own `agentUrl`. Its
resource and collector URLs remain shared under the Functions deployment block.

The smoke check performs only `/health` GETs and the Functions
`/network-probe` diagnostic POST. It does not reset fixtures, invoke a scenario,
create or retire a session, or write trial records. It prints credential
variable names when values are missing, never the values. The JSON separates
`connectivityStatus` from overall `status`: even if all connectivity checks
pass, the overall deployment remains blocked until identity and independent
enforcement checks are proven. Exit code `0` means overall readiness is clear;
exit code `3` means the deployment remains blocked; exit code `4` means config
could not be loaded; exit code `5` means invalid CLI usage.

Even a connectivity pass does not clear the study readiness gates. The report
keeps route identity binding and independently attributable enforcement
evidence blocked until a separate pilot establishes them. Session routes remain
blocked until their create/use/retire lifecycle is validated. This command is
not a trial runner and its checks are never counted in the planned matrix.

## Local source checks

- Node.js `node --test scripts/*.test.mjs` (also `npm test`): see the latest verification entry below.
  This includes synthetic Azure-audit/session checks; these are not Azure end-to-end
  results. The suite is hermetic: it reads the frozen matrix from git, not from a
  generated `results/` file, and binds ephemeral ports, so it passes on a clean clone
  and on a machine with other services running.
- `npm run build`: **passed**.
- The frozen revision-2 matrix contains 400 planned rows with digest
  `d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863`.
  Matrix validation does not mean trials ran.
- Docker Compose network separation and full image/runtime behavior still need
  container build and end-to-end validation.

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
- A live Functions diagnostic initially timed out because the research host's
  inbound NSG omitted the app's dedicated `10.48.1.0/24` subnet. Adding that
  subnet to the 443 and 8443 source rules restored TCP connectivity. HTTPS then
  failed because the worker did not trust the private pilot CA. The CA and both
  IP-SAN leaf certificates were renewed through 2027-11-03; the CA is packaged
  with Node and explicitly passed to the diagnostic HTTPS client with
  certificate verification enabled. The latest live diagnostic returned HTTP
  200 from both research and collector and connected to both sockets. This is a
  connectivity observation for the single diagnostic app; it proves neither
  route identity nor P3 enforcement.
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

## Latest verification — 2026-11-03

- Full local verification: **183 tests passed, 0 failed**.
- `infra/functions-route.bicep`, `infra/vm-route.bicep`,
  `infra/functions-p3-egress-candidate.bicep`, and
  `infra/research-host-pilot.bicep` compile.
- Docker builds passed for both `Dockerfile.node` and
  `Dockerfile.functions`. Each built image parsed the CA and reported the
  expected CA fingerprint.
- The existing Functions diagnostic app was redeployed with the explicit CA
  trust path and the updated connectivity-only probe. Its live research and
  collector checks returned HTTP 200. No `/run` endpoint, scenario, session
  lifecycle, or measured trial was invoked.
- Overall deployment readiness remains **blocked**. There is no real
  `config/experiment.json`, no validated per-route app/VM deployment matrix,
  no complete independent P3 denial evidence, and no full pilot or measured
  trial. Current Azure credit/spend could not be refreshed during this check.
