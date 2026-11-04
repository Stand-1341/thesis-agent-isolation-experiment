# Non-container application checks — 2026-11-04

These are read-only or deliberately rejected non-trial checks. No schedule row, fixture mutation, or experiment result was created.

## Local Functions and VM test suite

Ran the targeted Node suite for Functions routing/configuration, VM route templates, hosted research/collector workloads, and independent verifiers:

- Functions route template, P3 egress candidate, HTTP adapter, GPT-5 mini Functions pilot, live deployment smoke, Flex config, Key Vault pilot launcher.
- Controller VM, VM route template, research-host network, P3 network validation.
- Blob workload/verifier, resource verifier, collector verifier, trial assessments, denial reader, and shared core.

Result: **63 passed, 0 failed**. The full project build and test suite had also passed earlier in this session: **363 passed, 0 failed**.

## Azure Functions P1

- The deployed app `thesis-flex-pilot-20261103` was Running and exposed `thesisNetworkProbe`, `thesisRun`, and `thesisSessionSeed` HTTP functions.
- A temporary exact-workstation-IP allow rule was added for the non-trial diagnostic and removed immediately afterward. The final access list contains only the pre-existing trusted-controller and controller-firewall rules plus the default deny.
- `POST /api/network-probe` returned HTTP 200. Its approved research `/health` request returned HTTP 200; the collector TCP destination was reachable; the app reported its private CA configured and readable.
- `POST /api/run` with the valid Function and controller keys and an intentionally invalid scenario returned HTTP 400 with the request rejected as invalid. This confirms route authentication and validation without invoking a scenario. `trialExecuted=false`.

## Research and collector services

- `thesis-p3-targets` had been deallocated. It hosts the research and collector services at `10.48.9.4:443` and `10.48.9.5:8443`.
- Started `thesis-p3-targets` and left it Running, consistent with the instruction not to deallocate resources.
- From the controller VM, both HTTPS `/health` endpoints returned HTTP 200 with `ready=true`, using the project's research CA.
- The controller VM remains Running. It was not deallocated.

These checks establish Functions P1 connectivity and service health only. They do not prove every identity binding, P3 isolation, independent trial verification, or evidence retention.
