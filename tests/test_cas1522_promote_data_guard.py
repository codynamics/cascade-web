import os, subprocess, sys, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARD = os.path.join(ROOT, "ci", "promote_data_guard.py")


def run(paths):
    return subprocess.run([sys.executable, "-I", GUARD], input="\n".join(paths),
                          capture_output=True, text=True).returncode


class PromoteDataGuard(unittest.TestCase):
    def test_data_only_passes(self):
        self.assertEqual(run(["movies.json", "catalogue.json", "catalogue/catalogue.abc.json"]), 0)

    def test_code_path_fails(self):
        self.assertNotEqual(run(["movies.json", "app_template.html"]), 0)

    def test_workflow_path_fails(self):
        self.assertNotEqual(run([".github/workflows/promote.yml"]), 0)

    def test_prefix_lookalike_fails(self):
        self.assertNotEqual(run(["catalogue.json.bak", "cataloguex/a.json"]), 0)

    def test_promote_has_no_workflow_run(self):
        with open(os.path.join(ROOT, ".github", "workflows", "promote.yml"), encoding="utf-8") as f:
            self.assertNotIn("workflow_run", f.read())


if __name__ == "__main__":
    unittest.main()
