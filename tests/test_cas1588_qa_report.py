"""CAS-1588: the qa_report roll-up (case outcomes -> one result per area) and its never-red guarantee."""
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "ci"))
import qa_report  # noqa: E402

CASES = [
    {"id": "A-1", "how": "unit", "part": "A", "area": ["watch"], "refs": ["tests/js/a.test.mjs"]},
    {"id": "A-2", "how": "unit", "part": "A", "area": ["watch", "taste"], "refs": ["tests/lint/b.mjs"]},
    {"id": "A-3", "how": "unit", "part": "A", "area": ["taste"], "refs": ["tests/test_c.py"]},
    {"id": "A-4", "how": "lee-phone", "part": "C", "area": ["login"], "refs": []},
]
PROFILE = qa_report.PROFILES["qa"]


class Rollup(unittest.TestCase):
    def roll(self, **jobs):
        return {a: r for a, (r, _) in qa_report.rollup(CASES, PROFILE, jobs).items()}

    def test_all_pass(self):
        self.assertEqual(self.roll(engine="success", lint="success", data="success"), {"watch": "Pass", "taste": "Pass"})

    def test_any_fail_fails_only_its_areas(self):
        self.assertEqual(self.roll(engine="success", lint="failure", data="success"), {"watch": "Fail", "taste": "Fail"})
        self.assertEqual(self.roll(engine="failure", lint="success", data="success"), {"watch": "Fail", "taste": "Pass"})

    def test_skipped_job_is_partial_or_not_run(self):
        self.assertEqual(self.roll(engine="success", lint="success", data="skipped"), {"watch": "Pass", "taste": "Partial"})
        self.assertEqual(self.roll(), {"watch": "Not run", "taste": "Not run"})

    def test_blocked_when_prerequisite_missing(self):
        r = qa_report.rollup(CASES, PROFILE, {}, blocked=True)
        self.assertEqual(r["watch"][0], "Blocked")

    def test_failing_case_ids_in_detail(self):
        r = qa_report.rollup(CASES, PROFILE, {"engine": "failure", "lint": "success", "data": "success"})
        self.assertEqual(r["watch"][1], "A-1")

    def test_manual_cases_are_not_bench(self):
        self.assertIsNone(qa_report.case_kind({"how": "planned", "part": "A"}))
        self.assertEqual(qa_report.case_kind(CASES[3]), "phone")
        self.assertNotIn("login", self.roll(engine="failure"))

    def test_real_cases_all_have_areas(self):
        cases = qa_report.load_cases()
        self.assertTrue(cases)
        self.assertEqual([c["id"] for c in cases if not c.get("area")], [])


class NeverRed(unittest.TestCase):
    def test_missing_secret_warns_and_exits_zero(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("QA_DATABASE_URL", None)
            self.assertEqual(qa_report.main(["--workflow", "qa", "--job", "engine=success"]), 0)

    def test_database_error_warns_and_exits_zero(self):
        with mock.patch.dict(os.environ, {"QA_DATABASE_URL": "postgresql://nobody@127.0.0.1:1/x"}):
            self.assertEqual(qa_report.main(["--workflow", "qa", "--job", "engine=success"]), 0)

    def test_every_covered_area_gets_a_row(self):
        class A:
            workflow, env, point, source_job, blocked = "qa", None, None, "engine", False
        rows = qa_report.make_rows(A, {"engine": "success"}, qa_report.load_cases(), None, 1, "abc", "http://run")
        self.assertTrue(rows)
        self.assertTrue(all(r["kind"] == "bench" and r["point"] == 2 and r["run_url"] == "http://run" for r in rows))


if __name__ == "__main__":
    unittest.main()


class Cas1595Secrecy(unittest.TestCase):
    DSN = "postgresql://postgres.abc:p@ss#w:rd/x?y@aws-0-ap.pooler.supabase.com:5432/postgres"

    def test_parse_reserved_password(self):
        kw = qa_report.parse_dsn(self.DSN)
        self.assertEqual(kw["password"], "p@ss#w:rd/x?y")
        self.assertEqual(kw["user"], "postgres.abc")
        self.assertEqual(kw["host"], "aws-0-ap.pooler.supabase.com")
        self.assertEqual(kw["port"], 5432)
        self.assertEqual(kw["dbname"], "postgres")

    def test_parse_encoded_password(self):
        kw = qa_report.parse_dsn("postgresql://u:p%40s%23w@h.example:6543/db")
        self.assertEqual((kw["password"], kw["host"], kw["dbname"]), ("p@s#w", "h.example", "db"))

    def test_failure_prints_no_secret_and_stays_green(self):
        import io
        from contextlib import redirect_stdout
        boom = RuntimeError("failed to resolve host 'ss#w:rd' p@ss#w")
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {"QA_DATABASE_URL": self.DSN}), \
                mock.patch.object(qa_report, "write_rows", side_effect=boom), redirect_stdout(buf):
            rc = qa_report.main(["--workflow", "qa", "--job", "engine=success"])
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("::warning::qa_report: results NOT recorded (RuntimeError)", out)
        for secret in ("ss#w", "p@ss", "supabase", "postgres.abc"):
            self.assertNotIn(secret, out)
