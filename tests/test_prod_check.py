import datetime as dt
import os
import unittest

import yaml

from qa import prod_check as pc

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QA = "11111111-1111-1111-1111-111111111111"
C1 = "22222222-2222-2222-2222-222222222222"
NOW = dt.datetime(2026, 11, 24, 12, tzinfo=dt.timezone.utc)


class Fake:
    def __init__(self, **kw):
        self.t = 0
        self.d = dict(version={"commit": "abc123"}, files=["0001", "0002"], recorded=["0001", "0002"],
                      published=(NOW - dt.timedelta(hours=3)).isoformat(), fn=200,
                      health={"ok": True}, uptime=["success"] * 24,
                      rows=[{"moment": "hits_stream", "pushed_at": "x", "emailed_at": "y"}])
        self.d.update(kw)
        self.sent = []

    def clock(self): return self.t
    def sleep(self, s): self.t += s
    def site_version(self): return self.d["version"]
    def migration_files(self, r): return self.d["files"]
    def recorded_migrations(self): return self.d["recorded"]
    def catalogue_published_at(self): return self.d["published"]

    def function_health(self, n):
        v = self.d["fn"]
        if isinstance(v, Exception):
            raise v
        return v

    def health_json(self): return self.d["health"]
    def uptime_conclusions(self, n): return self.d["uptime"]
    def user_id_for_email(self, e): return C1

    def send_test_alert(self, u):
        self.sent.append(u)
        return "t0"

    def alert_rows(self, u, since): return self.d["rows"]


class ProdCheck(unittest.TestCase):
    def test_version(self):
        self.assertTrue(pc.check_version(Fake(), "abc123")[0])
        self.assertFalse(pc.check_version(Fake(), "def456")[0])

    def test_migrations(self):
        self.assertTrue(pc.check_migrations(Fake(), "x")[0])
        self.assertFalse(pc.check_migrations(Fake(recorded=["0001"]), "x")[0])
        self.assertFalse(pc.check_migrations(Fake(recorded=["0001", "0002", "0003"]), "x")[0])

    def test_catalogue_age(self):
        self.assertTrue(pc.check_catalogue_age(Fake(), NOW)[0])
        old = (NOW - dt.timedelta(hours=31)).isoformat()
        self.assertFalse(pc.check_catalogue_age(Fake(published=old), NOW)[0])
        self.assertFalse(pc.check_catalogue_age(Fake(published=None), NOW)[0])

    def test_functions(self):
        self.assertTrue(pc.check_functions(Fake())[0])
        self.assertFalse(pc.check_functions(Fake(fn=500))[0])
        self.assertFalse(pc.check_functions(Fake(fn=OSError("down")))[0])

    def test_health_uptime(self):
        self.assertTrue(pc.check_health_and_uptime(Fake())[0])
        self.assertFalse(pc.check_health_and_uptime(Fake(health={"ok": False}))[0])
        self.assertFalse(pc.check_health_and_uptime(Fake(uptime=["success"] * 23 + ["failure"]))[0])
        self.assertFalse(pc.check_health_and_uptime(Fake(uptime=["success"] * 5))[0])

    def test_alert_pass_and_fail(self):
        f = Fake()
        self.assertTrue(pc.check_alert(f, QA)[0])
        self.assertEqual(f.sent, [QA])
        self.assertFalse(pc.check_alert(Fake(rows=[]), QA, wait=60, poll=30)[0])
        ok, msg = pc.check_alert(Fake(rows=[{"moment": "hits_stream", "pushed_at": "x"}]), QA, wait=60, poll=30)
        self.assertFalse(ok)
        self.assertIn("email", msg)

    def test_refusals(self):
        for bad in ("", "  ", "not-a-uuid", C1):
            with self.assertRaises(SystemExit):
                pc.check_qa_user(bad, C1)
        self.assertEqual(pc.check_qa_user(QA, C1), QA)

    def test_run_refuses_before_sending_anything(self):
        for bad in ("", C1):
            f = Fake()
            with self.assertRaises(SystemExit):
                pc.run(f, "abc123", bad)
            self.assertEqual(f.sent, [])

    def test_run_exit_codes(self):
        self.assertEqual(pc.run(Fake(), "abc123", QA), 0)
        self.assertEqual(pc.run(Fake(), "zzz", QA), 1)

    def test_workflow_only_dispatch(self):
        path = os.path.join(ROOT, ".github", "workflows", "prod-check.yml")
        with open(path, encoding="utf-8") as fh:
            wf = yaml.safe_load(fh)
        trig = wf.get("on", wf.get(True))
        self.assertEqual(list(trig), ["workflow_dispatch"])
        self.assertEqual(wf["jobs"]["prod-check"]["environment"], "production")


if __name__ == "__main__":
    unittest.main()
