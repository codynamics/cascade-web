"""CAS-1227 AC4 — supabase/migrations/0007_admin_emails_function.sql must exist, record itself
in the schema_migrations ledger, and supabase/schema.sql must declare both
admin_member_emails_list() and the analytics_admins_select_self policy.

This never runs against a real database (none is available here, or in CI); it parses the SQL
files' own DDL text, the same convention tests/test_cas1220_schema_migration.py already uses.
"""
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION_0007 = REPO_ROOT / "supabase" / "migrations" / "0007_admin_emails_function.sql"


class AdminEmailsFunctionMigration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema_src = SCHEMA_SQL.read_text(encoding="utf-8")
        cls.migration_src = MIGRATION_0007.read_text(encoding="utf-8")

    def test_migration_file_exists(self):
        self.assertTrue(MIGRATION_0007.exists())

    def test_migration_registers_itself_in_the_ledger(self):
        self.assertIn(
            "insert into public.schema_migrations (version) values ('0007') on conflict do nothing;",
            self.migration_src)

    def test_migration_creates_the_security_definer_function(self):
        self.assertIn("create or replace function public.admin_member_emails_list()", self.migration_src)
        self.assertIn("security definer", self.migration_src)
        self.assertIn("set search_path = ''", self.migration_src)

    def test_migration_view_is_security_invoker_over_the_function(self):
        self.assertIn("create or replace view public.admin_member_emails", self.migration_src)
        self.assertIn("with (security_invoker = true) as", self.migration_src)
        self.assertIn("select user_id, email from public.admin_member_emails_list();", self.migration_src)

    def test_migration_makes_the_other_four_views_read_only(self):
        for view in ("admin_members", "admin_member_activity", "admin_member_onboarding", "admin_cascades"):
            self.assertIn(
                f"revoke insert, update, delete, truncate, references, trigger on public.{view} from authenticated;",
                self.migration_src)

    def test_schema_sql_declares_the_function(self):
        self.assertIn("create or replace function public.admin_member_emails_list()", self.schema_src)
        self.assertIn("security definer", self.schema_src)

    def test_schema_sql_view_is_security_invoker_over_the_function(self):
        self.assertIn("create or replace view public.admin_member_emails", self.schema_src)
        self.assertIn("with (security_invoker = true) as", self.schema_src)
        self.assertIn("select user_id, email from public.admin_member_emails_list();", self.schema_src)

    def test_schema_sql_declares_analytics_admins_select_self_policy(self):
        self.assertIn("create policy analytics_admins_select_self on public.analytics_admins", self.schema_src)
        self.assertIn("for select to authenticated using (user_id = auth.uid());", self.schema_src)

    def test_schema_sql_makes_the_other_four_views_read_only(self):
        for view in ("admin_members", "admin_member_activity", "admin_member_onboarding", "admin_cascades"):
            self.assertIn(
                f"revoke insert, update, delete, truncate, references, trigger on public.{view} from authenticated;",
                self.schema_src)


if __name__ == "__main__":
    unittest.main()
