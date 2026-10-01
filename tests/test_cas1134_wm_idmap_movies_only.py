"""CAS-1134 — Watchmode's id-map CSV lists films AND TV shows, and TMDB numbers them separately,
so the same TMDB ID often appears on both a movie row and a TV row. Unfiltered, the inverted
{tmdb_id: wm_id} map resolved a film to whichever row sorted last in the CSV — every TV row sorts
after every movie row in the real file — handing the film a TV show's ratings (or hiding it behind
the TV show's empty ones). This covers the id-map movie-only filter, the TV-tmdb-id set it's built
alongside, the enrich_watchmode_fields identity guard ('mismatch'), wm_id persistence, the repair
tier that re-fetches a title wrongly resolved before this fix, and the stricter 'scored' rule
(popularity_percentile alone only counts for an upcoming/in_cinema title).
"""
import datetime
import unittest
from unittest import mock

import poc_pipeline as pp

# The exact four rows from the ticket's own Observation, read from the live Watchmode CSV.
_COLLISION_CSV = (
    "Watchmode ID,IMDB ID,TMDB ID,TMDB Type,Title,Year\n"
    '"1406622","tt3659388","286217","movie","The Martian","2015"\n'
    '"3262859","tt38494991","286217","tv","Death at the White Hart",""\n'
    '"140257","tt0088763","105","movie","Back to the Future","1985"\n'
    '"3105857","tt0159206","105","tv","Sex and the City","1998"\n'
)


class IdmapMovieOnlyAndTvIds(unittest.TestCase):
    """AC1a — the id map keeps only movie rows; AC1b — a CSV with no TMDB Type column still
    parses exactly as before CAS-1134."""

    def test_the_idmap_resolves_only_to_the_movie_row(self):
        idmap = pp._parse_watchmode_idmap_csv(_COLLISION_CSV)
        inverted = pp._invert_watchmode_idmap(idmap)
        self.assertEqual(inverted[286217], "1406622")
        self.assertEqual(inverted[105], "140257")
        self.assertNotIn("3262859", idmap)
        self.assertNotIn("3105857", idmap)

    def test_the_tv_tmdb_id_set_names_both_colliding_ids(self):
        self.assertEqual(pp._parse_watchmode_tv_tmdb_ids_csv(_COLLISION_CSV), {286217, 105})

    def test_a_csv_with_no_type_column_still_parses_both_rows(self):
        csv_text = "wm_id,tmdb_id,imdb_id\n100,555,tt0000001\n200,556,tt0000002\n"
        self.assertEqual(pp._parse_watchmode_idmap_csv(csv_text), {"100": 555, "200": 556})

    def test_a_csv_with_no_type_column_yields_an_empty_tv_id_set(self):
        csv_text = "wm_id,tmdb_id,imdb_id\n100,555,tt0000001\n"
        self.assertEqual(pp._parse_watchmode_tv_tmdb_ids_csv(csv_text), set())


class EnrichWatchmodeFieldsIdentityGuard(unittest.TestCase):
    """AC1c — a details response that identifies a non-movie type writes nothing and returns
    'mismatch'; AC1d — a clean successful fetch stores wm_id."""

    def test_a_tv_type_response_writes_nothing_and_returns_mismatch(self):
        movie = {"tmdb_id": 286217}
        detail = {"tmdb_id": 286217, "tmdb_type": "tv", "user_rating": 7.0, "critic_score": 60,
                  "popularity_percentile": 99.0}
        budget = {"remaining": 5, "skipped": 0}
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcome = pp.enrich_watchmode_fields(movie, {286217: "3262859"}, budget)
        self.assertEqual(outcome, "mismatch")
        self.assertNotIn("wm_user_rating", movie)
        self.assertNotIn("wm_critic_score", movie)
        self.assertNotIn("wm_popularity_percentile", movie)
        self.assertNotIn("wm_fields_fetched_at", movie)
        self.assertNotIn("wm_id", movie)
        self.assertEqual(budget["remaining"], 4, "the credit is still spent — the fetch happened")

    def test_a_response_naming_a_different_tmdb_id_also_mismatches(self):
        movie = {"tmdb_id": 105}
        detail = {"tmdb_id": 999999, "user_rating": 7.0}
        budget = {"remaining": 5, "skipped": 0}
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcome = pp.enrich_watchmode_fields(movie, {105: "140257"}, budget)
        self.assertEqual(outcome, "mismatch")
        self.assertNotIn("wm_user_rating", movie)

    def test_a_clean_fetch_stores_wm_id(self):
        movie = {"tmdb_id": 286217}
        detail = {"tmdb_id": 286217, "tmdb_type": "movie", "user_rating": 7.8, "critic_score": 64,
                  "popularity_percentile": 91.2}
        budget = {"remaining": 5, "skipped": 0}
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcome = pp.enrich_watchmode_fields(movie, {286217: "1406622"}, budget)
        self.assertEqual(outcome, "ok")
        self.assertEqual(movie["wm_id"], "1406622")
        self.assertEqual(movie["wm_user_rating"], 7.8)


class ProbeCandidatesRepairTier(unittest.TestCase):
    """AC1e — with a budget of 1, probe_candidates spends it on a record carrying
    wm_fields_fetched_at but no wm_id, whose tmdb_id has a TV row — not on an unprobed or stale
    record, even one far more popular."""

    def test_the_repair_candidate_is_probed_first(self):
        today = datetime.date(2026, 10, 1)
        calls = []

        def fake_enrich(movie_, wm_idmap, budget, ttl_days=pp.WATCHMODE_CACHE_TTL_DAYS):
            if budget["remaining"] <= 0:
                budget["skipped"] += 1
                return "skip"
            calls.append((movie_["tmdb_id"], ttl_days))
            budget["remaining"] -= 1
            movie_["wm_id"] = "1406622"
            movie_["wm_user_rating"] = 7.5
            movie_["wm_fields_fetched_at"] = today.isoformat()
            return "ok"

        # A record fetched under the old bug: has wm_fields_fetched_at, no wm_id, tmdb_id has a
        # TV row — fetched only yesterday, so it would read as fresh under the normal TTL.
        repair_candidate = {"tmdb_id": 286217, "title": "The Martian", "year": "2015",
                            "popularity": 1.0, "status": [], "outcome": "no_score",
                            "wm_fields_fetched_at": "2026-09-30", "last_probed": "2026-09-30",
                            "probe_count": 1}
        # Far more popular, but neither published+stale nor repair.
        unprobed_candidate = {"tmdb_id": 999, "title": "T999", "year": "2020",
                              "popularity": 99999, "status": [], "outcome": "unprobed",
                              "first_seen": "2026-01-01", "last_probed": None, "probe_count": 0}
        stale_published = {"tmdb_id": 1, "title": "T1", "year": "2020", "popularity": 50000,
                           "status": [], "outcome": "scored", "wm_fields_fetched_at": "2020-01-01",
                           "last_probed": "2020-01-01", "probe_count": 1}
        candidates = {"286217": repair_candidate, "999": unprobed_candidate, "1": stale_published}

        with mock.patch.object(pp, "enrich_watchmode_fields", fake_enrich):
            outcomes = pp.probe_candidates(candidates, today, budget=1, wm_idmap={},
                                           published_ids={1}, tv_tmdb_ids={286217})

        self.assertEqual(calls, [(286217, 0)], "repair tier forces ttl_days=0 (always stale)")
        self.assertEqual(outcomes["probed"], 1)
        self.assertEqual(candidates["1"]["last_probed"], "2020-01-01", "untouched — budget spent")
        self.assertEqual(candidates["999"]["outcome"], "unprobed", "untouched — budget spent")

    def test_no_tv_tmdb_ids_means_no_repair_tier(self):
        today = datetime.date(2026, 10, 1)
        candidate = {"tmdb_id": 286217, "title": "The Martian", "year": "2015", "popularity": 1.0,
                    "status": [], "outcome": "no_score", "wm_fields_fetched_at": "2026-09-30",
                    "last_probed": "2026-09-30", "probe_count": 1}
        with mock.patch.object(pp, "enrich_watchmode_fields",
                               side_effect=AssertionError("must not probe without tv_tmdb_ids")):
            pp.probe_candidates({"286217": candidate}, today, budget=5, wm_idmap={},
                                published_ids=set())  # tv_tmdb_ids defaults empty


class ScoredRequiresARealRatingUnlessLadderCohort(unittest.TestCase):
    """AC1f — a released candidate whose only Watchmode field is wm_popularity_percentile ends
    'no_score'; an upcoming one with the same shape ends 'scored'."""

    def test_released_percentile_only_is_no_score_upcoming_is_scored(self):
        today = datetime.date(2026, 10, 1)
        released = {"tmdb_id": 1, "title": "Released", "year": "2020", "popularity": 10,
                    "status": ["included_streaming"], "outcome": "unprobed",
                    "first_seen": "2026-01-01", "last_probed": None, "probe_count": 0}
        upcoming = {"tmdb_id": 2, "title": "Upcoming", "year": "2027", "popularity": 5,
                   "status": ["upcoming"], "outcome": "unprobed", "first_seen": "2026-01-01",
                   "last_probed": None, "probe_count": 0}
        candidates = {"1": released, "2": upcoming}

        def fake_enrich(movie_, wm_idmap, budget, ttl_days=pp.WATCHMODE_CACHE_TTL_DAYS):
            budget["remaining"] -= 1
            movie_["wm_popularity_percentile"] = 70.0
            movie_["wm_fields_fetched_at"] = today.isoformat()
            return "ok"

        with mock.patch.object(pp, "enrich_watchmode_fields", fake_enrich):
            pp.probe_candidates(candidates, today, budget=2, wm_idmap={}, published_ids=set())

        self.assertEqual(candidates["1"]["outcome"], "no_score")
        self.assertEqual(candidates["2"]["outcome"], "scored")


class ReclassifyStaleScoredCandidates(unittest.TestCase):
    """Change #5's one-time correction: a candidate already wrongly marked 'scored' on popularity
    alone is reclassified to 'no_score' with last_probed cleared; a genuinely scored or ladder-
    cohort candidate is left alone."""

    def test_reclassifies_only_the_popularity_only_non_ladder_case(self):
        candidates = {
            "1": {"tmdb_id": 1, "status": ["included_streaming"], "outcome": "scored",
                 "wm_popularity_percentile": 70.0, "last_probed": "2026-09-01"},
            "2": {"tmdb_id": 2, "status": ["upcoming"], "outcome": "scored",
                 "wm_popularity_percentile": 70.0, "last_probed": "2026-09-01"},
            "3": {"tmdb_id": 3, "status": ["included_streaming"], "outcome": "scored",
                 "wm_user_rating": 8.0, "last_probed": "2026-09-01"},
        }
        fixed = pp.reclassify_stale_scored_candidates(candidates)
        self.assertEqual(fixed, 1)
        self.assertEqual(candidates["1"]["outcome"], "no_score")
        self.assertIsNone(candidates["1"]["last_probed"])
        self.assertEqual(candidates["2"]["outcome"], "scored", "ladder cohort — left alone")
        self.assertEqual(candidates["3"]["outcome"], "scored", "has a real rating — left alone")


if __name__ == "__main__":
    unittest.main()
