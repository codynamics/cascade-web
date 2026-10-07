"""CAS-1220 AC1 — schema.sql and migrations/0006_user_prefs_view.sql must both carry
user_prefs.view, the server home for per-account view state.

This never runs against a real database (none is available here, or in CI); it parses the SQL
files' own DDL text, the same convention tests/test_cas1092_schema_migration.py already uses.
"""
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION_0006 = REPO_ROOT / "supabase" / "migrations" / "0006_user_prefs_view.sql"


class UserPrefsViewColumn(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema_src = SCHEMA_SQL.read_text(encoding="utf-8")
        cls.migration_src = MIGRATION_0006.read_text(encoding="utf-8")

    def test_migration_file_exists(self):
        self.assertTrue(MIGRATION_0006.exists())

    def test_migration_adds_the_column(self):
        self.assertIn(
            "alter table public.user_prefs add column if not exists view jsonb;",
            self.migration_src)

    def test_migration_registers_itself_in_the_ledger(self):
        self.assertIn(
            "insert into public.schema_migrations (version) values ('0006') on conflict do nothing;",
            self.migration_src)

    def test_schema_sql_declares_the_column(self):
        self.assertIn(
            "alter table public.user_prefs add column if not exists view jsonb;",
            self.schema_src)


if __name__ == "__main__":
    unittest.main()
