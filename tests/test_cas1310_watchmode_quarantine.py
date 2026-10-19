"""CAS-1310 — daily.yml's nightly health assertions had been red every night since 12 Oct: the
same ~9 titles trip enrich_watchmode_fields' CAS-1134 identity guard, which writes nothing on a
'mismatch', so the title never leaves the 'unfetched'/no_score tiers that keep re-selecting it —
watchmode_identity never clears, and ~9 of the ~70 nightly Watchmode calls are wasted re-asking a
question whose answer won't change. Quarantines a mismatched tmdb_id in
state/watchmode_mismatch.json for WATCHMODE_MISMATCH_QUARANTINE_DAYS: neither
enrich_watchmode_fields_nightly nor the CAS-986 scoreability probe spends another credit on it
while quarantined, and watchmode_identity FAILs only on a mismatch that wasn't already
quarantined before the run.

No network: every case mocks poc_pipeline._fetch_watchmode_idmap/_fetch_watchmode_title_details,
the same pattern test_cas1134_wm_idmap_movies_only.py already uses.
"""
import datetime
import unittest
from unittest import mock

import poc_pipeline as pp
from monitor import health


class WatchmodeQuarantinedHelper(unittest.TestCase):
    """Direct coverage of the helper the nightly pass and the probe both call."""

    def test_no_entry_is_not_quarantined(self):
        self.assertFalse(pp._watchmode_quarantined({}, 1, datetime.date(2026, 10, 19)))

    def test_entry_within_the_window_is_quarantined(self):
        quarantine = {"1": {"wm_id": "w1", "first_seen": "2026-10-01", "last_seen": "2026-10-10"}}
        self.assertTrue(pp._watchmode_quarantined(quarantine, 1, datetime.date(2026, 10, 19)))

    def test_entry_past_30_days_is_no_longer_quarantined(self):
        quarantine = {"1": {"wm_id": "w1", "first_seen": "2026-09-01", "last_seen": "2026-09-01"}}
        self.assertFalse(pp._watchmode_quarantined(quarantine, 1, datetime.date(2026, 10, 19)))

    def test_record_mismatch_adds_a_new_entry(self):
        quarantine = {}
        pp._record_watchmode_mismatch(quarantine, 1, "w1", "2026-10-19")
        self.assertEqual(quarantine["1"],
                         {"wm_id": "w1", "first_seen": "2026-10-19", "last_seen": "2026-10-19"})

    def test_record_mismatch_refreshes_last_seen_not_first_seen(self):
        quarantine = {"1": {"wm_id": "w1", "first_seen": "2026-09-01", "last_seen": "2026-09-01"}}
        pp._record_watchmode_mismatch(quarantine, 1, "w1", "2026-10-19")
        self.assertEqual(quarantine["1"]["first_seen"], "2026-09-01")
        self.assertEqual(quarantine["1"]["last_seen"], "2026-10-19")


class NightlyFieldsQuarantine(unittest.TestCase):
    """AC1/AC2 — enrich_watchmode_fields_nightly: a new mismatch is quarantined; a quarantined
    id costs no credit next run; past the 30-day window it is retried."""

    @staticmethod
    def _idmap_for(tmdb_ids):
        return {f"wm-{i}": i for i in tmdb_ids}

    def test_a_new_mismatch_is_quarantined_and_spends_a_credit(self):
        movie = {"tmdb_id": 286217}
        detail = {"tmdb_id": 286217, "tmdb_type": "tv", "user_rating": 7.0}
        budget = {"remaining": 5, "skipped": 0}
        quarantine = {}

        with mock.patch.object(pp, "WATCHMODE_KEY", "test-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap",
                               return_value=self._idmap_for([286217])), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcomes = pp.enrich_watchmode_fields_nightly([movie], budget=budget,
                                                          quarantine=quarantine)

        self.assertEqual(outcomes.get("mismatch"), 1)
        self.assertEqual(outcomes.get("quarantined"), 0, "not yet quarantined when first fetched")
        self.assertEqual(budget["remaining"], 4, "the credit is still spent — the fetch happened")
        self.assertIn("286217", quarantine)
        self.assertEqual(quarantine["286217"]["last_seen"], pp._RUN_DATE)

    def test_a_quarantined_id_is_not_refetched_next_run(self):
        movie = {"tmdb_id": 286217}
        budget = {"remaining": 5, "skipped": 0}
        quarantine = {"286217": {"wm_id": "3262859", "first_seen": pp._RUN_DATE,
                                  "last_seen": pp._RUN_DATE}}

        with mock.patch.object(pp, "WATCHMODE_KEY", "test-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap",
                               return_value=self._idmap_for([286217])), \
             mock.patch.object(pp, "_fetch_watchmode_title_details",
                               side_effect=AssertionError("must not fetch a quarantined id")):
            outcomes = pp.enrich_watchmode_fields_nightly([movie], budget=budget,
                                                          quarantine=quarantine)

        self.assertEqual(outcomes.get("mismatch", 0), 0)
        self.assertEqual(outcomes["quarantined"], 1)
        self.assertEqual(budget["remaining"], 5, "no credit spent on the quarantined id")

    def test_a_quarantine_older_than_30_days_is_retried(self):
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        stale_quarantine_date = (today - datetime.timedelta(days=31)).isoformat()
        movie = {"tmdb_id": 286217}
        detail = {"tmdb_id": 286217, "tmdb_type": "movie", "user_rating": 7.8}
        budget = {"remaining": 5, "skipped": 0}
        quarantine = {"286217": {"wm_id": "3262859", "first_seen": stale_quarantine_date,
                                  "last_seen": stale_quarantine_date}}

        with mock.patch.object(pp, "WATCHMODE_KEY", "test-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap",
                               return_value=self._idmap_for([286217])), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcomes = pp.enrich_watchmode_fields_nightly([movie], budget=budget,
                                                          quarantine=quarantine)

        self.assertEqual(outcomes["quarantined"], 0, "past the window — not excluded")
        self.assertEqual(outcomes.get("ok"), 1)
        self.assertEqual(movie["wm_user_rating"], 7.8)


class ProbeCandidatesQuarantine(unittest.TestCase):
    """AC1/AC2 (CAS-986 probe side) — same contract as the nightly pass."""

    def test_a_quarantined_candidate_is_excluded_from_every_tier(self):
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        candidate = {"tmdb_id": 286217, "title": "The Martian", "year": "2015",
                    "popularity": 99999, "status": [], "outcome": "unprobed",
                    "first_seen": "2026-01-01", "last_probed": None, "probe_count": 0}
        quarantine = {"286217": {"wm_id": "3262859", "first_seen": pp._RUN_DATE,
                                  "last_seen": pp._RUN_DATE}}

        with mock.patch.object(pp, "enrich_watchmode_fields",
                               side_effect=AssertionError("must not probe a quarantined id")):
            outcomes = pp.probe_candidates({"286217": candidate}, today, budget=5, wm_idmap={},
                                           published_ids=set(), quarantine=quarantine)

        self.assertEqual(outcomes["quarantined"], 1)
        self.assertEqual(candidate["outcome"], "unprobed", "left untouched — never probed")

    def test_a_new_mismatch_from_the_probe_is_recorded_into_quarantine(self):
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        candidate = {"tmdb_id": 286217, "title": "The Martian", "year": "2015",
                    "popularity": 1.0, "status": [], "outcome": "unprobed",
                    "first_seen": "2026-01-01", "last_probed": None, "probe_count": 0}
        wm_idmap = {286217: "3262859"}
        detail = {"tmdb_id": 286217, "tmdb_type": "tv", "user_rating": 7.0}
        quarantine = {}

        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcomes = pp.probe_candidates({"286217": candidate}, today, budget=5,
                                           wm_idmap=wm_idmap, published_ids=set(),
                                           quarantine=quarantine)

        self.assertEqual(outcomes.get("mismatch"), 1)
        self.assertIn("286217", quarantine)
        self.assertEqual(quarantine["286217"]["wm_id"], "3262859")


class WatchmodeIdentityHealthCheck(unittest.TestCase):
    """AC3 — the health check itself: the detail line reports the quarantined count as
    information, never a reason to fail."""

    def test_zero_mismatches_with_quarantined_ids_still_passes_and_reports_the_count(self):
        c = health.check_watchmode_identity({"mismatch": 0, "quarantined": 1})
        self.assertTrue(c["ok"])
        self.assertIn("1 quarantined", c["detail"])

    def test_a_new_mismatch_still_fails_regardless_of_quarantined_count(self):
        c = health.check_watchmode_identity(
            {"mismatch": 1, "mismatch_ids": [999999], "quarantined": 9})
        self.assertFalse(c["ok"])
        self.assertIn("999999", c["detail"])
        self.assertIn("9 quarantined", c["detail"])

    def test_no_quarantined_key_behaves_exactly_as_before(self):
        c = health.check_watchmode_identity({"mismatch": 0})
        self.assertTrue(c["ok"])
        self.assertNotIn("quarantined", c["detail"])


if __name__ == "__main__":
    unittest.main()
