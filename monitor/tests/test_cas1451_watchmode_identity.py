"""CAS-1451 — watchmode_identity passes on a mismatch the run already quarantined, and still
fails on a published mismatch, >5 mismatches in a run, or >10 new quarantine entries in 7 days."""
import datetime as dt
import unittest

from monitor import health

TODAY = dt.date(2026, 11, 16)


def _stats(ids, quarantined=31):
    return {"mismatch": len(ids), "mismatch_ids": list(ids), "quarantined": quarantined}


def _q(*ids, first_seen="2026-10-01", wm_id="999"):
    return {str(i): {"wm_id": wm_id, "first_seen": first_seen, "last_seen": "2026-11-15"} for i in ids}


class QuarantinedMismatch(unittest.TestCase):
    def test_quarantined_mismatch_passes_with_id_and_total_in_detail(self):
        c = health.check_watchmode_identity(
            _stats([1559984]), quarantine=_q(1559984, first_seen="2026-11-15"),
            today_movies=[{"tmdb_id": 1559984, "wm_id": None}], today=TODAY)
        self.assertTrue(c["ok"])
        self.assertIn("1559984", c["detail"])
        self.assertIn("31 quarantined", c["detail"])

    def test_mismatch_not_in_quarantine_fails(self):
        c = health.check_watchmode_identity(_stats([42]), quarantine={}, today_movies=[], today=TODAY)
        self.assertFalse(c["ok"])
        self.assertIn("not quarantined", c["detail"])

    def test_published_with_mismatched_wm_id_fails(self):
        c = health.check_watchmode_identity(
            _stats([7]), quarantine=_q(7, wm_id="555"),
            today_movies=[{"tmdb_id": 7, "wm_id": 555}], today=TODAY)
        self.assertFalse(c["ok"])
        self.assertIn("published", c["detail"])

    def test_more_than_five_mismatches_in_one_run_fails(self):
        ids = list(range(1, 7))
        c = health.check_watchmode_identity(_stats(ids), quarantine=_q(*ids),
                                            today_movies=[], today=TODAY)
        self.assertFalse(c["ok"])
        self.assertIn("systemic", c["detail"])

    def test_five_mismatches_still_pass(self):
        ids = list(range(1, 6))
        c = health.check_watchmode_identity(_stats(ids), quarantine=_q(*ids),
                                            today_movies=[], today=TODAY)
        self.assertTrue(c["ok"])

    def test_quarantine_growth_over_ten_in_seven_days_fails(self):
        q = _q(*range(100, 111), first_seen="2026-11-14")   # 11 new
        c = health.check_watchmode_identity(_stats([100]), quarantine=q, today_movies=[], today=TODAY)
        self.assertFalse(c["ok"])
        self.assertIn("grew by 11", c["detail"])

    def test_quarantine_growth_of_ten_passes(self):
        q = _q(*range(100, 110), first_seen="2026-11-14")
        c = health.check_watchmode_identity(_stats([100]), quarantine=q, today_movies=[], today=TODAY)
        self.assertTrue(c["ok"])

    def test_old_entries_do_not_count_toward_growth(self):
        q = _q(*range(100, 130), first_seen="2026-10-01")
        c = health.check_watchmode_identity(_stats([100]), quarantine=q, today_movies=[], today=TODAY)
        self.assertTrue(c["ok"])


if __name__ == "__main__":
    unittest.main()
