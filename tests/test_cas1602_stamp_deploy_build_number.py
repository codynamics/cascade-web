"""CAS-1602: --stamp-deploy must fail loudly, never silently stamp a small build number (it stamped 1)."""
import os, sys, tempfile, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import poc_pipeline as pp


def fake_git(shallow_after, count):
    state = {"unshallowed": False}

    def _g(*args, timeout=10):
        if args[:2] == ("rev-parse", "--is-shallow-repository"):
            return "true" if (shallow_after or not state["unshallowed"]) else "false"
        if args[0] == "fetch":
            state["unshallowed"] = True
            return ""
        if args[:2] == ("rev-list", "--count"):
            return count
        return ""
    return _g


class StampDeployBuildNumber(unittest.TestCase):
    def test_shallow_clone_that_cannot_be_deepened_fails(self):
        with mock.patch.object(pp, "_git", fake_git(True, "1")):
            with self.assertRaises(RuntimeError):
                pp._deployed_build_number("abc1234")

    def test_count_not_above_floor_fails(self):
        with mock.patch.object(pp, "_git", fake_git(False, "1")):
            with self.assertRaises(RuntimeError):
                pp._deployed_build_number("abc1234")

    def test_non_numeric_count_fails(self):
        with mock.patch.object(pp, "_git", fake_git(False, "")):
            with self.assertRaises(RuntimeError):
                pp._deployed_build_number("abc1234")

    def test_full_history_returns_count_above_floor(self):
        with mock.patch.object(pp, "_git", fake_git(False, str(pp.BUILD_FLOOR + 5))):
            self.assertEqual(pp._deployed_build_number("abc1234"), pp.BUILD_FLOOR + 5)

    def test_stamp_deploy_exits_nonzero_and_writes_nothing_when_count_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            vj, bj = os.path.join(d, "version.json"), os.path.join(d, "build-info.js")
            with mock.patch.object(pp, "VERSION_JSON", vj), mock.patch.object(pp, "BUILD_INFO_JS", bj), \
                 mock.patch.object(pp, "_git", fake_git(True, "1")), \
                 mock.patch.dict(os.environ, {"CF_PAGES_COMMIT_SHA": "abc1234def"}):
                self.assertEqual(pp.stamp_deploy(), 1)
            self.assertFalse(os.path.exists(vj))
            self.assertFalse(os.path.exists(bj))


if __name__ == "__main__":
    unittest.main()
