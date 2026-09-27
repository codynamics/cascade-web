"""CAS-608 — "Upcoming" must not be where a released film with no AU offer goes to die.

_offerless_window (poc_pipeline.py) replaces the old "in_cinema if opened else upcoming" fallback
that derive_from_providers/derive_status fall back to when a title carries no usable offer: a title
past its cinema run with nothing to show for it is now `released`, not `upcoming`, so it drops off
the 7-day Watchmode ladder (_is_ladder_cohort) onto the 30-day one like any other released title.

AC5 requires app_template.html's own copy (offerlessWindow) to classify the same fixtures
identically — checked here via scripts/offerless_window_shim.mjs, the same node-shim pattern
scoreable_ids() already uses to ask the shipped engine a question from Python.
"""
import datetime
import json
import os
import subprocess
import unittest

import poc_pipeline as pp

_SHIM = os.path.join(os.path.dirname(__file__), "..", "scripts", "offerless_window_shim.mjs")


def _js_offerless_windows(fixtures):
    payload = json.dumps({"fixtures": fixtures})
    proc = subprocess.run(["node", _SHIM], input=payload, capture_output=True,
                          text=True, timeout=180, check=True)
    return json.loads(proc.stdout)["windows"]


class OfferlessWindowClassifiesByDateAlone(unittest.TestCase):
    today = datetime.date(2026, 9, 14)

    def test_no_cinema_date_known_is_upcoming(self):
        self.assertEqual(pp._offerless_window(None, self.today), "upcoming")

    def test_future_cinema_date_is_upcoming(self):
        not_yet = (self.today + datetime.timedelta(days=10)).isoformat()
        self.assertEqual(pp._offerless_window(not_yet, self.today), "upcoming")

    def test_opened_within_the_run_is_in_cinema(self):
        recent = (self.today - datetime.timedelta(days=10)).isoformat()
        self.assertEqual(pp._offerless_window(recent, self.today), "in_cinema")

    def test_opened_long_past_the_run_is_released_not_upcoming(self):
        long_ago = (self.today - datetime.timedelta(days=400)).isoformat()
        self.assertEqual(pp._offerless_window(long_ago, self.today), "released")

    def test_derive_from_providers_uses_the_same_classification(self):
        long_ago = (self.today - datetime.timedelta(days=400)).isoformat()
        windows = pp.derive_from_providers({"cinema_date": long_ago}, {}, self.today)
        self.assertEqual(windows, ["released"])

    def test_derive_status_uses_the_same_classification(self):
        long_ago = (self.today - datetime.timedelta(days=400)).isoformat()
        status = pp.derive_status({"cinema_date": long_ago}, [], self.today)
        self.assertEqual(status, ["released"])

    def test_no_cinema_date_but_an_old_year_is_released_not_upcoming(self):
        # CAS-1078: a back-catalogue title with no AU cinema_date at all and a release year already
        # behind us is an old title Cascade never got an AU date for, not a genuinely future one.
        self.assertEqual(pp._offerless_window(None, self.today, year=2018), "released")

    def test_no_cinema_date_and_no_year_is_still_upcoming(self):
        # `year` is optional and defaults to unknown — an unannounced title stays upcoming.
        self.assertEqual(pp._offerless_window(None, self.today, year=None), "upcoming")

    def test_no_cinema_date_and_a_year_not_yet_arrived_is_still_upcoming(self):
        self.assertEqual(pp._offerless_window(None, self.today, year=2027), "upcoming")

    def test_no_cinema_date_and_an_old_year_but_a_future_au_release_date_is_still_upcoming(self):
        future = (self.today + datetime.timedelta(days=30)).isoformat()
        self.assertEqual(
            pp._offerless_window(None, self.today, year=2018,
                                  release_dates=[{"region": "AU", "type": 4, "date": future}]),
            "upcoming")

    def test_derive_from_providers_reclassifies_an_old_undated_title(self):
        movie = {"cinema_date": None, "year": "2016", "release_dates": []}
        self.assertEqual(pp.derive_from_providers(movie, {}, self.today), ["released"])


class LadderCohortExcludesReleasedTitles(unittest.TestCase):
    """AC4: a fixture of 100 past-dated, offer-less films must put none of them on the 7-day ladder."""

    def test_a_hundred_past_dated_offerless_films_never_hit_the_ladder(self):
        today = datetime.date(2026, 9, 14)
        long_ago = (today - datetime.timedelta(days=400)).isoformat()
        movies = [{"tmdb_id": i, "status": pp.derive_from_providers({"cinema_date": long_ago}, {}, today)}
                  for i in range(100)]
        self.assertTrue(all(m["status"] == ["released"] for m in movies))
        self.assertEqual(sum(1 for m in movies if pp._is_ladder_cohort(m)), 0)

    def test_genuinely_upcoming_and_in_cinema_still_ride_the_ladder(self):
        today = datetime.date(2026, 9, 14)
        not_yet = (today + datetime.timedelta(days=10)).isoformat()
        recent = (today - datetime.timedelta(days=10)).isoformat()
        upcoming = {"status": pp.derive_from_providers({"cinema_date": not_yet}, {}, today)}
        in_cinema = {"status": pp.derive_from_providers({"cinema_date": recent}, {}, today)}
        self.assertTrue(pp._is_ladder_cohort(upcoming))
        self.assertTrue(pp._is_ladder_cohort(in_cinema))


class PythonAndAppTemplateAgree(unittest.TestCase):
    """CAS-608 AC5: poc_pipeline.py's _offerless_window and app_template.html's offerlessWindow
    must classify the same fixture identically."""

    def test_the_two_copies_classify_a_shared_fixture_table_identically(self):
        today = datetime.date(2026, 9, 14)
        today_iso = today.isoformat()
        cases = [
            None,
            (today + datetime.timedelta(days=10)).isoformat(),   # future -> upcoming
            (today - datetime.timedelta(days=1)).isoformat(),    # just opened -> in_cinema
            (today - datetime.timedelta(days=89)).isoformat(),   # last day of the run -> in_cinema
            (today - datetime.timedelta(days=91)).isoformat(),   # just past the run -> released
            (today - datetime.timedelta(days=400)).isoformat(),  # long released -> released
        ]
        python_windows = [pp._offerless_window(cd, today) for cd in cases]
        js_windows = _js_offerless_windows([{"cinema_date": cd, "today": today_iso} for cd in cases])
        self.assertEqual(python_windows, js_windows)


if __name__ == "__main__":
    unittest.main()
