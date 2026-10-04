"""Unit tests for match + de-dupe (CAS-85 / spec 26771457 §5).

Run:  python -m unittest monitor.tests.test_matching   (from the repo root)

CAS-825: admission (which film a Cascade admits) is now asked of the real shipped engine via
compute_admission() -> admit_shim.mjs, not recomputed field-by-field in Python. Every fixture
Cascade below carries `watchMarkers` (so app_template.html's agentFloor() has a usable window
rather than Infinity) and every fixture movie carries enough of a quality signal (wm_user_rating
or wm_critic_score, CAS-919/920) and a `language` for the taste baseline to clear — without them
the real engine holds a film back exactly as it would in the app, which is the whole point of
this ticket, but makes an under-specified fixture film look unmatched for the wrong reason.
`_admit()` below is the one place every test asks the engine for its answer.

CAS-1128: a 0 marker is no longer a score-gate bypass — normCascade migrates it to TRACK_MIN, a
real floor (50) an under-scored fixture film can fail same as any other, so an in_cinema/upcoming
fixture movie also needs a `wm_popularity_percentile` (cascadeScore blends in buzz for those
statuses) or it reads as if it had no score at all.
"""
import datetime as _dt
import json
import os
import unittest

from monitor import (compute_transitions, match, matches_criteria, compute_admission,
                     compute_auto_placements, synthesize_auto_watch_rows, service_ok,
                     notification_rows, suppressed_pairs, excluded_moments, match_film_watches,
                     match_newly_qualified, match_new_to_agent)
from monitor.matching import Hit, agent_channels, MOMENT_TO_WINDOW
from monitor.catalogue import load_catalogue_file
from monitor.store import InMemoryStore
from monitor.transitions import Transition

_HERE = os.path.dirname(os.path.abspath(__file__))
_FIX = os.path.join(os.path.dirname(_HERE), "fixtures")
RUN_DATE = _dt.date(2026, 7, 16)

# CAS-825: every fixture agent below gets this floor-clearing block merged into its own criteria,
# so agentFloor() always has a usable window at 0 rather than Infinity (no watchMarkers -> nothing
# can ever clear the real engine's score gate). Genre/imdb/etc. still do the actual narrowing these
# tests are about; this only keeps the score floor out of their way.
_OPEN_MARKERS = {"in_cinema": 0, "rent": 0, "stream": 0}


def _criteria(**extra):
    return {**extra, "watchMarkers": dict(_OPEN_MARKERS)}


def _load(name):
    with open(os.path.join(_FIX, name), encoding="utf-8") as fh:
        return json.load(fh)


def _admit(cascades, today=None, yesterday=None, account_prefs=None):
    """The one call site every test below uses to ask the real engine what these cascades admit —
    see compute_admission()'s own docstring for the shape."""
    catalogues = {}
    if today is not None:
        catalogues["today"] = today
    if yesterday is not None:
        catalogues["yesterday"] = yesterday
    return compute_admission(cascades, catalogues, account_prefs=account_prefs or {})


def _auto_placements(cascades, transitions):
    """CAS-841: film_watch rows standing in for "the app has already placed this film in the
    window the transition itself represents" — the assumption every fixture below made before the
    ticket existed (in production CAS-726 auto-places every admitted film, so this is the normal
    case, not a special one). Tests specifically about CAS-841's own gate build their own
    `film_watches` instead of calling this."""
    out = []
    for c in cascades:
        for t in transitions:
            window = MOMENT_TO_WINDOW.get(t.moment)
            if window:
                out.append({"user_id": c.get("user_id"), "movie_id": t.movie_id, "windows": [window]})
    return out


class MatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.today = load_catalogue_file(os.path.join(_FIX, "today.json"))
        cls.prev = load_catalogue_file(os.path.join(_FIX, "yesterday.json"))
        cls.transitions = compute_transitions(cls.prev, cls.today, RUN_DATE)
        cls.cascades = _load("cascades.json")
        cls.film_watches = _auto_placements(cls.cascades, cls.transitions)

    def _match(self, already=None, cascades=None, film_watches=None):
        cascades = self.cascades if cascades is None else cascades
        film_watches = self.film_watches if film_watches is None else film_watches
        admission = _admit(cascades, today=self.today)
        return match(cascades, self.transitions, already=already, admission=admission,
                    film_watches=film_watches)

    def _keys(self, by_user):
        return {(h.cascade_id, h.transition.movie_id, h.transition.moment)
                for hits in by_user.values() for h in hits}

    # ---- the right alerts for the right users ----
    def test_matches_expected_hits(self):
        by_user = self._match()
        self.assertEqual(self._keys(by_user), {
            ("cascade-A1", "5001", "hits_rent"),            # Drama rental, imdb 7.2 >= 7
            ("cascade-A2", "5003", "hits_cinema"),          # Action cinema opening
            ("cascade-B1", "5002", "hits_stream"),          # Comedy on Stan (service matches)
            ("cascade-B2", "5004", "past_opening_weekend"), # Thriller, opening + 4
        })
        self.assertEqual(set(by_user), {"user-A", "user-B"})
        self.assertEqual(len(by_user["user-A"]), 2)
        self.assertEqual(len(by_user["user-B"]), 2)

    # ---- global alert-type exclude (CAS-103 AC4) ----
    # The preference outranks the Cascade: a muted TYPE never fires for that user, however their
    # own Cascades are set, and it must not leak across to anyone else.
    def test_global_exclude_mutes_that_type_for_that_user(self):
        admission = _admit(self.cascades, today=self.today)
        by_user = match(self.cascades, self.transitions, admission=admission,
                        excluded={"user-A": ["hits_rent"]}, film_watches=self.film_watches)
        keys = self._keys(by_user)
        self.assertNotIn(("cascade-A1", "5001", "hits_rent"), keys)
        self.assertIn(("cascade-A2", "5003", "hits_cinema"), keys)      # A's other type is untouched
        self.assertIn(("cascade-B1", "5002", "hits_stream"), keys)      # B is unaffected

    def test_global_exclude_can_silence_a_user_entirely(self):
        admission = _admit(self.cascades, today=self.today)
        by_user = match(self.cascades, self.transitions, admission=admission,
                        excluded={"user-A": ["hits_rent", "hits_cinema"]}, film_watches=self.film_watches)
        self.assertNotIn("user-A", by_user)
        self.assertIn("user-B", by_user)

    def test_global_exclude_absent_changes_nothing(self):
        admission = _admit(self.cascades, today=self.today)
        self.assertEqual(self._keys(match(self.cascades, self.transitions, admission=admission,
                                          excluded={}, film_watches=self.film_watches)),
                         self._keys(self._match()))

    def test_excluded_moments_accepts_both_shapes(self):
        rows = [{"user_id": "user-A", "excluded_moments": ["hits_rent"]}]
        self.assertEqual(excluded_moments(rows), {"user-A": {"hits_rent"}})
        self.assertEqual(excluded_moments({"user-A": ["hits_rent"]}), {"user-A": {"hits_rent"}})
        self.assertEqual(excluded_moments(None), {})

    def test_excluded_moments_keeps_unknown_names(self):
        # Dropping a name we don't recognise would make a future rename fail OPEN — i.e. resume
        # emailing about the very thing the user muted.
        self.assertEqual(excluded_moments({"u": ["hits_teleport"]}), {"u": {"hits_teleport"}})

    def test_rating_bar_excludes(self):
        # cascade-A3 wants Drama at imdb>=8; 5001 is 7.2 -> excluded.
        self.assertNotIn(("cascade-A3", "5001", "hits_rent"), self._keys(self._match()))

    def test_inactive_cascade_ignored(self):
        # cascade-A4 is active:false; it would otherwise match 5001.
        self.assertFalse(any(h.cascade_id == "cascade-A4"
                             for hits in self._match().values() for h in hits))

    def test_genre_mismatch_excluded(self):
        # cascade-A5 (Horror) must not catch 5001 (Drama); and 5005 (Horror) is a first-sighting
        # so it produced no transition to match at all.
        keys = self._keys(self._match())
        self.assertFalse(any(cid == "cascade-A5" for cid, _, _ in keys))

    def test_streaming_service_filter(self):
        # cascade-B3 wants Comedy on Netflix; 5002 arrived on Stan -> no hit.
        self.assertNotIn(("cascade-B3", "5002", "hits_stream"), self._keys(self._match()))

    def test_moment_must_be_requested(self):
        # cascade-A1 only asked for hits_rent; it must not fire on cinema/stream moments.
        for hits in self._match().values():
            for h in hits:
                if h.cascade_id == "cascade-A1":
                    self.assertEqual(h.transition.moment, "hits_rent")

    # ---- de-dupe ----
    def test_dedupe_skips_already_sent(self):
        already = {("cascade-A1", "5001", "hits_rent")}
        keys = self._keys(self._match(already=already))
        self.assertNotIn(("cascade-A1", "5001", "hits_rent"), keys)
        self.assertIn(("cascade-A2", "5003", "hits_cinema"), keys)   # others unaffected

    def test_second_run_is_silent(self):
        # Acceptance: a second run with the same catalogue + last run's ledger -> zero alerts.
        first = self._match()
        already = {(h.cascade_id, h.transition.movie_id, h.transition.moment)
                   for hits in first.values() for h in hits}
        second = self._match(already=already)
        self.assertEqual(second, {})

    # ---- personal Pick overrides outrank the Cascade (CAS-100 AC5) ----
    def test_pick_off_suppresses_that_users_alert(self):
        # user-A took 5001 off by hand. cascade-A1 goes on matching it; we go on saying nothing.
        admission = _admit(self.cascades, today=self.today)
        keys = self._keys(match(self.cascades, self.transitions, admission=admission,
                                suppressed={("user-A", "5001")}, film_watches=self.film_watches))
        self.assertNotIn(("cascade-A1", "5001", "hits_rent"), keys)
        self.assertIn(("cascade-A2", "5003", "hits_cinema"), keys)     # user-A's other alerts stand

    def test_pick_off_is_per_user_not_global(self):
        # user-B turning 5001 off must not silence user-A's alert for the same film.
        admission = _admit(self.cascades, today=self.today)
        keys = self._keys(match(self.cascades, self.transitions, admission=admission,
                                suppressed={("user-B", "5001")}, film_watches=self.film_watches))
        self.assertIn(("cascade-A1", "5001", "hits_rent"), keys)

    def test_suppressed_pairs_reads_only_off(self):
        pairs = suppressed_pairs([
            {"user_id": "user-A", "movie_id": 5001, "state": "off"},
            {"user_id": "user-A", "movie_id": 5003, "state": "mine"},   # My Pick suppresses nothing
            {"user_id": "user-B", "movie_id": 5002},                    # no state -> not an override
        ])
        self.assertEqual(pairs, {("user-A", "5001")})

    def test_suppressed_pairs_rejects_a_json_object(self):
        # A dict here would silently iterate its KEYS and suppress nothing — fail loudly instead.
        with self.assertRaises(TypeError):
            suppressed_pairs({"user-A": "5001"})

    def test_no_overrides_changes_nothing(self):
        admission = _admit(self.cascades, today=self.today)
        self.assertEqual(self._keys(match(self.cascades, self.transitions, admission=admission,
                                          suppressed=None, film_watches=self.film_watches)),
                         self._keys(self._match()))

    # ---- ledger rows ----
    def test_notification_rows_shape(self):
        rows = notification_rows(self._match())
        self.assertEqual(len(rows), 4)
        for r in rows:
            # CAS-185: the ledger is the in-app delivery too, so a row also carries the agent
            # that caught the film and the film's title — enough for the bell to draw itself
            # without re-deriving anything from a catalogue that has moved on since.
            self.assertEqual(set(r), {"user_id", "cascade_id", "movie_id", "moment",
                                      "cascade_name", "title"})
            self.assertTrue(r["title"])
            self.assertTrue(r["cascade_name"])

    # ---- store round-trip (in-memory) drives the same de-dupe ----
    def test_inmemory_store_write_then_dedupe(self):
        store = InMemoryStore(cascades=self.cascades, notifications=[])
        active = store.fetch_active_cascades()
        self.assertTrue(all(c.get("active", True) for c in active))
        admission = _admit(active, today=self.today)
        first = match(active, self.transitions, already=store.fetch_notification_keys(),
                     admission=admission, film_watches=self.film_watches)
        store.insert_notifications(notification_rows(first))
        second = match(active, self.transitions, already=store.fetch_notification_keys(),
                       admission=admission, film_watches=self.film_watches)
        self.assertEqual(second, {})

    # ---- matches_criteria is now a lookup (CAS-825) ----
    def test_matches_criteria_is_a_lookup_not_a_recomputation(self):
        admission = {"c1": {"today": {"5001", "5003"}}}
        self.assertTrue(matches_criteria("5001", "c1", "today", admission))
        self.assertTrue(matches_criteria(5003, "c1", "today", admission))   # str()-coerced
        self.assertFalse(matches_criteria("5002", "c1", "today", admission))
        self.assertFalse(matches_criteria("5001", "c1", "yesterday", admission))  # wrong snapshot
        self.assertFalse(matches_criteria("5001", "unknown-cascade", "today", admission))
        self.assertFalse(matches_criteria("5001", "c1", "today", {}))       # no admission at all

    def test_service_ok_only_constrains_stream(self):
        class T:  # minimal stand-in
            moment = "hits_rent"
            services = []
        self.assertTrue(service_ok(T(), {"services": ["Netflix"]}))   # rent moment: unconstrained


class WindowPlacementTests(unittest.TestCase):
    """CAS-841: an agent's window-arrival moment (hits_cinema/hits_pvod/hits_rent/hits_stream)
    must agree with where the app has actually placed the film (film_watch.windows), not just
    admit it. Non-window moments (announced, opens_soon, newly_qualifies, new_to_agent) are never
    gated by placement."""

    def _movie(self, tmdb_id=8001, title="Placed Film", status=("rental",)):
        return {"tmdb_id": tmdb_id, "title": title, "genres": ["Drama"], "status": list(status),
                "cinema_date": "2026-01-01", "language": "en", "wm_critic_score": 70, "popularity": 50,
                "wm_popularity_percentile": 70,
                "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
                "wm_user_rating": 7.5}

    def _cascade(self, moments):
        return [{"id": "c1", "user_id": "u1", "name": "Everything", "active": True,
                 "alert_moments": list(moments), "criteria": _criteria(genre=["Drama"], imdb=7.0)}]

    def _match(self, cascades, transitions, film_watches, movie):
        admission = _admit(cascades, today=[movie])
        return match(cascades, transitions, admission=admission, film_watches=film_watches)

    # ---- AC1: fires only on the moment mapped from the film's OWN placed window ----
    def test_wrong_window_is_silent_right_window_fires(self):
        movie = self._movie()
        cascades = self._cascade(["hits_cinema", "hits_pvod", "hits_rent", "hits_stream"])
        watches = [{"user_id": "u1", "movie_id": "8001", "windows": ["rent"]}]

        cinema_t = Transition("8001", movie["title"], "hits_cinema", movie=movie)
        self.assertEqual(self._match(cascades, [cinema_t], watches, movie), {})

        rent_t = Transition("8001", movie["title"], "hits_rent", movie=movie)
        hits = self._match(cascades, [rent_t], watches, movie)
        self.assertEqual(len(hits.get("u1", [])), 1)
        self.assertEqual(hits["u1"][0].transition.moment, "hits_rent")

    # ---- AC2: no placement row at all -> fail closed ----
    def test_no_placement_row_is_silent(self):
        movie = self._movie()
        cascades = self._cascade(["hits_cinema", "hits_pvod", "hits_rent", "hits_stream"])
        t = Transition("8001", movie["title"], "hits_cinema", movie=movie)
        self.assertEqual(self._match(cascades, [t], [], movie), {})

    def test_an_empty_windows_row_is_the_same_as_no_row(self):
        movie = self._movie()
        cascades = self._cascade(["hits_rent"])
        watches = [{"user_id": "u1", "movie_id": "8001", "windows": []}]
        t = Transition("8001", movie["title"], "hits_rent", movie=movie)
        self.assertEqual(self._match(cascades, [t], watches, movie), {})

    # ---- AC3: non-window moments never leak into rule 3 ----
    def test_non_window_moments_fire_with_no_placement_row(self):
        movie = self._movie(status=("upcoming",))
        cascades = self._cascade(["announced", "opens_soon", "newly_qualifies", "new_to_agent"])
        for moment in ("announced", "opens_soon", "newly_qualifies", "new_to_agent"):
            t = Transition("8001", movie["title"], moment, movie=movie)
            hits = self._match(cascades, [t], [], movie)
            self.assertEqual(len(hits.get("u1", [])), 1, f"{moment} must fire with no placement row")

    # ---- CAS-926: opens_soon now fires anywhere in a multi-day window; the ledger's existing
    # de-dupe key must still stop a film alerting on each day of that window ----
    def test_opens_soon_dedupe_fires_once_across_the_window(self):
        movie = self._movie(status=("upcoming",))
        cascades = self._cascade(["opens_soon"])
        admission = _admit(cascades, today=[movie])
        t = Transition("8001", movie["title"], "opens_soon", movie=movie)

        first = match(cascades, [t], admission=admission, film_watches=[])
        self.assertEqual(len(first.get("u1", [])), 1)

        already = {("c1", "8001", "opens_soon")}
        second = match(cascades, [t], admission=admission, already=already, film_watches=[])
        self.assertEqual(second, {})

    # ---- AC4/5 are exercised via __main__.py's own counters (see test_delivery.py / manual run) ----
    def test_placement_counts_are_reported_when_a_dict_is_passed(self):
        movie = self._movie()
        cascades = self._cascade(["hits_cinema", "hits_rent"])
        admission = _admit(cascades, today=[movie])
        wrong_window_t = Transition("8001", movie["title"], "hits_cinema", movie=movie)
        counts = {}
        match(cascades, [wrong_window_t], admission=admission,
              film_watches=[{"user_id": "u1", "movie_id": "8001", "windows": ["rent"]}],
              placement_counts=counts)
        self.assertEqual(counts, {"wrong_window": 1})

        no_row_t = Transition("8001", movie["title"], "hits_rent", movie=movie)
        counts = {}
        match(cascades, [no_row_t], admission=admission, film_watches=[], placement_counts=counts)
        self.assertEqual(counts, {"no_placement": 1})


class AutoPlacementTests(unittest.TestCase):
    """CAS-1097: agent_films stops being client-pushed CURRENT membership — but an admitted film
    with no film_watch row of its own (automatic placement stopped being client-pushed per CAS-1096)
    still needs a placement for WindowPlacementTests' own CAS-841 gate to see it.
    compute_auto_placements()/synthesize_auto_watch_rows() derive one from agent_films' frozen
    admission_score, via placement_shim.mjs — the same earned/standing arithmetic
    recomputeFound's own placement block runs on the device (app_template.html's
    earnedWindowForScore/autoPlacementFor/autoPlacementForAdmission). A real film_watch row —
    manual, or a legacy pre-CAS-1096 auto one — always wins outright."""

    def _movie(self, tmdb_id=9001, status=("included_streaming",)):
        # showable() (matchesCriteria's own first gate) requires a CONFIRMED offer — a "sub" offer is
        # what windowOf() maps to "included_streaming" (app_template.html ~18709), matching `status`
        # above; without one hasConfirmedOffer() is false and every admission here reads empty.
        return {"tmdb_id": tmdb_id, "title": "Auto Placed Film", "genres": ["Drama"],
                "status": list(status), "cinema_date": "2026-01-01", "language": "en",
                "wm_critic_score": 70, "popularity": 50, "wm_popularity_percentile": 70,
                "wm_user_rating": 7.5, "offers": [{"service": "Netflix", "type": "sub"}]}

    def _cascade(self, moments, stream_marker=50):
        # Only `stream` is a usable window — in_cinema/premium/rent are off (Never), so the score-earn
        # ladder can only ever land on Stream, never short-circuit on an earlier always-open rung.
        # Built directly, not via _criteria() above — that helper always overwrites watchMarkers with
        # _OPEN_MARKERS, which this test's whole point (an earn that lands specifically on Stream)
        # needs full control over.
        markers = {"in_cinema": None, "premium": None, "rent": None, "stream": stream_marker}
        return [{"id": "c1", "user_id": "u1", "name": "Everything", "active": True,
                 "alert_moments": list(moments),
                 "criteria": {"genre": ["Drama"], "imdb": 7.0, "watchMarkers": markers}}]

    def test_an_admitted_film_with_no_film_watch_row_is_auto_placed_in_stream(self):
        movie = self._movie()
        cascades = self._cascade(["hits_stream"])
        agent_films = [{"user_id": "u1", "cascade_id": "c1", "movie_id": "9001", "admission_score": 80}]

        auto_placements = compute_auto_placements(agent_films, cascades, [movie], account_prefs={})
        self.assertEqual(auto_placements, {("u1", "9001"): "stream"},
            "an admission at a score above the Stream marker, with every earlier window off, must earn Stream")

        auto_rows = synthesize_auto_watch_rows(auto_placements, placed_keys=set())
        admission = _admit(cascades, today=[movie])
        t = Transition("9001", movie["title"], "hits_stream", movie=movie)
        hits = match(cascades, [t], admission=admission, film_watches=auto_rows)
        self.assertEqual(len(hits.get("u1", [])), 1,
            "a film admitted by an agent and auto-placed in Stream, with no film_watch row, must be "
            "treated as Stream")

    def test_a_manual_film_watch_row_overrides_the_synthesized_auto_placement(self):
        movie = self._movie()
        cascades = self._cascade(["hits_stream", "hits_rent"])
        agent_films = [{"user_id": "u1", "cascade_id": "c1", "movie_id": "9001", "admission_score": 80}]
        # The real film_watch row says Rent, by hand — the same admission_score that would otherwise
        # earn Stream via compute_auto_placements must never be allowed to overrule it.
        manual_watch = [{"user_id": "u1", "movie_id": "9001", "windows": ["rent"],
                         "sources": {"rent": "manual"}}]
        placed_keys = {("u1", "9001")}

        auto_placements = compute_auto_placements(agent_films, cascades, [movie], account_prefs={})
        auto_rows = synthesize_auto_watch_rows(auto_placements, placed_keys)
        self.assertEqual(auto_rows, [],
            "a (user, movie) already covered by a real film_watch row gets no synthesized row at all")

        admission = _admit(cascades, today=[movie])
        film_watches = manual_watch + auto_rows
        stream_t = Transition("9001", movie["title"], "hits_stream", movie=movie)
        self.assertEqual(match(cascades, [stream_t], admission=admission, film_watches=film_watches), {},
            "the manual Rent placement must win outright — Stream must not also fire")
        rent_t = Transition("9001", movie["title"], "hits_rent", movie=movie)
        hits = match(cascades, [rent_t], admission=admission, film_watches=film_watches)
        self.assertEqual(len(hits.get("u1", [])), 1, "the manual row's own Rent placement must still fire")

    def test_an_agent_films_row_naming_no_cascade_in_the_batch_is_skipped(self):
        movie = self._movie()
        agent_films = [{"user_id": "u1", "cascade_id": "gone", "movie_id": "9001", "admission_score": 80}]
        self.assertEqual(compute_auto_placements(agent_films, [], [movie], account_prefs={}), {})

    def test_an_explicit_watch_windows_list_false_blocks_the_rent_placement(self):
        """CAS-1156: watch_windows.rent={"list":false} (a window a member has explicitly switched
        off in Where & when) must read as off here the same way it does on the device — an explicit
        {list:false} must never earn a placement, the same as the window being absent entirely."""
        movie = {"tmdb_id": 9003, "title": "Rent Only Film", "genres": ["Drama"],
                 "status": ["rental"], "cinema_date": "2026-01-01", "language": "en",
                 "wm_critic_score": 70, "popularity": 50, "wm_popularity_percentile": 70,
                 "wm_user_rating": 7.5, "offers": [{"service": "Netflix", "type": "rent", "price": 5.99}]}
        # Only `rent` is a usable window at the agent level — in_cinema/premium/stream are off
        # (Never), so the account's own Where & when switch is the only thing left to decide this.
        # trackV:2 (CAS-1128) opts out of the legacy no-trackV forward migration (CAS-1143) that would
        # otherwise carry an open rent marker forward onto the null stream one.
        markers = {"in_cinema": None, "premium": None, "rent": 50, "stream": None}
        criteria = {"genre": ["Drama"], "imdb": 7.0, "watchMarkers": markers, "trackV": 2}
        cascade_on = {"id": "c-on", "user_id": "u-on", "name": "Everything", "active": True,
                      "alert_moments": ["hits_rent"], "criteria": criteria}
        cascade_off = {"id": "c-off", "user_id": "u-off", "name": "Everything", "active": True,
                       "alert_moments": ["hits_rent"], "criteria": criteria}
        agent_films = [
            {"user_id": "u-on", "cascade_id": "c-on", "movie_id": "9003", "admission_score": 80},
            {"user_id": "u-off", "cascade_id": "c-off", "movie_id": "9003", "admission_score": 80},
        ]
        account_prefs = {
            "u-on": {"watchWindows": {"rent": {"list": True}}},
            "u-off": {"watchWindows": {"rent": {"list": False}}},
        }

        auto_placements = compute_auto_placements(agent_films, [cascade_on, cascade_off], [movie],
                                                    account_prefs=account_prefs)
        self.assertEqual(auto_placements.get(("u-on", "9003")), "rent",
            "a user whose watch_windows.rent is {list:true} must still earn the Rent placement")
        self.assertNotIn(("u-off", "9003"), auto_placements,
            "a user whose watch_windows.rent is {list:false} must earn no placement at all — the "
            "window is explicitly off, not merely unanswered")

        auto_rows = synthesize_auto_watch_rows(auto_placements, placed_keys=set())
        admission = _admit([cascade_on, cascade_off], today=[movie])
        rent_t = Transition("9003", movie["title"], "hits_rent", movie=movie)
        hits = match([cascade_on, cascade_off], [rent_t], admission=admission, film_watches=auto_rows)
        self.assertEqual(len(hits.get("u-on", [])), 1,
            "the account with Rent switched on must still get its rental-window alert")
        self.assertEqual(len(hits.get("u-off", [])), 0,
            "the account with Rent explicitly switched off must produce no rental-window alert for "
            "an otherwise identical admission")


class TrackMigrationPlacementTests(unittest.TestCase):
    """CAS-1143: an agent row stored under CAS-917's old start-window-forward model (cinema-only,
    no `trackV`) must still follow its admission onto Stream once the film itself arrives there —
    placement_shim.mjs reaches the same trackV-guarded normCascade migration admit_shim.mjs does
    (both call E.normCascade), so this is the placement side of the same fix. The control — the
    identical row carrying trackV:2, meaning a person has explicitly left Stream off since CAS-1128
    shipped — must NOT be migrated, and so stays pinned at Cinema (the one window it actually tracks)
    rather than advancing onto a window it was never told to follow."""

    def _streaming_movie(self):
        # showable() needs a CONFIRMED offer (a "sub" offer maps to included_streaming, CAS-1097's
        # own _movie() fixture note above).
        return {"tmdb_id": 9002, "title": "CAS-1143 Track Migration Film", "genres": ["Drama"],
                "status": ["included_streaming"], "cinema_date": "2026-01-01", "language": "en",
                "wm_critic_score": 70, "popularity": 50, "wm_popularity_percentile": 70,
                "wm_user_rating": 7.5, "offers": [{"service": "Netflix", "type": "sub"}]}

    def _cascade(self, extra_criteria):
        markers = {"in_cinema": 50, "premium": None, "rent": None, "stream": None}
        criteria = {"genre": ["Drama"], "imdb": 7.0, "watchMarkers": markers}
        criteria.update(extra_criteria)
        return [{"id": "c1", "user_id": "u1", "name": "Legacy Agent", "active": True,
                 "criteria": criteria}]

    def test_cinema_only_agent_without_trackv_is_migrated_onto_stream(self):
        movie = self._streaming_movie()
        cascades = self._cascade({})
        agent_films = [{"user_id": "u1", "cascade_id": "c1", "movie_id": "9002", "admission_score": 80}]
        auto_placements = compute_auto_placements(agent_films, cascades, [movie], account_prefs={})
        self.assertEqual(auto_placements, {("u1", "9002"): "stream"},
            "an agent stored cinema-only (no trackV) must follow its admission onto Stream once the "
            "film itself is streaming — the start-window migration did not reach placement")

    def test_cinema_only_agent_with_trackv2_stays_pinned_at_cinema(self):
        movie = self._streaming_movie()
        cascades = self._cascade({"trackV": 2})
        agent_films = [{"user_id": "u1", "cascade_id": "c1", "movie_id": "9002", "admission_score": 80}]
        auto_placements = compute_auto_placements(agent_films, cascades, [movie], account_prefs={})
        self.assertEqual(auto_placements, {("u1", "9002"): "in_cinema"},
            "an agent explicitly carrying trackV:2 (Stream deliberately off) must stay pinned at "
            "Cinema, the one window it actually tracks, not be migrated onto Stream")


class ForwardWindowMatchTests(unittest.TestCase):
    """CAS-918: an auto placement forward-matches a moment for the film's NEXT window even
    though film_watch.windows hasn't caught up yet — the overnight Rent -> Stream rollover this
    ticket exists for (an auto Watch On that reached the next window unwatched still alerts). A
    manual placement, or a moment for a window BEHIND the one already placed, never
    forward-matches — CAS-841's original fail-closed behaviour stands for both."""

    def _movie(self, tmdb_id=8001, title="Rolled-Over Film", status=("rental",)):
        return {"tmdb_id": tmdb_id, "title": title, "genres": ["Drama"], "status": list(status),
                "cinema_date": "2026-01-01", "language": "en", "wm_critic_score": 70, "popularity": 50,
                "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
                "wm_user_rating": 7.5}

    def _cascade(self, moments):
        return [{"id": "c1", "user_id": "u1", "name": "Everything", "active": True,
                 "alert_moments": list(moments), "criteria": _criteria(genre=["Drama"], imdb=7.0)}]

    def _match(self, cascades, transitions, film_watches, movie, placement_counts=None):
        admission = _admit(cascades, today=[movie])
        return match(cascades, transitions, admission=admission, film_watches=film_watches,
                    placement_counts=placement_counts)

    # ---- row 1: auto placement climbs forward to the next window ----
    def test_auto_placement_forward_matches_the_next_window(self):
        movie = self._movie()
        cascades = self._cascade(["hits_stream"])
        watches = [{"user_id": "u1", "movie_id": "8001", "windows": ["rent"],
                    "sources": {"rent": "auto"}}]
        t = Transition("8001", movie["title"], "hits_stream", movie=movie)
        hits = self._match(cascades, [t], watches, movie)
        self.assertEqual(len(hits.get("u1", [])), 1)
        self.assertEqual(hits["u1"][0].transition.moment, "hits_stream")

    # ---- row 2: a manual placement never forward-matches ----
    def test_manual_placement_never_forward_matches(self):
        movie = self._movie()
        cascades = self._cascade(["hits_stream"])
        watches = [{"user_id": "u1", "movie_id": "8001", "windows": ["rent"],
                    "sources": {"rent": "manual"}}]
        t = Transition("8001", movie["title"], "hits_stream", movie=movie)
        counts = {}
        hits = self._match(cascades, [t], watches, movie, placement_counts=counts)
        self.assertEqual(hits, {})
        self.assertEqual(counts, {"wrong_window": 1})

    # ---- row 3: a moment behind the film's own placement never matches ----
    def test_a_moment_behind_the_placement_never_matches(self):
        movie = self._movie()
        cascades = self._cascade(["hits_rent"])
        watches = [{"user_id": "u1", "movie_id": "8001", "windows": ["stream"],
                    "sources": {"stream": "auto"}}]
        t = Transition("8001", movie["title"], "hits_rent", movie=movie)
        self.assertEqual(self._match(cascades, [t], watches, movie), {})

    # ---- row 4: no placement row at all still fails closed ----
    def test_no_placement_row_still_fails_closed(self):
        movie = self._movie()
        cascades = self._cascade(["hits_stream"])
        t = Transition("8001", movie["title"], "hits_stream", movie=movie)
        counts = {}
        hits = self._match(cascades, [t], [], movie, placement_counts=counts)
        self.assertEqual(hits, {})
        self.assertEqual(counts, {"no_placement": 1})

    # ---- row 5: in_cinema auto placement climbs forward to hits_rent ----
    def test_in_cinema_auto_forward_matches_hits_rent(self):
        movie = self._movie()
        cascades = self._cascade(["hits_rent"])
        watches = [{"user_id": "u1", "movie_id": "8001", "windows": ["in_cinema"],
                    "sources": {"in_cinema": "auto"}}]
        t = Transition("8001", movie["title"], "hits_rent", movie=movie)
        hits = self._match(cascades, [t], watches, movie)
        self.assertEqual(len(hits.get("u1", [])), 1)


class OneAgentPerFilmTests(unittest.TestCase):
    """CAS-784: two of a user's active Cascades both catching the same film at the same moment
    collapse to one hit — the single lowest-`criteria.order` cascade — on email same as on screen
    (CAS-709's lowest-.order-wins rule)."""

    def _transitions(self):
        prev = [{"tmdb_id": 1, "title": "A", "status": ["in_cinema"], "cinema_date": "2026-01-01",
                 "offers": []}]
        today = [{"tmdb_id": 1, "title": "A", "status": ["rental"], "cinema_date": "2026-01-01",
                  "genres": [], "language": "en", "imdb_rating": 7.0, "imdb_votes": 5000,
                  "wm_user_rating": 7.5, "wm_critic_score": 70,
                  "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}]
        return compute_transitions(prev, today, RUN_DATE)

    def _cascades(self, order0, order1):
        c0 = {"id": "c0", "user_id": "u1", "name": "Zero", "active": True,
              "alert_moments": ["hits_rent"], "criteria": _criteria()}
        c1 = {"id": "c1", "user_id": "u1", "name": "One", "active": True,
              "alert_moments": ["hits_rent"], "criteria": _criteria()}
        if order0 is not None:
            c0["criteria"]["order"] = order0
        if order1 is not None:
            c1["criteria"]["order"] = order1
        return [c0, c1]

    def _match(self, cascades, ts):
        admission = _admit(cascades, today=[t.movie for t in ts])
        return match(cascades, ts, admission=admission, film_watches=_auto_placements(cascades, ts))

    def test_two_agents_matching_one_film_yield_one_hit_from_the_lower_order(self):
        ts = self._transitions()
        hits = self._match(self._cascades(0, 1), ts)["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c0")

    def test_order_is_read_regardless_of_which_cascade_comes_first(self):
        ts = self._transitions()
        cascades = self._cascades(0, 1)
        cascades.reverse()             # "c1" (order 1) now appears before "c0" (order 0)
        hits = self._match(cascades, ts)["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c0")

    def test_missing_order_never_beats_a_numeric_order(self):
        ts = self._transitions()
        hits = self._match(self._cascades(None, 0), ts)["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c1")   # c1 carries order 0; c0 carries none

    def test_a_film_watch_hit_with_no_matching_cascade_still_fires(self):
        ts = self._transitions()
        watches = [{"user_id": "u1", "movie_id": "1", "windows": ["rent"]}]
        hits = match_film_watches(watches, ts, cascade_hits=set())
        self.assertEqual(len(hits.get("u1", [])), 1)
        self.assertIsNone(hits["u1"][0].cascade_id)

    def test_two_users_each_matching_the_same_film_both_keep_their_own_hit(self):
        # The collapse is per-user: two different users' Cascades catching the same film/moment
        # are not duplicates of each other.
        ts = self._transitions()
        cascades = [
            {"id": "c0", "user_id": "u1", "name": "Zero", "active": True,
             "alert_moments": ["hits_rent"], "criteria": _criteria(order=0)},
            {"id": "c1", "user_id": "u2", "name": "One", "active": True,
             "alert_moments": ["hits_rent"], "criteria": _criteria(order=0)},
        ]
        by_user = self._match(cascades, ts)
        self.assertEqual(len(by_user.get("u1", [])), 1)
        self.assertEqual(len(by_user.get("u2", [])), 1)


class OwnerAttributionTests(unittest.TestCase):
    """CAS-925: every Hit is attributed to the film's OWNER — the same single-owner answer the
    app's filmOwnerCascade gives — not necessarily the cascade whose own moment fired it. Read from
    the live production ledger vs. Moving disagreeing about who "owns" a film (Runner/Practical
    Magic 2, 2026-09-12): the monitor attributed a hit to whichever agent fired it, the app has
    always named the lowest-rank admitting agent (or a hand-pin), and the two must now agree."""

    def _transitions(self, genres=None):
        prev = [{"tmdb_id": 1, "title": "A", "status": ["in_cinema"], "cinema_date": "2026-01-01",
                 "offers": []}]
        today = [{"tmdb_id": 1, "title": "A", "status": ["rental"], "cinema_date": "2026-01-01",
                  "genres": genres if genres is not None else ["Drama"], "language": "en",
                  "imdb_rating": 7.0, "imdb_votes": 5000, "wm_user_rating": 7.5, "wm_critic_score": 70,
                  "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}]
        return compute_transitions(prev, today, RUN_DATE)

    def _cascade(self, cid, order, moments=("hits_rent",), genre=None, channels=None):
        criteria = _criteria(order=order)
        if genre is not None:
            criteria["genre"] = genre
        if channels is not None:
            criteria["channelsLive"] = channels
        return {"id": cid, "user_id": "u1", "name": cid, "active": True,
                "alert_moments": list(moments), "criteria": criteria}

    def _match(self, cascades, ts, picks=None, already=None):
        admission = _admit(cascades, today=[t.movie for t in ts])
        return match(cascades, ts, admission=admission, film_watches=_auto_placements(cascades, ts),
                    picks=picks, already=already)

    def test_a_owner_is_the_lower_rank_admitting_agent_even_if_it_never_fired(self):
        # order-0 admits the Drama film but never asked for hits_rent; order-2 did ask and fires.
        c0 = self._cascade("c0", 0, moments=())
        c2 = self._cascade("c2", 2)
        hits = self._match([c0, c2], self._transitions())["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c0")

    def test_b_falls_to_the_firing_agent_when_the_lower_rank_one_doesnt_admit(self):
        # order-0 wants Horror only, so it does not admit this Drama film -> not a candidate owner.
        c0 = self._cascade("c0", 0, moments=(), genre=["Horror"])
        c2 = self._cascade("c2", 2)
        hits = self._match([c0, c2], self._transitions())["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c2")

    def test_c_a_hand_pin_wins_whatever_the_ranks_or_criteria_say(self):
        # order-5 is pinned in by hand; it wants Horror only (would not otherwise admit this film)
        # and never asked for hits_rent — none of that matters once it is pinned (CAS-709).
        c0 = self._cascade("c0", 0, moments=())
        c2 = self._cascade("c2", 2)
        c5 = self._cascade("c5", 5, moments=(), genre=["Horror"])
        picks = [{"user_id": "u1", "movie_id": "1", "pinned_to": ["c5"]}]
        hits = self._match([c0, c2, c5], self._transitions(), picks=picks)["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c5")

    def test_d_not_in_excludes_an_otherwise_admitting_lower_rank_agent(self):
        c0 = self._cascade("c0", 0)
        c2 = self._cascade("c2", 2, moments=())
        picks = [{"user_id": "u1", "movie_id": "1", "not_in": ["c0"]}]
        hits = self._match([c0, c2], self._transitions(), picks=picks)["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c2")

    def test_e_two_agents_firing_the_same_moment_still_yield_one_hit_naming_the_owner(self):
        c0 = self._cascade("c0", 0)
        c2 = self._cascade("c2", 2)
        hits = self._match([c0, c2], self._transitions())["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c0")

    def test_f_already_suppresses_by_the_firing_id_never_the_owner_id(self):
        c0 = self._cascade("c0", 0, moments=())       # owner-to-be; never itself fires
        c2 = self._cascade("c2", 2)                    # the firing agent
        ts = self._transitions()
        # keyed on the FIRING agent (c2): suppresses the hit entirely.
        suppressed = self._match([c0, c2], ts, already={("c2", "1", "hits_rent")})
        self.assertEqual(suppressed.get("u1", []), [])
        # keyed on the OWNER (c0), who never fired: does not suppress anything.
        unsuppressed = self._match([c0, c2], ts, already={("c0", "1", "hits_rent")})["u1"]
        self.assertEqual(len(unsuppressed), 1)
        self.assertEqual(unsuppressed[0].cascade_id, "c0")

    def test_g_channels_are_resolved_from_the_owners_criteria(self):
        c0 = self._cascade("c0", 0, moments=(), channels={"inApp": True, "email": False})
        c2 = self._cascade("c2", 2, channels={"inApp": True, "email": True})
        hits = self._match([c0, c2], self._transitions())["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c0")
        self.assertFalse(hits[0].wants("email"))
        self.assertTrue(hits[0].wants("in_app"))


class PerAgentChannels(unittest.TestCase):
    """CAS-244: the account decides which channels EXIST; an agent decides which of them it uses.

    The direction matters, and it is the whole reason the front end writes a resolved `channelsLive` rather
    than a raw preference: an agent must never be able to grant itself a channel the person switched off at
    the account level. Everything here is about narrowing.
    """

    def _hit(self, criteria):
        t = type("T", (), {"movie_id": "1", "moment": "hits_rent", "title": "A", "services": [], "price": None,
                           "movie": {}})()
        return Hit(user_id="u", cascade_id="c", cascade_name="Agent", transition=t,
                   channels=agent_channels(criteria))

    def test_an_agent_that_was_never_asked_accepts_everything(self):
        h = self._hit({})
        self.assertIsNone(h.channels)
        self.assertTrue(h.wants("email"))
        self.assertTrue(h.wants("in_app"))

    def test_an_agent_can_turn_a_channel_off_for_itself(self):
        h = self._hit({"channelsLive": {"inApp": True, "email": False}})
        self.assertTrue(h.wants("in_app"))
        self.assertFalse(h.wants("email"))

    def test_push_is_not_a_fourth_switch_it_rides_in_app(self):
        # CAS-465: no channelsLive.push key exists — push must track whatever in_app already says.
        self.assertTrue(self._hit({"channelsLive": {"inApp": True, "email": False}}).wants("push"))
        self.assertFalse(self._hit({"channelsLive": {"inApp": False, "email": True}}).wants("push"))

    def test_the_raw_per_agent_answer_is_never_what_delivery_reads(self):
        # `channels` is the agent's own wish and survives the account turning a channel off and on again.
        # `channelsLive` is that wish with the account's permission already applied, and it is the only one
        # the monitor may read — otherwise an agent would be deliverable on a channel the person disabled.
        h = self._hit({"channels": {"email": True}, "channelsLive": {"inApp": True, "email": False}})
        self.assertFalse(h.wants("email"))

    def test_a_malformed_override_is_ignored_rather_than_obeyed(self):
        for bad in (None, "yes", [], 3):
            self.assertIsNone(agent_channels({"channelsLive": bad}), f"{bad!r} was read as a channel map")

    def test_match_attaches_the_agent_answer_to_every_hit(self):
        prev = [{"tmdb_id": 1, "title": "A", "status": ["in_cinema"], "cinema_date": "2026-01-01",
                 "offers": []}]
        today = [{"tmdb_id": 1, "title": "A", "status": ["rental"], "cinema_date": "2026-01-01",
                  "genres": [], "language": "en", "imdb_rating": 7.0, "imdb_votes": 5000,
                  "wm_user_rating": 7.5, "wm_critic_score": 70,
                  "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}]
        ts = compute_transitions(prev, today, RUN_DATE)
        cascades = [{"id": "c1", "user_id": "u1", "name": "Quiet one", "active": True,
                     "alert_moments": ["hits_rent"],
                     "criteria": _criteria(channelsLive={"inApp": True, "email": False})}]
        admission = _admit(cascades, today=[t.movie for t in ts])
        hits = match(cascades, ts, admission=admission,
                    film_watches=_auto_placements(cascades, ts))["u1"]
        self.assertEqual(len(hits), 1)
        self.assertFalse(hits[0].wants("email"))
        self.assertTrue(hits[0].wants("in_app"))


class FilmWatchTests(unittest.TestCase):
    """CAS-484: a per-film Watch-it tick is a second, agent-independent hit source — it owes
    nothing to any Cascade's criteria or bell, and the two sources must still de-dupe to exactly
    one notification when they both catch the same (user, movie, moment)."""

    def _transitions(self, moment="hits_stream"):
        status = {"hits_rent": "rental", "hits_stream": "included_streaming",
                  "hits_pvod": "pvod", "hits_cinema": "in_cinema"}[moment]
        prev = [{"tmdb_id": 1, "title": "A", "status": ["in_cinema"] if moment != "hits_cinema" else [],
                 "cinema_date": "2026-01-01", "offers": []}]
        today = [{"tmdb_id": 1, "title": "A", "status": [status], "cinema_date": "2026-01-01",
                  "genres": [], "language": "en", "imdb_rating": 7.0, "imdb_votes": 5000,
                  "wm_user_rating": 7.5, "wm_critic_score": 70, "popularity": 50,
                  "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}]
        return compute_transitions(prev, today, RUN_DATE)

    def _cascade(self, moment="hits_stream"):
        return [{"id": "c1", "user_id": "u1", "name": "Streaming agent", "active": True,
                 "alert_moments": [moment], "criteria": _criteria()}]

    def _match(self, cascades, ts):
        admission = _admit(cascades, today=[t.movie for t in ts])
        return match(cascades, ts, admission=admission, film_watches=_auto_placements(cascades, ts))

    # ---- the four scenarios the ticket's AC calls out by name ----
    def test_per_film_tick_alone_fires(self):
        ts = self._transitions("hits_stream")
        watches = [{"user_id": "u1", "movie_id": "1", "windows": ["stream"]}]
        hits = match_film_watches(watches, ts)
        self.assertEqual(len(hits.get("u1", [])), 1)
        h = hits["u1"][0]
        self.assertIsNone(h.cascade_id)
        self.assertEqual(h.cascade_name, "Your picks")
        self.assertEqual(h.transition.moment, "hits_stream")
        self.assertTrue(h.wants("email") and h.wants("in_app") and h.wants("push"))

    def test_agent_bell_alone_fires(self):
        ts = self._transitions("hits_stream")
        by_user = self._match(self._cascade(), ts)
        self.assertEqual(len(by_user.get("u1", [])), 1)
        cascade_seen = {("u1", h.transition.movie_id, h.transition.moment) for h in by_user["u1"]}
        # No film_watch row at all -> the per-film path contributes nothing.
        self.assertEqual(match_film_watches([], ts, cascade_hits=cascade_seen), {})

    def test_both_together_fire_once(self):
        ts = self._transitions("hits_stream")
        by_user = self._match(self._cascade(), ts)
        cascade_seen = {("u1", h.transition.movie_id, h.transition.moment) for h in by_user["u1"]}
        watches = [{"user_id": "u1", "movie_id": "1", "windows": ["stream"]}]
        watch_hits = match_film_watches(watches, ts, cascade_hits=cascade_seen)
        self.assertEqual(watch_hits, {})   # already caught by the agent bell this run -> no 2nd hit
        total = sum(len(v) for v in by_user.values()) + sum(len(v) for v in watch_hits.values())
        self.assertEqual(total, 1)

    def test_neither_fires_nothing(self):
        ts = self._transitions("hits_stream")
        self.assertEqual(self._match([], ts), {})
        self.assertEqual(match_film_watches([], ts), {})

    # ---- supporting behaviour ----
    def test_ignores_a_moment_the_film_did_not_reach(self):
        ts = self._transitions("hits_rent")               # film reached rental, not streaming
        watches = [{"user_id": "u1", "movie_id": "1", "windows": ["stream"]}]
        self.assertEqual(match_film_watches(watches, ts), {})

    def test_unknown_window_key_is_ignored(self):
        ts = self._transitions("hits_stream")
        watches = [{"user_id": "u1", "movie_id": "1", "windows": ["not_a_real_window"]}]
        self.assertEqual(match_film_watches(watches, ts), {})

    def test_second_run_is_silent(self):
        ts = self._transitions("hits_stream")
        watches = [{"user_id": "u1", "movie_id": "1", "windows": ["stream"]}]
        first = match_film_watches(watches, ts)
        already = {(h.user_id, h.transition.movie_id, h.transition.moment)
                   for hits in first.values() for h in hits}
        self.assertEqual(match_film_watches(watches, ts, already=already), {})

    def test_global_exclude_mutes_a_per_film_tick_too(self):
        ts = self._transitions("hits_stream")
        watches = [{"user_id": "u1", "movie_id": "1", "windows": ["stream"]}]
        self.assertEqual(match_film_watches(watches, ts, excluded={"u1": ["hits_stream"]}), {})

    def test_two_users_ticking_the_same_film_both_fire(self):
        ts = self._transitions("hits_stream")
        watches = [{"user_id": "u1", "movie_id": "1", "windows": ["stream"]},
                   {"user_id": "u2", "movie_id": "1", "windows": ["stream"]}]
        hits = match_film_watches(watches, ts)
        self.assertEqual(set(hits), {"u1", "u2"})


class NewlyQualifiedTests(unittest.TestCase):
    """CAS-602: a film already held in both catalogues that newly qualifies for an agent because
    its OWN attributes changed — an IMDb rating crossing the agent's bar here, standing in for
    "some other aspect of it has changed such that it now appears when yesterday it didn't"."""

    def _movie(self, imdb, status=("rental",), tmdb_id=9001, title="Rising Star", **extra):
        m = {"tmdb_id": tmdb_id, "title": title, "genres": ["Drama"], "status": list(status),
             "cinema_date": "2026-01-01", "language": "en", "wm_critic_score": 70,
             "wm_popularity_percentile": 70,
             "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
             "wm_user_rating": imdb}
        m.update(extra)
        return m

    def _cascade(self, imdb_bar=7.0, moments=("hits_rent",), user_id="u1", cascade_id="c1"):
        return [{"id": cascade_id, "user_id": user_id, "name": "Drama radar", "active": True,
                 "alert_moments": list(moments),
                 "criteria": _criteria(genre=["Drama"], imdb=imdb_bar)}]

    def _match(self, cascades, prev, today, **kw):
        admission = _admit(cascades, today=today, yesterday=prev)
        return match_newly_qualified(cascades, prev, today, admission=admission, **kw)

    # ---- the five named scenarios (CAS-602 change item 5) ----
    def test_rising_rating_crosses_the_bar_fires_exactly_once(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        hits = self._match(self._cascade(imdb_bar=7.0), prev, today)
        self.assertEqual(len(hits.get("u1", [])), 1)
        h = hits["u1"][0]
        self.assertEqual(h.transition.moment, "newly_qualifies")
        self.assertEqual(h.transition.movie_id, "9001")
        self.assertEqual(h.cascade_id, "c1")

    def test_same_film_the_following_day_unchanged_does_not_fire_again(self):
        # Yesterday's run already lifted it above the bar; today it holds at the same rating.
        prev = [self._movie(7.5)]
        today = [self._movie(7.5)]
        hits = self._match(self._cascade(imdb_bar=7.0), prev, today)
        self.assertEqual(hits, {})

    def test_a_film_that_already_matched_yesterday_never_fires(self):
        # Already above the bar yesterday; a further rise today changes nothing about "newly".
        prev = [self._movie(8.0)]
        today = [self._movie(9.0)]
        hits = self._match(self._cascade(imdb_bar=7.0), prev, today)
        self.assertEqual(hits, {})

    def test_a_film_absent_from_yesterday_never_fires(self):
        # That is `announced`'s job, not this one's.
        today = [self._movie(9.0)]
        hits = self._match(self._cascade(imdb_bar=7.0), [], today)
        self.assertEqual(hits, {})

    def test_gate_honours_alert_moments(self):
        # The film's current window is `rental` (-> hits_rent), but the cascade only asked for
        # hits_cinema — the mapped moment must be one the cascade actually asks for.
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        hits = self._match(self._cascade(imdb_bar=7.0, moments=("hits_cinema",)), prev, today)
        self.assertEqual(hits, {})

    def test_gate_honours_the_global_mute(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        hits = self._match(self._cascade(imdb_bar=7.0, moments=("hits_rent",)), prev, today,
                           excluded={"u1": ["hits_rent"]})
        self.assertEqual(hits, {})

    # ---- supporting behaviour ----
    def test_upcoming_film_maps_to_announced(self):
        prev = [self._movie(6.5, status=("upcoming",))]
        today = [self._movie(7.5, status=("upcoming",), popularity=50)]
        hits = self._match(self._cascade(imdb_bar=7.0, moments=("announced",)), prev, today)
        self.assertEqual(len(hits.get("u1", [])), 1)
        self.assertEqual(hits["u1"][0].transition.moment, "newly_qualifies")

    def test_second_run_with_the_same_ledger_is_silent(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        first = self._match(self._cascade(imdb_bar=7.0), prev, today)
        already = {(h.cascade_id, h.transition.movie_id, h.transition.moment)
                   for hits in first.values() for h in hits}
        second = self._match(self._cascade(imdb_bar=7.0), prev, today, already=already)
        self.assertEqual(second, {})

    def test_suppressed_pair_outranks_the_qualification(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        hits = self._match(self._cascade(imdb_bar=7.0), prev, today,
                           suppressed={("u1", "9001")})
        self.assertEqual(hits, {})

    def test_service_filter_applies_to_a_streaming_qualification(self):
        prev = [self._movie(6.5, status=("included_streaming",), offers=[])]
        today = [self._movie(7.5, status=("included_streaming",),
                             offers=[{"service": "Netflix", "type": "sub"}])]
        cascades = [{"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
                     "alert_moments": ["hits_stream"],
                     "criteria": _criteria(genre=["Drama"], imdb=7.0, services=["Stan"])}]
        hits = self._match(cascades, prev, today)
        self.assertEqual(hits, {})   # Netflix isn't Stan -> filtered out

    def test_inactive_cascade_ignored(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        cascades = self._cascade(imdb_bar=7.0)
        cascades[0]["active"] = False
        self.assertEqual(self._match(cascades, prev, today), {})

    def test_secondary_style_match_in_both_snapshots_never_fires(self):
        # CAS-1147 AC4: a film admitted only because the agent's wanted style sits SECOND in its
        # genre list, present unchanged in both catalogues — the any-style rule admits it both days
        # (same engine, same criteria, Lee's rule from 2026-08-24 above), so it must never read as
        # "newly" qualifying.
        movie = self._movie(7.5, genres=["Drama", "Thriller"])
        cascades = [{"id": "c1", "user_id": "u1", "name": "Thriller radar", "active": True,
                     "alert_moments": ["hits_rent"],
                     "criteria": _criteria(genre=["Thriller"], imdb=7.0)}]
        hits = self._match(cascades, [movie], [movie])
        self.assertEqual(hits, {})

    def test_two_agents_newly_qualifying_for_one_film_collapse_to_the_lower_order(self):
        # CAS-784: same one-film-one-agent rule applies here as in match().
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        cascades = [
            {"id": "c0", "user_id": "u1", "name": "Zero", "active": True,
             "alert_moments": ["hits_rent"],
             "criteria": _criteria(genre=["Drama"], imdb=7.0, order=1)},
            {"id": "c1", "user_id": "u1", "name": "One", "active": True,
             "alert_moments": ["hits_rent"],
             "criteria": _criteria(genre=["Drama"], imdb=7.0, order=0)},
        ]
        hits = self._match(cascades, prev, today)["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c1")


class NewToAgentTests(unittest.TestCase):
    """CAS-785: a film already held in both catalogues that starts matching an agent for the first
    time — the same day-over-day test as NewlyQualifiedTests, fired only when the agent itself has
    been stable (unedited) since before the previous run, and independent of any window moment."""

    PREV_RUN_START = _dt.datetime(2026, 7, 15, 20, 0, tzinfo=_dt.timezone.utc)
    STABLE = "2026-07-10T00:00:00+00:00"

    def _movie(self, imdb, status=("rental",), tmdb_id=9101, title="Quiet Riser", **extra):
        m = {"tmdb_id": tmdb_id, "title": title, "genres": ["Drama"], "status": list(status),
             "cinema_date": "2026-01-01", "language": "en", "wm_critic_score": 70,
             "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
             "wm_user_rating": imdb}
        m.update(extra)
        return m

    def _cascade(self, imdb_bar=7.0, updated_at=STABLE, user_id="u1", cascade_id="c1"):
        return [{"id": cascade_id, "user_id": user_id, "name": "Drama radar", "active": True,
                 "alert_moments": [], "criteria": _criteria(genre=["Drama"], imdb=imdb_bar),
                 "updated_at": updated_at}]

    def _match(self, cascades, prev, today, previous_run_start=PREV_RUN_START, **kw):
        admission = _admit(cascades, today=today, yesterday=prev)
        return match_new_to_agent(cascades, prev, today, previous_run_start,
                                  admission=admission, **kw)

    # ---- CAS-785 AC1(a) ----
    def test_stable_agent_first_appearance_fires_once(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        hits = self._match(self._cascade(imdb_bar=7.0), prev, today)
        self.assertEqual(len(hits.get("u1", [])), 1)
        h = hits["u1"][0]
        self.assertEqual(h.transition.moment, "new_to_agent")
        self.assertEqual(h.transition.movie_id, "9101")
        self.assertEqual(h.cascade_id, "c1")

    # ---- CAS-785 AC1(b) ----
    def test_agent_edited_inside_the_window_stays_silent(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        recent = "2026-07-16T01:00:00+00:00"      # after previous_run_start -> inside the window
        hits = self._match(self._cascade(imdb_bar=7.0, updated_at=recent), prev, today)
        self.assertEqual(hits, {})

    def test_edit_exactly_at_the_boundary_counts_as_inside_the_window(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        boundary = self.PREV_RUN_START.isoformat()
        hits = self._match(self._cascade(imdb_bar=7.0, updated_at=boundary), prev, today)
        self.assertEqual(hits, {})

    def test_missing_updated_at_fails_closed(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        cascades = self._cascade(imdb_bar=7.0)
        del cascades[0]["updated_at"]
        self.assertEqual(self._match(cascades, prev, today), {})

    # ---- CAS-785 AC1(c) ----
    def test_first_appearance_plus_a_window_transition_fires_once_not_twice(self):
        prev = [{"tmdb_id": 9102, "title": "Double Mover", "genres": ["Drama"], "status": [],
                 "cinema_date": "2026-07-16", "offers": [], "wm_user_rating": 6.5}]
        today = [{"tmdb_id": 9102, "title": "Double Mover", "genres": ["Drama"], "status": ["in_cinema"],
                  "cinema_date": "2026-07-16", "offers": [], "language": "en", "wm_critic_score": 70,
                  "popularity": 50, "wm_popularity_percentile": 70, "wm_user_rating": 7.5}]
        transitions = compute_transitions(prev, today, _dt.date(2026, 7, 16))
        cascade = {"id": "c1", "user_id": "u1", "name": "Drama radar", "active": True,
                   "alert_moments": ["hits_cinema"], "criteria": _criteria(genre=["Drama"], imdb=7.0),
                   "updated_at": self.STABLE}
        window_admission = _admit([cascade], today=[t.movie for t in transitions])
        window_hits = match([cascade], transitions, admission=window_admission,
                           film_watches=_auto_placements([cascade], transitions))
        covered = {(h.user_id, h.transition.movie_id)
                   for hits in window_hits.values() for h in hits}
        new_admission = _admit([cascade], today=today, yesterday=prev)
        new_hits = match_new_to_agent([cascade], prev, today, self.PREV_RUN_START,
                                      admission=new_admission, covered=covered)
        total = sum(len(v) for v in window_hits.values()) + sum(len(v) for v in new_hits.values())
        self.assertEqual(total, 1)
        self.assertEqual(window_hits["u1"][0].transition.moment, "hits_cinema")

    # ---- CAS-1041 ----
    def test_newly_qualifies_and_new_to_agent_for_two_agents_of_one_user_fire_once_not_twice(self):
        # Reproduces QA-260920-1: user has two active cascades and the SAME film crosses both bars
        # on the same day. Within match_newly_qualified() alone, CAS-784's own collapse already
        # reduces the two cascades' hits to one (owned by the lower-`order` cascade, CAS-925). But
        # match_new_to_agent() is a separate call with its own local collapse, blind to what
        # match_newly_qualified() already produced except via `covered` — and `covered` used to be
        # keyed by the OWNER's cascade_id, not the id of whichever cascade's own criteria actually
        # changed. That let the second cascade's own transition slip past the covered check, get
        # re-attributed to the same owner by CAS-925, and fire a second, redundant alert.
        prev = [self._movie(6.5, tmdb_id=9103, title="Split Alert")]
        today = [self._movie(7.5, tmdb_id=9103, title="Split Alert")]
        owner = {"id": "c-owner", "user_id": "u1", "name": "Massive Movies", "active": True,
                 "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"], imdb=7.0, order=0),
                 "updated_at": self.STABLE}
        other = {"id": "c-other", "user_id": "u1", "name": "Other Radar", "active": True,
                 "alert_moments": ["hits_rent"], "criteria": _criteria(genre=["Drama"], imdb=7.0, order=1),
                 "updated_at": self.STABLE}
        cascades = [owner, other]
        admission = _admit(cascades, today=today, yesterday=prev)

        newly_qualified_hits = match_newly_qualified(cascades, prev, today, admission=admission)
        self.assertEqual(sum(len(v) for v in newly_qualified_hits.values()), 1)
        self.assertEqual(newly_qualified_hits["u1"][0].cascade_id, "c-owner")

        covered = {(h.user_id, h.transition.movie_id)
                   for hits in newly_qualified_hits.values() for h in hits}
        new_to_agent_hits = match_new_to_agent(cascades, prev, today, self.PREV_RUN_START,
                                               admission=admission, covered=covered)
        total = (sum(len(v) for v in newly_qualified_hits.values()) +
                 sum(len(v) for v in new_to_agent_hits.values()))
        self.assertEqual(total, 1, "same (agent, film) pair must not alert twice across the two paths")

    # ---- CAS-785 AC1(d) ----
    def test_second_run_with_the_same_ledger_is_silent(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        first = self._match(self._cascade(imdb_bar=7.0), prev, today)
        already = {(h.cascade_id, h.transition.movie_id, h.transition.moment)
                   for hits in first.values() for h in hits}
        second = self._match(self._cascade(imdb_bar=7.0), prev, today, already=already)
        self.assertEqual(second, {})

    # ---- supporting behaviour ----
    def test_a_film_that_already_matched_yesterday_never_fires(self):
        prev = [self._movie(8.0)]
        today = [self._movie(9.0)]
        hits = self._match(self._cascade(imdb_bar=7.0), prev, today)
        self.assertEqual(hits, {})

    def test_a_film_absent_from_yesterday_never_fires(self):
        today = [self._movie(9.0)]
        hits = self._match(self._cascade(imdb_bar=7.0), [], today)
        self.assertEqual(hits, {})

    def test_gate_honours_the_global_mute(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        hits = self._match(self._cascade(imdb_bar=7.0), prev, today,
                           excluded={"u1": ["new_to_agent"]})
        self.assertEqual(hits, {})

    def test_suppressed_pair_outranks_the_qualification(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        hits = self._match(self._cascade(imdb_bar=7.0), prev, today,
                           suppressed={("u1", "9101")})
        self.assertEqual(hits, {})

    def test_inactive_cascade_ignored(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        cascades = self._cascade(imdb_bar=7.0)
        cascades[0]["active"] = False
        self.assertEqual(self._match(cascades, prev, today), {})

    def test_two_agents_first_appearance_collapse_to_the_lower_order(self):
        # CAS-784: same one-film-one-agent rule applies here as in match()/match_newly_qualified.
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        cascades = [
            {"id": "c0", "user_id": "u1", "name": "Zero", "active": True, "alert_moments": [],
             "criteria": _criteria(genre=["Drama"], imdb=7.0, order=1), "updated_at": self.STABLE},
            {"id": "c1", "user_id": "u1", "name": "One", "active": True, "alert_moments": [],
             "criteria": _criteria(genre=["Drama"], imdb=7.0, order=0), "updated_at": self.STABLE},
        ]
        hits = self._match(cascades, prev, today)["u1"]
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].cascade_id, "c1")


class AwardsAdmissionTests(unittest.TestCase):
    """CAS-1195: compute_admission() -> admit_shim.mjs now admits on matchesCriteria AND awardsListOK —
    the listing's own rule — not matchesCriteria alone, which waives the Awards requirement for a
    pre-release film (CAS-780, correct for WATCHES, wrong for "would the listing show this"). AC4 (an
    agent with no Awards requirement is unaffected) is covered at the engine level, where it can be
    checked against the real movies.json directly: tests/js/cas1195-award-admission.test.mjs."""

    def _movie(self, tmdb_id, status, award=None):
        m = {"tmdb_id": tmdb_id, "title": f"CAS-1195 {tmdb_id}", "status": list(status),
             "genres": ["Drama"], "age_rating": "M", "language": "en", "cinema_date": "2026-08-01",
             "wm_critic_score": 70, "popularity": 50, "wm_popularity_percentile": 70,
             "wm_user_rating": 7.5,
             # showable() needs a real offer behind a RELEASED (non-upcoming/in-cinema) fixture —
             # cinemas/upcoming carry none and are exempted by isUpcoming/inCinemaConfirmed instead.
             "offers": [] if status == ["upcoming"] else [{"provider": "Test"}]}
        if award is not None:
            m["award"] = award
        return m

    def _cascade(self):
        # kind:"stream" matters: normCascade's laneCrit zeroes selAwards for the default kind:"cinema"
        # lane (status:[] -> "cinema"), which would silently disable the very gate under test.
        return [{"id": "c1", "user_id": "u1", "name": "Nominees & Awards", "active": True,
                 "alert_moments": ["opens_soon", "announced"],
                 "criteria": _criteria(kind="stream", selAwards=4)}]  # 4 = AWARD_STOPS' "Winner" index

    # ---- AC1 ----
    def test_unawarded_upcoming_film_not_admitted_in_either_snapshot(self):
        movie = self._movie(9301, ["upcoming"])
        admission = _admit(self._cascade(), today=[movie], yesterday=[movie])
        self.assertNotIn("9301", admission["c1"]["today"])
        self.assertNotIn("9301", admission["c1"]["yesterday"])

    # ---- AC2 ----
    def test_won_upcoming_film_is_admitted_in_both_snapshots(self):
        movie = self._movie(9301, ["upcoming"], award="won")
        admission = _admit(self._cascade(), today=[movie], yesterday=[movie])
        self.assertIn("9301", admission["c1"]["today"])
        self.assertIn("9301", admission["c1"]["yesterday"])

    # ---- AC3 ----
    def test_released_film_follows_the_same_unawarded_awarded_split(self):
        unawarded = self._movie(9302, ["included_streaming"])
        admission = _admit(self._cascade(), today=[unawarded])
        self.assertNotIn("9302", admission["c1"]["today"])

        awarded = self._movie(9303, ["included_streaming"], award="won")
        admission = _admit(self._cascade(), today=[awarded])
        self.assertIn("9303", admission["c1"]["today"])


class AlertsOffGateTests(unittest.TestCase):
    """CAS-1198 AC4: an agent whose own Alerts switch is off writes alert_moments:[] (app-side) and
    produces no hit from match, match_newly_qualified or match_new_to_agent. A film the member has
    given a hand-set Watch On still produces its hit through match_film_watches regardless — that
    path owes nothing to any agent's criteria or bell (CAS-484)."""

    PREV_RUN_START = _dt.datetime(2026, 7, 16, 20, 0, tzinfo=_dt.timezone.utc)

    def _movie(self, imdb, status=("rental",), tmdb_id=9501, title="Quiet Agent Film", **extra):
        m = {"tmdb_id": tmdb_id, "title": title, "genres": ["Drama"], "status": list(status),
             "cinema_date": "2026-01-01", "language": "en", "wm_critic_score": 70,
             "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}],
             "wm_user_rating": imdb}
        m.update(extra)
        return m

    def _transitions(self):
        prev = [{"tmdb_id": 9501, "title": "Quiet Agent Film", "status": [], "cinema_date": "2026-01-01",
                 "offers": []}]
        today = [self._movie(7.5, status=("rental",))]
        return compute_transitions(prev, today, RUN_DATE)

    def _cascade(self, alerts_on, updated_at="2026-07-10T00:00:00+00:00"):
        return [{"id": "c1", "user_id": "u1", "name": "An agent", "active": True,
                 "alert_moments": [],   # what alertLive()/momentsOf() write app-side when alertsOn is false
                 "criteria": _criteria(genre=["Drama"], imdb=7.0, alertsOn=alerts_on),
                 "updated_at": updated_at}]

    def test_match_fires_nothing_when_alert_moments_is_empty(self):
        ts = self._transitions()
        cascades = self._cascade(alerts_on=False)
        admission = _admit(cascades, today=[t.movie for t in ts])
        hits = match(cascades, ts, admission=admission, film_watches=_auto_placements(cascades, ts))
        self.assertEqual(hits, {})

    def test_newly_qualified_fires_nothing_when_alert_moments_is_empty(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        cascades = self._cascade(alerts_on=False)
        admission = _admit(cascades, today=today, yesterday=prev)
        hits = match_newly_qualified(cascades, prev, today, admission=admission)
        self.assertEqual(hits, {})

    def test_new_to_agent_fires_nothing_when_the_agents_own_alerts_switch_is_off(self):
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        cascades = self._cascade(alerts_on=False)
        admission = _admit(cascades, today=today, yesterday=prev)
        hits = match_new_to_agent(cascades, prev, today, self.PREV_RUN_START, admission=admission)
        self.assertEqual(hits, {})

    def test_new_to_agent_still_fires_when_alerts_are_on_despite_no_window_alerts(self):
        # CAS-785's deliberate design, preserved: alert_moments empty because no WINDOW alert is
        # switched on must not by itself silence this moment — only the agent's OWN Alerts switch does.
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        cascades = self._cascade(alerts_on=True)
        admission = _admit(cascades, today=today, yesterday=prev)
        hits = match_new_to_agent(cascades, prev, today, self.PREV_RUN_START, admission=admission)
        self.assertEqual(len(hits.get("u1", [])), 1)

    def test_new_to_agent_still_fires_when_alerts_on_is_simply_missing(self):
        # A row the app hasn't yet corrected to carry the new field (CAS-1198 item 2: "existing agents
        # correct themselves the next time the app boots") must fail open, not silently mute every
        # pre-existing agent the moment this ticket ships.
        prev = [self._movie(6.5)]
        today = [self._movie(7.5)]
        cascades = self._cascade(alerts_on=False)
        del cascades[0]["criteria"]["alertsOn"]
        admission = _admit(cascades, today=today, yesterday=prev)
        hits = match_new_to_agent(cascades, prev, today, self.PREV_RUN_START, admission=admission)
        self.assertEqual(len(hits.get("u1", [])), 1)

    def test_match_film_watches_still_fires_regardless_of_the_agents_alerts_switch(self):
        ts = self._transitions()
        watches = [{"user_id": "u1", "movie_id": "9501", "windows": ["rent"]}]
        hits = match_film_watches(watches, ts)
        self.assertEqual(len(hits.get("u1", [])), 1)
        self.assertIsNone(hits["u1"][0].cascade_id)


if __name__ == "__main__":
    unittest.main()
