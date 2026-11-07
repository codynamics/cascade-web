"""CAS-1380 — grow the back catalogue in a deliberate order: 2023 onwards first, then 2010-2015,
then five-year blocks going back to 1930-1934, each highest Watchmode rating first.

AC1: scripts/wm_backcatalogue_sizing.py --mode enumerate stamps each title with the highest rating
gate it cleared (`rating_band`), processing gates highest first; a rerun under a weaker gate never
lowers an existing band.

AC2: poc_pipeline.probe_candidates()'s tier 2 (unprobed candidates) sorts by year block
(BACKCAT_PROBE_BLOCKS), then rating_band descending, then popularity descending — tiers 0, 1 and 3
are untouched by this ticket.
"""
import datetime
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "scripts"))
import wm_backcatalogue_sizing as sizing  # noqa: E402

import poc_pipeline as pp


def _never_call(*args, **kwargs):
    raise AssertionError("dry-run must not call the network")


class DryRunEnumerateRatingBandTestCase(unittest.TestCase):
    """AC1."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.out_path = os.path.join(self._tmpdir.name, "wm_backcatalogue_candidates.json")

    def _candidates_by_id(self):
        with open(self.out_path, encoding="utf-8") as fh:
            return {c["id"]: c for c in json.load(fh)}

    def test_band_is_the_highest_gate_a_title_clears(self):
        with mock.patch.object(pp, "get_json", side_effect=_never_call):
            sizing.run_enumerate(2020, 2021, [5.5, 7], max_credits=10,
                                  out_path=self.out_path, dry_run=True)
        candidates = self._candidates_by_id()
        self.assertEqual(candidates[1001]["rating_band"], 7)   # clears both gates (rating 7.2)
        self.assertEqual(candidates[1002]["rating_band"], 5.5)  # clears only 5.5 (rating 6.0)

    def test_a_second_run_under_a_weaker_gate_never_lowers_an_existing_band(self):
        with mock.patch.object(pp, "get_json", side_effect=_never_call):
            sizing.run_enumerate(2020, 2021, [5.5, 7], max_credits=10,
                                  out_path=self.out_path, dry_run=True)
            sizing.run_enumerate(2020, 2021, [5.5], max_credits=10,
                                  out_path=self.out_path, dry_run=True)
        candidates = self._candidates_by_id()
        self.assertEqual(candidates[1001]["rating_band"], 7)


class ProbeCandidatesBackcatProbeOrderTestCase(unittest.TestCase):
    """AC2 — tier 2 only: block rank, then rating_band descending, then popularity descending."""

    def test_block_then_band_then_popularity_order_with_a_budget_of_5(self):
        today = datetime.date(2026, 11, 7)
        calls = []

        def fake_enrich(c, wm_idmap, budget, ttl_days=pp.WATCHMODE_CACHE_TTL_DAYS):
            if budget["remaining"] <= 0:
                budget["skipped"] += 1
                return "skip"
            budget["remaining"] -= 1
            calls.append((c["year"], c.get("rating_band")))
            c["wm_user_rating"] = 70
            return "ok"

        candidates = {
            "1": {"tmdb_id": 1, "year": "2024", "popularity": 900, "rating_band": 5.5,
                  "outcome": "unprobed"},
            "2": {"tmdb_id": 2, "year": "2023", "popularity": 10, "rating_band": 7.0,
                  "outcome": "unprobed"},
            "3": {"tmdb_id": 3, "year": "2012", "popularity": 1, "rating_band": 8.0,
                  "outcome": "unprobed"},
            "4": {"tmdb_id": 4, "year": "2019", "popularity": 1, "rating_band": 8.0,
                  "outcome": "unprobed"},
            "5": {"tmdb_id": 5, "year": "2007", "popularity": 1, "rating_band": 8.0,
                  "outcome": "unprobed"},
            "6": {"tmdb_id": 6, "year": "1960", "popularity": 1, "rating_band": 8.0,
                  "outcome": "unprobed"},
        }

        with mock.patch.object(pp, "enrich_watchmode_fields", fake_enrich):
            outcomes = pp.probe_candidates(candidates, today, 5, {}, published_ids=set())

        self.assertEqual(calls, [
            ("2023", 7.0), ("2024", 5.5), ("2012", 8.0), ("2019", 8.0), ("2007", 8.0),
        ])
        self.assertEqual(outcomes["probed"], 5)
        self.assertNotIn("wm_user_rating", candidates["6"])   # 1960 ranks last, never probed


if __name__ == "__main__":
    unittest.main()
