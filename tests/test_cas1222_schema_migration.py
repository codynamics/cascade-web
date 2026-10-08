"""CAS-1222 — schema.sql and migrations/0009_merge_user_prefs_view.sql must both carry
merge_user_prefs_view(jsonb), the per-field, concurrency-safe merge into user_prefs.view.

This never runs against a real database (none is available here, or in CI); it parses the SQL files'
own DDL text, the same convention tests/test_cas1220_schema_migration.py already uses.
"""
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION_0009 = REPO_ROOT / "supabase" / "migrations" / "0009_merge_user_prefs_view.sql"


class MergeUserPrefsViewFunction(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema_src = SCHEMA_SQL.read_text(encoding="utf-8")
        cls.migration_src = MIGRATION_0009.read_text(encoding="utf-8")

    def test_migration_file_exists(self):
        self.assertTrue(MIGRATION_0009.exists())

    def test_migration_creates_the_function(self):
        self.assertIn(
            "create or replace function public.merge_user_prefs_view(p_patch jsonb)",
            self.migration_src)

    def test_migration_merges_rather_than_overwrites(self):
        self.assertIn(
            "set view = coalesce(public.user_prefs.view, '{}'::jsonb) || excluded.view;",
            self.migration_src)

    def test_migration_is_security_invoker(self):
        self.assertIn("security invoker", self.migration_src)

    def test_migration_grants_execute_to_authenticated_only(self):
        self.assertIn("revoke all on function public.merge_user_prefs_view(jsonb) from public;", self.migration_src)
        self.assertIn("grant execute on function public.merge_user_prefs_view(jsonb) to authenticated;", self.migration_src)

    def test_migration_registers_itself_in_the_ledger(self):
        self.assertIn(
            "insert into public.schema_migrations (version) values ('0009') on conflict do nothing;",
            self.migration_src)

    def test_schema_sql_declares_the_function(self):
        self.assertIn(
            "create or replace function public.merge_user_prefs_view(p_patch jsonb)",
            self.schema_src)
        self.assertIn(
            "grant execute on function public.merge_user_prefs_view(jsonb) to authenticated;",
            self.schema_src)


if __name__ == "__main__":
    unittest.main()
