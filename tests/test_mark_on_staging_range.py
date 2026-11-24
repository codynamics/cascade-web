"""CAS-1562: mark_on_staging range starts at the last green qa run, not github.event.before."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ci"))
for k, v in (("RANGE_FROM", "x"), ("JIRA_BASE_URL", "https://x.invalid"),
             ("JIRA_EMAIL", "a@b.c"), ("JIRA_API_TOKEN", "t")):
    os.environ.setdefault(k, v)
import mark_on_staging as m

# Newest first, as the API returns them. A=success, B=cancelled, C=failure, D=success (current).
RUNS = [
    {"id": 4, "head_sha": "D", "conclusion": "success"},
    {"id": 3, "head_sha": "C", "conclusion": "failure"},
    {"id": 2, "head_sha": "B", "conclusion": "cancelled"},
    {"id": 1, "head_sha": "A", "conclusion": "success"},
]


class RangeTests(unittest.TestCase):
    def test_range_skips_cancelled_and_failed(self):
        # API called with status=success returns only A and D; fake returns all to prove filtering.
        self.assertEqual(m.resolve_range_from(RUNS, 4, "C"), "A")

    def test_fallback_when_no_earlier_success(self):
        self.assertEqual(m.resolve_range_from(RUNS[1:3], 4, "EVT"), "EVT")
        self.assertEqual(m.resolve_range_from([], 4, "EVT"), "EVT")

    def test_fallback_on_api_error_or_no_token(self):
        def boom(*a): raise OSError("down")
        os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"], os.environ["GITHUB_RUN_ID"] = "o/r", "t", "4"
        self.assertEqual(m.compute_range_from("EVT", fetch=boom), "EVT")
        del os.environ["GH_TOKEN"]
        self.assertEqual(m.compute_range_from("EVT", fetch=lambda *a: RUNS), "EVT")

    def test_tickets_from_b_c_d_all_marked(self):
        import subprocess, tempfile
        os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"], os.environ["GITHUB_RUN_ID"] = "o/r", "t", "4"
        with tempfile.TemporaryDirectory() as d:
            def git(*a): return subprocess.check_output(
                ["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=d, text=True).strip()
            git("init", "-q")
            shas = {}
            for name, key in (("A", "CAS-1"), ("B", "CAS-2"), ("C", "CAS-3"), ("D", "CAS-4")):
                git("commit", "-q", "--allow-empty", "-m", f"{key}: {name}")
                shas[name] = git("rev-parse", "HEAD")
            runs = [dict(r, head_sha=shas[r["head_sha"]]) for r in RUNS]
            frm = m.compute_range_from(shas["C"], fetch=lambda *a: runs)
            self.assertEqual(frm, shas["A"])
            cwd = os.getcwd()
            os.chdir(d)
            try:
                self.assertEqual(m.shipped_keys(frm, shas["D"]), ["CAS-2", "CAS-3", "CAS-4"])
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
