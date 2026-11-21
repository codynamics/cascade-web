"""CAS-993 AC3 / CAS-1503 — scripts/wait_until_sydney.py's wait decision, injected times only (no real sleep).

Run:  python -m unittest tests.test_wait_until_sydney
"""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import wait_until_sydney as wus  # noqa: E402


class ComputeWait(unittest.TestCase):
    def test_0117_aest_waits_until_0300(self):
        # 2026-07-01 is well outside AU daylight saving (AEST, UTC+10).
        now = datetime.datetime(2026, 7, 1, 1, 17, tzinfo=wus.SYDNEY)
        decision = wus.compute_wait(now)
        self.assertGreater(decision.wait_seconds, 0)
        self.assertFalse(decision.warn)
        wake = now + datetime.timedelta(seconds=decision.wait_seconds)
        self.assertEqual((wake.hour, wake.minute), (3, 0))

    def test_0217_aedt_waits_until_0300(self):
        # 2026-01-15 is mid AU daylight saving (AEDT, UTC+11) — same 03:00 target, different
        # UTC offset, proving the conversion is DST-aware rather than a fixed hour count.
        now = datetime.datetime(2026, 1, 15, 2, 17, tzinfo=wus.SYDNEY)
        decision = wus.compute_wait(now)
        self.assertGreater(decision.wait_seconds, 0)
        self.assertFalse(decision.warn)
        wake = now + datetime.timedelta(seconds=decision.wait_seconds)
        self.assertEqual((wake.hour, wake.minute), (3, 0))

    def test_0330_does_not_wait(self):
        now = datetime.datetime(2026, 7, 1, 3, 30, tzinfo=wus.SYDNEY)
        decision = wus.compute_wait(now)
        self.assertEqual(decision.wait_seconds, 0)
        self.assertFalse(decision.warn)

    def test_0730_does_not_wait_and_warns(self):
        now = datetime.datetime(2026, 7, 1, 7, 30, tzinfo=wus.SYDNEY)
        decision = wus.compute_wait(now)
        self.assertEqual(decision.wait_seconds, 0)
        self.assertTrue(decision.warn)

    def test_utc_input_converted_before_comparison(self):
        # 16:00 UTC on 30 Jun (AEST, UTC+10) is 02:00 Sydney on 1 Jul — still before the 03:00 target.
        now = datetime.datetime(2026, 6, 30, 16, 0, tzinfo=datetime.timezone.utc)
        decision = wus.compute_wait(now)
        self.assertGreater(decision.wait_seconds, 0)
        self.assertLessEqual(decision.wait_seconds, 3600)


if __name__ == "__main__":
    unittest.main()
