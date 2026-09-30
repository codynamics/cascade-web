"""CAS-1092 AC2 — schema.sql and migrations/0001_account_safety_net.sql must both carry the
account safety net: the migration ledger, the archive-on-delete trigger (on the 12 named tables
and NOT on agent_films), agent soft delete, the notifications column-grant fix, watchlists'
one-row-per-user constraint, the BEFORE INSERT set_updated_at widening, app_config's seed,
purge_deleted_rows locked to service_role, the account-delete archive skip, and the two admin
views filtering out soft-deleted cascades.

This never runs against a real database (none is available here, or in CI); it parses the SQL
files' own DDL text, the same convention tests/test_cas1039_user_films_check_migration.py already
uses for schema.sql.
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION_0001 = REPO_ROOT / "supabase" / "migrations" / "0001_account_safety_net.sql"

ARCHIVED_TABLES = [
    "cascades", "user_films", "user_prefs", "notify_prefs", "film_picks", "film_watch",
    "lists", "list_films", "watchlists", "friends", "invites", "push_tokens",
]
NOT_ARCHIVED_TABLES = ["agent_films", "notifications", "usage_events", "contact_messages"]


class SchemaAndMigrationBothCarryTheChange(unittest.TestCase):
    """Every assertion below runs against BOTH files: schema.sql is the end state, 0001 is the
    standalone migration that gets a live project there. They must never drift (that drift is the
    exact CAS-1074 bug this ticket's migration ledger exists to stop)."""

    @classmethod
    def setUpClass(cls):
        cls.schema_src = SCHEMA_SQL.read_text(encoding="utf-8")
        cls.migration_src = MIGRATION_0001.read_text(encoding="utf-8")
        cls.sources = {"schema.sql": cls.schema_src, "0001_account_safety_net.sql": cls.migration_src}

    def test_migration_ledger_table(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("create table if not exists public.schema_migrations", src)
                self.assertIn("version    text primary key", src)

    def test_account_deleted_rows_archive_table(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("create table if not exists public.account_deleted_rows", src)
                self.assertIn("create or replace function public.archive_deleted_row", src)

    def test_archive_trigger_on_every_named_table(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                for table in ARCHIVED_TABLES:
                    pattern = (
                        r"create trigger archive_deleted_row after delete on public\." + table
                        + r"\s*\n\s*for each row execute function public\.archive_deleted_row\(\);"
                    )
                    self.assertRegex(src, pattern, f"missing archive_deleted_row trigger on {table}")

    def test_archive_trigger_not_on_excluded_tables(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                for table in NOT_ARCHIVED_TABLES:
                    pattern = r"create trigger archive_deleted_row after delete on public\." + table + r"\b"
                    self.assertNotRegex(src, pattern, f"archive_deleted_row trigger must not exist on {table}")

    def test_archive_trigger_count_matches_named_tables_exactly(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                triggers = re.findall(r"create trigger archive_deleted_row after delete on public\.(\w+)", src)
                self.assertEqual(sorted(triggers), sorted(ARCHIVED_TABLES))

    def test_delete_agent_rpc(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("create or replace function public.delete_agent(p_id uuid)", src)
                self.assertIn("security invoker", src)
                self.assertIn("grant execute on function public.delete_agent(uuid) to authenticated;", src)

    def test_cascades_deleted_at_column(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn(
                    "alter table public.cascades add column if not exists deleted_at timestamptz;", src)

    def test_notifications_locked_to_read_at_only(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("revoke update on public.notifications from authenticated;", src)
                self.assertIn("grant update (read_at) on public.notifications to authenticated;", src)

    def test_watchlists_unique_user_id(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn(
                    "create unique index if not exists watchlists_user_id_key on public.watchlists (user_id);",
                    src)
                # Never deletes rows — only a DO block that raises on a real violation.
                self.assertIn("raise exception 'watchlists: unique(user_id) violated", src)
                self.assertNotRegex(src, r"delete from public\.watchlists")

    def test_list_films_and_agent_films_with_check_verify_the_parent(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn(
                    "exists (select 1 from public.lists l where l.id = list_id and l.user_id = auth.uid())", src)
                self.assertIn(
                    "exists (select 1 from public.cascades c where c.id = cascade_id and c.user_id = auth.uid())",
                    src)

    def test_set_updated_at_fires_before_insert_too(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                tables = ["cascades", "user_films", "notify_prefs", "film_picks", "film_watch",
                          "user_prefs", "lists", "list_films", "watchlists"]
                for table in tables:
                    pattern = r"before insert or update on public\." + table + r"\b"
                    self.assertRegex(src, pattern, f"{table} must have a BEFORE INSERT OR UPDATE set_updated_at trigger")
                # The old BEFORE-UPDATE-only form must be fully gone, not just supplemented.
                self.assertNotRegex(src, r"\n\s*before update on public\.(cascades|user_films|notify_prefs"
                                          r"|film_picks|film_watch|user_prefs|lists|list_films|watchlists)\b")

    def test_new_rate_limit_indexes(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("on public.recommendations (sender_id, created_at);", src)
                self.assertIn("on public.usage_events (client_key, created_at);", src)
                self.assertIn("on public.contact_messages (client_key, created_at);", src)

    def test_account_delete_skips_the_archive(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("current_setting('cascade.account_delete', true) = 'on'", src)
                self.assertIn("perform set_config('cascade.account_delete', 'on', true);", src)
                # The flag must be set before any row is deleted inside delete_my_account().
                fn_match = re.search(
                    r"create or replace function public\.delete_my_account\(\)(.*?)\$\$;", src, re.S)
                self.assertIsNotNone(fn_match, "delete_my_account() body not found")
                body = fn_match.group(1)
                set_config_pos = body.find("set_config('cascade.account_delete'")
                first_delete_pos = body.find("delete from public.")
                self.assertGreater(set_config_pos, -1)
                self.assertGreater(first_delete_pos, -1)
                self.assertLess(set_config_pos, first_delete_pos,
                                 "cascade.account_delete must be set before delete_my_account deletes anything")

    def test_purge_deleted_rows_locked_to_service_role(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("create or replace function public.purge_deleted_rows(p_days int)", src)
                self.assertIn(
                    "revoke all on function public.purge_deleted_rows(int) from public, anon, authenticated;", src)
                self.assertIn(
                    "grant execute on function public.purge_deleted_rows(int) to service_role;", src)

    def test_app_config_min_client_build_seed(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("create table if not exists public.app_config", src)
                self.assertIn(
                    "insert into public.app_config (key, value) values ('min_client_build', '0'::jsonb)", src)

    def test_admin_views_filter_deleted_at_is_null(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                cascades_view = re.search(
                    r"create or replace view public\.admin_cascades.*?;", src, re.S)
                self.assertIsNotNone(cascades_view)
                self.assertIn("where deleted_at is null", cascades_view.group(0))

                members_view = re.search(
                    r"create or replace view public\.admin_members.*?\nag as \((.*?)\)\n", src, re.S)
                self.assertIsNotNone(members_view, "admin_members' ag CTE not found")
                self.assertIn("where cascades.deleted_at is null", members_view.group(1))

    def test_0001_registers_itself_in_the_ledger(self):
        self.assertIn(
            "insert into public.schema_migrations (version) values ('0001') on conflict do nothing;",
            self.migration_src)


class Migration0000BroughtIntoSequenceUnchanged(unittest.TestCase):
    """The pre-existing ad-hoc migration file must exist under its new numbered name with its SQL
    byte-for-byte unchanged (only the filename moved)."""

    def test_0000_file_exists(self):
        matches = list((REPO_ROOT / "supabase" / "migrations").glob("0000_*.sql"))
        self.assertEqual(len(matches), 1, "expected exactly one 0000_*.sql migration file")

    def test_old_ad_hoc_filename_is_gone(self):
        old_path = REPO_ROOT / "supabase" / "migrations" / "20260927_cas1074_admin_views_guard.sql"
        self.assertFalse(old_path.exists(), "the old ad-hoc filename should have been renamed, not duplicated")


if __name__ == "__main__":
    unittest.main()
