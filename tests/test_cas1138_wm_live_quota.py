"""CAS-1138 — Watchmode quota reporting used to read WATCHMODE_MONTHLY_CREDITS/WM_MONTHLY_QUOTA
constants (40,000 / 10,000) that described the old trial account, not the real 2,500-credit free
plan the account reverted to on 22 Sep 2026. wm_run_allowance already calls Watchmode's own GET
/status every run it isn't paused; this wires its live {quota, quotaUsed} through to
state/run_stats.json (via status_out) and state/api_budget.json's cycle record (via
_apply_live_wm_quota), and monitor.health's two Watchmode checks off a constant onto those live
figures — reporting "unavailable" rather than falling back to a guess when /status fails.

No network: every case stubs poc_pipeline._fetch_watchmode_status.
"""
import datetime
import unittest
from unittest import mock

import poc_pipeline as pp
from monitor import health


class WmRunAllowanceStatusOut(unittest.TestCase):
    """AC1a: a stubbed /status feeds back the live figures a caller needs to record."""

    def test_a_successful_status_call_fills_in_quota_quota_used_and_remaining(self):
        status_out = {}
        with mock.patch.object(pp, "_fetch_watchmode_status",
                               return_value={"quota": 2500, "quotaUsed": 1008}):
            pp.wm_run_allowance(datetime.date(2026, 10, 2), run_max_credits=50,
                                status_out=status_out)
        self.assertEqual(status_out, {"quota": 2500, "quota_used": 1008,
                                      "remaining_monthly_credits": 1492})

    def test_a_failed_status_call_leaves_every_field_null(self):
        status_out = {}
        with mock.patch.object(pp, "_fetch_watchmode_status", side_effect=RuntimeError("boom")):
            pp.wm_run_allowance(datetime.date(2026, 10, 2), run_max_credits=50,
                                status_out=status_out)
        self.assertEqual(status_out, {"quota": None, "quota_used": None,
                                      "remaining_monthly_credits": None})

    def test_a_zero_ceiling_never_calls_status_and_leaves_every_field_null(self):
        status_out = {}
        with mock.patch.object(pp, "_fetch_watchmode_status") as status_fn:
            pp.wm_run_allowance(datetime.date(2026, 10, 2), run_max_credits=0,
                                status_out=status_out)
        status_fn.assert_not_called()
        self.assertEqual(status_out, {"quota": None, "quota_used": None,
                                      "remaining_monthly_credits": None})


class ApplyLiveWmQuota(unittest.TestCase):
    """AC1a: the cycle record saved to state/api_budget.json picks up the live quota (replacing
    the WM_MONTHLY_QUOTA default) exactly when this run's /status succeeded."""

    def _stale_cycle(self):
        return {"cycle_start": "2026-09-12", "cycle_end": "2026-10-12", "quota": 10000,
               "quota_live": False, "spent": 0, "updated_at": "2026-10-02", "days": {}}

    def test_a_live_quota_overwrites_the_stale_default_and_sets_quota_live(self):
        cycle = pp._apply_live_wm_quota(self._stale_cycle(),
                                        {"quota": 2500, "quota_used": 1008,
                                         "remaining_monthly_credits": 1492})
        self.assertEqual(cycle["quota"], 2500)
        self.assertTrue(cycle["quota_live"])

    def test_no_live_quota_this_run_leaves_the_cycle_untouched(self):
        cycle = pp._apply_live_wm_quota(self._stale_cycle(),
                                        {"quota": None, "quota_used": None,
                                         "remaining_monthly_credits": None})
        self.assertEqual(cycle["quota"], 10000)
        self.assertFalse(cycle["quota_live"])


class CheckWatchmodeFetchLiveQuota(unittest.TestCase):
    """AC1b/AC1c/AC1d: monitor.health.check_watchmode_fetch reads the live quota from stats."""

    def test_ok_detail_states_both_live_figures_and_no_old_constants(self):
        # AC1b: "those stats" — the run stats a successful live /status of quota=2500/used=1008
        # would produce (remaining 1492).
        c = health.check_watchmode_fetch(
            {"calls": 10, "errors": 0, "quota": 2500, "quota_used": 1008,
             "remaining_monthly_credits": 1492},
            run_max_credits_raw="50")
        self.assertTrue(c["ok"])
        self.assertIn("1492", c["detail"])
        self.assertIn("2500", c["detail"])
        self.assertNotIn("40000", c["detail"])
        self.assertNotIn("10000", c["detail"])

    def test_fails_below_the_live_quotas_floor(self):
        # AC1c: quota 2500 -> floor 375 (15%); 300 remaining is below it.
        c = health.check_watchmode_fetch(
            {"calls": 10, "errors": 0, "quota": 2500, "quota_used": 2200,
             "remaining_monthly_credits": 300},
            run_max_credits_raw="50")
        self.assertFalse(c["ok"])
        self.assertEqual(c["threshold"], 375)

    def test_unknown_when_the_live_quota_is_unavailable(self):
        # AC1d: a failed /status this run.
        c = health.check_watchmode_fetch(
            {"calls": 10, "errors": 0, "quota": None, "quota_used": None,
             "remaining_monthly_credits": None},
            run_max_credits_raw="50")
        self.assertIsNone(c["ok"])


class CheckWatchmodePaceLiveQuota(unittest.TestCase):
    """AC1d: watchmode_pace also reports unavailable rather than pacing against a fallback."""

    def test_unknown_when_the_cycle_has_never_seen_a_live_quota(self):
        cycle = {"cycle_start": "2026-09-12", "cycle_end": "2026-10-12", "quota": 10000,
                "quota_live": False, "spent": 750, "updated_at": "2026-10-02",
                "days": {"2026-09-12": 250, "2026-09-13": 250, "2026-09-14": 250}}
        c = health.check_watchmode_pace(cycle, datetime.date(2026, 10, 2))
        self.assertIsNone(c["ok"])


if __name__ == "__main__":
    unittest.main()
