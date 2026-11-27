"""CAS-1567: the day-7 recap email, "Your first week with <agent>" - who gets it, what it holds, that it merges
into a same-evening email, never carries a rating exercise or a push, and writes its ledger rows."""
import datetime as dt
import os
import re
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest import mock

from monitor import answer_links as al
from monitor.phases import email_phase, push_phase
from monitor.store import InMemoryStore
from monitor.tests.test_cas1537_answers import _columns

UTC = dt.timezone.utc
# 17:00 AEDT on Sun 22 Nov 2026 = 06:00 UTC. Sydney sign-up dates: day 7 = Sun 15 Nov, day 6 = 16th, day 8 = 14th.
EMAIL_NOW = dt.datetime(2026, 11, 22, 6, 0, tzinfo=UTC)
SIGNUP = {"day7": "2026-11-15T01:00:00+00:00", "day6": "2026-11-16T01:00:00+00:00",
          "day8": "2026-11-14T01:00:00+00:00"}
PREFS = {"u1": {"in_app": True, "email_on": True, "email_address": "u1@example.test", "excluded_moments": []}}
CASCADES = [{"id": "c1", "user_id": "u1", "name": "Max", "active": True, "criteria": {"v": 2}}]
SECRET = "test-secret"


def _movies(*ids):
    return [{"tmdb_id": i, "title": f"Film {i}", "status": ["in_cinema"]} for i in ids]


def _row(n, movie, found_day, answer=None, emailed=True, read=True, moment="hits_cinema"):
    """A ledger row found at 03:00 AEDT on Nov `found_day`."""
    found = dt.datetime(2026, 11, found_day, 16, 0, tzinfo=UTC) - dt.timedelta(days=1)
    return {"id": f"n{n}", "user_id": "u1", "cascade_id": "c1", "movie_id": str(movie), "moment": moment,
            "cascade_name": "Max", "title": f"Film {movie}", "detail": {}, "found_at": found.isoformat(),
            "read_at": found.isoformat() if read else None, "pushed_at": found.isoformat(),
            "emailed_at": found.isoformat() if emailed else None, "answer": answer, "batch_id": None}


def _store(signup="day7", rows=None, films=None):
    return InMemoryStore(cascades=CASCADES, notifications=rows if rows is not None else [], prefs=PREFS,
                         user_films=films or [], user_created={"u1": SIGNUP[signup]},
                         user_prefs={"u1": {"watch_windows": {"premium": {"list": True}}}},
                         push_tokens=[{"user_id": "u1", "device_token": "tok"}])


def _run(store, now=EMAIL_NOW):
    sent = []
    with redirect_stdout(StringIO()), mock.patch.dict(os.environ, {al.SECRET_ENV: SECRET}):
        stats = email_phase(store, _movies(*range(1, 12)), now,
                            send=lambda to, subject, html, text: sent.append((to, subject, html, text)),
                            scores_fn=lambda ids: {})
    return stats, sent


def _week_rows():
    """Seven films alerted over the first week, found on the 16th..21st (film i on day 15 + i, film 7 on the 15th+... see below)."""
    days = {1: 16, 2: 17, 3: 18, 4: 19, 5: 20, 6: 21, 7: 22}
    return [_row(i, i, d) for i, d in days.items()]


class WhoGetsIt(unittest.TestCase):
    def test_day_7_gets_exactly_one_recap(self):
        stats, sent = _run(_store(rows=_week_rows()))
        self.assertEqual((stats["sent"], len(sent)), (1, 1))
        self.assertEqual(sent[0][1], "Your first week with your agent")

    def test_day_6_and_day_8_get_none(self):
        for signup in ("day6", "day8"):
            with self.subTest(signup=signup):
                stats, sent = _run(_store(signup, rows=_week_rows()))
                self.assertEqual((stats["sent"], sent), (0, []))

    def test_a_second_run_the_same_day_sends_nothing_new(self):
        store = _store(rows=_week_rows())
        _run(store)
        stats, sent = _run(store)
        self.assertEqual((stats["sent"], sent), (0, []))

    def test_a_failed_send_is_retried_by_a_rerun_the_same_day_without_rewriting_rows(self):
        store = _store(rows=_week_rows())

        def boom(*a):
            raise RuntimeError("resend down")
        with redirect_stdout(StringIO()):
            email_phase(store, _movies(*range(1, 12)), EMAIL_NOW, send=boom, scores_fn=lambda ids: {})
        stats, sent = _run(store)
        self.assertEqual(len(sent), 1)
        self.assertEqual(len([r for r in store._notifications if r["moment"] == "recap"]), 5)

    def test_it_is_sent_even_when_nothing_new_was_found(self):
        stats, sent = _run(_store(rows=[]))
        self.assertEqual(len(sent), 1)
        self.assertIn("You're all caught up.", sent[0][3])


class Content(unittest.TestCase):
    def setUp(self):
        # 7 films alerted; film 1 answered on its row, film 2 holds a verdict -> 5 to decide.
        # Verdicts: enjoyed + wow are ratings; "notfor" (Never) is a decision but not a rating -> 2 ratings.
        rows = _week_rows()
        rows[0]["answer"] = "rent"
        self.store = _store(rows=rows, films=[{"user_id": "u1", "movie_id": "2", "status": "enjoyed"},
                                              {"user_id": "u1", "movie_id": "99", "status": "notfor"},
                                              {"user_id": "u1", "movie_id": "98", "status": "wow"}])
        _, sent = _run(self.store)
        self.to, self.subject, self.html, self.text = sent[0]

    def test_the_three_tiles(self):
        for n, label in ((7, "films alerted"), (5, "to decide"), (2, "ratings")):
            self.assertRegex(self.html, rf">{n}</div><div[^>]*>{label}<")
            self.assertIn(f"{n} {label}", self.text)

    def test_up_to_five_films_newest_first_with_see_all(self):
        listed = self.text.split("STILL TO DECIDE")[1].split("See all")[0]
        self.assertEqual(re.findall(r"Film \d+", listed), ["Film 7", "Film 6", "Film 5", "Film 4", "Film 3"])
        self.assertIn("See all 5 in Cascade", self.text)
        self.assertIn("See all 5 in Cascade", self.html)

    def test_no_rating_exercise_and_the_reminder_line_appears_once(self):
        for body in (self.html, self.text):
            self.assertNotIn("Rate what you", body)
            self.assertNotIn("Help Max learn", body)
        line = "The more you rate, the better your agent gets. After you watch a film, tap Watched and say how you felt."
        self.assertEqual(self.text.count(line), 1)
        self.assertEqual(self.html.count(line), 1)

    def test_film_buttons_equal_the_shared_app_label_definition(self):
        cols = _columns(self.html)
        self.assertEqual(len(cols), 2 * 5)
        for i in range(5):
            on, watched = cols[2 * i], cols[2 * i + 1]
            self.assertEqual(on[0], "WATCH ON")
            self.assertEqual([lbl for lbl, _ in on[1]], [d["label"] for d in al.WATCH_ON])   # premium tracked
            self.assertEqual(watched[0], "WATCHED")
            self.assertEqual([lbl for lbl, _ in watched[1]], [d["label"] for d in al.WATCHED])
            self.assertTrue(all(href for _, href in watched[1]))

    def test_the_standard_footer(self):
        self.assertIn("Change what I&rsquo;m told", self.html)
        self.assertIn("Change what I'm told", self.text)

    def test_all_caught_up_keeps_heading_tiles_and_reminder(self):
        rows = [dict(r, answer="stream") for r in _week_rows()]
        _, sent = _run(_store(rows=rows))
        html, text = sent[0][2], sent[0][3]
        self.assertIn("Your first week with your agent", html)
        self.assertRegex(html, r">7</div><div[^>]*>films alerted<")
        self.assertRegex(html, r">0</div><div[^>]*>to decide<")
        self.assertIn("You&rsquo;re all caught up.", html)
        self.assertNotIn("Still to decide", html)
        self.assertEqual(text.count("The more you rate"), 1)


class MergeAndLedger(unittest.TestCase):
    def _store_with_tonights_alert(self):
        rows = _week_rows()
        # tonight's own unseen alert, found at 03:00 AEDT on the 22nd: this member's daily email.
        rows.append(dict(_row(20, 11, 22, emailed=False, read=False), found_at="2026-11-21T16:00:00+00:00"))
        return _store(rows=rows)

    def test_merged_into_the_same_evenings_daily_email_never_a_second(self):
        stats, sent = _run(self._store_with_tonights_alert())
        self.assertEqual(len(sent), 1)
        html = sent[0][2]
        self.assertIn("Your first week with your agent", html)
        self.assertEqual(len(re.findall(r"<div[^>]*>Film 11", html)), 1)   # tonight's alert, once, in the same email
        self.assertEqual(sent[0][3].count("The more you rate"), 1)

    def test_each_named_film_has_a_ledger_row_with_the_recaps_batch_id(self):
        store = _store(rows=_week_rows())
        _, sent = _run(store)
        batches = store.fetch_alert_batches("u1")
        self.assertEqual([b["kind"] for b in batches], ["recap"])
        self.assertTrue(batches[0]["emailed_at"])
        bid = batches[0]["id"]
        named = set(re.findall(r"Film (\d+)", sent[0][3].split("STILL TO DECIDE")[1].split("See all")[0]))
        recap_rows = [r for r in store._notifications if r["moment"] == "recap"]
        self.assertEqual({r["movie_id"] for r in recap_rows}, named)
        self.assertEqual(len(named), 5)
        for r in recap_rows:
            self.assertEqual(r["batch_id"], bid)
            self.assertTrue(r["emailed_at"])
        self.assertIn(f"dl=alerts:batch:{bid}", sent[0][3])

    def test_merged_email_upgrades_the_daily_batch_to_recap(self):
        store = self._store_with_tonights_alert()
        _run(store)
        batches = store.fetch_alert_batches("u1")
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["kind"], "recap")

    def test_no_push_for_the_recap(self):
        store = _store(rows=_week_rows())
        _run(store)
        sent = []
        push_now = dt.datetime(2026, 11, 22, 20, 30, tzinfo=UTC)
        with redirect_stdout(StringIO()):
            stats = push_phase(store, push_now, send=lambda *a, **k: sent.append(a) or True)
        self.assertEqual((stats["attempted"], sent), (0, []))
        self.assertTrue(all(r["pushed_at"] for r in store._notifications if r["moment"] == "recap"))


if __name__ == "__main__":
    unittest.main()
