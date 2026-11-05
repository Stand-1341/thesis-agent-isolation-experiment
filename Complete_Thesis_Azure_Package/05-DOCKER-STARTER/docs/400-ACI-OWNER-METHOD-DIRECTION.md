# Owner direction for a 400-row ACI replacement design

## Decision recorded

The study owner directed that the full 400-row experiment proceed after ACA
sessions were removed and explicitly stated that the ACI method change was
approved by the owner. This direction is recorded from the conversation; no
date or external reviewer record was supplied.

## Scope of this revision draft

- Preserve the 300 VM and Functions rows from revision 2.
- Replace the 100 ACA custom-session P1/P2 rows with ACI P1/P2 rows.
- Keep the 400-row count and 320 unauthorized / 80 legitimate balance.
- Use short-lived ACI container groups as the isolation unit.
- Define U6/U8 as cross-group Blob-marker access analogues. These do not test
  native ACA session memory and must be described as a method change.
- Keep every result non-runnable until the updated matrix, runner, live routes,
  independent verifiers, and readiness evidence are complete.

## Review boundary

This file records the study owner's direction only. It does not claim advisor,
IRB, departmental, or other external approval. The ACI revision remains a draft
until its route and scenario implementation is validated and the study's
required review authority accepts the changed isolation unit and U6/U8
definitions.
