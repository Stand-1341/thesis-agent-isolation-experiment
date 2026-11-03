"""Validate a supplied trial schedule; this never starts or records trials.

Checks structure, not size. The original version hardcoded 450 rows in 5 blocks of
90 containing the full deployment x profile x scenario product, which made the
revision-2 plan unloadable the moment the session-arm P3 cells were withdrawn.

The invariant that actually matters is kept and strengthened: **every block is a
complete replication** — all blocks contain exactly the same set of cells, each
once, in ascending order. Integrity against tampering is the frozen digest's job,
so it is reported here rather than guessed at.
"""
import csv
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[2]
# PLAN is the schedule the runner executes; callers and tests import it.
PLAN = PACKAGE / '03-PLANNED-TRIAL-MATRIX-400-REV2.csv'
SUPERSEDED = PACKAGE / '03-PLANNED-TRIAL-MATRIX-450.csv'   # historical, never edited
DEFAULT_PLANS = [PLAN, SUPERSEDED]
HEADER = ['planned_run_id', 'block', 'order_in_block', 'deployment', 'permission_profile',
          'scenario_id', 'scenario_type', 'status', 'result', 'verified_evidence_ref']


def validate(path=PLAN):
    raw = path.read_bytes()
    with path.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        if reader.fieldnames != HEADER:
            raise ValueError(f'{path.name}: header does not match the expected columns')
        rows = list(reader)

    if not rows:
        raise ValueError(f'{path.name}: no rows')
    if len({r['planned_run_id'] for r in rows}) != len(rows):
        raise ValueError(f'{path.name}: run IDs are not unique')
    if any(not r['planned_run_id'] for r in rows):
        raise ValueError(f'{path.name}: a row has no run ID')

    blocks = Counter(int(r['block']) for r in rows)
    numbers = sorted(blocks)
    if numbers != list(range(1, len(numbers) + 1)):
        raise ValueError(f'{path.name}: block numbers are not contiguous from 1')
    if len(set(blocks.values())) != 1:
        raise ValueError(f'{path.name}: blocks are not the same size: {dict(blocks)}')

    cell_sets = {}
    for block in numbers:
        group = [r for r in rows if int(r['block']) == block]
        orders = [int(r['order_in_block']) for r in group]
        if len(set(orders)) != len(orders):
            raise ValueError(f'{path.name}: block {block} repeats an order_in_block value')
        if orders != sorted(orders):
            raise ValueError(f'{path.name}: block {block} order is out of sequence')
        cells = [(r['deployment'], r['permission_profile'], r['scenario_id']) for r in group]
        if len(set(cells)) != len(cells):
            raise ValueError(f'{path.name}: block {block} repeats a trial cell')
        cell_sets[block] = set(cells)

    reference = cell_sets[numbers[0]]
    for block in numbers[1:]:
        if cell_sets[block] != reference:
            missing = reference - cell_sets[block]
            extra = cell_sets[block] - reference
            raise ValueError(f'{path.name}: block {block} is not a replication of block 1 '
                             f'(missing {sorted(missing)}, extra {sorted(extra)})')

    for r in rows:
        if r['status'] != 'NOT RUN' or r['result'] or r['verified_evidence_ref']:
            raise ValueError(f'{path.name}: the supplied plan must contain no recorded results')
        expected = 'unauthorized' if r['scenario_id'].startswith('U') else 'legitimate'
        if r['scenario_type'] != expected:
            raise ValueError(f"{path.name}: incorrect scenario type: {r['planned_run_id']}")

    return {
        'status': 'planned_not_measured',
        'source': path.name,
        'sha256': hashlib.sha256(raw).hexdigest(),
        'rows': len(rows),
        'blocks': len(numbers),
        'rowsPerBlock': blocks[numbers[0]],
        'distinctCells': len(reference),
        'unauthorized': sum(1 for r in rows if r['scenario_type'] == 'unauthorized'),
        'legitimate': sum(1 for r in rows if r['scenario_type'] == 'legitimate'),
    }


if __name__ == '__main__':
    targets = [Path(a) for a in sys.argv[1:]] or DEFAULT_PLANS
    print(json.dumps([validate(p) for p in targets], indent=2))
