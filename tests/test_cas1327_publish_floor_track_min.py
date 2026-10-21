"""CAS-1327 — the catalogue's publication floor equals the app's own agent-score minimum
(TRACK_MIN in app_template.html, 50), not a second hard-coded 60 in poc_pipeline.py.

AC2: scoreable_ids at floor=50 against real released (non-cinema) fixtures scoring exactly
49/50/59 — 50 and 59 scoreable, 49 not.

AC3: the floor the pipeline uses (engine_publish_floor) comes from the shipped engine's own
TRACK_MIN, not a value independent of it — proven by pointing the engine call at a fixture build
of index.html with TRACK_MIN changed, and showing the floor follows.
"""
import os
import tempfile
import unittest

import poc_pipeline as pp


def _movie(tmdb_id, wm_user_rating, popularity=100, status=("included_streaming",), **fields):
    m = {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": "2026", "popularity": popularity,
         "status": list(status), "offers": [], "cinema_date": "2026-01-01",
         "wm_user_rating": wm_user_rating}
    m.update(fields)
    return m


class ScoreableIdsAtFiftyFloorBoundary(unittest.TestCase):
    """AC2 — a released, non-cinema title's wmQScore floor is a hard boundary at 50, the app's own
    TRACK_MIN: 49 is excluded, 50 and 59 are included. wm_user_rating values below were picked by
    probing the real shipped engine's wmQScore/WM_SCALE for the exact qScore each is meant to hit."""

    def test_49_is_not_scoreable_50_and_59_are(self):
        below = _movie(1327049, wm_user_rating=5.15)   # wmQScore 49
        at = _movie(1327050, wm_user_rating=5.25)       # wmQScore 50
        above = _movie(1327059, wm_user_rating=5.91)    # wmQScore 59

        ids = pp.scoreable_ids([below, at, above], floor=50)

        self.assertNotIn(1327049, ids, "a qScore of 49 must not clear a floor of 50")
        self.assertIn(1327050, ids, "a qScore of 50 must clear a floor of 50")
        self.assertIn(1327059, ids, "a qScore of 59 must clear a floor of 50")


class EnginePublishFloorFollowsTrackMin(unittest.TestCase):
    """AC3 — engine_publish_floor() (what WM_PUBLISH_FLOOR's default is sourced from) reads
    TRACK_MIN from the shipped engine, not an independent value: change TRACK_MIN in a fixture
    build of index.html and the floor this function returns follows it."""

    def test_floor_follows_a_changed_track_min_fixture(self):
        with open(pp.APP_FILE, encoding="utf-8") as f:
            real_html = f.read()
        marker = "const TRACK_MIN=50, TRACK_MAX=100;"
        self.assertIn(marker, real_html, "fixture setup assumes today's real TRACK_MIN is 50")
        fixture_html = real_html.replace(marker, "const TRACK_MIN=77, TRACK_MAX=100;")

        fixture_path = tempfile.NamedTemporaryFile(
            dir=os.path.dirname(pp.APP_FILE), suffix=".html", delete=False).name
        try:
            with open(fixture_path, "w", encoding="utf-8") as f:
                f.write(fixture_html)
            self.assertEqual(pp.engine_publish_floor(fixture_path), 77,
                             "the floor must follow TRACK_MIN as changed in the fixture build")
            self.assertEqual(pp.engine_publish_floor(pp.APP_FILE), 50,
                             "the real, unmodified build's floor must still be today's TRACK_MIN")
        finally:
            os.remove(fixture_path)


if __name__ == "__main__":
    unittest.main()
