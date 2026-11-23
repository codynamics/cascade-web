"""Unit tests for the daily summary email (CAS-1021, reshaped by CAS-1526).

Run:  python -m unittest monitor.tests.test_metrics_report
"""
import datetime
import re
import unittest

from monitor import metrics_report as mr

NOW = datetime.datetime(2026, 11, 23, 3, 0, tzinfo=datetime.timezone.utc)
DAY = datetime.date(2026, 11, 23)


def _health(checks=None, checked_at="2026-11-22T20:59:40+00:00"):
    return {"checked_at": checked_at, "checks": checks or [{"name": "catalogue_size", "ok": True}]}


def _uptime(checks=None, last_run="2026-11-23T02:17:35Z"):
    return {"lastRun": last_run, "checks": checks or [{"name": "site_up", "ok": True}]}


REFRESH = {"runs": [{"run_at": "2026-11-22T20:59:21Z", "catalogue": {"after": 6275, "new": 3}}]}


def _users():
    def ago(**kw):
        return (NOW - datetime.timedelta(**kw)).isoformat()
    return [
        {"id": "a", "email": "a@x.com", "created_at": ago(hours=2)},
        {"id": "b", "email": "b@x.com", "created_at": ago(days=3)},
        {"id": "c", "email": "c@x.com", "created_at": ago(days=20)},
        {"id": "d", "email": "d@x.com", "created_at": ago(days=200)},
        {"id": "r", "email": "lee+canary@codynamics.com.au", "created_at": ago(hours=1)},
    ]


def _data(health=None, uptime=None, events=None):
    return {
        "health": mr.build_health(NOW, health or _health(), uptime or _uptime(), REFRESH),
        "members": mr.build_members(NOW, _users()),
        "onboarding": mr.build_onboarding(NOW, _users(), events if events is not None else []),
    }


class Report(unittest.TestCase):
    def test_all_good_subject_and_sections(self):
        r = mr.render_report(_data(), DAY)
        self.assertEqual(r["subject"], "Cascade daily — 2026-11-23 — All good")
        for section in ("System health", "Members", "Onboarding"):
            self.assertIn(section, r["html"])
        self.assertIn("Movie data: refreshed 2026-11-22 20:59 UTC, 6275 films (+3 new)", r["html"])
        self.assertIn("Details: ", r["html"])
        self.assertIn("https://cascade-admin.pages.dev", r["html"])

    def test_no_table_with_more_than_four_rows(self):
        html = mr.render_report(_data(), DAY)["html"]
        for table in re.findall(r"<table.*?</table>", html, re.S):
            self.assertLessEqual(table.count("<tr"), 4)
        self.assertNotIn("<table", html)

    def test_one_failing_check_is_one_problem(self):
        up = _uptime([{"name": "signup", "ok": False, "detail": "HTTP 500"},
                      {"name": "site_up", "ok": True}])
        r = mr.render_report(_data(uptime=up), DAY)
        self.assertEqual(r["subject"], "Cascade daily — 2026-11-23 — 1 problem")
        self.assertIn("signup: sign-up is failing (HTTP 500)", r["html"])

    def test_unknown_checks_are_not_problems(self):
        h = _health([{"name": "email_send", "ok": None, "status": "unknown"}])
        self.assertEqual(mr.build_health(NOW, h, _uptime(), REFRESH)["problems"], [])

    def test_stale_monitors_are_problems(self):
        up = _uptime(last_run="2026-11-22T23:00:00Z")  # 4h old
        h = _health(checked_at="2026-11-21T00:00:00+00:00")
        problems = mr.build_health(NOW, h, up, REFRESH)["problems"]
        self.assertEqual(len(problems), 2)
        self.assertIn("hourly monitor", problems[0])
        self.assertIn("nightly monitor", problems[1])

    def test_two_problems_plural(self):
        up = _uptime([{"name": "signup", "ok": False}, {"name": "site_up", "ok": False}])
        self.assertTrue(mr.render_report(_data(uptime=up), DAY)["subject"].endswith("— 2 problems"))


class Members(unittest.TestCase):
    def test_counts_exclude_robot(self):
        m = mr.build_members(NOW, _users())
        self.assertEqual(m, {"total": 4, "d1": 1, "d7": 2, "d30": 3})
        html = mr.render_report(_data(), DAY)["html"]
        self.assertIn("4 members", html)
        self.assertIn("1 in 24 hours · 2 in 7 days · 3 in 30 days", html)

    def test_unavailable(self):
        self.assertIsNone(mr.build_members(NOW, None))


class Onboarding(unittest.TestCase):
    def test_no_step_data_says_so_not_zeros(self):
        html = mr.render_report(_data(events=[]), DAY)["html"]
        self.assertIn("no first-run step data yet", html)

    def test_finished_and_top_stop_step(self):
        ev = [
            {"user_id": "a", "data": {"step": "welcome"}, "created_at": "2026-11-23T01:00:00Z"},
            {"user_id": "a", "data": {"step": "oaf_done"}, "created_at": "2026-11-23T01:05:00Z"},
            {"user_id": "b", "data": {"step": "welcome"}, "created_at": "2026-11-20T01:00:00Z"},
            {"user_id": "b", "data": {"step": "pick_films"}, "created_at": "2026-11-20T01:01:00Z"},
            {"user_id": "c", "data": {"step": "pick_films"}, "created_at": "2026-11-23T01:00:00Z"},  # not new
        ]
        o = mr.build_onboarding(NOW, _users(), ev)
        self.assertEqual((o["new"], o["finished"], o["top_step"], o["top_count"]),
                         (2, 1, "pick_films", 1))

    def test_unavailable(self):
        self.assertIsNone(mr.build_onboarding(NOW, _users(), None))
        self.assertIn("unavailable", mr.render_report(
            {**_data(), "onboarding": None}, DAY)["html"])


class Gather(unittest.TestCase):
    def test_store_failure_degrades_to_unavailable(self):
        class Broken:
            def fetch_auth_users(self):
                raise RuntimeError("HTTP 500")

            def fetch_onbstep_events(self, since):
                raise RuntimeError("HTTP 500")

        d = mr.gather(Broken(), NOW)
        self.assertIsNone(d["members"])
        self.assertIsNone(d["onboarding"])
        self.assertIn("problems", d["health"])

    def test_no_store(self):
        d = mr.gather(None, NOW)
        self.assertIsNone(d["members"])


if __name__ == "__main__":
    unittest.main()
