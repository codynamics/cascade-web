"""CAS-1504: the alert pipeline split into find (03:00) / push (07:30) / email (17:00).

Every test runs with a fixed clock and injected senders - no network, no real push, no real email.
"""
import datetime as dt
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest import mock

import monitor.__main__ as monitor_main
from monitor.phases import EMAIL_LOOKBACK_H, PUSH_LOOKBACK_H, email_phase, push_copy_for, push_phase
from monitor.store import InMemoryStore

FIXTURES = "monitor/fixtures"
UTC = dt.timezone.utc
FOUND = dt.datetime(2026, 11, 21, 16, 0, tzinfo=UTC)   # the 03:00 Sydney (AEDT) run
# 07:30 AEDT on 22 Nov = 20:30 UTC on 21 Nov; 17:00 AEDT on 22 Nov = 06:00 UTC on 22 Nov.
PUSH_NOW = dt.datetime(2026, 11, 21, 20, 30, tzinfo=UTC)
EMAIL_NOW = dt.datetime(2026, 11, 22, 6, 0, tzinfo=UTC)


def _load(name):
    with open(f"{FIXTURES}/{name}", encoding="utf-8") as fh:
        return json.load(fh)


def _row(i, user, movie, title, read=False, pushed=False, emailed=False, found=FOUND):
    return {"id": f"n{i}", "user_id": user, "cascade_id": None, "movie_id": str(movie), "moment": "hits_stream",
            "cascade_name": "My Cascade", "title": title, "detail": {"services": ["Netflix"], "price": None},
            "found_at": found.isoformat(),
            "read_at": FOUND.isoformat() if read else None,
            "pushed_at": FOUND.isoformat() if pushed else None,
            "emailed_at": FOUND.isoformat() if emailed else None}


PREFS = {
    "u1": {"in_app": True, "email_on": True, "email_address": "u1@example.test", "excluded_moments": []},
    "u2": {"in_app": True, "email_on": True, "email_address": "u2@example.test", "excluded_moments": []},
}
TOKENS = [{"user_id": "u1", "device_token": "tok-1"}, {"user_id": "u2", "device_token": "tok-2"}]


def _store(rows):
    return InMemoryStore(notifications=rows, prefs=PREFS, push_tokens=TOKENS)


class FindPhase(unittest.TestCase):
    """AC1(a): the 03:00 phase writes ledger rows and sends no email and no push."""

    def _store(self):
        return InMemoryStore(cascades=_load("cascades.json"), notifications=_load("notifications.json"),
                             emails=_load("emails.json"), prefs=_load("prefs.json"),
                             watches=_load("watches.json"),
                             push_tokens=[{"user_id": "user-A", "device_token": "tok-A"}])

    def _run(self, store):
        argv = ["--phase", "find", "--today", f"{FIXTURES}/today.json",
                "--yesterday", f"{FIXTURES}/yesterday.json", "--date", "2026-07-16"]
        buf = io.StringIO()
        with mock.patch.object(monitor_main, "_build_store", return_value=(store, "fixtures")), \
             mock.patch("monitor.__main__.send_via_resend") as email, \
             mock.patch("monitor.__main__.send_via_apns") as push, \
             redirect_stdout(buf):
            rc = monitor_main.main(argv)
        self.assertEqual(rc, 0)
        return email, push, buf.getvalue()

    def test_writes_ledger_rows_and_sends_nothing(self):
        store = self._store()
        before = len(store._notifications)
        email, push, out = self._run(store)
        email.assert_not_called()
        push.assert_not_called()
        new = store._notifications[before:]
        self.assertGreater(len(new), 0, out)
        for row in new:
            self.assertTrue(row.get("found_at"))
            self.assertIsNone(row.get("emailed_at"))
            self.assertIsNone(row.get("pushed_at"))
            self.assertIn("detail", row)
        self.assertIn("find phase: recorded", out)

    def test_rerunning_find_never_rewrites_a_recorded_alert_and_sends_nothing(self):
        store = self._store()
        self._run(store)
        keys = lambda: [(n.get("user_id"), n.get("cascade_id"), n.get("movie_id"), n.get("moment"))
                        for n in store._notifications]
        first = keys()
        email, push, _ = self._run(store)
        second = keys()
        self.assertEqual(second[:len(first)], first)           # nothing already recorded is touched
        self.assertEqual(len(second), len(set(second)))        # and no (user, agent, film, moment) twice
        email.assert_not_called()
        push.assert_not_called()


class PushPhase(unittest.TestCase):
    """AC1(b): exactly one push to a member with unread rows from that night, none to a member whose
    rows are all read; AC1(d): a re-run sends nothing twice."""

    def setUp(self):
        self.store = _store([
            _row(1, "u1", 101, "Alpha"), _row(2, "u1", 102, "Beta"), _row(3, "u1", 103, "Gamma"),
            _row(4, "u2", 201, "Delta", read=True), _row(5, "u2", 202, "Epsilon", read=True),
        ])
        self.send = mock.Mock(return_value=True)

    def _run(self):
        with redirect_stdout(io.StringIO()):
            return push_phase(self.store, PUSH_NOW, send=self.send)

    def test_one_push_to_the_member_with_unread_rows_and_none_to_all_read(self):
        stats = self._run()
        self.assertEqual(self.send.call_count, 1)
        tok, title, body = self.send.call_args.args[:3]
        self.assertEqual(tok, "tok-1")
        self.assertEqual(title, "Cascade found 3 films for you")
        self.assertEqual(body, "Alpha, Beta and 1 more.")
        self.assertEqual(stats["delivered"], 1)

    def test_rerun_sends_nothing_twice(self):
        self._run()
        self.send.reset_mock()
        self._run()
        self.send.assert_not_called()
        stamped = {r["id"] for r in self.store._notifications if r.get("pushed_at")}
        self.assertTrue({"n1", "n2", "n3"} <= stamped)

    def test_a_failed_push_is_not_stamped_so_a_rerun_retries(self):
        self.send.return_value = False
        self._run()
        self.assertFalse([r for r in self.store._notifications if r["id"] in ("n1", "n2", "n3") and r["pushed_at"]])
        self.send.return_value = True
        self.send.reset_mock()
        self._run()
        self.assertEqual(self.send.call_count, 1)

    def test_rows_read_after_the_find_run_are_not_pushed(self):
        for r in self.store._notifications:
            if r["user_id"] == "u1":
                r["read_at"] = FOUND.isoformat()
        self._run()
        self.send.assert_not_called()

    def test_rows_older_than_the_lookback_are_ignored(self):
        old = FOUND - dt.timedelta(hours=PUSH_LOOKBACK_H + 24)
        store = _store([_row(9, "u1", 109, "Old", found=old)])
        with redirect_stdout(io.StringIO()):
            push_phase(store, PUSH_NOW, send=self.send)
        self.send.assert_not_called()

    def test_copy_names_the_top_titles_truthfully(self):
        self.assertEqual(push_copy_for([_row(1, "u", 1, "Solo")]),
                         {"title": "Cascade found 1 film for you", "body": "Solo is in your Alerts."})
        two = push_copy_for([_row(1, "u", 1, "A"), _row(2, "u", 2, "B")])
        self.assertEqual(two["title"], "Cascade found 2 films for you")
        self.assertEqual(two["body"], "A and B.")


class EmailPhase(unittest.TestCase):
    """AC1(c): the 17:00 phase emails only unread rows and sends no email when all are read;
    AC1(d): a re-run sends nothing twice."""

    def setUp(self):
        self.store = _store([
            _row(1, "u1", 101, "Alpha"), _row(2, "u1", 102, "Seen Already", read=True),
            _row(3, "u2", 201, "Delta", read=True), _row(4, "u2", 202, "Epsilon", read=True),
        ])
        self.send = mock.Mock(return_value={})

    def _run(self):
        with redirect_stdout(io.StringIO()):
            return email_phase(self.store, [], EMAIL_NOW, send=self.send, scores_fn=lambda ids: {})

    def test_emails_only_the_unread_rows_and_nothing_to_an_all_read_member(self):
        stats = self._run()
        self.assertEqual(self.send.call_count, 1)
        to, subject, html, text = self.send.call_args.args[:4]
        self.assertEqual(to, "u1@example.test")
        self.assertIn("Alpha", html + text + subject)
        self.assertNotIn("Seen Already", html + text + subject)
        self.assertEqual(stats["sent"], 1)

    def test_no_email_at_all_when_every_alert_was_seen(self):
        for r in self.store._notifications:
            r["read_at"] = FOUND.isoformat()
        stats = self._run()
        self.send.assert_not_called()
        self.assertEqual(stats["attempted"], 0)

    def test_rerun_sends_nothing_twice(self):
        self._run()
        self.send.reset_mock()
        self._run()
        self.send.assert_not_called()
        self.assertTrue(next(r for r in self.store._notifications if r["id"] == "n1")["emailed_at"])
        # the row the member had already seen is never stamped - it was never emailed
        self.assertIsNone(next(r for r in self.store._notifications if r["id"] == "n2")["emailed_at"])

    def test_a_failed_send_is_not_stamped_so_a_rerun_retries(self):
        self.send.side_effect = RuntimeError("403")
        stats = self._run()
        self.assertEqual(stats["failed"], 1)
        self.assertIsNone(next(r for r in self.store._notifications if r["id"] == "n1")["emailed_at"])
        self.send.side_effect = None
        self.send.reset_mock()
        self._run()
        self.assertEqual(self.send.call_count, 1)

    def test_a_member_with_email_off_gets_none(self):
        self.store._prefs["u1"] = {**PREFS["u1"], "email_on": False}
        self._run()
        self.send.assert_not_called()

    def test_a_member_who_reads_between_runs_is_not_emailed(self):
        # unread at 07:30 (pushed), seen in the app before 17:00 -> no email
        for r in self.store._notifications:
            if r["id"] == "n1":
                r["pushed_at"] = FOUND.isoformat()
                r["read_at"] = (FOUND + dt.timedelta(hours=9)).isoformat()
        self._run()
        self.send.assert_not_called()

    def test_rows_older_than_the_lookback_are_ignored(self):
        old = EMAIL_NOW - dt.timedelta(hours=EMAIL_LOOKBACK_H + 24)
        self.store = _store([_row(9, "u1", 109, "Old", found=old)])
        self._run()
        self.send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
