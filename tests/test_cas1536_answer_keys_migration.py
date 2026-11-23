"""CAS-1536 AC7 - migration 0015 and schema.sql allow exactly the ten answer keys the "From your email" view
writes (the app's own Watch On / Watched button keys), and null. Reads the SQL text only; never touches a database.
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_SQL = REPO_ROOT / "supabase" / "schema.sql"
MIGRATION = REPO_ROOT / "supabase" / "migrations" / "0015_answer_keys.sql"

KEYS = {"in_cinema", "premium", "rent", "stream", "never", "wow", "liked", "enjoyed", "soso", "disliked"}


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql.replace("\r\n", "\n"))


def _allowed(src: str):
    m = re.search(r"add constraint notifications_answer_check check \(answer is null or answer in \(([^)]*)\)\)", src)
    assert m, "notifications_answer_check not found"
    return set(re.findall(r"'([^']+)'", m.group(1)))


class AnswerKeysMigration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = {"schema.sql": _norm(SCHEMA_SQL.read_text(encoding="utf-8")),
                       "0015_answer_keys.sql": _norm(MIGRATION.read_text(encoding="utf-8"))}

    def test_only_one_0015_migration_exists(self):
        self.assertEqual([p.name for p in MIGRATION.parent.glob("0015_*.sql")], ["0015_answer_keys.sql"])

    def test_both_files_allow_exactly_the_ten_keys_and_null(self):
        for name, src in self.sources.items():
            with self.subTest(file=name):
                self.assertEqual(_allowed(src), KEYS)
                self.assertIn("check (answer is null or answer in (", src)

    def test_the_old_values_are_gone_from_schema(self):
        src = self.sources["schema.sql"]
        for old in ("'cinema'", "'home'", "'notfor'"):
            self.assertNotIn(f"answer in ({old}", src)
            self.assertNotRegex(src, r"notifications_answer_check check \(answer is null or answer in \([^)]*" + old)

    def test_the_migration_is_safe_to_rerun(self):
        self.assertIn("drop constraint if exists notifications_answer_check", self.sources["0015_answer_keys.sql"])

    def test_the_ten_keys_are_the_apps_own_button_keys(self):
        html = (REPO_ROOT / "app_template.html").read_text(encoding="utf-8")
        m = re.search(r"const BATCH_ANSWER_KEYS = \[([^\]]*)\]", html)
        self.assertIsNotNone(m, "app_template.html must declare BATCH_ANSWER_KEYS")
        self.assertEqual(set(re.findall(r'"([^"]+)"', m.group(1))), KEYS)


if __name__ == "__main__":
    unittest.main()
