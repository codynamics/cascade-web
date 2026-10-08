"""CAS-1232 — the publish-floor gate (tests.test_data_quality.OnlyFloorQualifyingTitlesPublish)
used to ask the shipped engine whether each published film is scoreable TODAY using the test
runner's own wall-clock date/timezone, judged against a catalogue only the daily refresh rebuilds.
A film's score decays with time (CAS-289/CAS-318's cinema-estimate-window cap, CINEMA_ESTIMATE_
CAP_DAYS), so a title could cross below WM_PUBLISH_FLOOR on its own between refreshes and turn the
gate red with no code change — proven in production 8-9 Oct 2026 (a film scoreable at 23:59 UTC,
not scoreable two minutes later at 00:01 UTC, purely because the clock crossed a day boundary the
catalogue itself hadn't moved past yet).

The fix: poc_pipeline.scoreable_ids (and the gate test itself) now take an explicit `today`, pinned
to the catalogue's own "generated" build stamp — the engine's clock never has to be the real one.

AC1 lives here: same `today`, every timezone, the same answer; and the fallback (omitted `today`,
the pre-fix call shape) is shown to be exactly the thing that disagrees across a clock that has
moved on, which is the bug this ticket exists to stop reaching the gate.

Run: python -m unittest tests.test_cas1232_publish_floor_determinism
"""
import datetime
import os
import unittest

import poc_pipeline as pp
from poll_scheduler import CINEMA_ESTIMATE_CAP_DAYS

NOW = datetime.date.today()
# A "yesterday's build" stamp, comfortably before NOW regardless of when this test actually runs.
GENERATED = (NOW - datetime.timedelta(days=5)).isoformat()
GENERATED_PLUS_2 = (datetime.date.fromisoformat(GENERATED) + datetime.timedelta(days=2)).isoformat()


def _borderline_cinema_estimate(tmdb_id, as_of_iso, inside_by_days):
    """An ESTIMATED in_cinema claim with no critic/user rating — cinema buzz
    (wm_popularity_percentile) alone is what exempts it from WM_PUBLISH_FLOOR, and only while
    CINEMA_ESTIMATE_CAP_DAYS hasn't yet elapsed since cinema_date, judged as of `as_of_iso`.
    `inside_by_days` positive keeps it inside the window as of `as_of_iso`; negative pushes it out."""
    cinema_date = (datetime.date.fromisoformat(as_of_iso)
                   - datetime.timedelta(days=CINEMA_ESTIMATE_CAP_DAYS - inside_by_days)).isoformat()
    return {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": "2026",
            "cinema_date": cinema_date, "genres": ["Drama"],
            "release_dates": [{"date": cinema_date, "region": "AU", "type": 3}],
            "status": ["in_cinema"], "offers": [], "availability_confidence": "estimated",
            "wm_popularity_percentile": 70.0, "wm_critic_score": None, "wm_user_rating": None}


class PublishFloorIsDeterministic(unittest.TestCase):
    """CAS-1232 AC1: pinning `today` to the catalogue's own generated stamp makes the floor check
    independent of the runner's timezone, and of a clock that has since moved past that stamp."""

    def test_same_today_gives_the_same_answer_across_every_timezone(self):
        # Inside the estimate window by 1 day as of GENERATED: still cinema-buzz exempt.
        movie = _borderline_cinema_estimate(1232001, GENERATED, inside_by_days=1)
        old_tz = os.environ.get("TZ")
        try:
            answers = set()
            for tz in ("UTC", "Australia/Sydney", "Pacific/Kiritimati", "Pacific/Midway"):
                os.environ["TZ"] = tz
                ids = pp.scoreable_ids([dict(movie)], floor=pp.WM_PUBLISH_FLOOR, today=GENERATED)
                answers.add(1232001 in ids)
            self.assertEqual(answers, {True},
                             "pinning today= must give the same answer in every timezone")
        finally:
            if old_tz is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old_tz

    def test_pinned_today_is_unaffected_by_a_clock_that_has_moved_past_it(self):
        # Exactly the ticket's own proof: inside the window as of GENERATED, outside it 2 days
        # later (CINEMA_ESTIMATE_CAP_DAYS crossed in between) — and outside it again, further
        # still, as of this test's own real wall clock (NOW is 5 days after GENERATED).
        movie = _borderline_cinema_estimate(1232002, GENERATED, inside_by_days=1)

        pinned_at_generated = pp.scoreable_ids([dict(movie)], floor=pp.WM_PUBLISH_FLOOR, today=GENERATED)
        pinned_at_plus_2 = pp.scoreable_ids([dict(movie)], floor=pp.WM_PUBLISH_FLOOR, today=GENERATED_PLUS_2)
        no_today_at_all = pp.scoreable_ids([dict(movie)], floor=pp.WM_PUBLISH_FLOOR)  # pre-fix call shape

        self.assertIn(1232002, pinned_at_generated,
                      "as of the catalogue's own build date the film is still cinema-exempt")
        self.assertNotIn(1232002, pinned_at_plus_2,
                         "2 days later the estimate window has lapsed — it must no longer be exempt")
        self.assertNotIn(1232002, no_today_at_all,
                         "omitting today= falls back to the real wall clock, which has moved even "
                         "further past the window than +2 days — this is the bug today= fixes")


class ApplyTwoTierPublicationRequiresTomorrowsFloorToo(unittest.TestCase):
    """CAS-1232 AC2: the daily refresh itself must not publish a non-held title that clears the
    floor today but is already known to fall below it before the next refresh — select_publishable
    and revalidate_published_floor (wired together by apply_two_tier_publication) must demote it;
    a held twin keeps its existing exemption untouched."""

    def test_a_non_held_title_scoreable_today_but_not_tomorrow_is_demoted(self):
        movie = _borderline_cinema_estimate(1232003, GENERATED, inside_by_days=1)
        today_ids = pp.scoreable_ids([dict(movie)], floor=pp.WM_PUBLISH_FLOOR, today=GENERATED)
        tomorrow_ids = pp.scoreable_ids([dict(movie)], floor=pp.WM_PUBLISH_FLOOR,
                                        today=GENERATED_PLUS_2)
        self.assertIn(1232003, today_ids, "fixture must be scoreable today")
        self.assertNotIn(1232003, tomorrow_ids, "fixture must not be scoreable tomorrow")
        stable_ids = today_ids & tomorrow_ids

        candidates = {"1232003": movie}
        published, stats = pp.select_publishable(candidates, stable_ids,
                                                  previously_published_ids={1232003},
                                                  held_ids=set(), catalogue_target=10)
        self.assertNotIn(1232003, {m["tmdb_id"] for m in published})
        self.assertEqual(stats["demoted"], 1)

        survivors, dropped = pp.revalidate_published_floor([movie], stable_ids, held_ids=set())
        self.assertEqual(dropped, 1)
        self.assertNotIn(1232003, {m["tmdb_id"] for m in survivors})

    def test_the_same_title_held_keeps_its_existing_exemption(self):
        movie = _borderline_cinema_estimate(1232004, GENERATED, inside_by_days=1)
        today_ids = pp.scoreable_ids([dict(movie)], floor=pp.WM_PUBLISH_FLOOR, today=GENERATED)
        tomorrow_ids = pp.scoreable_ids([dict(movie)], floor=pp.WM_PUBLISH_FLOOR,
                                        today=GENERATED_PLUS_2)
        stable_ids = today_ids & tomorrow_ids

        candidates = {"1232004": movie}
        published, stats = pp.select_publishable(candidates, stable_ids,
                                                  previously_published_ids={1232004},
                                                  held_ids={"1232004"}, catalogue_target=10)
        self.assertIn(1232004, {m["tmdb_id"] for m in published})
        self.assertEqual(stats["exempt"], 1)

        survivors, dropped = pp.revalidate_published_floor([movie], stable_ids, held_ids={"1232004"})
        self.assertEqual(dropped, 0)
        self.assertIn(1232004, {m["tmdb_id"] for m in survivors})


if __name__ == "__main__":
    unittest.main()
