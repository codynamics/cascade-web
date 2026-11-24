"""CAS-1567 AC2 - migration 0017 and schema.sql both widen alert_batches.kind to ('daily', 'catchup', 'recap').
Reads the SQL text only; never touches a database.
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION = REPO_ROOT / "supabase" / "migrations" / "0017_alert_batch_recap_kind.sql"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql.replace("\r\n", "\n"))


class RecapKindMigration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = {"schema.sql": _norm(SCHEMA_SQL.read_text(encoding="utf-8")),
                       "0017": _norm(MIGRATION.read_text(encoding="utf-8"))}

    def test_only_one_0017_migration_exists(self):
        self.assertEqual([p.name for p in MIGRATION.parent.glob("0017_*.sql")],
                         ["0017_alert_batch_recap_kind.sql"])

    def test_both_files_allow_exactly_daily_catchup_recap(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("alter table public.alert_batches drop constraint if exists alert_batches_kind_check;", src)
                m = re.search(r"add constraint alert_batches_kind_check check \(kind in \(([^)]*)\)\)", src)
                self.assertIsNotNone(m)
                self.assertEqual(re.findall(r"'([^']+)'", m.group(1)), ["daily", "catchup", "recap"])

    def test_the_migration_records_itself(self):
        self.assertIn("insert into public.schema_migrations (version) values ('0017') on conflict do nothing;",
                      self.sources["0017"])


if __name__ == "__main__":
    unittest.main()
