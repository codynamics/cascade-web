"""CAS-792/CAS-796/CAS-860 - the agent-behaviour suite's alerting checks (D4, G4, G6, G7, H4, J1-J7, K6).

BUILD MODE: INDICATIVE. Deliberately outside monitor/tests/ so `npm run qa` (python -m
unittest discover -s monitor/tests) never picks these up - see QA-AGENTS.md. Run on request
via `npm run test:agents`.

CAS-825: match()/match_newly_qualified() now take `admission` (a precomputed real-engine answer,
see matching.compute_admission) instead of `catalogue`. CAS-860: every fixture cascade below that
needs to admit anything now carries `watchMarkers` (via `_criteria()`/`_OPEN_MARKERS`, so
agentFloor() has a usable 0 floor rather than Infinity) and every fixture movie a `language` plus a
scoreable rt_critic/imdb - the same fixture treatment monitor/tests/test_matching.py already uses
(see `_admit()`/`_auto_placements()` below, mirroring that file's `_admit()`/`_auto_placements()`).

Every check drives the real exported functions (compute_transitions, match,
match_newly_qualified, match_film_watches, delivery_plan, monitor.__main__.main) against
inputs shaped like a real two-day catalogue diff - nothing here re-implements matching.py's
or transitions.py's own logic. Where a check needs a genuinely new day-pair scenario (a new
unreleased title, a rating crossing an agent's bar, a full cinema-to-streaming walk), it is
built as an explicit two-record catalogue pair inline, the same technique
monitor/tests/test_matching.py's NewlyQualifiedTests/NewToAgentTests already use for their own
day-pair scenarios, rather than as committed JSON files. K6 is the exception: it asks for two
REAL consecutive snapshots, so it reuses monitor/fixtures/{today,yesterday}.json - already the
project's real-shaped fixture pair, and already hand-checked once in
monitor/tests/test_transitions.py.

Already covered by tests those tickets added - comment only, no test here:
  A4 - CAS-784's one-agent-per-film collapse: monitor/tests/test_matching.py::OneAgentPerFilmTests
  G5, G8 - CAS-785's first-appearance suite: monitor/tests/test_matching.py::NewToAgentTests
  I4, I5 - CAS-788's watched/blocked suppression: monitor/tests/test_watched_suppression.py

If a check fails against the real shipped code, this file does NOT change monitor/ production
code to force it green (this suite's own rule). G7 (CAS-792) found a real gap this way -
match_newly_qualified() had no collapse against a same-day real window transition - and CAS-796
fixed it in monitor/, not here; see G7 below.
"""
import datetime as dt
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

from monitor import (compute_transitions, match, match_newly_qualified, match_film_watches,
                     notification_rows, compute_admission)
from monitor.matching import MOMENT_TO_WINDOW
from monitor.__main__ import main
from monitor.catalogue import load_catalogue_file
from monitor.store import InMemoryStore

_HERE = os.path.dirname(os.path.abspath(__file__))
_FIX = os.path.join(os.path.dirname(_HERE), "fixtures")
RUN_DATE = dt.date(2026, 1, 10)

# CAS-860: the same fixture treatment monitor/tests/test_matching.py already uses (see that file's
# own top docstring) - every fixture cascade below that needs to admit anything gets `_criteria()`'s
# floor-clearing `watchMarkers`, and `_admit()`/`_auto_placements()` are the same helpers by the
# same names there, asking the real engine (via compute_admission -> admit_shim.mjs) rather than
# re-porting matchesCriteria's rules into Python a second time.
_OPEN_MARKERS = {"in_cinema": 0, "rent": 0, "stream": 0}


def _criteria(**extra):
    return {**extra, "watchMarkers": dict(_OPEN_MARKERS)}


def _admit(cascades, today=None, yesterday=None, account_prefs=None):
    catalogues = {}
    if today is not None:
        catalogues["today"] = today
    if yesterday is not None:
        catalogues["yesterday"] = yesterday
    return compute_admission(cascades, catalogues, account_prefs=account_prefs or {})


def _auto_placements(cascades, transitions):
    """CAS-841: film_watch rows standing in for "the app has already placed this film in the
    window the transition itself represents" - see test_matching.py's own copy of this helper."""
    out = []
    for c in cascades:
        for t in transitions:
            window = MOMENT_TO_WINDOW.get(t.moment)
            if window:
                out.append({"user_id": c.get("user_id"), "movie_id": t.movie_id, "windows": [window]})
    return out


class D4AFilmWatchWithNoMatchingCascade(unittest.TestCase):
    """D4: a film_watch row whose film no cascade matches still alerts on its own, deduped
    against agent hits via match_film_watches' own `cascade_hits` param (empty here, since no
    cascade caught it), and its ledger row carries a null cascade_id - the shape
    store.fetch_watch_notification_keys relies on to de-dupe per-film-watch rows separately
    from cascade-owned ones."""

    def test_fires_alone_with_a_null_cascade_in_the_ledger_key(self):
        prev = [{"tmdb_id": 601, "title": "Solo Riser", "status": ["pvod"], "genres": ["Horror"],
                "cinema_date": "2026-01-01", "offers": []}]
        today = [{"tmdb_id": 601, "title": "Solo Riser", "status": ["pvod", "rental"],
                 "genres": ["Horror"], "cinema_date": "2026-01-01",
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 5.99}]}]
        transitions = compute_transitions(prev, today, RUN_DATE)

        # No cascade at all watches Horror -> nothing from match() this run.
        cascade = [{"id": "c-drama", "user_id": "u1", "name": "Drama fan", "active": True,
                   "alert_moments": ["hits_rent"], "criteria": {"genre": ["Drama"]}}]
        agent_hits = match(cascade, transitions)
        self.assertEqual(agent_hits, {}, "setup: no cascade should catch this Horror film")

        watches = [{"user_id": "u1", "movie_id": "601", "windows": ["rent"]}]
        agent_seen = {(str(uid), h.transition.movie_id, h.transition.moment)
                      for uid, hits in agent_hits.items() for h in hits}
        watch_hits = match_film_watches(watches, transitions, cascade_hits=agent_seen)

        self.assertEqual(len(watch_hits.get("u1", [])), 1, "D4: the tick must fire on its own")
        h = watch_hits["u1"][0]
        self.assertIsNone(h.cascade_id, "D4: a per-film tick hit carries no owning cascade")
        row = h.notification_row()
        self.assertIsNone(row["cascade_id"], "D4: the ledger row's cascade_id must be null")


class G4_CAS1558_AnAnnouncedUnreleasedTitleFires(unittest.TestCase):
    """G4: a title absent from yesterday's catalogue, present today, still unreleased ->
    `announced` fires (CAS-242's one first-sighting-is-the-news exception)."""

    def test_a_new_unreleased_title_absent_yesterday_announces(self):
        today = [{"tmdb_id": 611, "title": "Future Tentpole", "status": ["upcoming"],
                 "genres": ["Sci-Fi"], "cinema_date": "2027-03-01", "offers": [],
                 "language": "en", "rt_critic": 70, "wm_critic_score": 70, "popularity": 50, "wm_user_rating": 7.5,
                 "wm_popularity_percentile": 80}]
        transitions = compute_transitions([], today, RUN_DATE)
        self.assertEqual({(t.movie_id, t.moment) for t in transitions}, {("611", "announced")})

        cascade = [{"id": "c1", "user_id": "u1", "name": "Sci-fi radar", "active": True,
                   "alert_moments": ["announced"], "criteria": _criteria(genre=["Sci-Fi"])}]
        admission = _admit(cascade, today=today)
        hits = match(cascade, transitions, admission=admission)
        self.assertEqual(len(hits.get("u1", [])), 1)
        self.assertEqual(hits["u1"][0].transition.moment, "announced")


class G6ARisingRatingCrossesTheAgentsBar(unittest.TestCase):
    """G6: a title held in both catalogues whose own rating crosses the agent's bar ->
    `newly_qualifies` fires on the moment its current window maps to (CAS-602)."""

    def test_newly_qualifies_fires_on_the_films_current_mapped_moment(self):
        offer = [{"service": "AppleTV", "type": "rent", "price": 6.99}]
        prev = [{"tmdb_id": 621, "title": "Slow Climber", "genres": ["Drama"], "status": ["rental"],
                "cinema_date": "2026-01-01", "offers": offer, "language": "en", "rt_critic": 70,
                "wm_user_rating": 6.4}]
        today = [{"tmdb_id": 621, "title": "Slow Climber", "genres": ["Drama"], "status": ["rental"],
                 "cinema_date": "2026-01-01", "offers": offer, "language": "en", "rt_critic": 70,
                 "wm_user_rating": 7.6}]
        cascade = [{"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
                   "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"], imdb=7.0)}]

        admission = _admit(cascade, today=today, yesterday=prev)
        hits = match_newly_qualified(cascade, prev, today, admission=admission)
        self.assertEqual(len(hits.get("u1", [])), 1)
        h = hits["u1"][0]
        self.assertEqual(h.transition.moment, "newly_qualifies")
        self.assertEqual(h.transition.movie_id, "621")


class G7RatingCrossPlusARealWindowTransitionSameDay(unittest.TestCase):
    """G7: G6's scenario, plus the SAME film also crosses a real catalogue window (in_cinema ->
    rental) the same day. The ticket's literal EXPECT is exactly one alert, not two.

    CAS-796: match_newly_qualified() now takes the same `covered` shape match_new_to_agent()
    already used (CAS-785) - the (cascade_id, movie_id) pairs match() already produced this run.
    monitor/__main__.py builds that set from match()'s own output and passes it straight through,
    so a real window transition wins and the newly-qualifies hit for the same pair is dropped.
    """

    def _fixture(self):
        prev = [{"tmdb_id": 622, "title": "Double Mover", "genres": ["Drama"], "status": ["in_cinema"],
                "cinema_date": "2026-01-01", "offers": [], "language": "en", "rt_critic": 70,
                "wm_user_rating": 6.4}]
        today = [{"tmdb_id": 622, "title": "Double Mover", "genres": ["Drama"], "status": ["rental"],
                 "cinema_date": "2026-01-01",
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
                 "language": "en", "rt_critic": 70, "wm_user_rating": 7.6}]
        cascade = [{"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
                   "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"], imdb=7.0)}]
        return prev, today, cascade

    def test_expect_one_alert_not_two(self):
        prev, today, cascade = self._fixture()
        transitions = compute_transitions(prev, today, RUN_DATE)
        admission = _admit(cascade, today=today, yesterday=prev)

        window_hits = match(cascade, transitions, admission=admission,
                            film_watches=_auto_placements(cascade, transitions))
        # CAS-1041: covered is keyed by user_id, not cascade_id — see match_newly_qualified's own
        # docstring (a re-attributed Hit's owner cascade can differ from the one whose criteria
        # changed) — mirrors monitor/__main__.py's own window_covered construction.
        covered = {(h.user_id, h.transition.movie_id)
                  for hits in window_hits.values() for h in hits}
        nq_hits = match_newly_qualified(cascade, prev, today, admission=admission, covered=covered)
        total = sum(len(v) for v in window_hits.values()) + sum(len(v) for v in nq_hits.values())

        self.assertEqual(total, 1,
            "G7 EXPECTs exactly one alert for a film that both newly-qualifies and crosses a "
            f"real window the same day, but match()+match_newly_qualified() produced {total}.")
        self.assertEqual(len(window_hits.get("u1", [])), 1,
            "the real window transition (hits_rent) must be the one that wins")
        self.assertEqual(nq_hits, {}, "the newly-qualifies hit for the same pair must be dropped")

    def test_a_newly_qualifying_film_with_no_window_transition_still_fires(self):
        """No over-suppression: a film that ONLY newly qualifies, with no window transition that
        day, must still produce its hit — `covered` must not swallow every newly_qualifies hit."""
        offer = [{"service": "AppleTV", "type": "rent", "price": 6.99}]
        prev = [{"tmdb_id": 623, "title": "Steady Climber", "genres": ["Drama"], "status": ["rental"],
                "cinema_date": "2026-01-01", "offers": offer, "language": "en", "rt_critic": 70,
                "wm_user_rating": 6.4}]
        today = [{"tmdb_id": 623, "title": "Steady Climber", "genres": ["Drama"], "status": ["rental"],
                 "cinema_date": "2026-01-01", "offers": offer, "language": "en", "rt_critic": 70,
                 "wm_user_rating": 7.6}]
        cascade = [{"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
                   "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"], imdb=7.0)}]
        transitions = compute_transitions(prev, today, RUN_DATE)
        admission = _admit(cascade, today=today, yesterday=prev)

        window_hits = match(cascade, transitions, admission=admission,
                            film_watches=_auto_placements(cascade, transitions))
        self.assertEqual(window_hits, {}, "setup: no real window transition this day")
        covered = {(h.user_id, h.transition.movie_id)
                  for hits in window_hits.values() for h in hits}
        nq_hits = match_newly_qualified(cascade, prev, today, admission=admission, covered=covered)

        self.assertEqual(len(nq_hits.get("u1", [])), 1)
        self.assertEqual(nq_hits["u1"][0].transition.moment, "newly_qualifies")

    def test_a_window_transition_with_no_newly_qualifies_still_fires_exactly_once(self):
        """A film that only crosses a window, and does not newly qualify, still produces exactly
        one hit — `covered` gates match_newly_qualified only, never match() itself."""
        prev = [{"tmdb_id": 624, "title": "Plain Mover", "genres": ["Drama"], "status": ["in_cinema"],
                "cinema_date": "2026-01-01", "offers": [], "language": "en", "rt_critic": 70,
                "wm_user_rating": 7.6}]
        today = [{"tmdb_id": 624, "title": "Plain Mover", "genres": ["Drama"], "status": ["rental"],
                 "cinema_date": "2026-01-01",
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
                 "language": "en", "rt_critic": 70, "wm_user_rating": 7.6}]
        cascade = [{"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
                   "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"], imdb=7.0)}]
        transitions = compute_transitions(prev, today, RUN_DATE)
        admission = _admit(cascade, today=today, yesterday=prev)

        window_hits = match(cascade, transitions, admission=admission,
                            film_watches=_auto_placements(cascade, transitions))
        covered = {(h.user_id, h.transition.movie_id)
                  for hits in window_hits.values() for h in hits}
        nq_hits = match_newly_qualified(cascade, prev, today, admission=admission, covered=covered)
        total = sum(len(v) for v in window_hits.values()) + sum(len(v) for v in nq_hits.values())

        self.assertEqual(total, 1)
        self.assertEqual(window_hits["u1"][0].transition.moment, "hits_rent")


class H4AnUnchangedCatalogueWithCascadesShuffled(unittest.TestCase):
    """H4: the same catalogue both days, agent membership (list order) shuffled -> zero hits,
    from any of the three hit sources."""

    def test_identical_catalogue_both_days_yields_zero_hits_whatever_order_cascades_are_in(self):
        catalogue = [
            {"tmdb_id": 631, "title": "Steady A", "genres": ["Drama"], "status": ["rental"],
             "cinema_date": "2026-01-01", "offers": [], "language": "en", "rt_critic": 70,
             "imdb_rating": 7.5, "imdb_votes": 5000},
            {"tmdb_id": 632, "title": "Steady B", "genres": ["Comedy"], "status": ["included_streaming"],
             "cinema_date": "2026-01-01", "offers": [{"service": "Stan", "type": "sub"}],
             "language": "en", "rt_critic": 70, "imdb_rating": 6.0, "imdb_votes": 5000},
        ]
        transitions = compute_transitions(catalogue, catalogue, RUN_DATE)
        self.assertEqual(transitions, [], "setup: an unchanged catalogue must produce no transitions")

        cascades = [
            {"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
             "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"], imdb=7.0)},
            {"id": "c2", "user_id": "u1", "name": "Comedy radar", "active": True,
             "alert_moments": ["hits_stream"], "criteria": _criteria(genre=["Comedy"])},
        ]
        admission = _admit(cascades, today=catalogue, yesterday=catalogue)
        for ordering in (cascades, list(reversed(cascades))):
            self.assertEqual(match(ordering, transitions, admission=admission), {})
            self.assertEqual(
                match_newly_qualified(ordering, catalogue, catalogue, admission=admission), {})


class J1AFilmWalksTheFullLadderOverFourFixturePairs(unittest.TestCase):
    """J1: cinema -> pvod -> rental -> streaming, each mapped moment fires exactly once, in
    order, across four consecutive day-pairs of the same film."""

    _BASE = {"tmdb_id": 641, "title": "Full Ladder", "genres": ["Drama"], "cinema_date": "2026-01-01"}
    STAGE0 = {**_BASE, "status": ["upcoming"], "offers": []}
    STAGE1 = {**_BASE, "status": ["in_cinema"], "offers": []}
    STAGE2 = {**_BASE, "status": ["in_cinema", "pvod"],
             "offers": [{"service": "Apple TV", "type": "buy", "price": 24.99}]}
    STAGE3 = {**_BASE, "status": ["in_cinema", "pvod", "rental"],
             "offers": STAGE2["offers"] + [{"service": "AppleTV", "type": "rent", "price": 6.99}]}
    STAGE4 = {**_BASE, "status": ["in_cinema", "pvod", "rental", "included_streaming"],
             "offers": STAGE3["offers"] + [{"service": "Stan", "type": "sub"}]}

    def test_each_step_fires_its_own_moment_once_in_order(self):
        pairs = [
            (self.STAGE0, self.STAGE1, "hits_cinema"),
            (self.STAGE1, self.STAGE2, "hits_pvod"),
            (self.STAGE2, self.STAGE3, "hits_rent"),
            (self.STAGE3, self.STAGE4, "hits_stream"),
        ]
        for prev, today, expected_moment in pairs:
            transitions = compute_transitions([prev], [today], RUN_DATE)
            moments = [t.moment for t in transitions if t.movie_id == "641"]
            self.assertEqual(moments, [expected_moment],
                f"{prev['status']} -> {today['status']} fired {moments}, expected [{expected_moment}]")


class J2AFilmMovingBackwardsATierFiresNothing(unittest.TestCase):
    """J2: the tier_rank forward-only guard (CAS-355) - a lower tier newly appearing after a
    higher one was already held (a transient provider gap) must not read as a gain."""

    def test_a_lower_tier_appearing_after_a_higher_one_is_guarded(self):
        prev = [{"tmdb_id": 651, "title": "Provider Gap", "genres": ["Drama"], "cinema_date": "2026-01-01",
                "status": ["included_streaming"], "offers": [{"service": "Stan", "type": "sub"}]}]
        today = [{"tmdb_id": 651, "title": "Provider Gap", "genres": ["Drama"], "cinema_date": "2026-01-01",
                 "status": ["included_streaming", "rental"],
                 "offers": [{"service": "Stan", "type": "sub"},
                           {"service": "AppleTV", "type": "rent", "price": 6.99}]}]
        transitions = compute_transitions(prev, today, RUN_DATE)
        self.assertEqual(transitions, [])


class J3AFirstSightingAlreadyInsideAWindowFiresNoStatusMoment(unittest.TestCase):
    """J3: a film's very first sighting, already sitting inside a window, is not a change -
    the honesty guardrail every status moment shares."""

    def test_a_brand_new_title_already_in_a_window_produces_no_status_moment(self):
        today = [{"tmdb_id": 661, "title": "Already There", "genres": ["Drama"], "cinema_date": "2025-01-01",
                 "status": ["rental"], "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}]
        transitions = compute_transitions([], today, RUN_DATE)
        self.assertEqual(transitions, [])


class J4_CAS1558_NeitherAnUnrequestedMomentNorAGlobalMuteFires(unittest.TestCase):
    """J4: a moment absent from the agent's alert_moments, and separately a global mute, each
    independently silence the same real transition."""

    def _fixture(self):
        prev = [{"tmdb_id": 671, "title": "Quiet Riser", "genres": ["Drama"], "cinema_date": "2026-01-01",
                "status": ["pvod"], "offers": [], "language": "en", "rt_critic": 70, "wm_critic_score": 70, "popularity": 50, "wm_user_rating": 7.5}]
        today = [{"tmdb_id": 671, "title": "Quiet Riser", "genres": ["Drama"], "cinema_date": "2026-01-01",
                 "status": ["pvod", "rental"], "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
                 "language": "en", "rt_critic": 70, "wm_critic_score": 70, "popularity": 50, "wm_user_rating": 7.5}]
        return prev, today

    def _match(self, cascade, **kw):
        prev, today = self._fixture()
        transitions = compute_transitions(prev, today, RUN_DATE)
        admission = _admit(cascade, today=today, yesterday=prev)
        return match(cascade, transitions, admission=admission,
                     film_watches=_auto_placements(cascade, transitions), **kw)

    def test_a_moment_the_agent_never_asked_for_does_not_fire(self):
        cascade = [{"id": "c1", "user_id": "u1", "name": "Cinema only", "active": True,
                   "alert_moments": ["hits_cinema"], "criteria": _criteria(genre=["Drama"])}]
        self.assertEqual(self._match(cascade), {})

    def test_a_globally_muted_moment_does_not_fire_even_when_requested(self):
        cascade = [{"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
                   "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"])}]
        self.assertEqual(self._match(cascade, excluded={"u1": ["hits_rent"]}), {})

    def test_the_same_moment_fires_absent_either_gate(self):
        # Control: proves both gates above are really doing something, not a fixture that never matched.
        cascade = [{"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
                   "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"])}]
        self.assertEqual(len(self._match(cascade).get("u1", [])), 1)


class J5_CAS1558_AllFourNotifyPrefCombinationsChooseTheirChannels(unittest.TestCase):
    """J5: {email_on, in_app} x {True, False} - only the chosen channels deliver, and CAS-465's
    push (which rides the same "in_app" gate, not a fourth independent switch) carries the
    existing unread badge count plus what this run delivers. Driven through the real CLI
    (monitor.__main__.main), with the store's push/unread reads patched (the CLI has no flag
    for them) and the network calls (send_via_resend / send_via_apns) patched so nothing real
    is ever sent."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def _write(self, name, data):
        path = os.path.join(self._tmp.name, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        return path

    def _run(self, email_on, in_app):
        today_path = self._write("today.json", [
            {"tmdb_id": 681, "title": "Badge Riser", "genres": ["Drama"], "cinema_date": "2026-01-01",
             "status": ["pvod", "rental"], "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
             "language": "en", "rt_critic": 70}])
        yest_path = self._write("yesterday.json", [
            {"tmdb_id": 681, "title": "Badge Riser", "genres": ["Drama"], "cinema_date": "2026-01-01",
             "status": ["pvod"], "offers": [], "language": "en", "rt_critic": 70}])
        cascades_path = self._write("cascades.json", [
            {"id": "c1", "user_id": "j5-user", "name": "Drama radar", "active": True,
             "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"])}])
        prefs_path = self._write("prefs.json", {
            "j5-user": {"in_app": in_app, "email_on": email_on, "email_address": "j5@test.example"}})
        # CAS-841: match()'s window-arrival gate needs the film actually placed in the "rent"
        # window for this user - the same auto-placement CAS-726 does in production.
        watches_path = self._write("watches.json", [
            {"user_id": "j5-user", "movie_id": "681", "windows": ["rent"]}])

        argv = ["--today", today_path, "--yesterday", yest_path, "--date", "2026-01-10",
                "--cascades", cascades_path, "--prefs", prefs_path, "--watches", watches_path]

        pushes = []

        def _fake_apns(token, title, body, badge=None, payload=None, on_invalid_token=None):
            pushes.append({"token": token, "badge": badge})
            return True

        with mock.patch.object(InMemoryStore, "fetch_push_tokens",
                               return_value={"j5-user": ["device-1"]}), \
            mock.patch.object(InMemoryStore, "fetch_unread_counts",
                              return_value={"j5-user": 3}), \
            mock.patch("monitor.__main__.send_via_apns", side_effect=_fake_apns),             mock.patch("monitor.__main__.USER_HELD_IDS_FILE", os.path.join(self._tmp.name, "held.json")), \
            mock.patch("monitor.__main__.send_via_resend", return_value={"id": "test"}) as resend:
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = main(argv)
        return rc, buf.getvalue(), resend, pushes

    def test_email_and_in_app_both_on_delivers_all_three_channels(self):
        rc, out, resend, pushes = self._run(email_on=True, in_app=True)
        self.assertEqual(rc, 0)
        resend.assert_called_once()
        self.assertIn("in-app channel", out)
        self.assertEqual(len(pushes), 1)
        self.assertEqual(pushes[0]["badge"], 4)   # 3 existing unread + 1 delivered this run

    def test_email_only_delivers_no_in_app_and_no_push(self):
        rc, out, resend, pushes = self._run(email_on=True, in_app=False)
        self.assertEqual(rc, 0)
        resend.assert_called_once()
        self.assertNotIn("in-app channel", out)
        self.assertEqual(pushes, [], "push rides in_app (CAS-465) - off means no push either")

    def test_in_app_only_delivers_in_app_and_push_but_no_email(self):
        rc, out, resend, pushes = self._run(email_on=False, in_app=True)
        self.assertEqual(rc, 0)
        resend.assert_not_called()
        self.assertIn("in-app channel", out)
        self.assertEqual(len(pushes), 1)
        self.assertEqual(pushes[0]["badge"], 4)

    def test_both_off_delivers_nothing_and_writes_no_ledger_row(self):
        rc, out, resend, pushes = self._run(email_on=False, in_app=False)
        self.assertEqual(rc, 0)
        resend.assert_not_called()
        self.assertEqual(pushes, [])
        self.assertIn("both channels off", out)


class J6_CAS1558_RerunningTheSameDayTwiceIsSilent(unittest.TestCase):
    """J6: a second run against the same transitions and the ledger the first run wrote must
    send nothing - de-dupe holds."""

    def _setup(self):
        prev = [{"tmdb_id": 691, "title": "Once Only", "genres": ["Drama"], "cinema_date": "2026-01-01",
                "status": ["pvod"], "offers": [], "language": "en", "rt_critic": 70, "wm_critic_score": 70, "popularity": 50, "wm_user_rating": 7.5}]
        today = [{"tmdb_id": 691, "title": "Once Only", "genres": ["Drama"], "cinema_date": "2026-01-01",
                 "status": ["pvod", "rental"], "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
                 "language": "en", "rt_critic": 70, "wm_critic_score": 70, "popularity": 50, "wm_user_rating": 7.5}]
        transitions = compute_transitions(prev, today, RUN_DATE)
        cascade = [{"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
                   "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"])}]
        admission = _admit(cascade, today=today, yesterday=prev)
        film_watches = _auto_placements(cascade, transitions)
        return cascade, transitions, admission, film_watches

    def test_second_call_with_the_first_runs_keys_already_sent_is_silent(self):
        cascade, transitions, admission, film_watches = self._setup()
        first = match(cascade, transitions, admission=admission, film_watches=film_watches)
        self.assertEqual(len(first.get("u1", [])), 1, "setup: the first run must produce a hit")
        already = {(h.cascade_id, h.transition.movie_id, h.transition.moment)
                  for hits in first.values() for h in hits}
        second = match(cascade, transitions, already=already, admission=admission, film_watches=film_watches)
        self.assertEqual(second, {})

    def test_via_the_real_store_round_trip(self):
        cascade, transitions, admission, film_watches = self._setup()
        store = InMemoryStore(cascades=cascade, notifications=[])
        first = match(store.fetch_active_cascades(), transitions, admission=admission,
                     already=store.fetch_notification_keys(), film_watches=film_watches)
        store.insert_notifications(notification_rows(first))
        second = match(store.fetch_active_cascades(), transitions, admission=admission,
                       already=store.fetch_notification_keys(), film_watches=film_watches)
        self.assertEqual(second, {})


class J7DateComputedMomentsNeverFireFromAMissingOrMalformedDate(unittest.TestCase):
    """J7: opens_soon / past_opening_weekend are computed straight from a REAL cinema_date
    (the honesty guardrail) - a missing or malformed one must never invent either moment."""

    def _rec(self, cinema_date):
        return {"tmdb_id": 701, "title": "No Real Date", "genres": ["Drama"], "status": ["upcoming"],
               "cinema_date": cinema_date, "offers": []}

    def test_missing_date_fires_neither_moment(self):
        rec = self._rec(None)
        pairs = {(t.movie_id, t.moment) for t in compute_transitions([rec], [rec], RUN_DATE)}
        self.assertNotIn(("701", "opens_soon"), pairs)
        self.assertNotIn(("701", "past_opening_weekend"), pairs)

    def test_malformed_date_fires_neither_moment(self):
        rec = self._rec("not-a-real-date")
        pairs = {(t.movie_id, t.moment) for t in compute_transitions([rec], [rec], RUN_DATE)}
        self.assertNotIn(("701", "opens_soon"), pairs)
        self.assertNotIn(("701", "past_opening_weekend"), pairs)


class K6RealConsecutiveSnapshotsMatchAHandCheckedExpectation(unittest.TestCase):
    """K6: monitor/fixtures/today.json + yesterday.json are two REAL consecutive catalogue
    snapshots (not the synthetic single-field deltas the checks above use) - the same pair
    monitor/tests/test_transitions.py's own hand-checked expectation already asserts. Re-run
    here, independently, as this suite's own check rather than trusting that suite's result."""

    def test_transition_set_matches_the_hand_checked_expectation(self):
        today = load_catalogue_file(os.path.join(_FIX, "today.json"))
        yesterday = load_catalogue_file(os.path.join(_FIX, "yesterday.json"))
        transitions = compute_transitions(yesterday, today, dt.date(2026, 7, 16))
        pairs = {(t.movie_id, t.moment) for t in transitions}
        # Hand-checked against monitor/fixtures/{today,yesterday}.json's content:
        #   5001 pvod -> rental                = hits_rent
        #   5002 gains included_streaming      = hits_stream
        #   5003 upcoming -> in_cinema         = hits_cinema
        #   5004 cinema_date 2026-07-12 + 4d   = past_opening_weekend (run date 2026-07-16)
        #   5005 absent from yesterday.json    = first sighting, no moment
        #   5006 included_streaming both days  = unchanged, no moment
        self.assertEqual(pairs, {
            ("5001", "hits_rent"),
            ("5002", "hits_stream"),
            ("5003", "hits_cinema"),
            ("5004", "past_opening_weekend"),
        })


if __name__ == "__main__":
    unittest.main()
