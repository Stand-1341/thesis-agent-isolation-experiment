# Deployment preflight report — 2026-11-03

## Latest live snapshot — 2026-11-03 09:55 UTC

**Still blocked; no experiment trials are running.** The Azure CLI is signed
into the enabled subscription. The research and collector services are active
on the private VM; an Azure-side check returned `{"ready":true}` from both
`10.48.9.4:443` and `10.48.9.5:8443` using the installed research CA.

Azure has one Flex Functions app, one research/collector VM, and one
diagnostic-only custom-container session pool. The Functions app does have
`POST /api/run`; on 2026-11-03 the existing Functions P1 user-assigned identity
was attached and selected through `AZURE_CLIENT_ID`. Its fixture role
assignments are in place, but token acquisition and full route behavior have
not been validated through a trial. A connectivity-only probe returned HTTP
200 from both research and collector, and also returned HTTP 200 from the
restricted destination. That is reachability evidence for this one app, not
P3 prevention evidence. The session pool is still running the header-audit
image, with one ready session and no VNet subnet. The frozen 80-row
non-counted pilot schedule is committed, but no cloud pilot has run. There is
no real `config/experiment.json`, and no experiment runner process is active.

The East US `gpt-5-mini` deployment is live at version `2025-08-07`,
GlobalStandard capacity 25. A single Entra-authenticated setup request returned
`READY` (148 input tokens, 66 output tokens; code-estimated cost $0.000169).
This is model connectivity evidence only, not a trial.

At 08:03 UTC Azure's billing API reported $200 current and estimated credit.
The API exposes no last-updated timestamp. The separate budget tracker reports
$16.6029 against its $125 alert threshold. Cost Management is throttling with
HTTP 429, and all 59 returned usage rows have blank cost fields, so charges
since the model deployment cannot yet be reconciled. The Basic firewall is
still provisioned at a published East US base rate of about $9.48/day plus
traffic; the diagnostic pool and VM are also running.

The local repository now includes the separately hashed pilot schedule,
correct session adapter wiring, selected-route dependency construction, the
Log Analytics token for Blob audit reads, managed-identity token providers, and
a Functions package that includes the CA required by the research host.

### Controller deployment update — 09:55 UTC

A private controller VM is now running at `10.48.11.4` with no public IP and
the controller, audit-reader, session-reader, and ACR-pull managed identities
attached. Its image was built and pushed to the existing private ACR as
`thesis-controller-pilot:1adac43` (digest
`sha256:a15ff91fe56fc164b8f3fce4136ac5d21280ca4556f0afd582e3f55e99328d99`).
The bootstrap initially failed because `azure.archive.ubuntu.com` did not
serve the Ubuntu package repository. The firewall application rule now allows
the exact replacement hostname `archive.ubuntu.com`; Azure Firewall and its
policy returned to `Succeeded`, and a VM-side HTTPS fetch from that host
succeeded. Docker 29.1.3 and Azure CLI 2.92.0 have been installed.

The VM signed in through its ACR-pull managed identity, ran `az acr login`,
pulled the image, and executed both `--help` and a structural pilot dry-run.
The pull resolved to digest
`sha256:a15ff91fe56fc164b8f3fce4136ac5d21280ca4556f0afd582e3f55e99328d99`.
The dry-run found 80 planned pilot rows, 64 measurable by scope rules, 12 not
applicable, and 4 unsupported P3 rows. It still reports 13 missing credential
variables, unchecked runtime dependencies, and all four readiness gates
unverified. It did not contact any trial route.

The Functions access restriction now allows the firewall egress IP
`20.120.82.51/32`. A controller-side unauthenticated `GET /api/run` returned
HTTP 404 (the trigger accepts POST), confirming host reachability through the
firewall and source allowlist. No authenticated POST was issued.

The Key Vault `thesisexpkv20261103` is deployed, restricted to the firewall
egress IP, and grants the controller identity Secrets User. It is empty; no
function, resource, or collector credentials have been provisioned to it. The
controller image also does not yet load Key Vault values at runtime. An attempt
to stage existing Azure Function secret settings into the vault was rejected
by automatic review; no secret values were retrieved or written. The Functions
P1 pilot still needs its controller key, function key, resource/collector
admin tokens, verifier key, and Key Vault loading wired to the runner. The
196 local software tests passed in this session, and all six focused
controller/secret-template tests passed. No cloud pilot scenario or measured
trial has run.

## Controller and evidence audit — 2026-11-03 08:25 UTC (historical; superseded)

The controller path is still missing. The only VM hosts the research and
collector services, so using it as controller would collapse the separation
between trial control and target services. The existing Container Apps
diagnostic job shares the session pool's restricted subnet: its NSG denies
collector access and the firewall also denies that route. Opening those rules
would change the session workload's isolation boundary. The desktop runner
cannot reach the private research endpoints. A dedicated controller host and
its own allow-listed network path are therefore required before even the
single-route pilot can run.

Azure identity inspection confirms that `id-thesis-audit-verifier` has Log
Analytics Reader on the workspace and `id-thesis-session-reader` has Blob Data
Reader on the session-mappings container. Neither identity is attached to an
experiment runner because no runner host exists. The fixture controller has
no Blob role on the separate pilot evidence account, and the candidate evidence
store is not wired into the CLI: run claims and records are still written only
to local disk. Blob versioning/retention in the candidate template does not by
itself prevent a contributor from changing evidence; immutable retention and
independent verification still need a validated design.

These are additional hard blockers, not readiness claims. No Azure resources
were changed during this audit and no pilot or measured trial was started.

At 08:37 UTC a candidate deployment template was added at
`infra/controller-vm-pilot.bicep`. This historical note is superseded by the
09:23 UTC deployment update above: the template has since been deployed.

## Current result

**BLOCKED — no trial execution.** This preflight was run locally against revision 2, using the frozen 400-row schedule and `config/experiment.example.json`. Its digest is `d904392e7d4f6e3f47ffdacad3cd682350506bc8a4d8123177dd0ca29afce863`.

| Scope result | Rows | Meaning |
| --- | ---: | --- |
| Measurable by the declared scope rules | 320 | Structurally in scope; Azure pilot validation is still required. |
| Not applicable | 60 | U6/U8 on VM and Functions, recorded without invoking a workload. |
| Unsupported pending network-denial capability | 20 | VM and Functions P3 U5/U7; the run is refused until `--deps` advertises validated evidence capability. |

The base preflight was run without `--deps`, so its network-capability source was unknown. A second structural pass with `--deps scripts/deps-live.mjs` found three absent live inputs: `THESIS_DENIAL_DESTINATION_IP`, `THESIS_LOG_ANALYTICS_WORKSPACE_ID`, and `THESIS_VM_TARGET_RESOURCE_ID`. The Functions capability also needs `THESIS_FLEX_SOURCE_IP` to be configured. `deps-live.mjs` can advertise VM flow-log and Functions firewall capabilities only when their inputs are available; that declaration is configuration readiness, not proof that deny records arrive. Pilot evidence is still required.

The example config has eight active revision-2 routes and names **13 unique credential environment variables**: eight route controller keys, three Functions keys, and shared research/collector admin keys. There is no local `config/experiment.json`. The values must be supplied securely by the operator; this report does not store them. The four readiness gates and seven live verifier pilot assertions remain unverified.

Read-only Azure inspection confirmed the CLI is signed in to an enabled subscription. The research VM is running with private IPs only; its NIC has separate private research (`10.48.9.4`) and collector (`10.48.9.5`) addresses. The Functions app is at `thesis-flex-pilot-20261103.azurewebsites.net`, has the `network-probe`, `run`, and `session-seed` triggers, integrates with `functions-pilot`, and now has both its system identity and the attached Functions P1 user-assigned identity. Azure reports 13 possible Functions outbound IPs, while the live dependency currently accepts one source IP. The VM NSG has no custom outbound-deny rules. These resources do not provide eight validated workload identities/routes or independently verified P3 enforcement. Docker Engine is installed and running.

## Reproduce the structural preflight

From `Complete_Thesis_Azure_Package/05-DOCKER-STARTER`:

```powershell
npm run check:deploy
```

This runs the CLI with the example config and revision-2 matrix. It checks local configuration shape, the declared matrix digest, row applicability, and missing credential variable names. It does not execute trials or prove endpoint reachability, telemetry delivery, or readiness gates. A nonzero exit is expected while the config is a template and readiness is incomplete.

To run it against a real operator-managed config and live dependency module after securely providing required inputs:

```powershell
node scripts/run-experiment-cli.mjs --config config/experiment.json --deps scripts/deps-live.mjs --dry-run
```

To verify runner implementation separately:

```powershell
npm run verify
```

The latest full local verification passed: **190 tests, 0 failed**. This is software verification, not cloud experiment validation.

## Still required before running the 400-row study

1. Supply a real eight-route configuration with eight distinct active workload principals and the required 13 unique credential environment variables, kept outside Git.
2. Supply the live dependency inputs, including workspace ID, VM flow-log target, controlled denial destination, and Functions outbound source address. `deps-live.mjs` does not consume a subscription ID, so it is not required as an environment variable. Validate that each query returns complete, correctly attributed records; capability metadata alone is insufficient.
3. Resolve live routes: provide supported controller-to-VM connectivity, route-specific workload identities, and separate Functions profile identities. Confirm whether Functions egress is pinned through the firewall; support its observed source set or a stable NAT address, then validate each adapter.
4. Run the non-counted pilot, prove the seven verifier assertions and four readiness gates with evidence, protect the evidence independently, and freeze the approved schedule and protocol.
5. Rerun preflight with the real config and `deps-live.mjs`; review it before launching the measured schedule.

Before step 4, deploy a separate controller host with its own route to the
private research/collector endpoints, Function endpoints, Blob fixture
endpoint, and Azure audit APIs. Attach only the required managed identities,
grant least-privilege roles, and validate effective token principals. Wire the
runner to durable evidence storage with exclusive claims, then independently
test evidence readback and retention controls. Do not open the diagnostic
session subnet to make it serve as a controller.

No measured trial was run and no trial outcome is reported here.

## Follow-up live diagnostic — 2026-11-03

The existing Functions app's VNet path was tested after this
structural preflight. The first probe timed out because its dedicated subnet
was absent from the research host's inbound NSG. After adding the subnet to the
scoped service rules, TCP connected but TLS failed because the private CA was
not trusted. The CA and server certificates were renewed, the public CA was
bundled into the Node workloads, and the Functions diagnostic uses it
explicitly while retaining certificate validation. The latest probe returned
HTTP 200 from both research and collector and still concluded
`indeterminate_without_independent_enforcer_evidence`.

This tests connectivity for the single Functions app only. It does not supply
the missing eight-route config or credentials, prove effective P1 profile identity binding,
prove P3 network enforcement, validate the independent verifiers, clear the
readiness gates, or run any measured trial. The subsequent full local
verification on 2026-11-03 passed 190/190 tests; both Node and Functions Docker
images build, and the four new or updated Bicep templates compile.
