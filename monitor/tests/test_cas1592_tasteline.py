"""CAS-1592: the one-time "<agent> has learned something" line in an alert email that is going out anyway.
The adjustment itself is the app's (tests/js/cas1592-taste-line-shim.test.mjs asserts the shim against the engine);
here the shim is stood in by `_lines` so the email/once/failed-send rules are tested without a catalogue."""
import datetime as dt
import os
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest import mock

from monitor import answer_links as al
from monitor import tasteline
from monitor.phases import email_phase
from monitor.store import InMemoryStore

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 11, 22, 6, 0, tzinfo=UTC)
PREFS = {"u1": {"in_app": True, "email_on": True, "email_address": "u1@example.test", "excluded_moments": []}}
CASCADES = [{"id": "c1", "user_id": "u1", "name": "Max", "active": True, "criteria": {"v": 2}}]
APP_TEXT = "Sci-fi with Thriller is up 6 from your ratings"


def _rated(n):
    return [{"user_id": "u1", "movie_id": str(100 + i), "status": "liked"} for i in range(n)]


def _row(moment="hits_cinema"):
    return {"id": "n1", "user_id": "u1", "cascade_id": "c1", "movie_id": "1", "moment": moment,
            "cascade_name": "Max", "title": "Film 1", "detail": {}, "found_at": (NOW - dt.timedelta(hours=8)).isoformat(),
            "read_at": None, "pushed_at": None, "emailed_at": None, "answer": None, "batch_id": None}


def _store(films, rows):
    return InMemoryStore(cascades=CASCADES, notifications=rows, prefs=PREFS, user_films=films,
                         user_created={"u1": "2026-11-01T01:00:00+00:00"})


def _lines(text=APP_TEXT):
    return mock.patch.object(tasteline, "compute_lines",
                             lambda users: {u["userId"]: {"ratings": 10, "pts": 6, "text": text} for u in users})


def _run(store, fail=False):
    sent = []

    def send(to, subject, html, text):
        if fail:
            raise RuntimeError("resend down")
        sent.append((to, subject, html, text))
    with redirect_stdout(StringIO()), mock.patch.dict(os.environ, {al.SECRET_ENV: "s"}):
        email_phase(store, [{"tmdb_id": 1, "title": "Film 1", "status": ["in_cinema"]}], NOW, send=send,
                    scores_fn=lambda ids: {})
    return sent


class TasteLine(unittest.TestCase):
    def test_fewer_than_10_ratings_no_line_and_shim_not_asked(self):
        asked = []
        with mock.patch.object(tasteline, "compute_lines", lambda u: asked.append(u) or {}):
            sent = _run(_store(_rated(9), [_row()]))
        self.assertEqual(len(sent), 1)
        self.assertNotIn("has learned something", sent[0][2])
        self.assertEqual(asked, [])

    def test_app_says_no_line_for_10_ratings_under_5_points(self):
        with _lines(text=None):   # the app's own decision for a best adjustment of 4
            store = _store(_rated(10), [_row()])
            sent = _run(store)
        self.assertNotIn("has learned something", sent[0][2])
        self.assertFalse(store.fetch_email_line_sent("u1", tasteline.LINE_KEY))

    def test_line_reads_as_the_apps_text_with_see_taste_link(self):
        with _lines():
            sent = _run(_store(_rated(10), [_row()]))
        _, subject, html, text = sent[0]
        self.assertIn("Max has learned something", html)
        self.assertIn(APP_TEXT, html)
        self.assertIn("Max has learned something\n" + APP_TEXT, text)
        self.assertIn("?dl=taste&src=email&cmp=taste_line&cta=see_taste", html.replace("&amp;", "&"))
        self.assertNotIn("rate", html.lower().split("has learned something")[1].split("</table>")[0])

    def test_once_sent_never_repeated(self):
        store = _store(_rated(10), [_row()])
        with _lines():
            first = _run(store)
            store._notifications[0]["emailed_at"] = None   # the same film is unseen again: another email goes
            second = _run(store)
        self.assertIn("has learned something", first[0][2])
        self.assertEqual(len(second), 1)
        self.assertNotIn("has learned something", second[0][2])

    def test_failed_send_is_not_recorded_and_next_email_carries_it(self):
        store = _store(_rated(10), [_row()])
        with _lines():
            self.assertEqual(_run(store, fail=True), [])
            self.assertFalse(store.fetch_email_line_sent("u1", tasteline.LINE_KEY))
            retry = _run(store)
        self.assertIn("has learned something", retry[0][2])
        self.assertTrue(store.fetch_email_line_sent("u1", tasteline.LINE_KEY))

    def test_no_email_that_day_means_no_line_and_no_extra_email(self):
        store = _store(_rated(10), [])   # nothing unseen, no replies, no recap
        asked = []
        with mock.patch.object(tasteline, "compute_lines", lambda u: asked.append(u) or {}):
            sent = _run(store)
        self.assertEqual(sent, [])
        self.assertEqual(asked, [])
        self.assertFalse(store.fetch_email_line_sent("u1", tasteline.LINE_KEY))

    def test_catchup_email_does_not_carry_it(self):
        store = _store(_rated(10), [_row(moment="catchup")])
        with _lines():
            sent = _run(store)
        self.assertNotIn("has learned something", sent[0][2])
        self.assertFalse(store.fetch_email_line_sent("u1", tasteline.LINE_KEY))

    def test_unreadable_record_owes_nobody_the_line(self):
        store = _store(_rated(10), [_row()])
        with _lines(), mock.patch.object(InMemoryStore, "fetch_email_line_sent", side_effect=RuntimeError("no table")):
            sent = _run(store)
        self.assertEqual(len(sent), 1)
        self.assertNotIn("has learned something", sent[0][2])

    def test_shim_failure_never_costs_the_email(self):
        with mock.patch.object(tasteline, "compute_lines", side_effect=RuntimeError("node missing")):
            sent = _run(_store(_rated(10), [_row()]))
        self.assertEqual(len(sent), 1)
        self.assertNotIn("has learned something", sent[0][2])


if __name__ == "__main__":
    unittest.main()
