"""CAS-1228 AC1/AC2 — supabase/migrations/0008_clear_passwords.sql must exist, record itself in
the schema_migrations ledger, and clear every auth.users row's encrypted_password to the empty
string except appreview@codynamics.com.au (the App Store / Play review account, CAS-1073).

Unlike the DDL-only migrations tests/test_cas1092_schema_migration.py and friends assert on by
parsing text (no live database is available here, or in CI, to run Postgres-only DDL against),
this migration's single statement is a plain UPDATE with no Postgres-only syntax, so AC2 actually
runs the extracted statement against a seeded in-memory sqlite auth.users table instead of just
parsing the text.
"""
import re
import sqlite3
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_0008 = REPO_ROOT / "supabase" / "migrations" / "0008_clear_passwords.sql"
REVIEW_EMAIL = "appreview@codynamics.com.au"


class ClearPasswordsMigration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.migration_src = MIGRATION_0008.read_text(encoding="utf-8")

    def test_migration_file_exists(self):
        self.assertTrue(MIGRATION_0008.exists())

    def test_migration_registers_itself_in_the_ledger(self):
        self.assertIn(
            "insert into public.schema_migrations (version) values ('0008') on conflict do nothing;",
            self.migration_src)

    def test_migration_updates_auth_users_encrypted_password(self):
        self.assertRegex(self.migration_src, r"update\s+auth\.users\b")
        self.assertIn("encrypted_password = ''", self.migration_src)

    def test_migration_excludes_the_review_account_case_insensitively(self):
        self.assertRegex(
            self.migration_src,
            r"lower\(email\)\s*<>\s*'" + re.escape(REVIEW_EMAIL) + r"'")

    def _extract_update_statement(self):
        match = re.search(r"update\s+auth\.users.*?;", self.migration_src, re.S | re.I)
        self.assertIsNotNone(match, "no UPDATE auth.users statement found in 0008_clear_passwords.sql")
        return match.group(0)

    @staticmethod
    def _seeded_connection():
        conn = sqlite3.connect(":memory:")
        conn.execute("ATTACH DATABASE ':memory:' AS auth")
        conn.execute("CREATE TABLE auth.users (id TEXT PRIMARY KEY, email TEXT, encrypted_password TEXT)")
        return conn

    def test_migration_clears_every_password_except_the_review_account(self):
        update_sql = self._extract_update_statement()
        conn = self._seeded_connection()
        try:
            conn.executemany(
                "INSERT INTO auth.users (id, email, encrypted_password) VALUES (?, ?, ?)",
                [
                    ("1", "alice@example.com", "somehash1"),
                    ("2", "BOB@Example.com", "somehash2"),  # mixed case, must still match lower()
                    ("3", REVIEW_EMAIL, "reviewhash"),
                ])

            conn.execute(update_sql)

            rows = dict(conn.execute("SELECT email, encrypted_password FROM auth.users").fetchall())
            self.assertEqual(rows["alice@example.com"], "")
            self.assertEqual(rows["BOB@Example.com"], "")
            self.assertEqual(rows[REVIEW_EMAIL], "reviewhash")
        finally:
            conn.close()

    def test_migration_is_idempotent(self):
        update_sql = self._extract_update_statement()
        conn = self._seeded_connection()
        try:
            conn.execute(
                "INSERT INTO auth.users (id, email, encrypted_password) VALUES ('1', 'alice@example.com', 'hash')")
            conn.execute(update_sql)
            conn.execute(update_sql)  # safe to run twice
            row = conn.execute("SELECT encrypted_password FROM auth.users WHERE id = '1'").fetchone()
            self.assertEqual(row[0], "")
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
