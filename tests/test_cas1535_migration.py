"""CAS-1535 AC10 - schema.sql and migrations/0014_alert_batches.sql must agree on the alert-batch schema:
the batch table, notifications.batch_id (+ index), the answer columns, RLS, and the widened client grant
(exactly `update (read_at, answer, answered_at)`).

Never runs against a database; it reads the SQL files' own DDL text, like the other test_cas*_migration.py.
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION = REPO_ROOT / "supabase" / "migrations" / "0014_alert_batches.sql"


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql.replace("\r\n", "\n"))


class AlertBatchesSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = {"schema.sql": _norm(SCHEMA_SQL.read_text(encoding="utf-8")),
                       "0014_alert_batches.sql": _norm(MIGRATION.read_text(encoding="utf-8"))}

    def test_only_one_0014_migration_exists(self):
        self.assertEqual([p.name for p in MIGRATION.parent.glob("0014_*.sql")], ["0014_alert_batches.sql"])

    def test_both_files_carry_the_batch_table(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("create table if not exists public.alert_batches (", src)
                for col in ("id uuid primary key default gen_random_uuid()",
                            "user_id uuid not null references auth.users(id) on delete cascade",
                            "sydney_date date not null",
                            "kind text not null default 'daily' check (kind in ('daily', 'catchup'))",
                            "headline text", "created_at timestamptz not null default now()",
                            "emailed_at timestamptz", "pushed_at timestamptz", "unique (user_id, sydney_date)"):
                    self.assertIn(col, src)

    def test_both_files_carry_the_notification_columns_and_index(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("alter table public.notifications add column if not exists batch_id uuid "
                              "references public.alert_batches(id) on delete set null;", src)
                self.assertIn("alter table public.notifications add column if not exists answer text;", src)
                self.assertIn("alter table public.notifications add column if not exists answered_at timestamptz;", src)
                self.assertIn("check (answer is null or answer in ('cinema', 'home', 'notfor'))", src)
                self.assertIn("create index if not exists notifications_batch_id_idx on public.notifications (batch_id);", src)

    def test_a_member_reads_only_their_own_batches(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("alter table public.alert_batches enable row level security;", src)
                self.assertIn("create policy alert_batches_read_own on public.alert_batches "
                              "for select using (auth.uid() = user_id);", src)
                self.assertNotRegex(src, r"create policy \w+ on public\.alert_batches for (insert|update|delete)")

    def test_the_client_grant_is_exactly_read_at_answer_answered_at(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertIn("revoke update on public.notifications from authenticated;", src)
                self.assertIn("grant update (read_at, answer, answered_at) on public.notifications to authenticated;", src)
        # ... and the old read_at-only grant is gone from the end-state schema.
        self.assertNotIn("grant update (read_at) on public.notifications to authenticated;", self.sources["schema.sql"])

    def test_the_migration_is_safe_to_rerun(self):
        src = self.sources["0014_alert_batches.sql"]
        self.assertIn("drop policy if exists alert_batches_read_own on public.alert_batches;", src)
        self.assertIn("drop constraint if exists notifications_answer_check", src)
        self.assertNotRegex(src, r"create table public\.")


if __name__ == "__main__":
    unittest.main()
