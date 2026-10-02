"""CAS-1102 — schema.sql and migrations/0003_delete_guard.sql must both carry the delete guard:
cascades can never be client-hard-deleted at all (only soft-deleted via delete_agent(), CAS-1092),
and a statement-level block_bulk_delete() trigger refuses any client statement that deletes more
than one row at once on the 8 named account tables.

This never runs against a real database (none is available here, or in CI); it parses the SQL
files' own DDL text, the same convention tests/test_cas1092_schema_migration.py and
tests/test_cas1098_complete_membership_migration.py already use.
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION_0003 = REPO_ROOT / "supabase" / "migrations" / "0003_delete_guard.sql"

GUARDED_TABLES = [
    "user_films", "film_watch", "film_picks", "list_films", "lists", "friends",
    "push_tokens", "agent_films",
]


class SchemaAndMigrationBothCarryTheChange(unittest.TestCase):
    """Every assertion below runs against BOTH files: schema.sql is the end state, 0003 is the
    standalone migration that gets a live project there. They must never drift (CAS-1074's exact
    failure mode, which is why the migration ledger exists)."""

    @classmethod
    def setUpClass(cls):
        cls.schema_src = SCHEMA_SQL.read_text(encoding="utf-8")
        cls.migration_src = MIGRATION_0003.read_text(encoding="utf-8")
        cls.sources = {"schema.sql": cls.schema_src, "0003_delete_guard.sql": cls.migration_src}

    def test_cascades_delete_revoked_for_client_roles(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("revoke delete on public.cascades from authenticated, anon;", src)

    def test_block_bulk_delete_function(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("create or replace function public.block_bulk_delete()", src)
                self.assertIn("returns trigger", src)
                fn_match = re.search(
                    r"create or replace function public\.block_bulk_delete\(\)(.*?)\$\$;", src, re.S)
                self.assertIsNotNone(fn_match, "block_bulk_delete() body not found")
                body = fn_match.group(1)
                self.assertIn("current_user in ('authenticated', 'anon')", body)
                self.assertIn("(select count(*) from old_rows) > 1", body)
                self.assertIn("raise exception 'bulk_delete_blocked';", body)

    def test_trigger_on_every_named_table(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                for table in GUARDED_TABLES:
                    pattern = (
                        r"create trigger block_bulk_delete after delete on public\." + table
                        + r"\s*\n\s*referencing old table as old_rows"
                        + r"\s*\n\s*for each statement execute function public\.block_bulk_delete\(\);"
                    )
                    self.assertRegex(src, pattern, f"missing block_bulk_delete trigger on {table}")

    def test_trigger_count_matches_named_tables_exactly(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                triggers = re.findall(
                    r"create trigger block_bulk_delete after delete on public\.(\w+)", src)
                self.assertEqual(sorted(triggers), sorted(GUARDED_TABLES))

    def test_trigger_not_on_cascades(self):
        # cascades is guarded by the outright revoke above, not the bulk-delete trigger — a client
        # can no longer delete it at all, one row or many.
        for name, src in self.sources.items():
            with self.subTest(file=name):
                pattern = r"create trigger block_bulk_delete after delete on public\.cascades\b"
                self.assertNotRegex(src, pattern, "block_bulk_delete trigger must not exist on cascades")

    def test_0003_registers_itself_in_the_ledger(self):
        self.assertIn(
            "insert into public.schema_migrations (version) values ('0003') on conflict do nothing;",
            self.migration_src)


if __name__ == "__main__":
    unittest.main()
