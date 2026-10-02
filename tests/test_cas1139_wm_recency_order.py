"""CAS-1139 — the free-plan Watchmode refresh is ordered by how recently a title was released,
not spent blind in catalogue/popularity order. A released title within WM_RECENT_RELEASE_DAYS of
its AU release date now refreshes weekly, the same as the upcoming/in_cinema ladder cohort; once
the weekly cohort and the never-fetched are covered, the nightly fields pass and the CAS-986
scoreability probe both spend the rest of their small shared pot on titles released within
WM_RECENT_YEAR_DAYS before the long back-catalogue tail. monitor.health's new watchmode_freshness
check asserts those two cohorts are actually being kept fresh, not just that SOME titles got
fetched this run.

No network: every enrich_watchmode_fields_nightly/probe_candidates case stubs
poc_pipeline._fetch_watchmode_idmap/_fetch_watchmode_title_details, the same pattern
test_cas830_watchmode_fields.py's own nightly-tier test already uses.
"""
import datetime
import unittest
from unittest import mock

import poc_pipeline as pp
from monitor import health


class EnrichWatchmodeFieldsNightlyRecencyOrder(unittest.TestCase):
    """AC1a/b/c."""

    @staticmethod
    def _idmap_for(tmdb_ids):
        return {f"wm-{i}": i for i in tmdb_ids}

    def test_budget_of_3_fetches_in_cinema_and_recent_titles_not_the_2019_title(self):
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        in_cinema = {"tmdb_id": 1, "status": ["in_cinema"],
                     "wm_fields_fetched_at": (today - datetime.timedelta(days=10)).isoformat()}
        recent_30d = {"tmdb_id": 2, "status": [],
                      "cinema_date": (today - datetime.timedelta(days=30)).isoformat(),
                      "wm_fields_fetched_at": (today - datetime.timedelta(days=8)).isoformat()}
        recent_200d = {"tmdb_id": 3, "status": [],
                       "cinema_date": (today - datetime.timedelta(days=200)).isoformat(),
                       "wm_fields_fetched_at": (today - datetime.timedelta(days=40)).isoformat()}
        old_2019 = {"tmdb_id": 4, "status": [], "cinema_date": "2019-06-01",
                    "wm_fields_fetched_at": (today - datetime.timedelta(days=60)).isoformat()}
        movies = [in_cinema, recent_30d, recent_200d, old_2019]
        detail = {"user_rating": 5.0, "critic_score": 50, "popularity_percentile": 50.0}
        budget = {"remaining": 3, "skipped": 0}

        with mock.patch.object(pp, "WATCHMODE_KEY", "test-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap",
                               return_value=self._idmap_for([1, 2, 3, 4])), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcomes = pp.enrich_watchmode_fields_nightly(movies, budget=budget)

        self.assertEqual(outcomes["ok"], 3)
        for m in (in_cinema, recent_30d, recent_200d):
            self.assertEqual(m["wm_fields_fetched_at"], pp._RUN_DATE)
        self.assertNotEqual(old_2019["wm_fields_fetched_at"], pp._RUN_DATE)

    def test_a_30_day_old_release_is_fetched_a_200_day_old_release_with_the_same_stamp_is_cached(self):
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        recent = {"tmdb_id": 10, "status": [],
                  "cinema_date": (today - datetime.timedelta(days=30)).isoformat(),
                  "wm_fields_fetched_at": (today - datetime.timedelta(days=8)).isoformat()}
        older = {"tmdb_id": 11, "status": [],
                "cinema_date": (today - datetime.timedelta(days=200)).isoformat(),
                "wm_fields_fetched_at": (today - datetime.timedelta(days=8)).isoformat()}
        movies = [recent, older]
        detail = {"user_rating": 5.0, "critic_score": 50, "popularity_percentile": 50.0}
        budget = {"remaining": 5, "skipped": 0}

        with mock.patch.object(pp, "WATCHMODE_KEY", "test-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap",
                               return_value=self._idmap_for([10, 11])), \
             mock.patch.object(pp, "_fetch_watchmode_title_details",
                               return_value=detail) as detail_fn:
            pp.enrich_watchmode_fields_nightly(movies, budget=budget)

        self.assertEqual(recent["wm_fields_fetched_at"], pp._RUN_DATE)
        detail_fn.assert_called_once_with("wm-10")   # the 200-day-old release is cached, never called

    def test_within_the_older_tail_the_stalest_fetched_title_goes_first(self):
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        stalest = {"tmdb_id": 20, "status": [], "cinema_date": "2015-01-01",
                  "wm_fields_fetched_at": (today - datetime.timedelta(days=90)).isoformat()}
        less_stale = {"tmdb_id": 21, "status": [], "cinema_date": "2016-01-01",
                     "wm_fields_fetched_at": (today - datetime.timedelta(days=35)).isoformat()}
        movies = [less_stale, stalest]   # deliberately out of stale order
        detail = {"user_rating": 5.0, "critic_score": 50, "popularity_percentile": 50.0}
        budget = {"remaining": 1, "skipped": 0}

        with mock.patch.object(pp, "WATCHMODE_KEY", "test-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap",
                               return_value=self._idmap_for([20, 21])), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            pp.enrich_watchmode_fields_nightly(movies, budget=budget)

        self.assertEqual(stalest["wm_fields_fetched_at"], pp._RUN_DATE)
        self.assertNotEqual(less_stale["wm_fields_fetched_at"], pp._RUN_DATE)


class ProbeCandidatesRecencyOrder(unittest.TestCase):
    """AC1d — tier 1 (published and stale) spends on the most recently released title first, not
    the most popular one."""

    def test_a_recently_released_low_popularity_candidate_is_probed_before_a_2019_blockbuster(self):
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        blockbuster = {"tmdb_id": 30, "status": [], "popularity": 500,
                       "cinema_date": "2019-01-01", "outcome": "scored"}
        recent = {"tmdb_id": 31, "status": [], "popularity": 5,
                 "cinema_date": (today - datetime.timedelta(days=20)).isoformat(),
                 "outcome": "scored"}
        candidates = {"30": blockbuster, "31": recent}
        wm_idmap = {30: "wm-30", 31: "wm-31"}
        detail = {"user_rating": 5.0, "critic_score": 50, "popularity_percentile": 50.0}

        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            pp.probe_candidates(candidates, today, 1, wm_idmap, published_ids={30, 31})

        self.assertEqual(recent["wm_fields_fetched_at"], today.isoformat())
        self.assertNotIn("wm_fields_fetched_at", blockbuster)


class WatchmodeFreshnessCheck(unittest.TestCase):
    """AC1e."""

    @staticmethod
    def _catalogue(stale_pct):
        today = datetime.date(2026, 10, 2)
        n = 100
        stale_n = round(n * stale_pct)
        movies = []
        for i in range(n):
            age = 20 if i < stale_n else 1
            movies.append({
                "tmdb_id": i, "status": ["in_cinema"],
                "cinema_date": (today - datetime.timedelta(days=5)).isoformat(),
                "wm_fields_fetched_at": (today - datetime.timedelta(days=age)).isoformat(),
            })
        return today, movies

    def test_ok_on_a_fresh_synthetic_catalogue(self):
        today, movies = self._catalogue(stale_pct=0.0)
        c = health.check_watchmode_freshness(movies, today)
        self.assertTrue(c["ok"])

    def test_fails_when_10_pct_of_in_cinema_films_carry_a_20_day_old_stamp(self):
        today, movies = self._catalogue(stale_pct=0.10)
        c = health.check_watchmode_freshness(movies, today)
        self.assertFalse(c["ok"])

    def test_detail_states_both_percentages_and_the_oldest_stamp_age(self):
        today, movies = self._catalogue(stale_pct=0.10)
        c = health.check_watchmode_freshness(movies, today)
        # three figures: the weekly-TTL pct, the within-a-year pct, and the oldest stamp's age.
        self.assertEqual(c["detail"].count("%"), 2)
        self.assertIn("20", c["detail"])


class IsLadderCohortUnchanged(unittest.TestCase):
    """AC1f."""

    def test_a_released_film_30_days_old_is_not_ladder_cohort(self):
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        movie = {"tmdb_id": 1, "status": [],
                "cinema_date": (today - datetime.timedelta(days=30)).isoformat()}
        self.assertFalse(pp._is_ladder_cohort(movie))


if __name__ == "__main__":
    unittest.main()
