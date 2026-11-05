# VM/Functions-only 400-row alternatives (draft)

**Status:** planning drafts only. Neither schedule is frozen, active, or authorized for a measured run. The active Rev3 protocol and its 300-row matrix remain unchanged. No ACA/ACI arm is included. No results were added or replaced.

Both drafts derive from `03-PLANNED-TRIAL-MATRIX-300-REV3.csv` (SHA-256 `a6bc3ffe78d677d25e07452e06cfc437062fdd9e8322b4c834d31118337ccc7e`). Existing planned IDs are retained when their rows remain in scope; added rows have unique IDs. Each output is created with exclusive-write semantics and will fail rather than overwrite an existing file. Candidate digests below are fingerprints for review, not a protocol freeze.

## Candidate A — preserve all scenarios, including N/A rows

File: `03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-NO-ACA-NO-ACI-DRAFT.csv`

SHA-256: `e766c20cde9d35b8bc59c6ba81386817c98327fe27b73158a4bdc7801209e0c2`

It preserves all 300 Rev3 rows and adds 100 repeats: one repeat for each deployment/scenario pair in each of five blocks. It has five blocks of 80 rows, 40 rows per deployment in each block, and eight rows per scenario in each block. Each of the ten scenarios has 40 rows across the schedule; the total is 320 unauthorized and 80 legitimate rows. Profile totals are P1=134, P2=133, P3=133.

This is a 400-row schedule, but it is **not 400 executable trials** under the current VM/Functions method. U6 and U8 are session-specific and not applicable on these deployments, so 80 scheduled rows are N/A. The maximum applicable denominator is 320, before any setup failure or indeterminate evidence. Choose this only if “400” means scheduled rows and N/A rows remain visible in the denominator.

## Candidate B — 400 applicable attempts across VM and Functions

File: `03-PLANNED-TRIAL-MATRIX-400-REV4-VM-FUNCTIONS-EXECUTABLE-NO-ACI-DRAFT-V3.csv`

SHA-256: `2ecce88dab8e7a61fa457ee6e27e5c6551a0035528aacd51d6e7502c6c0b0abe`

It excludes the 60 Rev3 U6/U8 rows that are N/A on VM/Functions, retains the 240 applicable Rev3 rows, and adds 160 unique repeat rows. Its allocation is:

| Dimension | Allocation |
|---|---|
| Blocks | 5 × 80 |
| Deployment per block | VM 40; Functions 40 |
| Scenario type per block | Unauthorized 64; legitimate 16 |
| Legitimate scenarios | L1 40; L2 40 total (8 each per block) |
| Unauthorized scenarios | U1–U4: 53 each; U5 and U7: 54 each total (10 or 11 per block) |
| Deployment total | VM 200; Functions 200 |
| Profiles per deployment | P1 67; P2 67; P3 66 |
| Profiles per block | 26, 27, 27 rows, with profile order rotated across blocks |
| Repeats per deployment/profile/scenario cell | Unauthorized: 8 or 9; legitimate: 6 or 7 |

This produces exactly 400 applicable planned attempts and preserves the 80:20 unauthorized/legitimate ratio. It excludes U6/U8, so the resulting claim must be limited to the eight scenarios applicable to VM and Functions. It also uses unequal scenario repetitions: the six applicable unauthorized scenarios cannot each have the same integer count while making 320 unauthorized rows; the deterministic remainder rule assigns 54 rows to U5 and U7 and 53 to U1–U4. This allocation was set by scenario order, not observed results.

## Generation and freeze conditions

The separate generators are:

- `05-DOCKER-STARTER/scripts/create-vmfns-400-no-aci-draft.mjs`
- `05-DOCKER-STARTER/scripts/create-vmfns-400-executable-no-aci-draft.mjs`

They pin and verify the Rev3 source digest, preserve existing run IDs for retained rows, produce new unique IDs, keep every row `NOT RUN`, shuffle within blocks using a fixed seed, and use exclusive file creation. Their structural allocation checks passed when generating these drafts. The runner already accepts a selected protocol through `--protocol`; Candidate B is declared by `05-DOCKER-STARTER/config/protocol-400-rev4-vm-functions-draft.json` and uses the no-secret route map in `05-DOCKER-STARTER/config/experiment.azure-live.json`. Its protocol opts in to repeated cells within a block, while all existing protocols retain the validator's strict default. A CLI guard rejects measured execution for this draft while `measuredExecutionEnabled` is false.

A structural-only CLI preflight accepted Candidate B and reported 400 selected rows, zero N/A, 364 structurally measurable, and 36 unsupported due to absent independent-network-denial capability evidence (18 each for VM P3 and Functions P3). All four readiness gates remained unverified, runtime dependencies were not checked, and local credential variables were missing. This is a blocker report, not a validation claim. A final method decision, cell-level verifier applicability review, route readiness, and owner freeze must precede any counted run. Existing 400 Rev2 and ACI draft files remain historical and unmodified.

The Candidate B protocol also defines a separate one-row P3 U5 non-counted pilot at `03-PILOT-TRIAL-MATRIX-2026-11-05-P3-U5-CENTRAL-REV4-DRAFT.csv` (ID `pilot-routecheck-central-vm-p3-u5-20261105a`, SHA-256 `79fe077a505ce4f61a468717778193af21a02cd06c1d44acaf9be03e958519fb`). It is `NOT RUN` and is not part of the 400 rows. It may be used only to validate the Central P3 U5 path and exact-window denial reader; the P3 U7 confirmation came from a separate non-counted run. The desktop could not query Azure Logs because its interactive Azure CLI token had expired, so the controller managed identity is required for the pilot and independent readback.

Functions P3 still has no proven network-denial evidence path. The read-only inventory found subnet `10.48.6.0/24` delegated to `Microsoft.App/environments`, with no attached NSG or route table. Existing VNet Flow Logs target storage with seven-day retention, but Traffic Analytics is disabled and no Log Analytics destination is configured; there are no saved exact-window P3 U5/U7 runs. Do not describe these as NSG denies or advertise Functions P3 network-denial capability until a real telemetry path and exact-run evidence are established.
