import csv
import tempfile
import unittest
from pathlib import Path
from validate_supplied_plan import PLAN, validate


class PlanValidationTest(unittest.TestCase):
    def test_supplied_plan(self):
        self.assertEqual(validate()['rows'], 450)

    def test_duplicate_cell_is_rejected(self):
        with PLAN.open(encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            fields, rows = reader.fieldnames, list(reader)
        for field in ('deployment', 'permission_profile', 'scenario_id', 'scenario_type'):
            rows[1][field] = rows[0][field]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.csv'
            with path.open('w', encoding='utf-8', newline='') as stream:
                writer = csv.DictWriter(stream, fieldnames=fields)
                writer.writeheader()
                writer.writerows(rows)
            with self.assertRaisesRegex(ValueError, 'each cell'):
                validate(path)


if __name__ == '__main__':
    unittest.main()
