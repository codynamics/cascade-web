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
            r"\s*(?:elif \[.*workflow_dispatch.*\]; then|else)\n"
            r"\s*git fetch origin staging\n"
            r"\s*sha=\$\(git rev-parse origin/staging\)",
            merge_step,
        )
        self.assertIsNotNone(
            m, "origin/staging must only be used when the sha input is empty")
        self.assertNotIn("workflow_run", merge_step)


class PromoteRollbackTests(unittest.TestCase):
    """CAS-1550 — rollback mode: main's tree := a previous release's tree, in one new commit."""

    def setUp(self):
        self.text = _read(PROMOTE_YML)
        self.lines = self.text.splitlines()
        self.rollback = "\n".join(_step_lines(self.lines, "Roll main back to a previous release"))
        self.merge = "\n".join(_step_lines(self.lines, "Merge the QA'd staging commit into main"))

    def test_rollback_input_exists_and_sha_stays_first(self):
        self.assertRegex(self.text, r"workflow_dispatch:\s*\n\s*inputs:\s*\n\s*sha:")
        self.assertRegex(self.text, r"\n      rollback_to:\n")

    def test_rollback_builds_new_commit_from_target_tree(self):
        self.assertIn('git commit-tree "${target}^{tree}" -p HEAD', self.rollback)
        self.assertIn('rollback: main to $ROLLBACK_TO', self.rollback)
        self.assertIn("git merge --ff-only", self.rollback)

    def test_non_ancestor_is_refused(self):
        self.assertIn('git merge-base --is-ancestor "$target" HEAD', self.rollback)
        self.assertRegex(self.rollback, r"not an ancestor of main[^\n]*\n\s*exit 1")

    def test_no_force_push_or_history_rewrite(self):
        for bad in ("--force", "push -f", "push origin +", "reset --hard"):
            self.assertNotIn(bad, self.text)

    def test_normal_path_unchanged_and_gated_on_empty_input(self):
        self.assertIn("if: ${{ inputs.rollback_to == '' }}", self.merge)
        self.assertIn('git merge --no-ff -X theirs FETCH_HEAD -m "promote: staging@$sha"', self.merge)
        self.assertIn("if: ${{ inputs.rollback_to != '' }}", self.text)
        # the rollback step runs before the normal merge, and the push is shared by both paths
        self.assertLess(self.text.index("Roll main back"), self.text.index("Merge the QA'd staging"))
        self.assertEqual(self.text.count("git push origin main"), 1)

    def test_normal_promote_tags_release_timestamp(self):
        tag = "\n".join(_step_lines(self.lines, "Tag the release commit on main"))
        self.assertIn("if: ${{ inputs.rollback_to == '' }}", tag)
        self.assertIn("release-$(date -u +%Y%m%dT%H%M%SZ)", tag)
        self.assertIn('git push origin "$tag"', tag)
        self.assertLess(self.text.index("git push origin main"), self.text.index("Tag the release commit"))


class QaDispatchPromoteTests(unittest.TestCase):
    def setUp(self):
        self.qa_text = _read(QA_YML)

    def test_dispatch_promote_passes_tested_sha(self):
        lines = self.qa_text.splitlines()
        step = "\n".join(_step_lines(lines, "Dispatch promote-data.yml"))
        self.assertIn("gh workflow run promote-data.yml", step)
        self.assertIn("-f sha=${{ github.sha }}", step)


if __name__ == "__main__":
    unittest.main()
