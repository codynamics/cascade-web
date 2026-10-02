"""CAS-1135 — CAS-1134 found 332 films matched to a TV show sharing their TMDB number (47
published with the TV show's ratings, 285 hidden behind its empty ones) and nothing in
monitor/health.py noticed, because every existing check measures volume/coverage, never identity.
Covers the four checks this ticket adds: watchmode_identity (CAS-1134's details-response
'mismatch' outcome), watchmode_remap_backlog (the repair tier's own backlog, day over day),
released_scored_without_rating (CAS-1134's tightened 'scored' rule), and landmark_films (a fixed
list of well-known titles that must stay published and scoreable). Synthetic inputs throughout,
no network — landmark_films's only external dependency is the local `node` + shipped engine,
exactly what tests/test_data_quality.py's own publication-floor test already relies on.
"""
import unittest

from monitor import health


class WatchmodeIdentity(unittest.TestCase):
    def test_pass_zero_mismatches(self):
        c = health.check_watchmode_identity({"calls": 40, "errors": 0, "mismatch": 0})
        self.assertTrue(c["ok"])

    def test_fail_one_mismatch_names_the_tmdb_id(self):
        c = health.check_watchmode_identity(
            {"calls": 40, "errors": 0, "mismatch": 1, "mismatch_ids": [286217]})
        self.assertFalse(c["ok"])
        self.assertIn("286217", c["detail"])

    def test_unknown_when_absent(self):
        c = health.check_watchmode_identity(None)
        self.assertIsNone(c["ok"])
        self.assertEqual(c["status"], "unknown")


class WatchmodeRemapBacklog(unittest.TestCase):
    def _records(self, n_backlog, n_clean=10):
        # n_backlog records carry the exact CAS-1134 shape: fetched, no wm_id, tmdb_id has a TV row.
        out = [{"tmdb_id": 1000 + i, "wm_fields_fetched_at": "2026-09-14", "wm_id": None}
              for i in range(n_backlog)]
        out += [{"tmdb_id": 2000 + i, "wm_fields_fetched_at": "2026-09-14", "wm_id": f"wm{i}"}
               for i in range(n_clean)]
        return out

    def test_pass_zero_backlog(self):
        c = health.check_watchmode_remap_backlog(self._records(0), tv_tmdb_ids={1000}, prev_value=None)
        self.assertTrue(c["ok"])

    def test_fail_backlog_that_did_not_fall(self):
        records = self._records(3)
        tv_ids = {r["tmdb_id"] for r in records[:3]}
        c = health.check_watchmode_remap_backlog(records, tv_tmdb_ids=tv_ids, prev_value=3)
        self.assertFalse(c["ok"])
        self.assertEqual(c["value"], 3)

    def test_fail_backlog_grew(self):
        records = self._records(5)
        tv_ids = {r["tmdb_id"] for r in records[:5]}
        c = health.check_watchmode_remap_backlog(records, tv_tmdb_ids=tv_ids, prev_value=3)
        self.assertFalse(c["ok"])

    def test_warn_backlog_is_falling(self):
        records = self._records(2)
        tv_ids = {r["tmdb_id"] for r in records[:2]}
        c = health.check_watchmode_remap_backlog(records, tv_tmdb_ids=tv_ids, prev_value=5)
        self.assertIsNone(c["ok"])
        self.assertEqual(c["status"], "warn")

    def test_skipped_when_id_map_unavailable(self):
        c = health.check_watchmode_remap_backlog(self._records(3), tv_tmdb_ids=None, prev_value=None)
        self.assertIsNone(c["ok"])
        self.assertEqual(c["status"], "skipped")


class ReleasedScoredWithoutRating(unittest.TestCase):
    def test_pass_every_scored_candidate_has_a_rating(self):
        candidates = [
            {"tmdb_id": 1, "outcome": "scored", "status": ["pvod"], "wm_user_rating": 7.5,
             "wm_critic_score": None},
            {"tmdb_id": 2, "outcome": "scored", "status": ["upcoming"], "wm_user_rating": None,
             "wm_critic_score": None, "wm_popularity_percentile": 99.0},
        ]
        c = health.check_released_scored_without_rating(candidates)
        self.assertTrue(c["ok"])

    def test_fail_a_released_scored_candidate_with_no_rating(self):
        candidates = [
            {"tmdb_id": 3, "title": "No Rating Film", "outcome": "scored", "status": ["pvod"],
             "wm_user_rating": None, "wm_critic_score": None, "wm_popularity_percentile": 55.0},
        ]
        c = health.check_released_scored_without_rating(candidates)
        self.assertFalse(c["ok"])
        self.assertIn("No Rating Film", c["detail"])

    def test_pass_no_score_candidates_are_not_flagged(self):
        candidates = [{"tmdb_id": 4, "outcome": "no_score", "status": ["pvod"],
                      "wm_user_rating": None, "wm_critic_score": None}]
        c = health.check_released_scored_without_rating(candidates)
        self.assertTrue(c["ok"])


class LandmarkFilms(unittest.TestCase):
    def _good_movie(self, tmdb_id, title):
        return {"tmdb_id": tmdb_id, "title": title, "status": ["included_streaming"],
               "wm_user_rating": 8.5, "wm_critic_score": 85, "wm_fields_fetched_at": "2026-09-14",
               "wm_id": f"fixture-{tmdb_id}"}

    def test_pass_every_landmark_film_published_and_scoreable(self):
        movies = [self._good_movie(tmdb_id, name) for tmdb_id, name in health.LANDMARK_FILMS.items()]
        c = health.check_landmark_films(movies)
        self.assertTrue(c["ok"])

    def test_fail_one_landmark_film_missing(self):
        items = list(health.LANDMARK_FILMS.items())
        movies = [self._good_movie(tmdb_id, name) for tmdb_id, name in items[1:]]   # drop the first
        c = health.check_landmark_films(movies)
        self.assertFalse(c["ok"])
        self.assertIn(items[0][1], c["detail"])

    def test_fail_one_landmark_film_below_floor(self):
        items = list(health.LANDMARK_FILMS.items())
        movies = [self._good_movie(tmdb_id, name) for tmdb_id, name in items]
        movies[0]["wm_user_rating"] = 1.0   # well below WM_PUBLISH_FLOOR
        movies[0]["wm_critic_score"] = None
        c = health.check_landmark_films(movies)
        self.assertFalse(c["ok"])
        self.assertIn(items[0][1], c["detail"])


class DryRunCoversAllFour(unittest.TestCase):
    """AC2: the --dry-run fixture exercises all four new checks and stays all-green."""

    def test_dry_run_includes_the_four_new_checks_and_passes(self):
        import io
        import json
        import os
        import tempfile

        out_fd, out_path = tempfile.mkstemp(suffix=".json")
        os.close(out_fd)
        try:
            code = health.main(["--dry-run", "--out", out_path])
            self.assertEqual(code, 0)
            report = json.load(io.open(out_path, encoding="utf-8"))
            names = {c["name"] for c in report["checks"]}
            for n in ("watchmode_identity", "watchmode_remap_backlog",
                     "released_scored_without_rating", "landmark_films"):
                self.assertIn(n, names)
            self.assertTrue(report["ok"])
        finally:
            os.path.exists(out_path) and os.remove(out_path)


if __name__ == "__main__":
    unittest.main()
