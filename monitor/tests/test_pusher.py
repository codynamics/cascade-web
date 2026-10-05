"""Unit tests for the APNs push channel (CAS-465 / CAS-1204 curl+HTTP/2 transport).

Run:  python -m unittest monitor.tests.test_pusher
"""
import json
import os
import subprocess
import unittest
from unittest import mock

from monitor import pusher
from monitor.matching import Hit
from monitor.pusher import push_copy, send_via_apns
from monitor.transitions import Transition

APNS_ENV_VARS = ("APNS_KEY_ID", "APNS_TEAM_ID", "APNS_AUTH_KEY", "APNS_BUNDLE_ID")


def _hit(title, moment, cascade="Drama rentals"):
    t = Transition(movie_id="1", title=title, moment=moment, services=[], price=None, movie={})
    return Hit(user_id="user-A", cascade_id="c1", cascade_name=cascade, transition=t)


def _curl_stdout(status, http_version="2", body=""):
    """A fake curl stdout: the response body followed by pusher's --write-out marker, exactly
    as send_via_apns parses it back out."""
    return f"{body}{pusher._CURL_META_MARKER}{status}:{http_version}"


def _fake_completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=["curl"], returncode=returncode, stdout=stdout, stderr=stderr)


class NoSecretsNoOp(unittest.TestCase):
    """Mirrors emailer.py's degrade-gracefully-with-no-RESEND_API_KEY convention: a monitor run
    with no APNs configured (true until Lee adds the GitHub Actions secrets) must still complete
    green, never attempting a network call."""

    def setUp(self):
        self._env_patch = mock.patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        for var in APNS_ENV_VARS:
            os.environ.pop(var, None)
        self.addCleanup(self._env_patch.stop)
        self._warned_patch = mock.patch.object(pusher, "_warned_missing_config", False)
        self._warned_patch.start()
        self.addCleanup(self._warned_patch.stop)

    def test_no_op_when_all_unset(self):
        with mock.patch("subprocess.run") as run:
            ok = send_via_apns("device-token", "Title", "Body")
        self.assertFalse(ok)
        run.assert_not_called()

    def test_no_op_when_only_some_are_set(self):
        os.environ["APNS_KEY_ID"] = "K1"
        os.environ["APNS_TEAM_ID"] = "T1"
        # APNS_AUTH_KEY / APNS_BUNDLE_ID still unset
        with mock.patch("subprocess.run") as run:
            ok = send_via_apns("device-token", "Title", "Body")
        self.assertFalse(ok)
        run.assert_not_called()

    def test_missing_config_warns_visibly_once(self):
        """CAS-483: a silent False is what let a missing daily.yml env-block hide for three
        tickets' worth of work — the gap must now print, but only once per run, not once per
        device/push, so a real config gap can't drown the log either."""
        with mock.patch("subprocess.run"), mock.patch("builtins.print") as printed:
            send_via_apns("device-token", "Title", "Body")
            send_via_apns("device-token-2", "Title", "Body")
        warnings = [c for c in printed.call_args_list if "push not configured" in str(c)]
        self.assertEqual(len(warnings), 1)
        self.assertIn("APNS_KEY_ID", str(warnings[0]))


class ConfiguredPushBase(unittest.TestCase):
    """Common fixture for tests that exercise the curl call itself: fake APNS_* secrets and a
    stubbed provider token (DER/ECDSA signing is covered by test_der/test_ecdsa elsewhere)."""

    DEVICE_TOKEN = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567"
    PROVIDER_TOKEN = "fake-jwt-provider-token"

    def setUp(self):
        self._env_patch = mock.patch.dict(os.environ, {
            "APNS_KEY_ID": "K1", "APNS_TEAM_ID": "T1",
            "APNS_AUTH_KEY": "fake-key-not-parsed", "APNS_BUNDLE_ID": "au.com.codynamics.cascade",
        }, clear=False)
        self._env_patch.start()
        self.addCleanup(self._env_patch.stop)
        self._token_patch = mock.patch.object(pusher, "_provider_token", return_value=self.PROVIDER_TOKEN)
        self._token_patch.start()
        self.addCleanup(self._token_patch.stop)


class CurlInvocationKeepsSecretsOffTheCommandLine(ConfiguredPushBase):
    """CAS-1204: the device token used to be printed into the Actions log on every failure.
    The fix moves both secrets off the command line entirely (curl --config on stdin), so they
    cannot appear in a process listing or anywhere subprocess.run's argv is logged."""

    def test_argv_carries_http2_and_config_stdin_but_no_secrets(self):
        with mock.patch("subprocess.run", return_value=_fake_completed(stdout=_curl_stdout(200))) as run:
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body")
        self.assertTrue(ok)
        argv = run.call_args.args[0]
        self.assertIn("--http2", argv)
        self.assertIn("--config", argv)
        self.assertIn("-", argv)
        joined_argv = " ".join(argv)
        self.assertNotIn(self.DEVICE_TOKEN, joined_argv)
        self.assertNotIn(self.PROVIDER_TOKEN, joined_argv)

    def test_config_on_stdin_carries_url_headers_and_body(self):
        with mock.patch("subprocess.run", return_value=_fake_completed(stdout=_curl_stdout(200))) as run:
            send_via_apns(self.DEVICE_TOKEN, "Title Words", "Body Words", thread_id="thread-99")
        config_text = run.call_args.kwargs["input"]
        self.assertIn(f"https://{pusher.APNS_HOST}/3/device/{self.DEVICE_TOKEN}", config_text)
        self.assertIn(f"authorization: bearer {self.PROVIDER_TOKEN}", config_text)
        self.assertIn("apns-topic: au.com.codynamics.cascade", config_text)
        self.assertIn("apns-push-type: alert", config_text)
        self.assertIn("content-type: application/json", config_text)
        self.assertIn("Title Words", config_text)
        self.assertIn("Body Words", config_text)
        self.assertIn("thread-99", config_text)


class SuccessAndRejection(ConfiguredPushBase):
    def test_200_returns_true(self):
        with mock.patch("subprocess.run", return_value=_fake_completed(stdout=_curl_stdout(200))):
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body")
        self.assertTrue(ok)

    def test_410_calls_on_invalid_token_and_returns_false(self):
        body = json.dumps({"reason": "Unregistered"})
        removed = []
        with mock.patch("subprocess.run", return_value=_fake_completed(stdout=_curl_stdout(410, body=body))), \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body", on_invalid_token=removed.append)
        self.assertFalse(ok)
        self.assertEqual(removed, [self.DEVICE_TOKEN])
        warnings = [c for c in printed.call_args_list if "APNs push rejected" in str(c)]
        self.assertEqual(len(warnings), 1)
        self.assertIn("Unregistered", str(warnings[0]))

    def test_400_bad_device_token_calls_on_invalid_token_and_returns_false(self):
        body = json.dumps({"reason": "BadDeviceToken"})
        removed = []
        with mock.patch("subprocess.run", return_value=_fake_completed(stdout=_curl_stdout(400, body=body))), \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body", on_invalid_token=removed.append)
        self.assertFalse(ok)
        self.assertEqual(removed, [self.DEVICE_TOKEN])
        warnings = [c for c in printed.call_args_list if "APNs push rejected" in str(c)]
        self.assertEqual(len(warnings), 1)
        self.assertIn("BadDeviceToken", str(warnings[0]))

    def test_403_with_reason_prints_reason_without_removing_token(self):
        body = json.dumps({"reason": "Forbidden"})
        removed = []
        with mock.patch("subprocess.run", return_value=_fake_completed(stdout=_curl_stdout(403, body=body))), \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body", on_invalid_token=removed.append)
        self.assertFalse(ok)
        self.assertEqual(removed, [])
        warnings = [c for c in printed.call_args_list if "APNs push rejected" in str(c)]
        self.assertEqual(len(warnings), 1)
        self.assertIn("Forbidden", str(warnings[0]))

    def test_transient_error_does_not_trigger_removal(self):
        removed = []
        with mock.patch("subprocess.run", return_value=_fake_completed(stdout=_curl_stdout(500))), \
             mock.patch("builtins.print"):
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body", on_invalid_token=removed.append)
        self.assertFalse(ok)
        self.assertEqual(removed, [])


class TransportFailuresAreLoggedWithoutSecrets(ConfiguredPushBase):
    """CAS-1204 AC: curl missing, a non-zero exit, a timeout, or unparseable output must each
    log exactly one line and never the device token or provider token."""

    def test_curl_missing_logs_one_line_and_returns_false(self):
        with mock.patch("subprocess.run", side_effect=FileNotFoundError()), \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body")
        self.assertFalse(ok)
        self.assertEqual(printed.call_count, 1)
        logged = str(printed.call_args_list[0])
        self.assertIn("APNs push failed", logged)
        self.assertNotIn(self.DEVICE_TOKEN, logged)
        self.assertNotIn(self.PROVIDER_TOKEN, logged)

    def test_nonzero_exit_logs_one_line_without_secrets(self):
        stderr = f"curl: (6) Could not resolve host; token {self.PROVIDER_TOKEN} device {self.DEVICE_TOKEN}"
        with mock.patch("subprocess.run", return_value=_fake_completed(returncode=6, stderr=stderr)), \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body")
        self.assertFalse(ok)
        self.assertEqual(printed.call_count, 1)
        logged = str(printed.call_args_list[0])
        self.assertIn("APNs push failed", logged)
        self.assertNotIn(self.DEVICE_TOKEN, logged)
        self.assertNotIn(self.PROVIDER_TOKEN, logged)

    def test_timeout_logs_one_line_and_returns_false(self):
        with mock.patch("subprocess.run",
                         side_effect=subprocess.TimeoutExpired(cmd=["curl"], timeout=10)), \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body")
        self.assertFalse(ok)
        self.assertEqual(printed.call_count, 1)
        logged = str(printed.call_args_list[0])
        self.assertIn("APNs push failed", logged)
        self.assertNotIn(self.DEVICE_TOKEN, logged)
        self.assertNotIn(self.PROVIDER_TOKEN, logged)

    def test_unparseable_output_logs_one_line_and_returns_false(self):
        with mock.patch("subprocess.run", return_value=_fake_completed(stdout="not curl meta at all")), \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body")
        self.assertFalse(ok)
        self.assertEqual(printed.call_count, 1)
        self.assertIn("APNs push failed", str(printed.call_args_list[0]))

    def test_http_1_1_response_is_treated_as_a_failure(self):
        with mock.patch("subprocess.run", return_value=_fake_completed(stdout=_curl_stdout(200, "1.1"))), \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns(self.DEVICE_TOKEN, "Title", "Body")
        self.assertFalse(ok)
        logged = " ".join(str(c) for c in printed.call_args_list)
        self.assertIn("HTTP/1.1", logged)


class SilentTokenMintFailureIsLogged(unittest.TestCase):
    """CAS-1194 AC1: a provider-token mint failure used to be swallowed by a bare
    `except Exception: return False` with zero output — the one silent path among
    send_via_apns's four failure modes (the other three each already print a reason). It must
    now print exactly one line naming the exception class, and never any part of the key
    material. This path never reaches curl."""

    def setUp(self):
        self._env_patch = mock.patch.dict(os.environ, {
            "APNS_KEY_ID": "K1", "APNS_TEAM_ID": "T1",
            "APNS_AUTH_KEY": "not-real-key-material", "APNS_BUNDLE_ID": "au.com.codynamics.cascade",
        }, clear=False)
        self._env_patch.start()
        self.addCleanup(self._env_patch.stop)

    def test_mint_failure_logs_exception_class_without_key_material(self):
        with mock.patch.object(pusher, "_provider_token", side_effect=ValueError("bad DER")), \
             mock.patch("subprocess.run") as run, \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns("device-token", "Title", "Body")
        self.assertFalse(ok)
        run.assert_not_called()
        self.assertEqual(printed.call_count, 1)
        logged = str(printed.call_args_list[0])
        self.assertIn("ValueError", logged)
        self.assertNotIn("not-real-key-material", logged)


class CopyTemplates(unittest.TestCase):
    """CAS-465 build step 2: copy must match the spec'd templates exactly, and the status-moment
    phrasing must be the bell's own REAL_MOMENT_SAID wording, not a reinvented string."""

    def test_announced(self):
        copy = push_copy(_hit("Dune Three", "announced", cascade="Sci-fi epics"))
        self.assertEqual(copy["title"], "New match for Sci-fi epics")
        self.assertEqual(copy["body"],
                          "Dune Three just joined Cascade — matches your Sci-fi epics agent.")

    def test_status_moments_reuse_the_bells_own_phrasing(self):
        cases = {
            "hits_cinema": "reached a cinema",
            "hits_pvod": "is available to buy",
            "hits_rent": "dropped to a rental price",
            "hits_stream": "landed on streaming",
            "past_opening_weekend": "is past its opening weekend",
        }
        for moment, said in cases.items():
            copy = push_copy(_hit("Fixture Film", moment))
            self.assertEqual(copy["title"], "Fixture Film")
            self.assertEqual(copy["body"], f"Fixture Film {said}.")


if __name__ == "__main__":
    unittest.main()
