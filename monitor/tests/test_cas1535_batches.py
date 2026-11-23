"""CAS-1535: alert batches, the ledger-before-email rule, and the day +1 catch-up (server side).

Fixed clock / injected senders / a stubbed catch-up pick list - no network, no real push, no real email.
The Me-list ranking itself is covered by tests/js/cas1535-catchup-parity.test.mjs (the shim vs the app).
"""
import datetime as dt
import io
import json
import re
import unittest
from contextlib import redirect_stdout
from unittest import mock

import monitor.__main__ as monitor_main
from monitor.batches import batch_url, ensure_batch, sydney_date
from monitor.catchup import STAGES, catchup_hits, due_users, suppress_caught_up
from monitor.matching import Hit
from monitor.phases import email_phase, push_copy_for, push_phase
from monitor.store import InMemoryStore
from monitor.transitions import Transition

FIXTURES = "monitor/fixtures"
UTC = dt.timezone.utc
FOUND = dt.datetime(2026, 11, 21, 16, 0, tzinfo=UTC)       # 03:00 Sydney on the 22nd
PUSH_NOW = dt.datetime(2026, 11, 21, 20, 30, tzinfo=UTC)
EMAIL_NOW = dt.datetime(2026, 11, 22, 6, 0, tzinfo=UTC)
BATCH = "11111111-1111-4111-8111-111111111111"


def _load(name):
    with open(f"{FIXTURES}/{name}", encoding="utf-8") as fh:
        return json.load(fh)


def _row(i, user, movie, title, batch=None, **kw):
    r = {"id": f"n{i}", "user_id": user, "cascade_id": None, "movie_id": str(movie), "moment": "hits_stream",
         "cascade_name": "My Cascade", "title": title, "detail": {"services": ["Netflix"], "price": None},
         "found_at": FOUND.isoformat(), "read_at": None, "pushed_at": None, "emailed_at": None}
    if batch:
        r["batch_id"] = batch
    r.update(kw)
    return r


PREFS = {"u1": {"in_app": True, "email_on": True, "email_address": "u1@example.test", "excluded_moments": []}}
TOKENS = [{"user_id": "u1", "device_token": "tok-1"}]


def _store(rows, **kw):
    return InMemoryStore(notifications=rows, prefs=PREFS, push_tokens=TOKENS, **kw)


def _hrefs(html):
    return re.findall(r'href="([^"]+)"', html.replace("&amp;", "&"))


class FindBatches(unittest.TestCase):
    """AC1: a find run writes one batch per member per Sydney date and stamps its id on every row."""

    def _store(self, **kw):
        return InMemoryStore(cascades=_load("cascades.json"), notifications=_load("notifications.json"),
                             emails=_load("emails.json"), prefs=_load("prefs.json"),
                             watches=_load("watches.json"), **kw)

    def _run(self, store, phase="find"):
        argv = ["--phase", phase, "--today", f"{FIXTURES}/today.json",
                "--yesterday", f"{FIXTURES}/yesterday.json", "--date", "2026-07-16"]
        buf = io.StringIO()
        with mock.patch.object(monitor_main, "_build_store", return_value=(store, "fixtures")), \
             mock.patch("monitor.__main__.send_via_resend") as email, \
             mock.patch("monitor.__main__.send_via_apns") as push, \
             mock.patch("monitor.__main__.compute_scores", return_value={}), \
             redirect_stdout(buf):
            rc = monitor_main.main(argv)
        self.assertEqual(rc, 0, buf.getvalue())
        return email, push

    def test_one_batch_per_member_per_night_stamped_on_every_new_row(self):
        store = self._store()
        before = len(store._notifications)
        self._run(store)
        new = store._notifications[before:]
        self.assertGreater(len(new), 0)
        for row in new:
            self.assertTrue(row.get("batch_id"), row)
        by_user = {}
        for row in new:
            by_user.setdefault(row["user_id"], set()).add(row["batch_id"])
        for uid, ids in by_user.items():
            self.assertEqual(len(ids), 1, uid)
        batches = store._alert_batches
        self.assertEqual(len(batches), len(by_user))
        self.assertEqual(len({(b["user_id"], b["sydney_date"]) for b in batches}), len(batches))
        for b in batches:
            self.assertEqual(b["kind"], "daily")
            self.assertRegex(b["headline"], r"^.+ found \d+ films? for you$")

    def test_a_second_find_the_same_night_joins_the_same_batch(self):
        store = self._store()
        before = len(store._notifications)
        self._run(store)
        first = {b["user_id"]: b["id"] for b in store._alert_batches}
        # Drop one recorded row so the re-run has something to write again.
        victim = store._notifications.pop()
        self._run(store)
        self.assertEqual({b["user_id"]: b["id"] for b in store._alert_batches}, first)
        rewritten = [r for r in store._notifications[before:] if r["movie_id"] == victim["movie_id"]
                     and r["user_id"] == victim["user_id"]]
        self.assertTrue(rewritten)
        self.assertEqual(rewritten[-1]["batch_id"], first[victim["user_id"]])

    def test_ensure_batch_is_get_or_create_and_a_catchup_upgrades_a_daily_batch(self):
        store = InMemoryStore()
        a = ensure_batch(store, "u", "2026-11-22", "daily", "X found 1 film for you")
        b = ensure_batch(store, "u", "2026-11-22", "catchup")
        self.assertEqual(a["id"], b["id"])
        self.assertEqual(store.fetch_alert_batch("u", "2026-11-22")["kind"], "catchup")
        self.assertEqual(sydney_date(FOUND), "2026-11-22")


class PushCarriesTheBatch(unittest.TestCase):
    """AC3."""

    def test_payload_batch_equals_the_nights_batch(self):
        store = _store([_row(1, "u1", 101, "Alpha", BATCH), _row(2, "u1", 102, "Beta", BATCH)])
        send = mock.Mock(return_value=True)
        with redirect_stdout(io.StringIO()):
            push_phase(store, PUSH_NOW, send=send)
        payload = send.call_args.kwargs["payload"]
        self.assertEqual(payload["batch"], BATCH)
        self.assertEqual(payload["open"], "alerts")
        self.assertIn("src", payload)
        self.assertIn("cmp", payload)

    def test_a_legacy_row_with_no_batch_joins_one_before_the_push(self):
        store = _store([_row(1, "u1", 101, "Alpha")])
        send = mock.Mock(return_value=True)
        with redirect_stdout(io.StringIO()):
            push_phase(store, PUSH_NOW, send=send)
        bid = send.call_args.kwargs["payload"]["batch"]
        self.assertEqual(store._notifications[0]["batch_id"], bid)
        self.assertEqual(store.fetch_alert_batch("u1", "2026-11-22")["id"], bid)


class EmailLinksOpenTheBatch(unittest.TestCase):
    """AC2 and AC8 (second half)."""

    def _send(self, store, **kw):
        send = mock.Mock(return_value={})
        with redirect_stdout(io.StringIO()):
            email_phase(store, [], EMAIL_NOW, send=send, scores_fn=lambda ids: {}, **kw)
        return send

    def test_every_film_link_and_see_all_open_the_batch_and_keep_attribution(self):
        store = _store([_row(i, "u1", 100 + i, f"Film {i}", BATCH) for i in range(1, 4)])
        send = self._send(store)
        html = send.call_args.args[2]
        links = _hrefs(html)
        film_links = [h for h in links if "dl=alerts:batch:" in h]
        self.assertTrue(film_links)
        for mid in (101, 102, 103):
            self.assertTrue(any(f"dl=alerts:batch:{BATCH}&film={mid}&" in h for h in film_links), mid)
        self.assertTrue(any(h.endswith(f"?dl=alerts:batch:{BATCH}&src=email&cmp=unseen_alert&cta=see_all")
                            for h in film_links))
        for h in film_links:
            self.assertIn("src=email", h)
            self.assertIn("cmp=unseen_alert", h)
            self.assertIn("cta=", h)
        self.assertTrue(any("cta=answer_" in h for h in links))   # CAS-1537: the Watch On / Watched buttons
        self.assertIn(f"dl=alerts:batch:{BATCH}", send.call_args.args[3])   # the text part too

    def test_a_legacy_row_gets_its_batch_before_the_send(self):
        store = _store([_row(1, "u1", 101, "Alpha")])
        send = self._send(store)
        bid = store._notifications[0]["batch_id"]
        self.assertTrue(bid)
        self.assertIn(f"dl=alerts:batch:{bid}", send.call_args.args[2])

    def test_a_failed_emailed_at_stamp_still_leaves_the_batch_id_on_every_emailed_row(self):
        store = _store([_row(1, "u1", 101, "Alpha"), _row(2, "u1", 102, "Beta")])
        with mock.patch.object(store, "mark_notifications", side_effect=RuntimeError("db down")):
            send = self._send(store)
        send.assert_called_once()
        self.assertTrue(all(r.get("batch_id") for r in store._notifications))
        self.assertEqual(len({r["batch_id"] for r in store._notifications}), 1)
        self.assertIn(store._notifications[0]["batch_id"], send.call_args.args[2])

    def test_no_email_when_the_batch_cannot_be_written(self):
        store = _store([_row(1, "u1", 101, "Alpha")])
        with mock.patch.object(store, "insert_alert_batch", side_effect=RuntimeError("db down")):
            send = self._send(store)
        send.assert_not_called()
        self.assertIsNone(store._notifications[0]["emailed_at"])


class LedgerBeforeEmailInAllMode(unittest.TestCase):
    """AC8 (first half): the single-run `all` mode writes the rows first; a failed write sends no email."""

    def _run(self, store):
        argv = ["--phase", "all", "--today", f"{FIXTURES}/today.json",
                "--yesterday", f"{FIXTURES}/yesterday.json", "--date", "2026-07-16"]
        with mock.patch.object(monitor_main, "_build_store", return_value=(store, "fixtures")), \
             mock.patch("monitor.__main__.send_via_resend") as email, \
             mock.patch("monitor.__main__.send_via_apns"), \
             mock.patch("monitor.__main__.compute_scores", return_value={}), \
             redirect_stdout(io.StringIO()):
            monitor_main.main(argv)
        return email

    def _store(self):
        return InMemoryStore(cascades=_load("cascades.json"), notifications=_load("notifications.json"),
                             emails=_load("emails.json"), prefs=_load("prefs.json"), watches=_load("watches.json"))

    def test_rows_with_batch_ids_exist_for_everything_emailed(self):
        store = self._store()
        before = len(store._notifications)
        email = self._run(store)
        self.assertTrue(email.called)
        new = store._notifications[before:]
        self.assertTrue(new)
        self.assertTrue(all(r.get("batch_id") for r in new))
        emailed = [r for r in new if r.get("emailed_at")]
        self.assertTrue(emailed)       # stamped after the send, by id
        for call in email.call_args_list:
            self.assertIn("dl=alerts:batch:", call.args[2])

    def test_a_failed_ledger_insert_sends_that_member_no_email(self):
        store = self._store()
        with mock.patch.object(store, "insert_notifications", side_effect=RuntimeError("db down")):
            email = self._run(store)
        email.assert_not_called()


# --------------------------------------------------------------------------- catch-up ---------------

def _picks(_users):
    return {"user-A": {"cinema": ["5003"], "coming": [], "streaming": ["5002", "5001"]}}


class CatchUp(unittest.TestCase):
    NOW = dt.datetime.now(UTC)

    def _store(self, created_hours_ago=2, **kw):
        created = (self.NOW - dt.timedelta(hours=created_hours_ago)).isoformat()
        return InMemoryStore(cascades=_load("cascades.json"), notifications=_load("notifications.json"),
                             emails=_load("emails.json"), prefs=_load("prefs.json"),
                             watches=_load("watches.json"), user_created={"user-A": created}, **kw)

    def _run(self, store, picks=_picks, phase="find"):
        argv = ["--phase", phase, "--today", f"{FIXTURES}/today.json",
                "--yesterday", f"{FIXTURES}/yesterday.json", "--date", "2026-07-16"]
        with mock.patch.object(monitor_main, "_build_store", return_value=(store, "fixtures")), \
             mock.patch("monitor.__main__.send_via_resend"), mock.patch("monitor.__main__.send_via_apns"), \
             mock.patch("monitor.__main__.compute_scores", return_value={}), \
             mock.patch("monitor.catchup.compute_catchup_picks", side_effect=picks), \
             redirect_stdout(io.StringIO()):
            monitor_main.main(argv)

    def _catchup_rows(self, store):
        return [r for r in store._notifications if r.get("moment") == "catchup"]

    def test_a_new_member_gets_one_catchup_batch_with_a_row_per_film(self):
        store = self._store()
        self._run(store)
        rows = self._catchup_rows(store)
        self.assertEqual([(r["movie_id"], r["detail"]["stage"]) for r in rows],
                         [("5003", "cinema"), ("5002", "streaming"), ("5001", "streaming")])
        batch = store.fetch_alert_batch("user-A", sydney_date(self.NOW))
        self.assertEqual(batch["kind"], "catchup")
        self.assertTrue(all(r["batch_id"] == batch["id"] for r in rows))
        # tonight's ordinary alerts for the member join the same batch
        mine = [r for r in store._notifications if r["user_id"] == "user-A" and r.get("found_at")
                and r.get("batch_id")]
        self.assertEqual({r["batch_id"] for r in mine}, {batch["id"]})

    def test_catchup_runs_once_only(self):
        store = self._store()
        self._run(store)
        n = len(self._catchup_rows(store))
        self.assertGreater(n, 0)
        self._run(store)                                   # a second find the same night
        self.assertEqual(len(self._catchup_rows(store)), n)
        # ... and a later night: the account is still inside the window, but already has its batch.
        store._alert_batches = [{**b, "sydney_date": "2020-01-01"} for b in store._alert_batches]
        self._run(store)
        self.assertEqual(len(self._catchup_rows(store)), n)
        self.assertEqual(len([b for b in store._alert_batches if b["kind"] == "catchup"]), 1)

    def test_an_account_older_than_24_hours_gets_none(self):
        store = self._store(created_hours_ago=30)
        self._run(store)
        self.assertEqual(self._catchup_rows(store), [])
        self.assertEqual(due_users(store, self.NOW, ["user-A"]), [])

    def test_empty_groups_are_omitted_and_an_all_empty_result_writes_nothing(self):
        hits = catchup_hits(["user-A"], _load("cascades.json"), {}, {}, {"5003": {"title": "T"}},
                            picks_fn=lambda users: {"user-A": {"cinema": ["5003"], "coming": [], "streaming": []}})
        self.assertEqual([h.transition.stage for h in hits["user-A"]], ["cinema"])
        none = catchup_hits(["user-A"], _load("cascades.json"), {}, {}, {},
                            picks_fn=lambda users: {"user-A": {"cinema": [], "coming": [], "streaming": []}})
        self.assertEqual(none, {})
        store = self._store()
        self._run(store, picks=lambda users: {"user-A": {"cinema": [], "coming": [], "streaming": []}})
        self.assertEqual(self._catchup_rows(store), [])
        self.assertFalse(store.has_catchup_batch("user-A"))     # nothing written, so still owed tomorrow

    def test_the_push_names_the_agent_and_the_top_two_films_in_catchup_order(self):
        rows = [_row(1, "u1", 3, "Streamer", moment="catchup", detail={"stage": "streaming"}),
                _row(2, "u1", 1, "Cinema One", moment="catchup", detail={"stage": "cinema"}),
                _row(3, "u1", 2, "Coming One", moment="catchup", detail={"stage": "coming"})]
        copy = push_copy_for(rows, "Max")
        self.assertEqual(copy["title"], "Max found 3 films for you")
        self.assertEqual(copy["body"], "Cinema One, Coming One and 1 more.")
        self.assertEqual(push_copy_for(rows[:2], "Max")["body"], "Cinema One and Streamer.")
        self.assertEqual(push_copy_for(rows[:1], "Cascade")["title"], "Cascade found 1 film for you")

    def test_the_catchup_email_has_the_groups_in_order_compact_cards_and_see_all_top_and_bottom(self):
        store = self._store()
        self._run(store)
        batch = store.fetch_alert_batch("user-A", sydney_date(self.NOW))
        today = {str(m["tmdb_id"]): m for m in monitor_main.load_catalogue_file(f"{FIXTURES}/today.json")}
        today["5003"] = {**today["5003"], "poster": "/p.jpg"}
        # an unread ordinary alert in the same batch follows as one more group
        store._notifications.append(_row(99, "user-A", 5004, "Weekend Past", batch["id"], cascade_id=None,
                                         moment="hits_cinema", found_at=FOUND.isoformat()))
        for r in store._notifications:
            if r["user_id"] == "user-A":
                r["found_at"] = EMAIL_NOW.isoformat()
                r["read_at"] = None
                r["emailed_at"] = None
        store._emails["user-A"] = "user-a@example.test"
        send = mock.Mock(return_value={})
        with redirect_stdout(io.StringIO()):
            email_phase(store, list(today.values()), EMAIL_NOW, send=send,
                        scores_fn=lambda ids: {i: 80 for i in ids}, target_user="user-A")
        to, subject, html, text = send.call_args.args[:4]
        self.assertRegex(subject, r"found \d+ films? for you$")
        order = [html.index(h) for h in ("In cinemas now", "On your streaming services", "Also found for you")]
        self.assertEqual(order, sorted(order))
        self.assertNotIn("Coming to cinemas", html)               # an empty group is left out
        see_all = f"dl=alerts:batch:{batch['id']}&src=email&cmp=catchup_alert&cta=see_all"
        self.assertGreaterEqual(html.replace("&amp;", "&").count(see_all), 2)
        self.assertLess(html.index("See all in Cascade"), html.index("In cinemas now"))
        self.assertGreater(html.rindex("See all in Cascade"), html.rindex("View in Cascade"))
        self.assertEqual(html.count("View in Cascade"), 4)
        for needle in ("Cinema Opener", "Stream Arrival", "Rent Riser", "Weekend Past", ">80<", "<img"):
            self.assertIn(needle, html)
        self.assertEqual(html.count("WATCH ON"), 4)               # CAS-1537: every compact card has the buttons

    def test_stages_are_the_three_groups_in_order(self):
        self.assertEqual([k for k, _ in STAGES], ["cinema", "coming", "streaming"])


class NeverReannouncedForTheSameStage(unittest.TestCase):
    """AC7."""

    def _hit(self, moment, movie="5003"):
        return Hit(user_id="u1", cascade_id="c1", cascade_name="Max",
                   transition=Transition(movie_id=movie, title="T", moment=moment))

    def test_in_cinemas_now_blocks_a_later_hits_cinema_but_not_a_later_hits_stream(self):
        keys = {("u1", "5003", "cinema")}
        by_user = {"u1": [self._hit("hits_cinema"), self._hit("hits_stream"), self._hit("hits_cinema", "9")]}
        dropped = suppress_caught_up(by_user, keys)
        self.assertEqual(dropped, 1)
        self.assertEqual([(h.transition.movie_id, h.transition.moment) for h in by_user["u1"]],
                         [("5003", "hits_stream"), ("9", "hits_cinema")])

    def test_coming_blocks_announced_and_opens_soon(self):
        by_user = {"u1": [self._hit("announced"), self._hit("opens_soon"), self._hit("hits_cinema")]}
        suppress_caught_up(by_user, {("u1", "5003", "coming")})
        self.assertEqual([h.transition.moment for h in by_user["u1"]], ["hits_cinema"])

    def test_streaming_blocks_hits_stream(self):
        by_user = {"u1": [self._hit("hits_stream")]}
        suppress_caught_up(by_user, {("u1", "5003", "streaming")})
        self.assertEqual(by_user["u1"], [])

    def test_the_store_reports_the_stages_it_already_announced(self):
        store = InMemoryStore(notifications=[_row(1, "u1", 5003, "T", moment="catchup",
                                                  detail={"stage": "cinema"}), _row(2, "u1", 7, "U")])
        self.assertEqual(store.fetch_catchup_stage_keys(), {("u1", "5003", "cinema")})

    def test_a_later_run_through_the_pipeline_drops_the_same_stage_but_not_a_later_one(self):
        # End to end on the fixtures: find which film+user gets a hits_cinema, record it as caught up for
        # the same stage, and run again on a fresh ledger.
        def run(extra_rows):
            store = InMemoryStore(cascades=_load("cascades.json"), notifications=_load("notifications.json") + extra_rows,
                                  emails=_load("emails.json"), prefs=_load("prefs.json"), watches=_load("watches.json"))
            argv = ["--phase", "find", "--today", f"{FIXTURES}/today.json",
                    "--yesterday", f"{FIXTURES}/yesterday.json", "--date", "2026-07-16"]
            with mock.patch.object(monitor_main, "_build_store", return_value=(store, "fixtures")), \
                 mock.patch("monitor.__main__.compute_scores", return_value={}), redirect_stdout(io.StringIO()):
                monitor_main.main(argv)
            return {(r["user_id"], r["movie_id"], r["moment"]) for r in store._notifications}

        baseline = run([])
        uid, mid = "user-B", "5002"
        self.assertIn((uid, mid, "hits_stream"), baseline, "the fixtures must produce this alert to bite")
        caught = _row(500, uid, mid, "Caught", moment="catchup", detail={"stage": "streaming"})
        again = run([caught])
        self.assertNotIn((uid, mid, "hits_stream"), again)          # same stage: never re-announced
        self.assertIn((uid, mid, "catchup"), again)
        # a DIFFERENT stage for the same film still alerts normally
        other = _row(501, uid, mid, "Caught", moment="catchup", detail={"stage": "cinema"})
        self.assertIn((uid, mid, "hits_stream"), run([other]))


if __name__ == "__main__":
    unittest.main()
