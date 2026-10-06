"""CAS-486/CAS-1203: the on-demand notification test harness.

Covers the things that actually make "intense test cycles" safe and possible:
  - target_user fails closed (no default that resolves to "everyone")
  - the fixture file's own id range / marker are enforced before anything is built from it
  - build_catalogues fires exactly the requested scenario's transition, nothing else
  - the cleanup DELETE is scoped strictly to the reserved fixture id range, never wider
  - CAS-1203: find_real_film() picks a real, admitted-and-placed film when one qualifies; never a
    film already carrying a ledger row, film_watch row, or verdict on the account; falls back
    (None) when nothing qualifies; build_real_catalogues() moves only the chosen film back one
    step, yielding exactly one transition.
  - CAS-1207: report_and_verify()'s real-film mode COUNTS this run's own row rather than deleting
    it (so it stays visible in the member's own Alerts); cleanup_stale_real_film() deletes an
    earlier run's leftover row instead, so a repeat run on the same film is not permanently
    suppressed by find_real_film()'s own ledger de-dupe.
"""
import datetime as _dt
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from monitor import compute_transitions
from monitor.__main__ import main
from monitor.notify_test import (DEFAULT_FIXTURES, FIXTURE_MARKER, arm_watch, build_catalogues,
                                  build_real_catalogues, cleanup_stale_real_film, find_real_film,
                                  load_fixture_films, report_and_verify, validate_target_user)
from monitor.store import FIXTURE_ID_MAX, FIXTURE_ID_MIN, InMemoryStore


class TargetUserFailsClosed(unittest.TestCase):
    def test_empty_is_refused(self):
        with self.assertRaises(SystemExit):
            validate_target_user("")

    def test_none_is_refused(self):
        with self.assertRaises(SystemExit):
            validate_target_user(None)

    def test_not_a_uuid_is_refused(self):
        with self.assertRaises(SystemExit):
            validate_target_user("everyone")

    def test_a_real_uuid_is_accepted(self):
        uid = "5ef56b23-cdec-5c0a-af6d-3bea00000000"
        self.assertEqual(validate_target_user(uid), uid)


class FixtureFileGuardrails(unittest.TestCase):
    def test_the_real_fixture_file_loads_and_covers_every_scenario(self):
        films = load_fixture_films(DEFAULT_FIXTURES)
        scenarios = {f["scenario"] for f in films}
        self.assertEqual(scenarios, {"announced", "hits_cinema", "hits_pvod", "hits_rent", "hits_stream"})
        for f in films:
            self.assertTrue(FIXTURE_ID_MIN <= f["tmdb_id"] <= FIXTURE_ID_MAX)
            self.assertEqual(f["director"], FIXTURE_MARKER)

    def _write(self, films):
        fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump({"films": films}, fh)
        fh.close()
        return fh.name

    def test_an_id_outside_the_reserved_range_is_refused(self):
        path = self._write([{"tmdb_id": 12345, "scenario": "announced", "director": FIXTURE_MARKER,
                              "today_status": ["upcoming"], "yesterday_present": False,
                              "yesterday_status": []}])
        try:
            with self.assertRaises(ValueError):
                load_fixture_films(path)
        finally:
            os.unlink(path)

    def test_a_missing_marker_is_refused(self):
        path = self._write([{"tmdb_id": 999000001, "scenario": "announced", "director": "Someone Real",
                              "today_status": ["upcoming"], "yesterday_present": False,
                              "yesterday_status": []}])
        try:
            with self.assertRaises(ValueError):
                load_fixture_films(path)
        finally:
            os.unlink(path)


class BuildCatalogues(unittest.TestCase):
    def setUp(self):
        self.films = load_fixture_films(DEFAULT_FIXTURES)

    def test_unknown_scenario_raises(self):
        with self.assertRaises(ValueError):
            build_catalogues(self.films, "not_a_real_scenario", "2026-08-13")

    def test_announced_film_is_absent_yesterday_present_today(self):
        yesterday, today = build_catalogues(self.films, "announced", "2026-08-13")
        self.assertNotIn(999000001, [m["tmdb_id"] for m in yesterday])
        self.assertIn(999000001, [m["tmdb_id"] for m in today])

    def test_exactly_the_chosen_scenario_transitions_and_nothing_else(self):
        for scenario in ("announced", "hits_cinema", "hits_pvod", "hits_rent", "hits_stream"):
            with self.subTest(scenario=scenario):
                yesterday, today = build_catalogues(self.films, scenario, "2026-08-13")
                transitions = compute_transitions(yesterday, today, __import__("datetime").date(2026, 8, 13))
                fired = {(t.movie_id, t.moment) for t in transitions
                         if int(t.movie_id) >= FIXTURE_ID_MIN}
                target = next(f for f in self.films if f["scenario"] == scenario)
                self.assertIn((str(target["tmdb_id"]), scenario), fired)
                # every other fixture film holds its own today-state on both days, so it must not
                # also produce a transition just from being present in this catalogue pair.
                others = {(t.movie_id, t.moment) for t in transitions
                          if int(t.movie_id) >= FIXTURE_ID_MIN and t.movie_id != str(target["tmdb_id"])}
                self.assertEqual(others, set())


class DeliverySourceProof(unittest.TestCase):
    """CAS-601 (reverses CAS-502 AC1, supersedes CAS-502 AC3): proves the rule end to end through
    the real `python -m monitor` pipeline, fed by the harness's own catalogue builder — not a
    synthetic shortcut. A WINDOW moment (hits_stream here) an agent's own alert_moments/criteria
    catches delivers with no Watch it tick required; a per-film Watch-it tick on the same
    film+window must still resolve to exactly one alert, not two (the agent/watch de-dupe)."""

    TARGET_USER = "5ef56b23-cdec-5c0a-af6d-3bea00000001"
    DATE = "2026-08-13"

    def setUp(self):
        films = load_fixture_films(DEFAULT_FIXTURES)
        self.yesterday, self.today = build_catalogues(films, "hits_stream", self.DATE)
        self.target = next(f for f in films if f["scenario"] == "hits_stream")
        # This cascade would have caught the fixture film under the pre-CAS-502 rule — present in
        # BOTH scenarios below, so the only variable between them is the Watch-it tick.
        # CAS-825: watchMarkers gives agentFloor() a usable 0-floor window — without one, admission
        # (now asked of the real engine) holds every film back regardless of anything else here.
        self.cascades = [{"id": "cascade-fixture", "user_id": self.TARGET_USER, "name": "Everything",
                           "active": True, "alert_moments": ["hits_stream"],
                           "criteria": {"watchMarkers": {"in_cinema": 0, "rent": 0, "stream": 0}}}]

    def _run(self, watches):
        with tempfile.TemporaryDirectory() as d:
            paths = {}
            for name, doc in (("yesterday", {"movies": self.yesterday}), ("today", {"movies": self.today}),
                               ("cascades", self.cascades), ("notifications", []), ("watches", watches)):
                paths[name] = os.path.join(d, f"{name}.json")
                with open(paths[name], "w", encoding="utf-8") as fh:
                    json.dump(doc, fh)
            argv = ["--today", paths["today"], "--yesterday", paths["yesterday"], "--date", self.DATE,
                    "--dry-run", "--cascades", paths["cascades"], "--notifications", paths["notifications"],
                    "--watches", paths["watches"], "--target-user", self.TARGET_USER]
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = main(argv)
            return rc, buf.getvalue()

    def test_an_agent_match_delivers_with_no_watch_it_tick(self):
        # CAS-841: the agent path now also needs the film's own placement — in production CAS-726
        # auto-places every admitted film, so this row stands in for that auto-placement, not a
        # manual tick; the point under test (the next one) is that a SEPARATE manual tick on the
        # same film+window does not turn this one alert into two.
        watches = [{"user_id": self.TARGET_USER, "movie_id": str(self.target["tmdb_id"]),
                    "windows": ["stream"]}]
        rc, out = self._run(watches=watches)
        self.assertEqual(rc, 0)
        self.assertIn("1 new alert(s)", out)
        self.assertNotIn("no new alerts for anyone", out)
        self.assertIn("digest preview", out)
        self.assertIn(self.target["title"], out)

    def test_the_same_film_with_a_watch_it_tick_delivers(self):
        # The agent already caught this film with no tick (previous test) — a Watch-it tick on the
        # SAME film+window must not turn that one alert into two (agent/watch de-dupe via cascade_hits).
        watches = [{"user_id": self.TARGET_USER, "movie_id": str(self.target["tmdb_id"]),
                    "windows": ["stream"]}]
        rc, out = self._run(watches)
        self.assertEqual(rc, 0)
        self.assertIn("1 new alert(s)", out)
        self.assertNotIn("no new alerts for anyone", out)
        self.assertIn("digest preview", out)
        self.assertIn(self.target["title"], out)

    def test_an_agent_with_no_alert_moments_stays_silent(self):
        # CAS-601 AC5: the gate still bites — same fixture film, same cascade, but alert_moments
        # emptied out (as if this moment's Alert toggle were off) must alert nobody.
        self.cascades = [{**self.cascades[0], "alert_moments": []}]
        rc, out = self._run(watches=[])
        self.assertEqual(rc, 0)
        self.assertIn("0 new alert(s)", out)
        self.assertIn("no new alerts for anyone", out)
        self.assertNotIn("digest preview", out)


class AnnouncedDeliveryProof(unittest.TestCase):
    """CAS-506 AC1/AC4: the `announced` moment is agent-level again — a film new to Cascade that
    matches an active agent's taste notifies with no Watch it tick set (AC1), and a Watch-it tick
    present on the same film does not turn that one notification into two (AC4)."""

    TARGET_USER = "5ef56b23-cdec-5c0a-af6d-3bea00000002"
    DATE = "2026-08-13"

    def setUp(self):
        films = load_fixture_films(DEFAULT_FIXTURES)
        self.yesterday, self.today = build_catalogues(films, "announced", self.DATE)
        self.target = next(f for f in films if f["scenario"] == "announced")
        # Matches the fixture film's own genre (Drama) so the agent's taste criteria really fires,
        # not just its alert_moments membership. CAS-825: watchMarkers as above.
        self.cascades = [{"id": "cascade-fixture", "user_id": self.TARGET_USER, "name": "Drama radar",
                           "active": True, "alert_moments": ["announced"],
                           "criteria": {"genre": ["Drama"],
                                       "watchMarkers": {"in_cinema": 0, "rent": 0, "stream": 0}}}]

    def _run(self, watches):
        with tempfile.TemporaryDirectory() as d:
            paths = {}
            for name, doc in (("yesterday", {"movies": self.yesterday}), ("today", {"movies": self.today}),
                               ("cascades", self.cascades), ("notifications", []), ("watches", watches)):
                paths[name] = os.path.join(d, f"{name}.json")
                with open(paths[name], "w", encoding="utf-8") as fh:
                    json.dump(doc, fh)
            argv = ["--today", paths["today"], "--yesterday", paths["yesterday"], "--date", self.DATE,
                    "--dry-run", "--cascades", paths["cascades"], "--notifications", paths["notifications"],
                    "--watches", paths["watches"], "--target-user", self.TARGET_USER]
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = main(argv)
            return rc, buf.getvalue()

    def test_a_newly_announced_film_delivers_with_no_watch_it_tick(self):
        rc, out = self._run(watches=[])
        self.assertEqual(rc, 0)
        self.assertIn("1 new alert(s)", out)
        self.assertNotIn("no new alerts for anyone", out)
        self.assertIn("digest preview", out)
        self.assertIn(self.target["title"], out)

    def test_a_watch_it_tick_on_the_same_film_still_yields_exactly_one_notification(self):
        # Ticked for a window the film hasn't reached yet — present on the film, but not what fires
        # this run. Only `announced` transitions, so this must still resolve to exactly one alert.
        watches = [{"user_id": self.TARGET_USER, "movie_id": str(self.target["tmdb_id"]),
                    "windows": ["in_cinema"]}]
        rc, out = self._run(watches)
        self.assertEqual(rc, 0)
        self.assertIn("1 new alert(s)", out)
        self.assertNotIn("no new alerts for anyone", out)


class CleanupScope(unittest.TestCase):
    def test_only_fixture_range_ids_are_removed(self):
        store = InMemoryStore(notifications=[
            {"cascade_id": "c1", "movie_id": "999000001", "moment": "announced"},
            {"cascade_id": "c2", "movie_id": "999000002", "moment": "hits_cinema"},
            {"cascade_id": "c3", "movie_id": "42", "moment": "hits_rent"},   # a real movie — must survive
        ])
        removed = store.delete_notifications_for_movie_ids(["999000001", "999000002", "42", "not-a-number"])
        self.assertEqual(removed, 2)
        remaining = {movie_id for (_cascade_id, movie_id, _moment) in store.fetch_notification_keys()}
        self.assertEqual(remaining, {"42"})

    def test_a_malicious_or_malformed_id_can_only_shrink_the_set_never_widen_it(self):
        store = InMemoryStore(notifications=[{"cascade_id": "c1", "movie_id": "42", "moment": "hits_rent"}])
        removed = store.delete_notifications_for_movie_ids(["42", "'; drop table notifications; --", None, ""])
        self.assertEqual(removed, 0)


class RealFilmCleanupScope(unittest.TestCase):
    """CAS-1203: delete_notifications_for_user_film() is the real-film counterpart to CleanupScope
    above — a real film's tmdb_id lives outside the reserved fixture range, so it needs its own
    precise (user_id, movie_id, moment, emailed_at >= since) scope rather than that range sweep."""

    def test_only_the_matching_user_movie_moment_at_or_after_since_is_removed(self):
        store = InMemoryStore(notifications=[
            {"user_id": "u1", "movie_id": "42", "moment": "hits_stream", "cascade_id": "c1",
             "emailed_at": "2026-01-02T00:00:01+00:00"},                                  # matches
            {"user_id": "u1", "movie_id": "42", "moment": "hits_stream", "cascade_id": "c1",
             "emailed_at": "2026-01-01T00:00:00+00:00"},                                  # too early
            {"user_id": "u1", "movie_id": "42", "moment": "hits_cinema", "cascade_id": "c1",
             "emailed_at": "2026-01-02T00:00:01+00:00"},                                  # wrong moment
            {"user_id": "u2", "movie_id": "42", "moment": "hits_stream", "cascade_id": "c9",
             "emailed_at": "2026-01-02T00:00:01+00:00"},                                  # wrong user
            {"user_id": "u1", "movie_id": "43", "moment": "hits_stream", "cascade_id": "c1",
             "emailed_at": "2026-01-02T00:00:01+00:00"},                                  # wrong movie
        ])
        removed = store.delete_notifications_for_user_film("u1", "42", "hits_stream",
                                                            "2026-01-02T00:00:00+00:00")
        self.assertEqual(removed, 1)
        self.assertEqual(len(store.fetch_notification_keys()), 4)


class GuaranteedMatchViaWatchIt(unittest.TestCase):
    """CAS-1052 AC1: a target user whose agents match none of the fixture films (here: no agents at
    all) still gets exactly one alert for the scenario via the temporary Watch-it row arm_watch()
    ticks — proven through the real `python -m monitor` pipeline, same as DeliverySourceProof above
    — and cleanup (delete_film_watch_for_movie_ids) removes the row afterwards."""

    TARGET_USER = "5ef56b23-cdec-5c0a-af6d-3bea00000004"
    DATE = "2026-08-13"
    SCENARIO = "hits_stream"

    def setUp(self):
        self.films = load_fixture_films(DEFAULT_FIXTURES)
        self.target = next(f for f in self.films if f["scenario"] == self.SCENARIO)
        self.yesterday, self.today = build_catalogues(self.films, self.SCENARIO, self.DATE)

    def test_no_agents_still_delivers_via_the_armed_watch_it_tick_then_cleanup_removes_it(self):
        store = InMemoryStore()   # zero cascades — nothing could match this user on taste
        arm_watch(store, self.TARGET_USER, self.films, self.SCENARIO)
        watches = store.fetch_film_watches()
        self.assertEqual(len(watches), 1)
        self.assertEqual(watches[0]["windows"], ["stream"])

        with tempfile.TemporaryDirectory() as d:
            paths = {}
            for name, doc in (("yesterday", {"movies": self.yesterday}), ("today", {"movies": self.today}),
                               ("cascades", []), ("notifications", []), ("watches", watches)):
                paths[name] = os.path.join(d, f"{name}.json")
                with open(paths[name], "w", encoding="utf-8") as fh:
                    json.dump(doc, fh)
            argv = ["--today", paths["today"], "--yesterday", paths["yesterday"], "--date", self.DATE,
                    "--dry-run", "--cascades", paths["cascades"], "--notifications", paths["notifications"],
                    "--watches", paths["watches"], "--target-user", self.TARGET_USER]
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = main(argv)
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("1 new alert(s)", out)
        self.assertNotIn("no new alerts for anyone", out)
        self.assertIn(self.target["title"], out)

        removed = store.delete_film_watch_for_movie_ids([self.target["tmdb_id"]])
        self.assertEqual(removed, 1)
        self.assertEqual(store.fetch_film_watches(), [])

    def test_announced_has_no_window_so_arm_watch_is_a_no_op(self):
        store = InMemoryStore()
        arm_watch(store, self.TARGET_USER, self.films, "announced")
        self.assertEqual(store.fetch_film_watches(), [])


class VerifyExitCode(unittest.TestCase):
    """CAS-1052 AC2: 0 alerts created for --target-user -> report_and_verify (the core of
    `notify_test.py --verify`) returns a non-zero returncode, so the harness exits non-zero rather
    than reporting green over silence."""

    TARGET_USER = "5ef56b23-cdec-5c0a-af6d-3bea00000005"

    def setUp(self):
        self.films = load_fixture_films(DEFAULT_FIXTURES)
        self.target = next(f for f in self.films if f["scenario"] == "hits_stream")

    def test_zero_alerts_fails_closed(self):
        store = InMemoryStore(notifications=[], watches=[], push_tokens=[])
        rc, message = report_and_verify(store, self.TARGET_USER, self.films, {}, {})
        self.assertEqual(rc, 1)
        self.assertIn("FAILED", message)
        self.assertIn("0 registered push token", message)

    def test_at_least_one_alert_recorded_passes_and_reports_push_tokens(self):
        store = InMemoryStore(
            notifications=[{"cascade_id": None, "user_id": self.TARGET_USER,
                            "movie_id": str(self.target["tmdb_id"]), "moment": "hits_stream"}],
            watches=[{"user_id": self.TARGET_USER, "movie_id": str(self.target["tmdb_id"]),
                      "windows": ["stream"]}],
            push_tokens=[{"user_id": self.TARGET_USER, "device_token": "abc"}],
        )
        rc, message = report_and_verify(store, self.TARGET_USER, self.films, {}, {})
        self.assertEqual(rc, 0)
        self.assertNotIn("FAILED", message)
        self.assertIn("1 registered push token", message)

    def test_verify_tears_down_the_temporary_watch_row_either_way(self):
        store = InMemoryStore(
            notifications=[],
            watches=[{"user_id": self.TARGET_USER, "movie_id": str(self.target["tmdb_id"]),
                      "windows": ["stream"]}],
        )
        report_and_verify(store, self.TARGET_USER, self.films, {}, {})
        self.assertEqual(store.fetch_film_watches(), [])

    def test_run_stats_deltas_isolate_this_runs_own_contribution(self):
        before = {"date": "2026-09-20", "email": {"attempted": 5, "delivered": 5, "errors": 0}}
        after = {"date": "2026-09-20", "email": {"attempted": 6, "delivered": 6, "errors": 0}}
        store = InMemoryStore(notifications=[{"cascade_id": None, "user_id": self.TARGET_USER,
                                              "movie_id": str(self.target["tmdb_id"]),
                                              "moment": "hits_stream"}])
        rc, message = report_and_verify(store, self.TARGET_USER, self.films, before, after)
        self.assertEqual(rc, 0)
        self.assertIn("email attempted 1/delivered 1", message)

    def test_a_stale_snapshot_from_a_different_date_is_not_subtracted(self):
        before = {"date": "2026-09-19", "email": {"attempted": 5, "delivered": 5, "errors": 0}}
        after = {"date": "2026-09-20", "email": {"attempted": 1, "delivered": 1, "errors": 0}}
        store = InMemoryStore(notifications=[{"cascade_id": None, "user_id": self.TARGET_USER,
                                              "movie_id": str(self.target["tmdb_id"]),
                                              "moment": "hits_stream"}])
        rc, message = report_and_verify(store, self.TARGET_USER, self.films, before, after)
        self.assertEqual(rc, 0)
        self.assertIn("email attempted 1/delivered 1", message)


class RealFilmSelection(unittest.TestCase):
    """CAS-1203: find_real_film() judged by the real admission/placement/matching code (same
    fixture shapes as monitor.tests.test_matching.AutoPlacementTests, which already proves this
    engine arithmetic) — never a second, hand-ported guess at what an agent would catch."""

    def _movie(self, tmdb_id=9001, status=("included_streaming",), poster="/x.jpg", **extra):
        m = {"tmdb_id": tmdb_id, "title": "Auto Placed Film", "genres": ["Drama"],
             "status": list(status), "cinema_date": "2026-01-01", "language": "en",
             "wm_critic_score": 70, "popularity": 50, "wm_popularity_percentile": 70,
             "wm_user_rating": 7.5, "offers": [{"service": "Netflix", "type": "sub"}],
             "poster": poster}
        m.update(extra)
        return m

    def _cascade(self, moments=("hits_stream",), stream_marker=50):
        # Only `stream` is usable — in_cinema/premium/rent are off (Never) — so an earned score
        # can only ever land on Stream, matching the AutoPlacementTests precedent this mirrors.
        markers = {"in_cinema": None, "premium": None, "rent": None, "stream": stream_marker}
        return {"id": "c1", "user_id": "u1", "name": "Everything", "active": True,
                "alert_moments": list(moments),
                "criteria": {"genre": ["Drama"], "imdb": 7.0, "watchMarkers": markers}}

    def _agent_films(self, movie_id="9001", score=80):
        return [{"user_id": "u1", "cascade_id": "c1", "movie_id": movie_id, "admission_score": score}]

    def test_a_real_film_is_chosen_when_one_qualifies(self):
        store = InMemoryStore(cascades=[self._cascade()], agent_films=self._agent_films())
        pick, reason = find_real_film(store, "u1", "hits_stream", [self._movie()])
        self.assertIsNone(reason)
        self.assertEqual(pick["film"]["tmdb_id"], 9001)
        self.assertEqual(pick["cascade_id"], "c1")
        self.assertEqual(pick["cascade_name"], "Everything")

    def test_a_film_with_an_existing_ledger_row_is_never_chosen(self):
        store = InMemoryStore(
            cascades=[self._cascade()], agent_films=self._agent_films(),
            notifications=[{"cascade_id": "c1", "user_id": "u1", "movie_id": "9001", "moment": "hits_stream"}])
        pick, reason = find_real_film(store, "u1", "hits_stream", [self._movie()])
        self.assertIsNone(pick)
        self.assertIn("no existing ledger/Watch-it/verdict row", reason)

    def test_a_film_with_an_existing_film_watch_row_is_never_chosen(self):
        store = InMemoryStore(
            cascades=[self._cascade()], agent_films=self._agent_films(),
            watches=[{"user_id": "u1", "movie_id": "9001", "windows": ["rent"], "sources": {}}])
        pick, reason = find_real_film(store, "u1", "hits_stream", [self._movie()])
        self.assertIsNone(pick)
        self.assertIn("no existing ledger/Watch-it/verdict row", reason)

    def test_a_film_with_an_existing_verdict_is_never_chosen(self):
        store = InMemoryStore(
            cascades=[self._cascade()], agent_films=self._agent_films(),
            user_films=[{"user_id": "u1", "movie_id": "9001", "status": "liked"}])
        pick, reason = find_real_film(store, "u1", "hits_stream", [self._movie()])
        self.assertIsNone(pick)
        self.assertIn("no existing ledger/Watch-it/verdict row", reason)

    def test_falls_back_when_no_agent_has_the_alert_on(self):
        store = InMemoryStore(cascades=[self._cascade(moments=())], agent_films=self._agent_films())
        pick, reason = find_real_film(store, "u1", "hits_stream", [self._movie()])
        self.assertIsNone(pick)
        self.assertIn("Alert on", reason)

    def test_falls_back_when_nothing_in_the_catalogue_holds_the_window(self):
        store = InMemoryStore(cascades=[self._cascade()], agent_films=self._agent_films())
        pick, reason = find_real_film(store, "u1", "hits_stream", [self._movie(status=("rental",))])
        self.assertIsNone(pick)
        self.assertIn("no unseen film holds", reason)

    def test_falls_back_when_candidates_exist_but_no_agent_admits_or_places_any(self):
        # Genre mismatch (Comedy, not Drama): the candidate holds the right window and has a
        # poster, but the agent's own criteria admits nothing.
        store = InMemoryStore(cascades=[self._cascade()], agent_films=self._agent_films())
        movie = self._movie(genres=["Comedy"])
        pick, reason = find_real_film(store, "u1", "hits_stream", [movie])
        self.assertIsNone(pick)
        self.assertIn("no agent", reason)

    def test_highest_scoring_qualifying_film_wins(self):
        low = self._movie(tmdb_id=9001, wm_critic_score=40, wm_user_rating=5.0, popularity=5,
                           wm_popularity_percentile=20)
        high = self._movie(tmdb_id=9002, wm_critic_score=95, wm_user_rating=9.0, popularity=500,
                            wm_popularity_percentile=99)
        agent_films = self._agent_films("9001") + self._agent_films("9002")
        store = InMemoryStore(cascades=[self._cascade()], agent_films=agent_films)
        pick, reason = find_real_film(store, "u1", "hits_stream", [low, high])
        self.assertIsNone(reason)
        self.assertEqual(pick["film"]["tmdb_id"], 9002,
            "the film with the clearly higher Cascade score must be the one chosen")


class RealFilmCataloguePair(unittest.TestCase):
    """CAS-1203: build_real_catalogues() moves ONLY the chosen film back one AVAILABILITY_TIERS
    step (or drops it for `announced`) — every other film is byte-identical on both days, and the
    pair yields exactly one transition of the right moment."""

    def _movie(self, tmdb_id, status):
        return {"tmdb_id": tmdb_id, "title": f"Film {tmdb_id}", "status": list(status),
                "offers": [], "genres": [], "cinema_date": None}

    def test_moving_the_chosen_film_back_one_step_yields_exactly_one_transition(self):
        today_movies = [self._movie(9001, ["included_streaming"]), self._movie(9002, ["rental"])]
        yesterday, today = build_real_catalogues(today_movies, today_movies[0], "hits_stream")
        self.assertEqual(today, today_movies, "today must be the real catalogue, unchanged")
        transitions = compute_transitions(yesterday, today, _dt.date(2026, 1, 2))
        fired = [(t.movie_id, t.moment) for t in transitions]
        self.assertEqual(fired, [("9001", "hits_stream")])

    def test_every_other_film_is_unchanged_in_both_catalogues(self):
        today_movies = [self._movie(9001, ["included_streaming"]), self._movie(9002, ["rental"])]
        yesterday, _ = build_real_catalogues(today_movies, today_movies[0], "hits_stream")
        other_yesterday = next(m for m in yesterday if str(m["tmdb_id"]) == "9002")
        other_today = next(m for m in today_movies if str(m["tmdb_id"]) == "9002")
        self.assertEqual(other_yesterday, other_today)

    def test_announced_removes_the_chosen_film_from_yesterday_entirely(self):
        today_movies = [self._movie(9010, ["upcoming"]), self._movie(9002, ["rental"])]
        yesterday, today = build_real_catalogues(today_movies, today_movies[0], "announced")
        self.assertNotIn(9010, [m["tmdb_id"] for m in yesterday])
        self.assertIn(9010, [m["tmdb_id"] for m in today])
        transitions = compute_transitions(yesterday, today, _dt.date(2026, 1, 2))
        fired = [(t.movie_id, t.moment) for t in transitions]
        self.assertEqual(fired, [("9010", "announced")])


class RealFilmNoTickArmed(unittest.TestCase):
    """CAS-1203 AC3: real-film mode never arms a temporary Watch-it tick — the agent catches the
    film by itself, so the email names the agent, not "Your picks"."""

    def test_find_real_film_never_writes_a_film_watch_row(self):
        movie = {"tmdb_id": 9001, "title": "Auto Placed Film", "genres": ["Drama"],
                 "status": ["included_streaming"], "cinema_date": "2026-01-01", "language": "en",
                 "wm_critic_score": 70, "popularity": 50, "wm_popularity_percentile": 70,
                 "wm_user_rating": 7.5, "offers": [{"service": "Netflix", "type": "sub"}],
                 "poster": "/x.jpg"}
        markers = {"in_cinema": None, "premium": None, "rent": None, "stream": 50}
        cascade = {"id": "c1", "user_id": "u1", "name": "Everything", "active": True,
                   "alert_moments": ["hits_stream"],
                   "criteria": {"genre": ["Drama"], "imdb": 7.0, "watchMarkers": markers}}
        agent_films = [{"user_id": "u1", "cascade_id": "c1", "movie_id": "9001", "admission_score": 80}]
        store = InMemoryStore(cascades=[cascade], agent_films=agent_films)
        pick, _ = find_real_film(store, "u1", "hits_stream", [movie])
        self.assertIsNotNone(pick)
        self.assertEqual(store.fetch_film_watches(), [],
            "find_real_film must only ever READ the store, never arm a Watch-it tick")


class RealFilmVerifyCounts(unittest.TestCase):
    """CAS-1207: report_and_verify()'s real-film mode COUNTS the row this run itself created —
    exact (user, movie, moment) match, and only at/after the run's own `armed_at` — makes no
    delete call, and never touches film_watch or user_films. (Supersedes CAS-1203's delete-based
    behaviour: deleting the row made it vanish from the member's own Alerts seconds after
    delivery — CAS-1207's observed bug.)"""

    REAL_FILM = {"tmdb_id": "9001", "title": "Auto Placed Film", "moment": "hits_stream",
                 "cascade_name": "Everything", "armed_at": "2026-01-02T00:00:00+00:00"}

    def test_counts_only_this_runs_own_row_and_deletes_nothing(self):
        # Each row below carries a distinct (cascade_id, movie_id, moment) key, since
        # fetch_notification_keys() returns a de-duplicated SET of those keys — this lets its
        # length stand in for "how many rows survive" without a same-key row masking a deletion.
        store = InMemoryStore(notifications=[
            {"user_id": "u1", "movie_id": "9001", "moment": "hits_stream", "cascade_id": "c1",
             "emailed_at": "2026-01-02T00:00:01+00:00"},                                         # this run
            {"user_id": "u1", "movie_id": "9001", "moment": "hits_stream", "cascade_id": "c2",
             "emailed_at": "2026-01-01T00:00:00+00:00"},                                         # earlier/real
            {"user_id": "u2", "movie_id": "9001", "moment": "hits_stream", "cascade_id": "c9",
             "emailed_at": "2026-01-02T00:00:01+00:00"},                                         # other user
            {"user_id": "u1", "movie_id": "9001", "moment": "hits_cinema", "cascade_id": "c1",
             "emailed_at": "2026-01-02T00:00:01+00:00"},                                         # other moment
        ])
        rc, message = report_and_verify(store, "u1", [], {}, {}, real_film=self.REAL_FILM)
        self.assertEqual(rc, 0)
        self.assertIn("in-app rows written 1", message)
        # No delete call: all 4 rows, including "this run"'s own, are still there.
        self.assertEqual(len(store.fetch_notification_keys()), 4)

    def test_names_the_film_and_agent_in_real_film_mode(self):
        store = InMemoryStore(notifications=[
            {"user_id": "u1", "movie_id": "9001", "moment": "hits_stream", "cascade_id": "c1",
             "emailed_at": "2026-01-02T00:00:01+00:00"}])
        rc, message = report_and_verify(store, "u1", [], {}, {}, real_film=self.REAL_FILM)
        self.assertEqual(rc, 0)
        self.assertIn("Auto Placed Film", message)
        self.assertIn("Everything", message)
        self.assertNotIn("fixture", message)

    def test_fixture_mode_default_still_says_fixture(self):
        store = InMemoryStore()
        _rc, message = report_and_verify(store, "u1", [], {}, {})
        self.assertIn("fixture", message)

    def test_real_film_mode_never_touches_film_watch_or_user_films(self):
        store = InMemoryStore(
            notifications=[{"user_id": "u1", "movie_id": "9001", "moment": "hits_stream",
                           "cascade_id": "c1", "emailed_at": "2026-01-02T00:00:01+00:00"}],
            watches=[{"user_id": "u1", "movie_id": "42", "windows": ["rent"], "sources": {}}],
            user_films=[{"user_id": "u1", "movie_id": "7", "status": "liked"}],
        )
        report_and_verify(store, "u1", [], {}, {}, real_film=self.REAL_FILM)
        self.assertEqual(store.fetch_film_watches(),
                         [{"user_id": "u1", "movie_id": "42", "windows": ["rent"], "sources": {}}])
        self.assertEqual(store.fetch_user_films(), [{"user_id": "u1", "movie_id": "7", "status": "liked"}])

    def test_zero_matching_rows_fails_closed_in_real_film_mode_too(self):
        store = InMemoryStore(notifications=[])
        rc, message = report_and_verify(store, "u1", [], {}, {}, real_film=self.REAL_FILM)
        self.assertEqual(rc, 1)
        self.assertIn("FAILED", message)


class CleanupStaleRealFilm(unittest.TestCase):
    """CAS-1207 AC2: since report_and_verify() no longer deletes a real-film row (previous test
    class), an earlier run's leftover row for the same (user, film, moment) would otherwise block
    find_real_film() from ever re-choosing that film — cleanup_stale_real_film() deletes it
    instead, regardless of its age, and is a no-op under --no-cleanup or with no stale state."""

    STALE = {"tmdb_id": "9001", "title": "Auto Placed Film", "moment": "hits_stream",
              "cascade_name": "Everything", "armed_at": "2026-01-02T00:00:00+00:00"}

    def test_deletes_an_earlier_row_for_the_same_user_film_and_moment_whatever_its_age(self):
        store = InMemoryStore(notifications=[
            {"user_id": "u1", "movie_id": "9001", "moment": "hits_stream", "cascade_id": "c1",
             "emailed_at": "2020-01-01T00:00:00+00:00"},   # years old — must still go
            {"user_id": "u1", "movie_id": "9001", "moment": "hits_cinema", "cascade_id": "c1",
             "emailed_at": "2026-01-02T00:00:01+00:00"},   # other moment — survives
            {"user_id": "u2", "movie_id": "9001", "moment": "hits_stream", "cascade_id": "c9",
             "emailed_at": "2020-01-01T00:00:00+00:00"},   # other user — survives
        ])
        removed = cleanup_stale_real_film(store, "u1", self.STALE)
        self.assertEqual(removed, 1)
        self.assertEqual(len(store.fetch_notification_keys()), 2)

    def test_skipped_under_no_cleanup(self):
        store = InMemoryStore(notifications=[
            {"user_id": "u1", "movie_id": "9001", "moment": "hits_stream", "cascade_id": "c1",
             "emailed_at": "2020-01-01T00:00:00+00:00"},
        ])
        removed = cleanup_stale_real_film(store, "u1", self.STALE, cleanup=False)
        self.assertEqual(removed, 0)
        self.assertEqual(len(store.fetch_notification_keys()), 1)

    def test_no_stale_state_is_a_no_op(self):
        store = InMemoryStore(notifications=[
            {"user_id": "u1", "movie_id": "9001", "moment": "hits_stream", "cascade_id": "c1",
             "emailed_at": "2020-01-01T00:00:00+00:00"},
        ])
        removed = cleanup_stale_real_film(store, "u1", None)
        self.assertEqual(removed, 0)
        self.assertEqual(len(store.fetch_notification_keys()), 1)


if __name__ == "__main__":
    unittest.main()
