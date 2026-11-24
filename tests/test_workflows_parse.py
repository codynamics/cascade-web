"""CAS-1542 — every .github/workflows/*.yml must parse as YAML.

A workflow that doesn't parse can't run (and GitHub reports a red run on every push), so a
broken one must fail `npm run qa` rather than go unseen.
"""
import glob
import os
import re
import unittest

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOWS = sorted(glob.glob(os.path.join(ROOT, ".github", "workflows", "*.yml")))


class WorkflowsParse(unittest.TestCase):
    def test_workflows_exist(self):
        self.assertTrue(WORKFLOWS, "no workflow files found")

    def test_every_workflow_parses(self):
        for path in WORKFLOWS:
            with self.subTest(workflow=os.path.basename(path)):
                with open(path, encoding="utf-8") as f:
                    yaml.safe_load(f)

    def test_playwright_jobs_pin_ubuntu_2404(self):
        """CAS-1560 — Playwright WebKit isn't supported on ubuntu-latest (26.04); pin 24.04."""
        pw = re.compile(r"playwright (install|test)|test:e2e|test:e2e:full|test:integrity")
        for path in WORKFLOWS:
            with open(path, encoding="utf-8") as f:
                doc = yaml.safe_load(f)
            for name, job in (doc.get("jobs") or {}).items():
                runs = "\n".join(str(s.get("run", "")) for s in job.get("steps", []) or [])
                if pw.search(runs):
                    with self.subTest(workflow=os.path.basename(path), job=name):
                        self.assertEqual(job.get("runs-on"), "ubuntu-24.04")


if __name__ == "__main__":
    unittest.main()
