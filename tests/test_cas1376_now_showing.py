"""CAS-1376 — the AU chains' own Now Showing lists, not only the CINEMA_RUN_DAYS guess, decide
whether a film is still genuinely on a screen. The Odyssey was still on Hoyts' own list 110 days
after it opened; CINEMA_RUN_DAYS (90) had already taken it out of in_cinema.

Every test here mocks the network (fetch_hoyts_now_showing/fetch_event_now_showing are patched
directly, or get_text/get_json are patched to read saved fixtures) and writes no real state file.

Run: python -m unittest tests.test_cas1376_now_showing
"""
import datetime
import os
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _film(tmdb_id=1, title="Test Film", cinema_date="2026-07-16", status=None, **kw):
    m = {"tmdb_id": tmdb_id, "title": title, "cinema_date": cinema_date,
         "offers": [], "status": status or ["released"],
         "availability_confidence": "estimated"}
    m.update(kw)
    return m


class TitleNormalisation(unittest.TestCase):
    def test_case_and_punctuation_are_folded(self):
        self.assertEqual(pp.normalize_cinema_title("The Odyssey"),
                          pp.normalize_cinema_title("THE ODYSSEY!"))

    def test_language_subtitle_suffix_is_stripped(self):
        self.assertEqual(pp.normalize_cinema_title("Ramayana: Rise Of A Legend (Hindi, Eng Sub)"),
                          pp.normalize_cinema_title("Ramayana Rise Of A Legend"))

    def test_different_titles_stay_different(self):
        self.assertNotEqual(pp.normalize_cinema_title("The Odyssey"),
                             pp.normalize_cinema_title("Whalefall"))

    def test_none_title_does_not_raise(self):
        self.assertEqual(pp.normalize_cinema_title(None), "")


class ChainDateParsing(unittest.TestCase):
    def test_long_month_name(self):
        self.assertEqual(pp._parse_chain_date("16 July 2026"), "2026-07-16")

    def test_abbreviated_month_name(self):
        self.assertEqual(pp._parse_chain_date("15 Oct 2026"), "2026-10-15")

    def test_unparseable_text_returns_none(self):
        self.assertIsNone(pp._parse_chain_date("Coming soon"))


class HoytsFetchParsesSavedFixture(unittest.TestCase):
    """No network: get_text is patched to return a saved real page."""

    def test_the_odyssey_is_parsed_with_its_release_date(self):
        with open(os.path.join(FIXTURES, "cas1376_hoyts_now_showing.html"), encoding="utf-8") as f:
            page = f.read()
        with mock.patch.object(pp, "get_text", lambda *a, **kw: page):
            films = pp.fetch_hoyts_now_showing()
        self.assertGreaterEqual(len(films), 10)
        odyssey = next(f for f in films if f["title"] == "The Odyssey")
        self.assertEqual(odyssey["release_date"], "2026-07-16")

    def test_a_dubbed_title_is_still_captured_with_its_qualifier_intact(self):
        # normalize_cinema_title is what strips the qualifier, not the fetcher — the fetcher must
        # hand back the raw chain title untouched.
        with open(os.path.join(FIXTURES, "cas1376_hoyts_now_showing.html"), encoding="utf-8") as f:
            page = f.read()
        with mock.patch.object(pp, "get_text", lambda *a, **kw: page):
            films = pp.fetch_hoyts_now_showing()
        titles = [f["title"] for f in films]
        self.assertTrue(any("Eng Sub" in t for t in titles))


class EventFetchParsesSavedFixture(unittest.TestCase):
    """No network: get_json is patched to return a saved real response."""

    def test_the_odyssey_is_parsed_with_its_release_date(self):
        import json
        with open(os.path.join(FIXTURES, "cas1376_event_now_showing.json"), encoding="utf-8") as f:
            data = json.load(f)
        with mock.patch.object(pp, "get_json", lambda *a, **kw: data):
            films = pp.fetch_event_now_showing()
        self.assertGreaterEqual(len(films), 10)
        odyssey = next(f for f in films if f["title"] == "The Odyssey")
        self.assertEqual(odyssey["release_date"], "2026-07-16")


def _run_update(records, hoyts=None, event=None, today=datetime.date(2026, 11, 4), state_path=None):
    """Runs update_now_showing with both chain fetchers replaced by fixed return values (or an
    exception when a fetcher is given as an Exception instance), against a throwaway state file."""
    def _fetcher(result):
        def fn():
            if isinstance(result, Exception):
                raise result
            return result
        return fn

    chains = {}
    if hoyts is not None:
        chains["hoyts"] = _fetcher(hoyts)
    if event is not None:
        chains["event"] = _fetcher(event)
    with mock.patch.object(pp, "CINEMA_CHAIN_FETCHERS", chains), \
         mock.patch.object(pp, "CINEMA_CHAINS_STATE_FILE", state_path):
        return pp.update_now_showing(records, today)


class MatchingSetsOnScreen(unittest.TestCase):
    """AC1 — a matched film is on_screen with the matching chain in on_screen_src, and its status
    carries in_cinema, however long ago it opened, exactly as derive_status now applies CAS-1376."""

    def test_title_matched_within_a_year_of_cinema_date_is_marked_on_screen(self):
        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, "cinema_chains_state.json")
            records = [_film(tmdb_id=1368337, title="The Odyssey", cinema_date="2026-07-16")]
            hoyts_films = ([{"title": "The Odyssey", "release_date": "2026-07-16"}]
                           + [{"title": f"Filler {i}", "release_date": None} for i in range(10)])
            report = _run_update(records, hoyts=hoyts_films, event=[], state_path=state_path)
        m = records[0]
        self.assertTrue(m["on_screen"])
        self.assertEqual(m["on_screen_src"], ["hoyts"])
        self.assertEqual(m["on_screen_checked"], "2026-11-04")
        self.assertIn("in_cinema", m["status"])
        self.assertEqual(report["hoyts"]["matched"], 1)

    def test_a_release_date_more_than_a_year_off_does_not_match(self):
        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, "cinema_chains_state.json")
            records = [_film(tmdb_id=2, title="Remake", cinema_date="2020-01-01")]
            hoyts_films = ([{"title": "Remake", "release_date": "2026-07-16"}]
                           + [{"title": f"Filler {i}", "release_date": None} for i in range(10)])
            report = _run_update(records, hoyts=hoyts_films, event=[], state_path=state_path)
        self.assertNotIn("on_screen", records[0])
        self.assertIn("Remake", report["hoyts"]["unmatched_titles"])

    def test_a_film_no_longer_on_any_usable_chains_list_is_cleared(self):
        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, "cinema_chains_state.json")
            records = [_film(tmdb_id=3, title="Old News", cinema_date="2026-01-01",
                              on_screen=True, on_screen_src=["hoyts"], on_screen_checked="2026-11-03",
                              status=["in_cinema"], availability_confidence="confirmed")]
            hoyts_films = [{"title": f"Filler {i}", "release_date": None} for i in range(10)]
            _run_update(records, hoyts=hoyts_films, event=[], state_path=state_path)
        self.assertNotIn("on_screen", records[0])
        self.assertNotIn("on_screen_src", records[0])


class FewFilmsGuard(unittest.TestCase):
    """AC4 — a chain returning fewer than NOW_SHOWING_MIN_FILMS titles is ignored for this run."""

    def test_chain_under_the_floor_is_ignored_and_never_matched(self):
        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, "cinema_chains_state.json")
            records = [_film(tmdb_id=1, title="Sparse Chain Film", cinema_date="2026-07-16")]
            hoyts_films = [{"title": "Sparse Chain Film", "release_date": "2026-07-16"}]  # just 1
            report = _run_update(records, hoyts=hoyts_films, event=[], state_path=state_path)
        self.assertTrue(report["hoyts"]["ignored"])
        self.assertEqual(report["hoyts"]["matched"], 0)
        self.assertNotIn("on_screen", records[0])

    def test_a_fetch_exception_is_reported_as_ignored_not_raised(self):
        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, "cinema_chains_state.json")
            records = [_film(tmdb_id=1, title="Whatever", cinema_date="2026-07-16")]
            report = _run_update(records, hoyts=RuntimeError("boom"), event=[], state_path=state_path)
        self.assertTrue(report["hoyts"]["ignored"])
        self.assertEqual(report["hoyts"]["fetched"], 0)


class AllChainsFailedFallback(unittest.TestCase):
    """AC5 — every chain failing must never mark the whole catalogue off screen; on_screen is held
    for NOW_SHOWING_ALL_FAILED_GRACE_DAYS runs, then cleared catalogue-wide."""

    def test_on_screen_survives_the_grace_period(self):
        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, "cinema_chains_state.json")
            records = [_film(tmdb_id=1, title="Holdover", on_screen=True, on_screen_src=["hoyts"],
                              on_screen_checked="2026-11-01", status=["in_cinema"],
                              availability_confidence="confirmed")]
            for day in range(pp.NOW_SHOWING_ALL_FAILED_GRACE_DAYS):
                _run_update(records, hoyts=RuntimeError("down"), event=RuntimeError("down"),
                            today=datetime.date(2026, 11, 2 + day), state_path=state_path)
                self.assertTrue(records[0].get("on_screen"), f"cleared too early on day {day}")

    def test_on_screen_is_cleared_once_the_grace_period_is_exceeded(self):
        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, "cinema_chains_state.json")
            records = [_film(tmdb_id=1, title="Holdover", on_screen=True, on_screen_src=["hoyts"],
                              on_screen_checked="2026-11-01", status=["in_cinema"],
                              availability_confidence="confirmed")]
            for day in range(pp.NOW_SHOWING_ALL_FAILED_GRACE_DAYS + 1):
                _run_update(records, hoyts=RuntimeError("down"), event=RuntimeError("down"),
                            today=datetime.date(2026, 11, 2 + day), state_path=state_path)
            self.assertNotIn("on_screen", records[0])

    def test_a_single_working_chain_resets_the_failure_streak(self):
        with tempfile.TemporaryDirectory() as d:
            state_path = os.path.join(d, "cinema_chains_state.json")
            records = [_film(tmdb_id=1, title="Holdover", on_screen=True, on_screen_src=["hoyts"],
                              on_screen_checked="2026-11-01", status=["in_cinema"],
                              availability_confidence="confirmed")]
            _run_update(records, hoyts=RuntimeError("down"), event=RuntimeError("down"),
                        today=datetime.date(2026, 11, 2), state_path=state_path)
            working = [{"title": f"Filler {i}", "release_date": None} for i in range(10)]
            _run_update(records, hoyts=working, event=[], today=datetime.date(2026, 11, 3),
                        state_path=state_path)
            with mock.patch.object(pp, "CINEMA_CHAINS_STATE_FILE", state_path):
                self.assertEqual(pp._load_cinema_chains_state().get("consecutive_all_failed"), 0)


if __name__ == "__main__":
    unittest.main()
