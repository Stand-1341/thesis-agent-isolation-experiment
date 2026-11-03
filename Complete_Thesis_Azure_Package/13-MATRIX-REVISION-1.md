# 13 — MATRIX REVISION 1

**Status:** applied. The runner now executes revision 2 (400 rows).

| | File | Rows | Blocks | SHA-256 |
|---|---|---:|---:|---|
| Rev 1 (historical) | `03-PLANNED-TRIAL-MATRIX-450.csv` | 450 | 5 × 90 | `39bb833e…d532298` |
| **Rev 2 (current)** | `03-PLANNED-TRIAL-MATRIX-400-REV2.csv` | **400** | 5 × 80 | `d904392e…afce863` |

Revision 1 is retained **unmodified**. It is the record of what was planned
before the platform limits were established, and its digest is still verified in
CI. Revision 2 is the schedule the runner executes.

## What was withdrawn

50 cells: **the entire P3 profile of the `azure_custom_sessions_hyperv`
deployment** — 10 scenarios × 5 repetitions.

## Why

The P3 profile asks for *selective network containment*: deny one destination,
keep an approved one reachable, and produce evidence that independently
attributes the denial to the configuration.

A custom container session pool cannot express that. `sessionNetworkConfiguration.status`
accepts exactly two values in the ARM schema:

```
'EgressDisabled' | 'EgressEnabled'
```

There is no per-destination rule, no VNet injection, no user-defined route, and —
because Microsoft lists Azure Container Apps as incompatible with VNet flow logs
— no flow-log record either. So:

- `EgressDisabled` blocks the approved destination too, so a legitimate operation
  cannot complete and P3 stops being *selective*.
- `EgressEnabled` allows everything and produces no attributable denial.

**This is a capability gap, not an evidence gap.** No verification technique
recovers it: there is no configuration that both permits one destination and
denies another, so there is nothing correct to observe. That is why the cells were
withdrawn rather than marked unverifiable.

## What the study now claims

| Arm | P1 | P2 | P3 | Containment evidence |
|---|:--:|:--:|:--:|---|
| `azure_vm` | ✅ | ✅ | ✅ | Flow-log `D` state plus a named `AclRule` |
| `azure_functions_flex` | ✅ | ✅ | ✅ | Firewall deny scoped to the app's outbound IPs |
| `azure_custom_sessions_hyperv` | ✅ | ✅ | — | Withdrawn |

The sessions arm still contributes 100 trials covering isolation and
authorization. It no longer contributes to the network-containment claim.

Wording for the thesis:

> Dynamic sessions provide Hyper-V isolation and lifecycle guarantees, but expose
> no platform-enforced selective egress and no attributable network telemetry.
> Network containment is therefore evaluated on the VM and Functions deployments,
> and the sessions deployment is evaluated for isolation and authorization only.

That is a finding about the platform, established by testing it, not an omission.

## What changed in the repository

- `03-PLANNED-TRIAL-MATRIX-400-REV2.csv` — 400 rows, byte-exact, CRLF, `*.csv -text`
  in `.gitattributes`. Every surviving row keeps its **original `planned_run_id`**,
  so evidence collected under either revision stays traceable. Blocks renumber to
  5 × 80; `order_in_block` keeps its original values, so gaps in the sequence are
  the visible record of which cells were withdrawn.
- `config/protocol.json` — declares `matrix.file`, `matrix.sha256`, the expected
  shape, the superseded revision and the withdrawal reason. The CLI verifies the
  default matrix against the **declared** digest rather than one computed from the
  same bytes, so editing the matrix now fails instead of silently verifying itself.
- `scripts/trial-schedule.mjs` — `validateSchedule` no longer hardcodes 450 rows
  and 90-row blocks. It validates structure (contiguous blocks, equal size,
  ascending unique order, unique cells) and returns computed counts. Integrity is
  the digest's job; a row count was never the right guard.
- `.github/workflows/ci.yml` — pins **both** digests. Revision 1 must not change
  (it is history); revision 2 must not drift (it is the plan).
- `12-RUN-INPUTS.md`, `READINESS-AUDIT.md` — renumbered to 400.

## How to reverse this

If a supported selective-egress design for session pools is ever established, the
cells return by regenerating revision 2 from revision 1 with the session-P3 filter
removed. The original rows are intact, so no data is lost — only the selection is
narrowed.
