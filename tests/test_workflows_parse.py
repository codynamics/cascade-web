"""CAS-1542 — every .github/workflows/*.yml must parse as YAML.

A workflow that doesn't parse can't run (and GitHub reports a red run on every push), so a
broken one must fail `npm run qa` rather than go unseen.
"""
import glob
import os
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


if __name__ == "__main__":
    unittest.main()
