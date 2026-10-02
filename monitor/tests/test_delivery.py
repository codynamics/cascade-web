"""Delivery preferences and the two channels (CAS-185).

Alerts became real in two directions at once: the ledger stopped being only an email de-dupe
and became the in-app delivery, and how a user wants to be told moved from a device to their
account. Both are decisions the daily job makes without anyone watching, so both are tested
here rather than left to the run's own output.
"""
import unittest

from monitor import (PREFS_DEFAULT, compute_admission, delivery_plan, excludes_from_prefs, match,
                     prefs_for)
from monitor.matching import MOMENT_TO_WINDOW
from monitor.store import InMemoryStore
from monitor.transitions import Transition

# CAS-825: admission is asked of the real engine now, so every fixture cascade needs a usable
# watchMarkers window and every fixture movie needs enough of a quality signal (wm_user_rating/
# wm_critic_score here) to clear the score gate — see monitor/tests/test_matching.py's own header
# note. CAS-1128: a 0 marker is no longer a score-gate bypass — normCascade migrates it to
# TRACK_MIN, a real floor an unscored or low-scored fixture film can fail same as any other.
_OPEN_MARKERS = {"in_cinema": 0, "rent": 0, "stream": 0}


def _movie(mid="9001", title="Fixture Film", **over):
    m = {"tmdb_id": int(mid), "title": title, "genres": ["Drama"], "language": "en",
         "age_rating": "M", "status": ["rental"], "popularity": 10,
         "wm_user_rating": 7.5, "wm_critic_score": 70,
         "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}
    m.update(over)
    return m


def _transition(moment="hits_rent", movie=None, services=("AppleTV",)):
    movie = movie or _movie()
    return Transition(movie_id=str(movie["tmdb_id"]), title=movie["title"], moment=moment,
                      movie=movie, services=list(services), price=6.99)


def _cascade(cid="c1", user="user-A", moments=("hits_rent",), criteria=None):
    crit = {**(criteria or {}), "watchMarkers": dict(_OPEN_MARKERS)}
    return {"id": cid, "user_id": user, "name": "Drama rentals", "active": True,
            "criteria": crit, "alert_moments": list(moments)}


def _auto_placements(cascades, transitions):
    """CAS-841: stand in for the app's own auto-placement (CAS-726) — every window-arrival
    transition here is treated as already placed in its own window, matching what these fixtures
    assumed before the ticket existed."""
    return [{"user_id": c["user_id"], "movie_id": t.movie_id, "windows": [MOMENT_TO_WINDOW[t.moment]]}
           for c in cascades for t in transitions if t.moment in MOMENT_TO_WINDOW]


def _match(cascades, transitions, film_watches=None, **kw):
    admission = compute_admission(cascades, {"today": [t.movie for t in transitions]})
    if film_watches is None:
        film_watches = _auto_placements(cascades, transitions)
    return match(cascades, transitions, admission=admission, film_watches=film_watches, **kw)


class PrefsDefaults(unittest.TestCase):
    def test_a_user_with_no_row_gets_the_apps_own_defaults(self):
        # Never having opened the notify screen is not the same as wanting nothing.
        self.assertEqual(prefs_for({}, "nobody"), PREFS_DEFAULT)
        self.assertTrue(prefs_for({}, "nobody")["in_app"])
        self.assertFalse(prefs_for({}, "nobody")["email_on"])

    def test_a_partial_row_only_overrides_what_it_states(self):
        got = prefs_for({"u": {"email_on": True}}, "u")
        self.assertTrue(got["email_on"])
        self.assertTrue(got["in_app"])          # untouched by a row that says nothing about it
        self.assertIsNone(got["email_address"])

    def test_an_explicit_false_is_kept(self):
        self.assertFalse(prefs_for({"u": {"in_app": False}}, "u")["in_app"])

    def test_a_null_column_is_not_an_answer(self):
        # Postgres hands back nulls for columns nobody has set; those must fall back, not
        # overwrite the default with None.
        self.assertTrue(prefs_for({"u": {"in_app": None}}, "u")["in_app"])


class DeliveryPlan(unittest.TestCase):
    def test_email_when_asked_for_and_we_have_an_address(self):
        self.assertEqual(delivery_plan({"email_on": True, "in_app": True}, "a@b.test"), "email")

    def test_wait_when_email_is_asked_for_and_there_is_no_address(self):
        # Writing the ledger here would mark the alert delivered when nobody was told.
        self.assertEqual(delivery_plan({"email_on": True, "in_app": True}, None), "wait")

    def test_in_app_alone_still_delivers(self):
        self.assertEqual(delivery_plan({"email_on": False, "in_app": True}, None), "inapp")

    def test_both_off_delivers_nothing(self):
        self.assertEqual(delivery_plan({"email_on": False, "in_app": False}, "a@b.test"), "none")


class GlobalMutes(unittest.TestCase):
    def test_a_muted_moment_never_fires_for_that_user(self):
        prefs = {"user-A": {"excluded_moments": ["hits_rent"]}}
        got = _match([_cascade()], [_transition()], excluded=excludes_from_prefs(prefs))
        self.assertEqual(got, {})

    def test_a_mute_is_per_user_and_does_not_leak(self):
        prefs = {"user-B": {"excluded_moments": ["hits_rent"]}}
        got = _match([_cascade()], [_transition()], excluded=excludes_from_prefs(prefs))
        self.assertEqual(len(got["user-A"]), 1)


class LedgerRow(unittest.TestCase):
    def test_the_row_carries_what_the_bell_needs_to_draw_itself(self):
        # The in-app surface must not have to re-derive the film from today's catalogue: a film
        # that has since left it would blank a row about something that really did happen.
        hits = _match([_cascade()], [_transition()])["user-A"]
        row = hits[0].notification_row()
        self.assertEqual(row["user_id"], "user-A")
        self.assertEqual(row["cascade_id"], "c1")
        self.assertEqual(row["moment"], "hits_rent")
        self.assertEqual(row["cascade_name"], "Drama rentals")
        self.assertEqual(row["title"], "Fixture Film")

    def test_a_film_crossing_a_watched_window_produces_exactly_one_alert(self):
        # CAS-185 AC3, without waiting for a real window change: the transition fires once, and
        # a second run over the same ledger says nothing.
        cascades, trans = [_cascade()], [_transition()]
        first = _match(cascades, trans)
        self.assertEqual(len(first["user-A"]), 1)
        already = {(h.cascade_id, h.transition.movie_id, h.transition.moment)
                   for h in first["user-A"]}
        self.assertEqual(_match(cascades, trans, already=already), {})


class StoreSources(unittest.TestCase):
    def test_the_in_memory_store_serves_prefs_and_picks(self):
        store = InMemoryStore(prefs={"u": {"in_app": False}},
                              picks=[{"user_id": "u", "movie_id": "1", "state": "off"}])
        self.assertFalse(store.fetch_notify_prefs()["u"]["in_app"])
        self.assertEqual(store.fetch_picks()[0]["state"], "off")

    def test_an_empty_store_still_answers(self):
        store = InMemoryStore()
        self.assertEqual(store.fetch_notify_prefs(), {})
        self.assertEqual(store.fetch_picks(), [])


if __name__ == "__main__":
    unittest.main()
