"""CAS-1230 — Chennai Love Story (tmdb_id 1443136) stayed published with a wmQScore below
WM_PUBLISH_FLOOR because no LIVE publication pass had re-run select_publishable/
revalidate_published_floor since its score fell below the floor (CAS-1105's exact shape, see that
ticket's own test): select_publishable/isScoreable themselves were never at fault. Confirmed by
direct reproduction: handing the real committed state/candidates.json + state/user_held_ids.json to
pp.scoreable_ids/pp.select_publishable drops it correctly.

This test encodes the rule directly with a synthetic record (no live data required) so a future
regression — a path that publishes, or keeps published, a below-floor non-held title — is caught
here regardless of what the committed catalogue happens to hold. It also pins down that
test_data_quality's OnlyFloorQualifyingTitlesPublish predicate (poc_pipeline.scoreable_ids, called
the same way) agrees with select_publishable's own verdict — the two can never again drift apart
because they are literally the same function call.

Run: python -m unittest tests.test_cas1230_publish_floor_predicate_agreement
"""
import unittest

import poc_pipeline as pp


def _below_floor_in_cinema(tmdb_id):
    """Modelled on 1443136 (Chennai Love Story): in_cinema, long past its run (cinema_date months
    before "today"), no critic or user score at all — cinema buzz alone can't exempt a title with no
    popularity signal to rank it on either."""
    return {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": "2026",
            "cinema_date": "2026-07-24", "genres": ["Drama"],
            "release_dates": [{"date": "2026-07-24", "region": "AU", "type": 3}],
            "status": ["in_cinema"], "offers": [], "availability_confidence": "estimated",
            "popularity": None, "wm_popularity_percentile": None,
            "wm_critic_score": None, "wm_user_rating": None}


class BelowFloorInCinemaTitleNeverPublishes(unittest.TestCase):
    """The CAS-1230 rule: a title that fails WM_PUBLISH_FLOOR and is not user-held does not
    publish, even when it was previously published and is still stamped in_cinema."""

    def test_select_publishable_excludes_it(self):
        offender = _below_floor_in_cinema(1443136)
        candidates = {"1443136": offender}
        engine_ids = pp.scoreable_ids([dict(offender)], floor=pp.WM_PUBLISH_FLOOR)
        self.assertNotIn(1443136, engine_ids)  # the real engine agrees it isn't scoreable
        published, stats = pp.select_publishable(candidates, engine_ids,
                                                  previously_published_ids={1443136},
                                                  held_ids=set(), catalogue_target=10)
        self.assertNotIn(1443136, {m["tmdb_id"] for m in published})
        self.assertEqual(stats["demoted"], 1)

    def test_held_title_is_exempt(self):
        offender = _below_floor_in_cinema(2)
        candidates = {"2": offender}
        engine_ids = pp.scoreable_ids([dict(offender)], floor=pp.WM_PUBLISH_FLOOR)
        published, stats = pp.select_publishable(candidates, engine_ids,
                                                  previously_published_ids={2},
                                                  held_ids={"2"}, catalogue_target=10)
        self.assertIn(2, {m["tmdb_id"] for m in published})
        self.assertEqual(stats["exempt"], 1)

    def test_data_quality_predicate_agrees_with_select_publishable(self):
        # Same shape as tests.test_data_quality.OnlyFloorQualifyingTitlesPublish's own offender
        # check, over the same synthetic record — so a future change to either side that makes them
        # disagree is caught here, not just assumed from reading the source.
        offender = _below_floor_in_cinema(3)
        held_ids = set()
        scoreable = pp.scoreable_ids([dict(offender)], floor=pp.WM_PUBLISH_FLOOR)
        is_offender = (offender["tmdb_id"] not in scoreable
                       and not (held_ids is None or str(offender["tmdb_id"]) in held_ids))
        self.assertTrue(is_offender)

        candidates = {"3": offender}
        engine_ids = pp.scoreable_ids([dict(offender)], floor=pp.WM_PUBLISH_FLOOR)
        published, _ = pp.select_publishable(candidates, engine_ids, previously_published_ids={3},
                                              held_ids=held_ids, catalogue_target=10)
        self.assertEqual(is_offender, 3 not in {m["tmdb_id"] for m in published})


if __name__ == "__main__":
    unittest.main()
