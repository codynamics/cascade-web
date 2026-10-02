"""CAS-1120 — schema.sql and migrations/0004_invite_date_note_name.sql must both carry: invites
gets optional suggested_date/note (with a 500-char note check), invite_by_token() returns both, and
user_prefs gets an optional display_name (with a 1-60-char check).

This never runs against a real database (none is available here, or in CI); it parses the SQL
files' own DDL text, the same convention tests/test_cas1102_delete_guard_migration.py already uses.
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION_0004 = REPO_ROOT / "supabase" / "migrations" / "0004_invite_date_note_name.sql"


class SchemaAndMigrationBothCarryTheChange(unittest.TestCase):
    """Every assertion below runs against BOTH files: schema.sql is the end state, 0004 is the
    standalone migration that gets a live project there. They must never drift (CAS-1074's exact
    failure mode, which is why the migration ledger exists)."""

    @classmethod
    def setUpClass(cls):
        cls.schema_src = SCHEMA_SQL.read_text(encoding="utf-8")
        cls.migration_src = MIGRATION_0004.read_text(encoding="utf-8")
        cls.sources = {"schema.sql": cls.schema_src, "0004_invite_date_note_name.sql": cls.migration_src}

    def test_invites_suggested_date_column(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("alter table public.invites add column if not exists suggested_date date;", src)

    def test_invites_note_column_and_check(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("alter table public.invites add column if not exists note text;", src)
                self.assertIn("alter table public.invites drop constraint if exists invites_note_check;", src)
                self.assertIn(
                    "alter table public.invites add constraint invites_note_check\n"
                    "  check (note is null or char_length(note) <= 500);",
                    src,
                )

    def test_invite_by_token_returns_suggested_date_and_note(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                fn_match = re.search(
                    r"create or replace function public\.invite_by_token\(p_token text\)(.*?)\$\$;", src, re.S)
                self.assertIsNotNone(fn_match, "invite_by_token() body not found")
                body = fn_match.group(1)
                self.assertIn("'suggested_date', suggested_date,", body)
                self.assertIn("'note', note,", body)

    def test_user_prefs_display_name_column_and_check(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("alter table public.user_prefs add column if not exists display_name text;", src)
                self.assertIn(
                    "alter table public.user_prefs drop constraint if exists user_prefs_display_name_check;", src)
                self.assertIn(
                    "alter table public.user_prefs add constraint user_prefs_display_name_check\n"
                    "  check (display_name is null or char_length(display_name) between 1 and 60);",
                    src,
                )

    def test_0004_registers_itself_in_the_ledger(self):
        self.assertIn(
            "insert into public.schema_migrations (version) values ('0004') on conflict do nothing;",
            self.migration_src)


if __name__ == "__main__":
    unittest.main()
