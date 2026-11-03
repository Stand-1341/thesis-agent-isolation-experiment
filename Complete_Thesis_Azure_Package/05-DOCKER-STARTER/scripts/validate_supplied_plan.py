"""Validate the supplied trial schedule; this never starts or records trials."""
import csv
import hashlib
import itertools
import json
from pathlib import Path

PLAN = Path(__file__).resolve().parents[2] / '03-PLANNED-TRIAL-MATRIX-450.csv'
DEPLOYMENTS = {'azure_vm', 'azure_functions_flex', 'azure_custom_sessions_hyperv'}
PROFILES = {'P1', 'P2', 'P3'}
SCENARIOS = {*(f'U{i}' for i in range(1, 9)), 'L1', 'L2'}


def validate(path=PLAN):
    raw = path.read_bytes()
    with path.open(encoding='utf-8-sig', newline='') as stream:
        rows = list(csv.DictReader(stream))
    if len(rows) != 450:
        raise ValueError(f'expected 450 rows, found {len(rows)}')
    if len({r['planned_run_id'] for r in rows}) != 450:
        raise ValueError('run IDs are not unique')
    expected = set(itertools.product(DEPLOYMENTS, PROFILES, SCENARIOS))
    for block in range(1, 6):
        group = [r for r in rows if r['block'] == str(block)]
        cells = [(r['deployment'], r['permission_profile'], r['scenario_id']) for r in group]
        if len(group) != 90 or set(cells) != expected:
            raise ValueError(f'block {block} does not contain each cell exactly once')
        if [int(r['order_in_block']) for r in group] != list(range(1, 91)):
            raise ValueError(f'block {block} order is incomplete or out of sequence')
    for r in rows:
        if r['status'] != 'NOT RUN' or r['result'] or r['verified_evidence_ref']:
            raise ValueError('the supplied plan must contain no recorded results')
        if r['scenario_type'] != ('unauthorized' if r['scenario_id'].startswith('U') else 'legitimate'):
            raise ValueError(f"incorrect scenario type: {r['planned_run_id']}")
    return {'status': 'planned_not_measured', 'source': path.name, 'sha256': hashlib.sha256(raw).hexdigest(),
            'rows': len(rows), 'blocks': 5, 'unauthorized': 360, 'legitimate': 90}


if __name__ == '__main__':
    print(json.dumps(validate(), indent=2))
