"""CAS-1105 — 6 non-held, below-floor titles stayed published indefinitely after CAS-1083's own
revalidate_stale_upcoming() flipped them from a buzz-exempt "upcoming" classification to a scored
"released" one. select_publishable itself was never at fault (CAS-1072 already proved isScoreable/
select_publishable correctly demote an aged, below-floor, non-held title given real inputs) — the
gap was that the status flip was applied once, by hand, directly against the committed catalogue
(outside apply_two_tier_publication), so select_publishable never ran again to re-decide those 6
titles' membership. revalidate_published_floor() closes that: a safety net that re-checks the real
floor against every published title on every publication pass, regardless of how its status got
there, and drops a non-held offender even when select_publishable was skipped entirely.

Run: python -m unittest tests.test_cas1105_publish_floor_revalidation
"""
import unittest

import poc_pipeline as pp


def _below_floor_released(tmdb_id):
    """Shaped exactly like the real CAS-1105 offenders: status flipped to "released" by
    revalidate_stale_upcoming, no critic/user rating behind it at all — not even the aged cinema-
    buzz estimate CAS-1072's offenders carried."""
    return {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": "2025",
            "cinema_date": None, "genres": ["Documentary"], "release_dates": [],
            "status": ["released"], "offers": [], "availability_confidence": "estimated",
            "wm_popularity_percentile": 47.1, "wm_critic_score": None, "wm_user_rating": None}


class RevalidatePublishedFloorDropsAStrandedOffender(unittest.TestCase):
    """The exact CAS-1105 scenario: a title already IN the published set (select_publishable was
    never consulted this pass) that no longer clears the floor and isn't held must not survive."""

    def test_a_non_held_below_floor_title_is_dropped(self):
        offender = _below_floor_released(1)
        engine_ids = pp.scoreable_ids([offender], floor=pp.WM_PUBLISH_FLOOR)
        self.assertNotIn(1, engine_ids)  # the real engine agrees it isn't scoreable
        survivors, dropped = pp.revalidate_published_floor([offender], engine_ids, held_ids=set())
        self.assertEqual(dropped, 1)
        self.assertNotIn(1, {m["tmdb_id"] for m in survivors})

    def test_the_same_title_held_survives(self):
        offender = _below_floor_released(2)
        engine_ids = pp.scoreable_ids([offender], floor=pp.WM_PUBLISH_FLOOR)
        survivors, dropped = pp.revalidate_published_floor([offender], engine_ids, held_ids={"2"})
        self.assertEqual(dropped, 0)
        self.assertIn(2, {m["tmdb_id"] for m in survivors})

    def test_held_ids_none_drops_nothing(self):
        # CAS-1067's own fail-safe: an unreadable state/user_held_ids.json must never be read as
        # "nothing is held" — demote nothing at all this run rather than guess.
        offender = _below_floor_released(3)
        engine_ids = pp.scoreable_ids([offender], floor=pp.WM_PUBLISH_FLOOR)
        survivors, dropped = pp.revalidate_published_floor([offender], engine_ids, held_ids=None)
        self.assertEqual(dropped, 0)
        self.assertIn(3, {m["tmdb_id"] for m in survivors})

    def test_a_still_scoreable_title_is_unaffected(self):
        scoreable = _below_floor_released(4)
        scoreable["wm_critic_score"] = 90
        engine_ids = pp.scoreable_ids([scoreable], floor=pp.WM_PUBLISH_FLOOR)
        self.assertIn(4, engine_ids)
        survivors, dropped = pp.revalidate_published_floor([scoreable], engine_ids, held_ids=set())
        self.assertEqual(dropped, 0)
        self.assertIn(4, {m["tmdb_id"] for m in survivors})


if __name__ == "__main__":
    unittest.main()
