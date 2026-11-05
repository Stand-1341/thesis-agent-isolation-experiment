# Rev5 identifier correction and restart — 2026-11-05

The user directed a restart of the full 400-row VM/Functions experiment. The preceding frozen rev4 schedule had 74 IDs whose embedded profile label differed from the authoritative profile column. The first Functions U2 row was labeled P1 in its ID but assigned P3; its workload and verifier both used P3. The prior run was stopped, with three claims and three records preserved in the evidence container. They are not counted toward this restart.

This schedule gives all 400 rows fresh unique IDs reflecting their actual deployment, profile and scenario. Row order, block, assignment, scenario, and remaining columns are unchanged. Its matrix SHA-256 is `2bd601c4de01900c318857901b36578b62fff95385f33f2e34a2c05b78a4bee5`. The rev4 files and evidence are retained. The protocol otherwise retains the same scoped readiness evidence and limitations described in `400-REV4-READINESS-FREEZE-2026-11-05.md`; it excludes ACA/ACI and U6/U8 and uses unequal scenario repetitions. The user-directed change is not represented as institutional approval.

The corrected schedule must pass label-to-column validation, controller structural preflight and unique-claim safeguards before measured execution. The old stopped service and marker are retained; the restart uses its own distinct service and marker.
