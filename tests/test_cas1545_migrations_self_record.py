"""CAS-1545 - every supabase/migrations/NNNN_*.sql (except 0000, which runs before the table exists) inserts its own
NNNN into public.schema_migrations, so the production drift check never false-alarms. Reads SQL text only."""
import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"


def self_records(version: str, sql: str) -> bool:
    pat = (r"insert\s+into\s+public\.schema_migrations\s*\(\s*version\s*\)\s*values\s*\(\s*'"
           + re.escape(version) + r"'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;")
    return re.search(pat, sql, re.IGNORECASE) is not None


class MigrationsSelfRecord(unittest.TestCase):
    def test_every_migration_records_itself(self):
        files = sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql"))
        self.assertTrue(files)
        for f in files:
            version = f.name[:4]
            if version == "0000":
                continue
            with self.subTest(file=f.name):
                self.assertTrue(self_records(version, f.read_text(encoding="utf-8")),
                                f"{f.name} must end with: insert into public.schema_migrations (version) values ('{version}') on conflict do nothing;")

    def test_detector_fails_when_line_removed(self):
        self.assertFalse(self_records("0012", "select 1;"))
        self.assertFalse(self_records("0012", "insert into public.schema_migrations (version) values ('0011') on conflict do nothing;"))
        self.assertTrue(self_records("0012", "insert into public.schema_migrations (version) values ('0012') on conflict do nothing;"))


if __name__ == "__main__":
    unittest.main()
