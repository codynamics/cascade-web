"""CAS-1549: qa.sim.accounts guard + 'the engine builds it, Python does not' tests."""
import json
import os
import re
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from qa.sim import accounts  # noqa: E402

PROD = "https://ypccfyatejejslzlfrbf.supabase.co"
STAGING = "https://oenvezqluwqdwlzfhisc.supabase.co"


class Guard(unittest.TestCase):
    def test_every_command_refuses_production_with_no_network_or_subprocess(self):
        env = {"SUPABASE_URL": PROD, "SUPABASE_SERVICE_ROLE_KEY": "k", "SUPABASE_ANON_KEY": "a"}
        boom = AssertionError("network/subprocess call made against production")
        for cmd in accounts.COMMANDS:
            with mock.patch("urllib.request.urlopen", side_effect=boom) as net, \
                 mock.patch("subprocess.run", side_effect=boom) as sub:
                with self.assertRaises(SystemExit) as cm:
                    accounts.main([cmd], env)
                self.assertNotIn(cm.exception.code, (0, None), cmd)
                net.assert_not_called()
                sub.assert_not_called()

    def test_missing_url_refused(self):
        with self.assertRaises(SystemExit) as cm:
            accounts.main(["list"], {})
        self.assertNotIn(cm.exception.code, (0, None))

    def test_staging_url_passes_guard(self):
        accounts.guard(STAGING)


class FakeApi:
    def __init__(self):
        self.calls = []

    def find_users(self):
        return {}

    anon_key = "anon"

    def call(self, method, path, body=None, key=None, bearer=None):
        self.calls.append((method, path, body))
        if path.startswith("/auth/v1/admin/users"):
            return {"id": "uid-%d" % len(self.calls)}
        if "token" in path:
            return {"access_token": "jwt"}
        return "created" if "complete_membership" in path else None


class EngineBuilds(unittest.TestCase):
    def test_answers_go_to_engine_and_engine_output_goes_to_complete_membership(self):
        seen = []

        def fake_run(cmd, input=None, **kw):
            ans = json.loads(input)
            seen.append(ans)
            out = {"agents": [{"id": "x", "name": ans["name"], "criteria": {"ENGINE": ans["name"]},
                               "alert_moments": [], "active": True}],
                   "prefs": {"p": 1}, "notify": {"in_app": False}, "moods": [{"id": "releases"}]}
            return subprocess.CompletedProcess(cmd, 0, json.dumps(out), "")

        api = FakeApi()
        with mock.patch("subprocess.run", side_effect=fake_run):
            accounts.cmd_create(api)
        self.assertEqual([a["name"] for a in seen], ["QA A", "QA B", "QA C", "QA D"])
        self.assertEqual([(a["where"], a["partner"], a["children"], a["age"]) for a in seen], [
            (["cinema", "rent", "stream"], "no", None, "18plus"),
            (["stream"], "yes", None, "18plus"),
            (["cinema", "stream"], "yes", "yes", "18plus"),
            (["rent", "stream"], "no", None, "under18")])
        rpcs = [c for c in api.calls if "complete_membership" in c[1]]
        self.assertEqual(len(rpcs), 4)
        self.assertEqual([r[2]["p"]["agents"][0]["criteria"] for r in rpcs],
                         [{"ENGINE": n} for n in ("QA A", "QA B", "QA C", "QA D")])

    def test_build_script_uses_the_named_engine_functions(self):
        src = open(accounts.BUILD_SCRIPT, encoding="utf8").read()
        for name in ("oneAgentBuildDraft", "oneAgentCommit", "loadEngine", "cascadeToRow", "userPrefsRow", "prefsRow"):
            self.assertIn(name, src)
        app = open(os.path.join(accounts.ROOT, "app_template.html"), encoding="utf8").read()
        self.assertIn("const moods = oneAgentStarterMoods(who, ages);", app)

    def test_python_computes_no_bars_alerts_or_lists(self):
        src = open(accounts.__file__.replace(".pyc", ".py"), encoding="utf8").read()
        code = "\n".join(l for l in src.splitlines() if not l.strip().startswith("#"))
        for needle in (r'"bar"', r"'bar'", r'"al"', r"'al'", r'"styles"', r"'styles'", r"alert_moments\s*=", r'"show"'):
            self.assertIsNone(re.search(needle, code), needle)

    def test_real_engine_end_to_end(self):
        """No mocks: the real engine builds the payload from the built index.html."""
        if not os.path.exists(os.path.join(accounts.ROOT, "index.html")):
            self.skipTest("index.html not built")
        p = accounts.build_payload("d")
        self.assertEqual(len(p["agents"]), 1)
        self.assertEqual(p["agents"][0]["criteria"]["v"], 2)
        self.assertTrue(any(m["id"] == "releases" for m in p["moods"]))


if __name__ == "__main__":
    unittest.main()
