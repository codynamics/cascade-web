"""CAS-1555: the first-ten-days simulator, against an in-memory store with a fake clock (no network).

Days 0 to 10 for the QA accounts built by the app's own engine (monitor/tests/_journey_env.py), the real find / push /
email phases, and the app's own tutBannerDecide from the built index.html (node on PATH). The catch-up picks come
from the engine's shim in production; here they are fixed film ids from the committed catalogue slice.

Run:  python -m unittest monitor.tests.test_firstdays   (from the repo root)
"""
import datetime as dt
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from monitor import firstdays
from monitor.tests._journey_env import build_store, fixture_catalogue
from qa.sim import age_account

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 12, 1, 10, 0, tzinfo=UTC)
CATALOGUE = fixture_catalogue()
PICKS = [str(m["tmdb_id"]) for m in CATALOGUE[:3]]


def fake_picks(users):
    return {u["userId"]: {"cinema": PICKS[:1], "coming": PICKS[1:2], "streaming": PICKS[2:3]} for u in users}


def stub_banner(cases):
    """Stand-in for the node shim in the tests that are not about the banner (it costs a node start per day)."""
    return [(c["now"] - dt.datetime.fromisoformat(c["createdAt"]).timestamp() * 1000) >= 86400000 for c in cases]


def run(keys=("a",), expectations_dir=firstdays.FIRSTDAYS_DIR, set_hook=None, banner_fn=stub_banner):
    store, accounts = build_store()
    accounts = {k: accounts[k] for k in keys}
    original = {uid: "2026-11-01T00:00:00+00:00" for uid in store.fetch_notify_prefs()}
    store._user_created.update(original)
    lines = []
    seen_set = []

    def set_created_at(uid, iso):
        seen_set.append((uid, iso))
        if set_hook:
            set_hook(uid, iso)
        store.set_user_created_at(uid, iso)

    with mock.patch("monitor.catchup.compute_catchup_picks", side_effect=fake_picks), \
         mock.patch("monitor.__main__.compute_scores", return_value={}):
        rc = firstdays.run_firstdays(store, accounts, CATALOGUE, set_created_at, out=lines.append,
                                     clock=lambda: NOW, expectations_dir=expectations_dir,
                                     banner_fn=banner_fn)
    return rc, lines, store, accounts, original, seen_set


class FirstTenDays(unittest.TestCase):
    def test_days_0_to_10_pass_and_the_catchup_arrives_exactly_once(self):
        rc, lines, store, accounts, _, _ = run(("a", "b"), banner_fn=firstdays.app_banner)
        text = "\n".join(lines)
        self.assertEqual(rc, 0, text)
        self.assertNotIn("FAIL", text)
        for k in ("a", "b"):
            days = [ln for ln in lines if f"account={k} " in ln]
            self.assertEqual(len(days), 11, text)
            self.assertEqual([int(ln.split("day=")[1].split()[0]) for ln in days], list(range(11)))
            arrivals = [ln for ln in days if "batches=+1" in ln]
            self.assertEqual(len(arrivals), 1, text)
            self.assertIn("day=1 ", arrivals[0])
            self.assertIn("catchup_films=3", arrivals[0])
        # ... and the run leaves nothing behind
        self.assertEqual(store.fetch_alert_batches(accounts["a"]), [])

    def test_banner_comes_from_the_apps_own_function(self):
        _, lines, *_ = run(banner_fn=firstdays.app_banner)
        banner = {int(ln.split("day=")[1].split()[0]): ln.endswith("banner=True") for ln in lines}
        self.assertFalse(banner[0])
        self.assertTrue(all(banner[d] for d in range(1, 11)), banner)

    def test_each_day_moves_created_at_back(self):
        _, _, _, accounts, _, seen = run()
        ages = [(NOW - dt.datetime.fromisoformat(iso)).total_seconds() / 86400 for _, iso in seen[:11]]
        self.assertEqual(ages, [0.0] + [d - 0.5 for d in range(1, 11)])

    def test_an_expectation_that_does_not_hold_is_a_fail(self):
        tmp = tempfile.mkdtemp()
        try:
            spec = json.loads(open(os.path.join(firstdays.FIRSTDAYS_DIR, "a.json"), encoding="utf-8").read())
            spec["days"]["1"]["catchup"] = "none"
            open(os.path.join(tmp, "a.json"), "w", encoding="utf-8").write(json.dumps(spec))
            rc, lines, *_ = run(expectations_dir=tmp)
        finally:
            shutil.rmtree(tmp)
        self.assertEqual(rc, 1)
        self.assertTrue(any(ln.startswith("FAIL") and "day=1 " in ln for ln in lines))

    def test_a_second_catchup_would_be_caught(self):
        obs = {"new_rows": 3, "new_batches": 1, "new_catchup_batches": 1, "total_catchup_batches": 2,
               "catchup_rows": 3, "pushes": 0, "mails": 0, "banner": True}
        self.assertTrue(firstdays.check_day({"catchup": "arrives", "banner": True}, obs))


class RestoresCreatedAt(unittest.TestCase):
    def test_restored_after_a_pass(self):
        rc, _, store, accounts, original, _ = run()
        self.assertEqual(rc, 0)
        self.assertEqual(store.fetch_user_created_at()[accounts["a"]], original[accounts["a"]])

    def test_restored_after_a_fail(self):
        tmp = tempfile.mkdtemp()
        try:
            spec = json.loads(open(os.path.join(firstdays.FIRSTDAYS_DIR, "a.json"), encoding="utf-8").read())
            spec["days"]["5"]["catchup"] = "arrives"   # never true: day 5 is a FAIL
            open(os.path.join(tmp, "a.json"), "w", encoding="utf-8").write(json.dumps(spec))
            rc, lines, store, accounts, original, _ = run(expectations_dir=tmp)
        finally:
            shutil.rmtree(tmp)
        self.assertEqual(rc, 1, "\n".join(lines))
        self.assertEqual(store.fetch_user_created_at()[accounts["a"]], original[accounts["a"]])

    def test_restored_after_an_error_mid_run(self):
        store, accounts = build_store()
        accounts = {"a": accounts["a"]}
        original = "2026-11-01T00:00:00+00:00"
        store._user_created[accounts["a"]] = original
        with mock.patch("monitor.firstdays._run_engine_find", side_effect=RuntimeError("boom")), \
                self.assertRaises(RuntimeError):
            firstdays.run_firstdays(store, accounts, CATALOGUE, store.set_user_created_at, out=lambda s: None,
                                    clock=lambda: NOW)
        self.assertEqual(store.fetch_user_created_at()[accounts["a"]], original)


class AgeAccountGuard(unittest.TestCase):
    PROD = "postgresql://postgres:x@db.ypccfyatejejslzlfrbf.supabase.co:5432/postgres"
    UID = "00000000-0000-4000-8000-000000000001"

    def test_refuses_a_production_url_before_any_write(self):
        run_sql = mock.Mock()
        with mock.patch("subprocess.run") as sp, self.assertRaises(SystemExit) as cm:
            age_account.age(self.PROD, self.UID, 3, now=NOW, run=run_sql)
        self.assertIn("PRODUCTION", str(cm.exception))
        run_sql.assert_not_called()
        sp.assert_not_called()
        with mock.patch("subprocess.run") as sp, self.assertRaises(SystemExit):
            age_account.main(["--user", self.UID, "--days", "3"], env={"SUPABASE_DB_URL": self.PROD}, run=run_sql)
        run_sql.assert_not_called()
        sp.assert_not_called()

    def test_refuses_a_missing_url(self):
        run_sql = mock.Mock()
        with self.assertRaises(SystemExit):
            age_account.age("", self.UID, 3, now=NOW, run=run_sql)
        run_sql.assert_not_called()

    def test_staging_writes_now_minus_days(self):
        sql = []
        out = age_account.age("postgresql://x@db.stagingref.supabase.co/postgres", self.UID, 2.5, now=NOW, run=sql.append)
        self.assertEqual(len(sql), 1)
        self.assertIn(self.UID, sql[0])
        self.assertEqual(dt.datetime.fromisoformat(out), NOW - dt.timedelta(days=2.5))

    def test_a_non_uuid_user_never_reaches_the_sql(self):
        run_sql = mock.Mock()
        with self.assertRaises(SystemExit):
            age_account.set_created_at("postgresql://x@stagingref/db", "1'; drop table x; --", NOW.isoformat(), run=run_sql)
        run_sql.assert_not_called()


if __name__ == "__main__":
    unittest.main()
