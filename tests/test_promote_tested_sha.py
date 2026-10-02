"""CAS-1158 — a dispatched qa run must promote the commit it tested, not whatever happens to be
on the head of staging when it finishes. Static checks against the workflow YAML text, the way
tests.test_cas993_alerts_workflow reads alerts.yml, rather than a full YAML parse.

Run:  python -m unittest tests.test_promote_tested_sha
"""
import os
import re
import unittest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMOTE_YML = os.path.join(_REPO_ROOT, ".github", "workflows", "promote.yml")
QA_YML = os.path.join(_REPO_ROOT, ".github", "workflows", "qa.yml")


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def _step_lines(all_lines: list, step_name: str) -> list:
    start = next(i for i, l in enumerate(all_lines) if l.strip() == f"- name: {step_name}")
    indent = len(all_lines[start]) - len(all_lines[start].lstrip(" "))
    end = len(all_lines)
    for j in range(start + 1, len(all_lines)):
        l = all_lines[j]
        if l.strip() and (len(l) - len(l.lstrip(" "))) <= indent:
            end = j
            break
    return all_lines[start + 1:end]


class PromoteDispatchInputTests(unittest.TestCase):
    def setUp(self):
        self.promote_text = _read(PROMOTE_YML)

    def test_workflow_dispatch_declares_sha_input(self):
        m = re.search(
            r"workflow_dispatch:\s*\n\s*inputs:\s*\n\s*sha:\s*\n(?:\s+.+\n)*",
            self.promote_text,
        )
        self.assertIsNotNone(m, "promote.yml must declare a workflow_dispatch input named sha")

    def test_merge_step_uses_input_only_when_non_empty(self):
        lines = self.promote_text.splitlines()
        merge_step = "\n".join(_step_lines(lines, "Merge the QA'd staging commit into main"))
        self.assertIn("inputs.sha", merge_step)
        # origin/staging must only be reachable when the sha input is empty.
        m = re.search(
            r"if \[.*workflow_dispatch.*\] && \[ -n \"\$\{\{ inputs\.sha \}\}\" \]; then\n"
            r"\s*sha=\"\$\{\{ inputs\.sha \}\}\"\n"
            r"\s*elif \[.*workflow_dispatch.*\]; then\n"
            r"\s*git fetch origin staging\n"
            r"\s*sha=\$\(git rev-parse origin/staging\)",
            merge_step,
        )
        self.assertIsNotNone(
            m, "origin/staging must only be used when the sha input is empty")
        self.assertIn("github.event.workflow_run.head_sha", merge_step)


class QaDispatchPromoteTests(unittest.TestCase):
    def setUp(self):
        self.qa_text = _read(QA_YML)

    def test_dispatch_promote_passes_tested_sha(self):
        lines = self.qa_text.splitlines()
        step = "\n".join(_step_lines(lines, "Dispatch promote.yml"))
        self.assertIn("gh workflow run promote.yml", step)
        self.assertIn("-f sha=${{ github.sha }}", step)


if __name__ == "__main__":
    unittest.main()
