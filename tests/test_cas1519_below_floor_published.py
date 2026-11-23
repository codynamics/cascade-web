"""CAS-1519 — 36 films scored below WM_PUBLISH_FLOOR (e.g. "The Mongoose": user rating only, Cascade
score 49) sat in movies.json and failed the blocking gate. They were legitimately published as
user-held: state/user_held_ids.json held 8,720 ids until CAS-1517's commit replaced it with the
monitor fixture pair {"5001","5002"} (monitor/tests/test_main.py ran main() un-patched and wrote
the real file). With the exemption gone they read as non-held offenders.

Run: python -m unittest tests.test_cas1519_below_floor_published
"""
import json
import unittest

import poc_pipeline as pp


def _mongoose_shape(tmdb_id):
    """A released streaming title with a user rating only (5.2 -> Cascade score 49 < floor 50)."""
    return {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": "2026", "cinema_date": None,
            "genres": ["Action"], "release_dates": [], "status": ["included_streaming"],
            "offers": [{"service": "Amazon Prime Video", "type": "sub", "price": None, "format": None}],
            "availability_confidence": "confirmed", "wm_user_rating": 5.2, "wm_critic_score": None,
            "wm_popularity_percentile": 100.0, "popularity": 145.5,
            "poster": "/x.jpg", "synopsis": "x", "outcome": "scored"}


class BelowFloorNonHeldTitleIsNotPublished(unittest.TestCase):
    def test_not_published_when_not_held(self):
        m = _mongoose_shape(1294189)
        ids = pp.scoreable_ids([dict(m)], floor=pp.WM_PUBLISH_FLOOR, today="2026-11-22")
        self.assertNotIn(1294189, ids)
        recs, _ = pp.select_publishable({"1294189": m}, ids, {1294189}, set(), 10)
        self.assertEqual(recs, [])
        survivors, dropped = pp.revalidate_published_floor([m], ids, set())
        self.assertEqual((survivors, dropped), ([], 1))

    def test_held_title_keeps_its_exemption(self):
        m = _mongoose_shape(1294189)
        ids = pp.scoreable_ids([dict(m)], floor=pp.WM_PUBLISH_FLOOR, today="2026-11-22")
        recs, stats = pp.select_publishable({"1294189": m}, ids, {1294189}, {"1294189"}, 10)
        self.assertEqual([r["tmdb_id"] for r in recs], [1294189])
        self.assertEqual(stats["exempt"], 1)


class CommittedHeldIdsIsNotTheMonitorFixture(unittest.TestCase):
    def test_held_ids_file_is_not_the_fixture_pair(self):
        held = pp.load_user_held_ids()
        self.assertIsNotNone(held)
        self.assertNotEqual(held, {"5001", "5002"}, "state/user_held_ids.json was overwritten by monitor test fixtures")


if __name__ == "__main__":
    unittest.main()
