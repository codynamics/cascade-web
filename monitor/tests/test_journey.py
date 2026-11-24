"""CAS-1554: the film journey simulator, against an in-memory store (no network).

Every qa/journeys/*.json is run through the REAL admission / placement / score engine (node + the built index.html)
and the real find/push/email phases, with the four QA accounts built by the app's own engine
(monitor/tests/_journey_env.py) and a committed 159-film slice of the real catalogue. Only the accounts a journey
involves are run here (the workflow runs all four) so the suite stays quick.

Run:  python -m unittest monitor.tests.test_journey   (from the repo root; needs Node on PATH)
"""
import glob
import io
import json
import os
import unittest
from unittest import mock

import yaml

from monitor import journey
from monitor.tests._journey_env import ROOT, build_store, fixture_catalogue

JOURNEYS = sorted(glob.glob(os.path.join(ROOT, "qa", "journeys", "*.json")))
CATALOGUE = fixture_catalogue()


def accounts_involved(j: dict) -> list:
    """The accounts a journey mentions (criteria, expectations, member actions); 'a' when it names none."""
    keys = set()
    crit = j.get("criteria") or {}
    for k in ("qualifies", "not_qualifies", "below_bar"):
        keys |= set(crit.get(k) or [])
    keys |= set((crit.get("genre_state") or {}))
    for s in j["steps"]:
        keys |= set((s.get("expect") or {}))
        for a in (s.get("before") or []) + (s.get("after") or []):
            keys.add(a["account"])
    return sorted(keys) or ["a"]


def run_journey(j: dict, keys=None, **kw):
    store, accounts = build_store()
    keys = keys or accounts_involved(j)
    lines = []
    rc = journey.run_journey(j, store, {k: accounts[k] for k in keys}, CATALOGUE, out=lines.append, **kw)
    return rc, lines, store, accounts


def one_step_journey(expect, **extra):
    """lee+qa-a, in cinemas: the one step that alerts her."""
    j = {"name": "unit", "criteria": {"genres": ["Drama", "Thriller", "Crime"], "qualifies": ["a"]},
         "start": {"date": "2026-12-13", "status": ["upcoming"], "release_date": "2026-12-20", "offers": []},
         "steps": [{"name": "in cinemas", "date": "2026-12-20", "status": ["in_cinema"],
                    "release_date": "2026-12-20", "offers": [], "expect": expect}]}
    j.update(extra)
    return j


class EveryJourneyFile(unittest.TestCase):
    def test_all_twelve_journeys_ship(self):
        names = {os.path.splitext(os.path.basename(p))[0] for p in JOURNEYS}
        self.assertEqual(names, {
            "full-run", "not-my-service", "alerts-off-genre", "watched-before-rent", "not-for-me",
            "catchup-overlap", "below-bar", "genre-off", "age-rating", "window-not-followed", "backwards",
            "repeat-day"})

    def test_each_journey_runs_clean(self):
        for path in JOURNEYS:
            j = journey.load_journey(path)
            with self.subTest(journey=j["name"]):
                rc, lines, _, _ = run_journey(j)
                text = "\n".join(lines)
                if j.get("known_disagreement"):
                    # The shipped engine disagrees with what the ticket expects. The runner reports it as a FAIL
                    # for a human to judge; this pins that it still does (and why), so a product fix flips it.
                    self.assertEqual(rc, 1, text)
                    self.assertIn("FAIL", text)
                else:
                    self.assertEqual(rc, 0, text)
                    self.assertNotIn("FAIL", text)


class TheCheckIsStrict(unittest.TestCase):
    def test_wrong_expect_exits_non_zero_and_names_the_step(self):
        j = one_step_journey({})    # the engine alerts a in cinemas; this journey claims none
        rc, lines, _, _ = run_journey(j)
        self.assertEqual(rc, 1)
        bad = [l for l in lines if l.startswith("FAIL")]
        self.assertTrue(bad, lines)
        self.assertIn("step=1 (in cinemas)", bad[0])
        self.assertIn("account=a", bad[0])
        self.assertIn("unexpected", bad[0])

    def test_a_missing_expected_alert_is_a_fail(self):
        j = one_step_journey({"a": [{"moment": "hits_cinema", "channels": ["in_app", "push", "email"]}]})
        j["steps"][0]["status"] = ["upcoming"]    # no move at all: nothing happens, yet one is expected
        j["steps"][0]["release_date"] = "2026-12-20"
        rc, lines, _, _ = run_journey(j)
        self.assertEqual(rc, 1)
        self.assertTrue(any(l.startswith("FAIL") and "missing" in l for l in lines), lines)

    def test_an_alert_for_another_film_is_a_fail(self):
        j = one_step_journey({"a": [{"moment": "hits_cinema", "channels": ["in_app", "push", "email"]}]})
        real_find = journey._run_engine_find

        def find_and_stray(store, today, yesterday, date, uid, held):
            out = real_find(store, today, yesterday, date, uid, held)
            store.insert_notifications([{"id": "stray-1", "user_id": uid, "cascade_id": "c-x", "movie_id": "42",
                                         "moment": "hits_stream", "title": "Stray", "cascade_name": "x",
                                         "found_at": "2999-01-01T00:00:00+00:00", "read_at": "2999-01-01T00:00:00+00:00"}])
            return out

        with mock.patch.object(journey, "_run_engine_find", find_and_stray):
            rc, lines, _, _ = run_journey(j)
        self.assertEqual(rc, 1)
        self.assertTrue(any(l.startswith("FAIL") and "OTHER[42]" in l for l in lines), lines)

    def test_a_criteria_set_no_film_meets_is_a_setup_fail(self):
        j = one_step_journey({}, criteria={"genres": ["Drama"], "qualifies": ["a"], "not_qualifies": ["a"]})
        rc, lines, _, _ = run_journey(j)
        self.assertEqual(rc, 2)
        self.assertTrue(lines[0].startswith("SETUP FAIL"), lines)
        self.assertFalse(any(l.startswith("PASS") or l.startswith("FAIL") for l in lines))

    def test_no_film_with_the_right_genre_is_a_setup_fail(self):
        j = one_step_journey({}, criteria={"genres": ["No Such Genre"], "qualifies": ["a"]})
        rc, lines, _, _ = run_journey(j)
        self.assertEqual(rc, 2)
        self.assertIn("SETUP FAIL", lines[0])


class Cleanup(unittest.TestCase):
    def _spy(self, store):
        calls = []
        real = store.purge_journey_state

        def purge(user_ids, movie_id=None):
            calls.append((sorted(user_ids), movie_id))
            return real(user_ids, movie_id)
        store.purge_journey_state = purge
        return calls

    def test_cleanup_runs_before_and_after_even_after_a_fail(self):
        store, accounts = build_store()
        calls = self._spy(store)
        j = one_step_journey({})
        rc = journey.run_journey(j, store, {"a": accounts["a"]}, CATALOGUE, out=lambda _l: None)
        self.assertEqual(rc, 1)
        self.assertGreaterEqual(len(calls), 2)
        self.assertEqual(calls[0][0], [accounts["a"]])
        self.assertIsNotNone(calls[-1][1])    # the after-run cleanup names the film
        self.assertEqual(store.fetch_recent_notifications(journey.EPOCH), [], "the FAIL's alerts were left behind")
        self.assertEqual(store.fetch_agent_films(), [])

    def test_cleanup_runs_when_the_run_blows_up(self):
        store, accounts = build_store()
        calls = self._spy(store)
        j = one_step_journey({"a": [{"moment": "hits_cinema", "channels": ["in_app"]}]})
        with mock.patch.object(journey, "_run_engine_find", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                journey.run_journey(j, store, {"a": accounts["a"]}, CATALOGUE, out=lambda _l: None)
        self.assertGreaterEqual(len(calls), 2)
        self.assertEqual(store.fetch_recent_notifications(journey.EPOCH), [])

    def test_cleanup_removes_only_the_named_accounts_and_film(self):
        store, accounts = build_store()
        store.insert_notifications([{"id": "keep", "user_id": "someone-else", "movie_id": "1", "moment": "hits_cinema",
                                     "cascade_id": "c", "found_at": "2026-01-01T00:00:00+00:00"},
                                    {"id": "go", "user_id": accounts["a"], "movie_id": "2", "moment": "hits_cinema",
                                     "cascade_id": "c", "found_at": "2026-01-01T00:00:00+00:00"}])
        store.upsert_user_film(accounts["a"], "2", "enjoyed")
        store.upsert_user_film(accounts["a"], "3", "enjoyed")
        store.purge_journey_state([accounts["a"]], "2")
        ids = {r["id"] for r in store.fetch_recent_notifications(journey.EPOCH)}
        self.assertEqual(ids, {"keep"})
        self.assertEqual([r["movie_id"] for r in store.fetch_user_films()], ["3"])


class Wiring(unittest.TestCase):
    def test_housekeeping_and_held_ids_are_switched_off_for_a_journey(self):
        store, accounts = build_store()
        js = journey.JourneyStore(store, accounts, send=False)
        self.assertEqual(js.delete_old_usage_events(), 0)
        self.assertEqual(js.purge_deleted_rows(), 0)
        self.assertIsNone(js.fetch_user_held_ids())
        self.assertEqual(sorted(js.fetch_push_tokens()), sorted(accounts.values()))   # synthetic device tokens

    def test_send_off_never_touches_the_real_senders(self):
        j = one_step_journey({"a": [{"moment": "hits_cinema", "channels": ["in_app", "push", "email"]}]})
        with mock.patch("monitor.phases.send_via_apns") as apns, mock.patch("monitor.phases.send_via_resend") as mail, \
                mock.patch("monitor.emailer.send_via_resend") as mail2:
            rc, lines, _, _ = run_journey(j)
        self.assertEqual(rc, 0, lines)
        apns.assert_not_called()
        mail.assert_not_called()
        mail2.assert_not_called()

    def test_accounts_file_parse(self):
        from qa.sim.accounts import email_for
        text = "\n".join(f"{email_for(k)} 00000000-0000-4000-8000-00000000000{i}" for i, k in enumerate("abcd", 1))
        out = journey.accounts_from_list(text, ["a", "d"])
        self.assertEqual(out, {"a": "00000000-0000-4000-8000-000000000001", "d": "00000000-0000-4000-8000-000000000004"})
        with self.assertRaises(journey.SetupFail):
            journey.accounts_from_list(email_for("a") + " (missing)", ["a"])

    def test_the_cli_refuses_a_live_project_url_before_any_write(self):
        env = {"SUPABASE_URL": "https://ypccfyatejejslzlfrbf.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k"}
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch("urllib.request.urlopen") as net:
            with self.assertRaises(SystemExit) as cm:
                journey.main(["--journey", "full-run"], out=lambda _l: None)
        self.assertIn("REFUSING", str(cm.exception))
        net.assert_not_called()

    def test_expect_normalisation(self):
        step = {"expect": {"a": [{"moment": "hits_rent", "channels": ["push", "in_app"]}], "b": "none"}}
        self.assertEqual(journey._expected(step, "a"), ["hits_rent:in_app+push"])
        self.assertEqual(journey._expected(step, "b"), [])
        self.assertEqual(journey._expected(step, "c"), [])


class SimulateWorkflow(unittest.TestCase):
    PATH = os.path.join(ROOT, ".github", "workflows", "simulate.yml")

    def test_parses_dispatch_only_staging_only(self):
        with open(self.PATH, encoding="utf-8") as fh:
            raw = fh.read()
        doc = yaml.safe_load(raw)
        triggers = doc.get("on", doc.get(True))
        self.assertEqual(list(triggers), ["workflow_dispatch"])
        self.assertEqual(set(triggers["workflow_dispatch"]["inputs"]), {"journey", "send"})
        self.assertIs(triggers["workflow_dispatch"]["inputs"]["send"]["default"], False)
        self.assertEqual(doc["jobs"]["simulate"]["environment"], "staging")
        self.assertNotIn("production", raw.lower())
        self.assertIn("ypccfyatejejslzlfrbf", raw)    # the guard that refuses the live project


if __name__ == "__main__":
    unittest.main()
