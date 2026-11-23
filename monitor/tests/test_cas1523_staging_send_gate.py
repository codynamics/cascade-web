"""CAS-1523: CASCADE_ENV=staging only ever emails lee+*@codynamics.com.au and never pushes."""
import json
import os
import unittest
from unittest import mock

from monitor import emailer, pusher


class _Resp:
    def read(self):
        return json.dumps({"id": "x"}).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class StagingSendGate(unittest.TestCase):
    def _send(self, to, env):
        with mock.patch.dict(os.environ, {"CASCADE_ENV": env, "RESEND_API_KEY": "k"}, clear=False), \
                mock.patch("urllib.request.urlopen", return_value=_Resp()) as up:
            out = emailer.send_via_resend(to, "s", "<p>h</p>", "t")
        return out, up

    def test_staging_skips_non_lee_address(self):
        out, up = self._send("someone@example.com", "staging")
        up.assert_not_called()
        self.assertIn("skipped", out)

    def test_staging_allows_lee_plus_address(self):
        out, up = self._send("lee+c2@codynamics.com.au", "staging")
        up.assert_called_once()
        self.assertNotIn("skipped", out)

    def test_staging_rejects_lookalike(self):
        for addr in ("lee@codynamics.com.au", "lee+x@codynamics.com.au.evil.com", "x-lee+a@codynamics.com.au"):
            out, up = self._send(addr, "staging")
            up.assert_not_called()

    def test_production_sends_anyone(self):
        out, up = self._send("someone@example.com", "production")
        up.assert_called_once()

    def test_unset_env_sends(self):
        env = {k: v for k, v in os.environ.items() if k != "CASCADE_ENV"}
        env["RESEND_API_KEY"] = "k"
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch("urllib.request.urlopen", return_value=_Resp()) as up:
            emailer.send_via_resend("someone@example.com", "s", "h", "t")
        up.assert_called_once()

    def test_staging_push_skipped(self):
        with mock.patch.dict(os.environ, {"CASCADE_ENV": "staging"}), \
                mock.patch("subprocess.run") as run:
            self.assertFalse(pusher.send_via_apns("tok", "t", "b"))
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
