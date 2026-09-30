"""CAS-1098 AC2 — schema.sql and migrations/0002_complete_membership.sql must both carry the
complete_membership() transaction: the 'account_exists' short-circuit, the membership_completed_at
column + its backfill, and email_has_account(). This never runs against a real database (none is
available here, or in CI); it parses the SQL files' own DDL/DML text, the same convention
tests/test_cas1092_schema_migration.py already uses.
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION_0002 = REPO_ROOT / "supabase" / "migrations" / "0002_complete_membership.sql"


class SchemaAndMigrationBothCarryTheChange(unittest.TestCase):
    """Every assertion below runs against BOTH files: schema.sql is the end state, 0002 is the
    standalone migration that gets a live project there. They must never drift (CAS-1074's exact
    failure mode, which is why the migration ledger exists)."""

    @classmethod
    def setUpClass(cls):
        cls.schema_src = SCHEMA_SQL.read_text(encoding="utf-8")
        cls.migration_src = MIGRATION_0002.read_text(encoding="utf-8")
        cls.sources = {"schema.sql": cls.schema_src, "0002_complete_membership.sql": cls.migration_src}

    def test_membership_completed_at_column(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn(
                    "alter table public.user_prefs add column if not exists "
                    "membership_completed_at timestamptz;", src)

    def test_membership_completed_at_backfill(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn(
                    "set membership_completed_at = coalesce(membership_completed_at, updated_at, now())",
                    src)

    def test_complete_membership_function_exists(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("create or replace function public.complete_membership(p jsonb)", src)
                self.assertIn("returns text", src)
                self.assertIn("security invoker", src)

    def test_account_exists_branch_writes_nothing(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("return 'account_exists';", src)
                self.assertIn("return 'created';", src)
                # The guard must check every one of the six tables an onboarding draft could touch.
                fn_match = re.search(
                    r"create or replace function public\.complete_membership\(p jsonb\)(.*?)\$\$;",
                    src, re.S)
                self.assertIsNotNone(fn_match, "complete_membership() body not found")
                body = fn_match.group(1)
                guard_match = re.search(r"if(.*?)then\s*\n\s*return 'account_exists';", body, re.S)
                self.assertIsNotNone(guard_match, "account_exists guard not found")
                guard = guard_match.group(1)
                for table in ("cascades", "user_prefs", "notify_prefs", "user_films", "film_picks",
                               "film_watch"):
                    self.assertIn(f"from public.{table}", guard, f"guard missing a check on {table}")
                    self.assertRegex(guard, rf"public\.{table}\s+where user_id = auth\.uid\(\)")

    def test_complete_membership_grants(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn(
                    "revoke all on function public.complete_membership(jsonb) from public;", src)
                self.assertIn(
                    "grant execute on function public.complete_membership(jsonb) to authenticated;", src)

    def test_email_has_account_function(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn(
                    "create or replace function public.email_has_account(p_email text)", src)
                self.assertIn("returns boolean", src)
                self.assertIn("security definer", src)
                self.assertIn("set search_path = public, auth", src)
                self.assertIn("where lower(email) = lower(p_email)", src)

    def test_email_has_account_grants(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn(
                    "revoke all on function public.email_has_account(text) from public;", src)
                self.assertIn(
                    "grant execute on function public.email_has_account(text) to anon, authenticated;",
                    src)

    def test_0002_registers_itself_in_the_ledger(self):
        self.assertIn(
            "insert into public.schema_migrations (version) values ('0002') on conflict do nothing;",
            self.migration_src)


if __name__ == "__main__":
    unittest.main()
