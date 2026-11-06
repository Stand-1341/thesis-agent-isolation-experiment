# Research question and deployment assessment

The source for the original research questions and method is
`../../01-FULL-THESIS-ORIGINAL.docx`. The latest local 400-row candidate is
`../config/protocol-400-rev5-vm-functions-idfix.json`, with its freeze record
in `400-REV5-IDFIX-RESTART-2026-11-05.md`.

## What the current design can answer

| Thesis question | Scope of the 400-row VM/Functions revision |
| --- | --- |
| RQ1: unauthorized resource access across cloud architectures | Can investigate the included scenarios on the two included deployment types, if measured runs and independent verification succeed. |
| RQ2: compare VM, serverless and microVM containment | Cannot answer the original three-way question: the microVM/session architecture is excluded. |
| RQ3: compare permission configurations while preserving legitimate tasks | Can compare the included profiles and legitimate tasks on VM and Functions, subject to successful execution and verification. |

The original method describes three architectures, three permission profiles,
eight unauthorized and two legitimate scenarios, with five repetitions: 450
deterministic trials. The 400-row revision excludes the session architecture
and U6/U8 and has unequal repetitions. Results must describe that revised
scope and cannot be represented as the original 450-trial study. The thesis's
optional indirect prompt-injection extension needs its own attack/control
design; a directly assigned GPT-5 mini tool-use task does not measure it.

Pilot observations, the 59-entry sanitized pilot index and structural
preflight are not the final results. The rev5 restart note reports three
preserved claims and records from a stopped earlier run, excluded from the
restart; completion of the corrected 400 rows has not been established from
the evidence currently accessible to the workstation.

## Deployment status

There is no complete one-click Azure deployment in this repository. Existing
templates provision pieces of a previous environment and require additional
inputs and operations:

`../config/experiment.450-three-architecture.example.json` illustrates nine
routes with a separate session pool per profile. These are placeholders, not
deployed resources. The session dependency factory selects the pool by profile
and requires distinct control and fixture-owner managed identities. The live
pool-to-workload identity binding, U6/U8 behavior, and session P3 egress remain
unverified. Run `node scripts/preflight-three-architecture.mjs --config
config/experiment.450-three-architecture.example.json` from the starter
directory for an offline blocked-status report; it never launches trials.

1. A resource group and authority to create compute, network, identities,
   storage, Functions and role assignments; available quota and cost review.
2. Network, firewall and private endpoints, with the intended P3 allow/deny
   behavior and independent network evidence. Some templates modify shared
   firewall rules and route tables and require review against existing state.
3. VM and Functions workloads, package installation, TLS, identities and
   route-specific credentials, research and collector services, and fixture
   data. A VM template alone does not install the complete study.
4. Independent evidence storage and reader, retention configuration, runtime
   configuration, and checks that saved evidence can be read and correlated.
5. Live checks of each route and scenario, corrected schedule and protocol
   hashes, exclusive claims, and preflight before measured execution.

The signed-in workstation account could not read the pilot resource group or
start the previous controller VM on November 5, 2026. The absence of visible
resources under that account does not establish that the resources were
deleted. Restore appropriate Azure access and inspect the existing resources
before choosing recovery or a fresh deployment. Deployment and pilot validation
may incur charges; an Azure budget is an alert and does not itself stop spend.

An Azure portal deployment button must not be advertised as complete until an
orchestrated template and bootstrap cover the dependencies above and a fresh
deployment is validated. The private repository also requires a delivery
mechanism Azure Resource Manager can access; a link to a private raw template
is not sufficient by itself.

## Outstanding work

- Restore sufficient Azure access, inspect the previously used resources and
  evidence, and confirm quota, available credits and cost before redeployment.
- Build and validate the session P3 selective egress path with independent
  denial telemetry. The existing pool cannot establish this; the Sandbox
  candidate and its limitations are described in `SESSION-P3-CANDIDATE.md`.
- Verify each session pool's actual workload identity, token isolation,
  U6/U8 fixture and lifecycle behavior, and verifier results in cloud pilots.
- Resolve the original method's 60 U6/U8 cells on VM and Functions, which the
  current scope checker marks not applicable, and document the resulting
  denominators and study method before collecting measured results.
- Compose and validate the separate Azure templates, application bootstrap,
  secrets, route configuration and evidence store into a deployable workflow.
- Repair or reconcile three failing full-suite checks: the Rev4 measured-run
  CLI expectation, the sessionless U6/U8 verifier expectation, and the VM
  template operator-ingress expectation. The November 5 local verification had
  450 passing tests and these three failures; focused session tests passed.
- Run the applicable live pilot, freeze a validated protocol and only then run
  and independently review the measured records. The original 450-row plan is
  still marked planning-only and its preflight intentionally refuses launch.
