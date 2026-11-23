"""CAS-416: a ledger-write failure must warn, not crash the run.

The daily job's most damaging failure mode isn't a bad send — it's `insert_notifications`
throwing on a schema mismatch and taking the whole run down with it, so every user after the
one that tripped it gets nothing. This exercises the CLI end-to-end against the fixtures with
a store that fails the ledger write, the same way a live 400 does.
"""
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from monitor.__main__ import main
from monitor.store import InMemoryStore

FIXTURES = "monitor/fixtures"

# CAS-1519: a non-dry-run main() writes the held-ids safety net to the REAL state/user_held_ids.json.
# Several tests below run main() for real against the 5001/5002 fixtures, so a local run overwrote
# the 8,720-id file with {"5001","5002"} (committed by accident in CAS-1517) and every user-held
# below-floor film lost its floor exemption. Point the whole module at a temp file.
_HELD_TMP = None
_HELD_PATCH = None


def setUpModule():
    global _HELD_TMP, _HELD_PATCH
    _HELD_TMP = tempfile.TemporaryDirectory()
    _HELD_PATCH = mock.patch("monitor.__main__.USER_HELD_IDS_FILE",
                             os.path.join(_HELD_TMP.name, "user_held_ids.json"))
    _HELD_PATCH.start()


def tearDownModule():
    _HELD_PATCH.stop()
    _HELD_TMP.cleanup()


class TargetUserSafetyValve(unittest.TestCase):
    """CAS-486: --target-user must scope a run to exactly one user, so the notify-test harness can
    never spray real users. monitor/fixtures has two: user-A (Drama rentals fires on tmdb_id 5001,
    pvod->rental) and user-B (unrelated cascades)."""

    def test_only_the_target_user_is_matched(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16", "--dry-run",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--watches", f"{FIXTURES}/watches.json",
            "--target-user", "user-A",
        ]
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main(argv)
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn("user user-A", out)
        self.assertNotIn("user user-B", out)

    def test_an_unmatched_target_user_delivers_to_no_one(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16", "--dry-run",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--watches", f"{FIXTURES}/watches.json",
            "--target-user", "some-user-not-in-fixtures",
        ]
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main(argv)
        self.assertEqual(rc, 0)
        self.assertIn("no new alerts for anyone", buf.getvalue())


class ChannelIndependence(unittest.TestCase):
    """CAS-493: a failed email send must not suppress the in-app (or push) delivery for the same
    user — only the email channel retries next run. user-A in the fixtures has both channels on
    and a real hits_rent match, so it exercises the mixed-outcome path end to end."""

    def _run(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--emails", f"{FIXTURES}/emails.json",
            "--prefs", f"{FIXTURES}/prefs.json",
            "--watches", f"{FIXTURES}/watches.json",
        ]
        buf = io.StringIO()
        with mock.patch("monitor.__main__.send_via_resend",
                         side_effect=RuntimeError("403 Forbidden")):
            with redirect_stdout(buf):
                rc = main(argv)
        return rc, buf.getvalue()

    def test_email_failure_still_delivers_in_app_and_writes_its_ledger_row(self):
        rc, out = self._run()
        self.assertEqual(rc, 0)
        self.assertIn("email channel — failed", out)
        self.assertIn("in-app channel — delivered", out)
        # AC2: the summary must report the in-app count truthfully, not zero.
        self.assertRegex(out, r"sent 0 email digest\(s\), [1-9]\d* in-app-only")
        self.assertRegex(out, r"wrote [1-9]\d* notification row\(s\)")

    def test_email_success_is_unaffected(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--emails", f"{FIXTURES}/emails.json",
            "--prefs", f"{FIXTURES}/prefs.json",
            "--watches", f"{FIXTURES}/watches.json",
        ]
        buf = io.StringIO()
        with mock.patch("monitor.__main__.send_via_resend", return_value={"id": "test"}):
            with redirect_stdout(buf):
                rc = main(argv)
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn("email channel — sent", out)
        self.assertRegex(out, r"sent [1-9]\d* email digest\(s\)")


class UserHeldIdsSnapshot(unittest.TestCase):
    """CAS-986: state/user_held_ids.json — the two-tier catalogue's demotion-safety net — is
    written once per real run, never on --dry-run (the docstring's own "write nothing" promise)."""

    def _argv(self, extra=None):
        return [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--watches", f"{FIXTURES}/watches.json",
        ] + (extra or [])

    def test_a_real_run_writes_the_sorted_union_as_a_plain_array(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "state", "user_held_ids.json")
            buf = io.StringIO()
            with mock.patch("monitor.__main__.USER_HELD_IDS_FILE", out_path):
                with redirect_stdout(buf):
                    rc = main(self._argv())
            self.assertEqual(rc, 0)
            with open(out_path, encoding="utf-8") as fh:
                written = json.load(fh)
            self.assertEqual(written, sorted(written))
            self.assertEqual(set(written), {"5001", "5002"})
            self.assertIn("wrote 2 held id(s)", buf.getvalue())

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "state", "user_held_ids.json")
            with mock.patch("monitor.__main__.USER_HELD_IDS_FILE", out_path):
                with redirect_stdout(io.StringIO()):
                    rc = main(self._argv(["--dry-run"]))
            self.assertEqual(rc, 0)
            self.assertFalse(os.path.exists(out_path))


class LedgerWriteResilience(unittest.TestCase):
    def test_a_ledger_write_failure_is_a_warning_not_a_crash(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--emails", f"{FIXTURES}/emails.json",
            "--prefs", f"{FIXTURES}/prefs.json",
            "--watches", f"{FIXTURES}/watches.json",
        ]
        buf = io.StringIO()
        with mock.patch.object(InMemoryStore, "insert_notifications",
                                side_effect=RuntimeError("HTTP Error 400: Bad Request")):
            with redirect_stdout(buf):
                rc = main(argv)
        self.assertEqual(rc, 0)
        self.assertIn("could not write ledger", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
