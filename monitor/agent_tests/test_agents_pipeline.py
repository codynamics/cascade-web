"""CAS-791 — the three agent-behaviour checks that live at the pipeline layer, not the engine
(K1-K3). Deliberately outside monitor/tests/ so `npm run qa` (python -m unittest discover -s
monitor/tests) never picks these up — see QA-AGENTS.md. Run on request via `npm run test:agents`.

Nothing here re-implements poc_pipeline's own logic: each check drives the real function
(build_html, apply_monotonic_status/tier_rank) or runs the real suite it names (test_data_quality's
blocking half, test_pipeline_resilience) and asserts against that.
"""
import datetime
import os
import subprocess
import unittest

import poc_pipeline as pp
from tests import run_data_quality
from tests import test_pipeline_resilience as tpr

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class K1RebuildMatchesTheCommittedIndexExceptItsOwnStamp(unittest.TestCase):
    """K1: `python poc_pipeline.py --build-html` against the committed index.html — the exact
    check qa.yml's build-check job runs (BUILD_INFO/BUILD_DATE excluded from the diff; anything
    else that moves means the committed build is stale). index.html/version.json AND the
    www/ iOS mirror build_html() also stamps (_sync_ios_www) are restored to their committed
    content afterwards regardless of outcome — this check reads the real build path, it does
    not get to leave the working tree dirty."""

    def test_rebuild_diffs_only_by_its_build_stamp(self):
        # CAS-860: this check only means anything inside a git working tree — `git diff` exits 129
        # ("not a git repository") otherwise, which is an environment fact, not a build defect.
        git_dir = subprocess.run(["git", "rev-parse", "--git-dir"], cwd=REPO_ROOT,
                                 capture_output=True, text=True)
        if git_dir.returncode != 0:
            self.skipTest("not running inside a git working tree")

        # Binary snapshot/restore, deliberately — a text-mode round trip on Windows translates line
        # endings on the way out, which can leave a byte-identical-after-normalization file still
        # reading as "modified" to git's stat cache. Restoring the exact original bytes sidesteps that.
        www_index = os.path.join(pp.IOS_WWW_DIR, "index.html")
        paths = (pp.APP_FILE, pp.VERSION_JSON, www_index)
        originals = {p: open(p, "rb").read() for p in paths}
        try:
            pp.build_html()
            diff = subprocess.run(
                ["git", "diff", "-U0", "--", "index.html"],
                cwd=REPO_ROOT, capture_output=True, text=True, check=True,
            ).stdout
        finally:
            for p in paths:
                with open(p, "wb") as f:
                    f.write(originals[p])

        changed = [line for line in diff.splitlines()
                   if line[:1] in "+-" and line[:3] not in ("+++", "---")]
        drift = [line for line in changed if "BUILD_INFO" not in line and "BUILD_DATE" not in line]
        self.assertEqual(drift, [],
                          f"index.html rebuilds {len(drift)} line(s) away from the committed one, "
                          f"beyond its own build stamp: {drift[:5]}")


class K2StatusNeverRegressesAcrossARefresh(unittest.TestCase):
    """K2: no film's availability status ever moves backward on the canonical ladder
    (poc_pipeline.AVAILABILITY_TIERS) once apply_monotonic_status — the one gate every write to
    m['status'] goes through — has run. Driven across a batch of titles moving every direction
    (forward, one held-back backward read, unchanged), asserting the rank invariant holds for
    every one, not just the single-title cases tests/test_monotonic_status.py already covers."""

    def test_tier_rank_never_drops_after_a_monotonic_guarded_write(self):
        day = datetime.date(2026, 8, 20)
        cases = [
            (["upcoming"], "confirmed", ["in_cinema"], "confirmed"),          # forward
            (["included_streaming"], "confirmed", ["rental"], "estimated"),   # backward read - held
            (["rental"], "confirmed", ["rental"], "confirmed"),               # unchanged
            (["pvod"], "confirmed", ["included_streaming"], "confirmed"),     # forward
        ]
        for before_status, before_conf, candidate, candidate_conf in cases:
            m = {"status": list(before_status), "availability_confidence": before_conf}
            rank_before = pp.tier_rank(m["status"])
            pp.apply_monotonic_status(m, candidate, candidate_conf, day)
            rank_after = pp.tier_rank(m["status"])
            self.assertGreaterEqual(rank_after, rank_before,
                f"{before_status} -> candidate {candidate} let rank drop to {m['status']}")


class K3_CAS1558_ExistingSuitesRunGreenAgainstTheBuiltCatalogue(unittest.TestCase):
    """K3: the existing data-quality (blocking half — the same split CI's `data` job runs, via
    tests.run_data_quality) and pipeline-resilience suites, run directly rather than
    re-implemented, so this check is exactly as strict as the real gate."""

    def test_blocking_data_quality_checks_pass(self):
        result = run_data_quality.main()
        self.assertEqual(result, 0, "a blocking data-quality check failed against the built catalogue")

    def test_pipeline_resilience_suite_passes(self):
        suite = unittest.TestLoader().loadTestsFromModule(tpr)
        result = unittest.TextTestRunner(verbosity=0).run(suite)
        self.assertTrue(result.wasSuccessful(), "the pipeline-resilience suite failed against the built catalogue")


if __name__ == "__main__":
    unittest.main()
