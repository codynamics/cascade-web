"""CAS-973 — the workflow-failure alert script (scripts/send_alert.py).

Every network seam is monkeypatched directly on urllib.request, so no test here makes a live
HTTP call (same pattern as monitor/tests/test_emailer.py's SendViaResendTests).
"""
import io
import json
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import send_alert  # noqa: E402


class BuildMessageTests(unittest.TestCase):
    def test_subject_names_the_workflow(self):
        subject, _ = send_alert.build_message("daily", "https://x.test/runs/1", "refresh", "Build", "")
        self.assertEqual(subject, "[Cascade ALERT] daily failed")

    def test_body_carries_workflow_run_job_and_step(self):
        _, text = send_alert.build_message("qa", "https://x.test/runs/9", "engine", "Engine invariants", "")
        self.assertIn("Workflow: qa", text)
        self.assertIn("https://x.test/runs/9", text)
        self.assertIn("Failing job: engine", text)
        self.assertIn("Failing step: Engine invariants", text)

    def test_unknown_job_and_step_are_stated_honestly(self):
        _, text = send_alert.build_message("qa", "https://x.test/runs/9", "", "", "")
        self.assertIn("Failing job: (unknown)", text)
        self.assertIn("Failing step: (unknown)", text)

    def test_log_tail_included_only_when_present(self):
        _, without = send_alert.build_message("qa", "https://x.test/runs/9", "engine", "Engine", "")
        self.assertNotIn("log", without.lower())
        _, with_tail = send_alert.build_message("qa", "https://x.test/runs/9", "engine", "Engine", "boom\nline2")
        self.assertIn("boom", with_tail)
        self.assertIn("line2", with_tail)


class FindFailureTests(unittest.TestCase):
    def test_reads_failed_job_step_and_log_tail(self):
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = (
            b'{"jobs": [{"id": 1, "name": "ok", "conclusion": "success", "steps": []}, '
            b'{"id": 2, "name": "engine", "conclusion": "failure", '
            b'"steps": [{"name": "Build", "conclusion": "success"}, '
            b'{"name": "Engine invariants", "conclusion": "failure"}]}]}'
        )
        jobs_resp.__enter__.return_value = jobs_resp
        logs_resp = mock.MagicMock()
        logs_resp.read.return_value = "\n".join(f"line{i}" for i in range(50)).encode("utf-8")
        logs_resp.__enter__.return_value = logs_resp

        with mock.patch("urllib.request.urlopen", side_effect=[jobs_resp, logs_resp]):
            job, step, tail = send_alert.find_failure("o/r", "123", "tok")

        self.assertEqual(job, "engine")
        self.assertEqual(step, "Engine invariants")
        self.assertNotIn("line0", tail)          # only the last 40 lines
        self.assertIn("line49", tail)

    def test_no_failed_job_returns_blanks(self):
        resp = mock.MagicMock()
        resp.read.return_value = b'{"jobs": [{"id": 1, "name": "ok", "conclusion": "success", "steps": []}]}'
        resp.__enter__.return_value = resp
        with mock.patch("urllib.request.urlopen", return_value=resp):
            job, step, tail = send_alert.find_failure("o/r", "123", "tok")
        self.assertEqual((job, step, tail), ("", "", ""))

    def test_api_error_degrades_to_blanks_instead_of_raising(self):
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("boom")):
            job, step, tail = send_alert.find_failure("o/r", "123", "tok")
        self.assertEqual((job, step, tail), ("", "", ""))


class MainTests(unittest.TestCase):
    def setUp(self):
        # CAS-1460: streak gating has its own tests below; here it always says "send" so the
        # urlopen call sequences these tests script (jobs lookup, then Resend) stay as written.
        patcher = mock.patch.object(send_alert, "fetch_streak",
                                    return_value=(True, 3, "2026-11-16T00:00:00+00:00", "threshold met"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _env(self, **overrides):
        env = {
            "CASCADE_ALERT_TO": "lee@example.test",
            "RESEND_API_KEY": "key",
            "WORKFLOW_NAME": "daily",
            "GITHUB_REPOSITORY": "codynamics/cascade-web",
            "GITHUB_RUN_ID": "42",
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_TOKEN": "tok",
        }
        env.update(overrides)
        return env

    def test_no_alert_to_exits_nonzero(self):
        """CAS-995 AC2: with CASCADE_ALERT_TO unset, the send script exits non-zero so the run
        itself shows red instead of silently doing nothing."""
        with mock.patch.dict(os.environ, self._env(CASCADE_ALERT_TO=""), clear=True), \
             mock.patch("urllib.request.urlopen") as urlopen:
            rc = send_alert.main()
        self.assertEqual(rc, 1)
        urlopen.assert_not_called()

    def test_no_resend_key_skips_email_but_still_exits_0_with_no_push_configured(self):
        """RESEND_API_KEY only gates send_email_alert — find_failure's jobs lookup still runs
        whenever GITHUB_REPOSITORY/RUN_ID/GITHUB_TOKEN are present, so urlopen IS called once."""
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = b'{"jobs": []}'
        jobs_resp.__enter__.return_value = jobs_resp
        with mock.patch.dict(os.environ, self._env(RESEND_API_KEY=""), clear=True), \
             mock.patch("urllib.request.urlopen", return_value=jobs_resp) as urlopen:
            rc = send_alert.main()
        self.assertEqual(rc, 0)
        urlopen.assert_called_once()
        self.assertNotEqual(urlopen.call_args[0][0].full_url, send_alert.RESEND_ENDPOINT)

    def test_sends_exactly_one_email_when_configured(self):
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = b'{"jobs": []}'
        jobs_resp.__enter__.return_value = jobs_resp
        send_resp = mock.MagicMock()
        send_resp.read.return_value = b'{"id": "abc"}'
        send_resp.__enter__.return_value = send_resp

        with mock.patch.dict(os.environ, self._env(), clear=True), \
             mock.patch("urllib.request.urlopen", side_effect=[jobs_resp, send_resp]) as urlopen:
            rc = send_alert.main()

        self.assertEqual(rc, 0)
        self.assertEqual(urlopen.call_count, 2)  # one jobs lookup, one Resend send
        send_req = urlopen.call_args_list[-1][0][0]
        self.assertEqual(send_req.full_url, send_alert.RESEND_ENDPOINT)

    def test_resend_http_error_is_reported_and_exits_nonzero(self):
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = b'{"jobs": []}'
        jobs_resp.__enter__.return_value = jobs_resp
        err = urllib.error.HTTPError(
            url=send_alert.RESEND_ENDPOINT, code=403, msg="Forbidden",
            hdrs={"Content-Type": "text/html"}, fp=io.BytesIO(b"blocked"),
        )
        with mock.patch.dict(os.environ, self._env(), clear=True), \
             mock.patch("urllib.request.urlopen", side_effect=[jobs_resp, err]):
            rc = send_alert.main()
        self.assertEqual(rc, 1)

    def _push_env(self, **overrides):
        return self._env(SUPABASE_URL="https://x.supabase.co",
                         SUPABASE_SERVICE_ROLE_KEY="role-key", **overrides)

    def test_ac1_email_failure_still_sends_the_push(self):
        """CAS-995 AC1: an alert with email sending stubbed to fail still sends the push."""
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = b'{"jobs": []}'
        jobs_resp.__enter__.return_value = jobs_resp
        email_err = urllib.error.HTTPError(
            url=send_alert.RESEND_ENDPOINT, code=500, msg="Boom",
            hdrs={"Content-Type": "text/html"}, fp=io.BytesIO(b"boom"),
        )
        with mock.patch.dict(os.environ, self._push_env(), clear=True), \
             mock.patch("urllib.request.urlopen", side_effect=[jobs_resp, email_err]), \
             mock.patch.object(send_alert, "find_push_tokens_for_email", return_value=["tok-1"]), \
             mock.patch.object(send_alert.pusher, "send_via_apns", return_value=True) as push:
            rc = send_alert.main()
        push.assert_called_once()
        self.assertEqual(push.call_args[0][0], "tok-1")
        self.assertEqual(rc, 1)   # the email failure is still real and reported

    def test_ac1_push_failure_still_sends_the_email(self):
        """CAS-995 AC1, the other direction: push failing outright still lets the email send."""
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = b'{"jobs": []}'
        jobs_resp.__enter__.return_value = jobs_resp
        send_resp = mock.MagicMock()
        send_resp.read.return_value = b'{"id": "abc"}'
        send_resp.__enter__.return_value = send_resp
        with mock.patch.dict(os.environ, self._push_env(), clear=True), \
             mock.patch("urllib.request.urlopen", side_effect=[jobs_resp, send_resp]), \
             mock.patch.object(send_alert, "find_push_tokens_for_email",
                               side_effect=urllib.error.URLError("push lookup down")) as lookup:
            rc = send_alert.main()
        lookup.assert_called_once()
        self.assertEqual(rc, 1)   # the push failure is still real and reported
        # the email send itself (the second urlopen call) still happened
        self.assertEqual(send_alert.RESEND_ENDPOINT, "https://api.resend.com/emails")

    def test_push_skipped_without_supabase_config_email_still_sent(self):
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = b'{"jobs": []}'
        jobs_resp.__enter__.return_value = jobs_resp
        send_resp = mock.MagicMock()
        send_resp.read.return_value = b'{"id": "abc"}'
        send_resp.__enter__.return_value = send_resp
        with mock.patch.dict(os.environ, self._env(), clear=True), \
             mock.patch("urllib.request.urlopen", side_effect=[jobs_resp, send_resp]):
            rc = send_alert.main()
        self.assertEqual(rc, 0)


class FindPushTokensForEmailTests(unittest.TestCase):
    def test_finds_tokens_for_a_matching_user(self):
        users_resp = mock.MagicMock()
        users_resp.read.return_value = json.dumps(
            {"users": [{"id": "u1", "email": "someone@else.test"},
                      {"id": "u2", "email": "Lee@Example.test"}]}).encode("utf-8")
        users_resp.__enter__.return_value = users_resp
        tokens_resp = mock.MagicMock()
        tokens_resp.read.return_value = json.dumps(
            [{"device_token": "tok-a"}, {"device_token": "tok-b"}]).encode("utf-8")
        tokens_resp.__enter__.return_value = tokens_resp

        with mock.patch("urllib.request.urlopen", side_effect=[users_resp, tokens_resp]) as urlopen:
            tokens = send_alert.find_push_tokens_for_email(
                "https://x.supabase.co", "role-key", "lee@example.test")

        self.assertEqual(tokens, ["tok-a", "tok-b"])
        push_req = urlopen.call_args_list[-1][0][0]
        self.assertIn("user_id=eq.u2", push_req.full_url)

    def test_no_matching_user_returns_no_tokens(self):
        users_resp = mock.MagicMock()
        users_resp.read.return_value = json.dumps({"users": []}).encode("utf-8")
        users_resp.__enter__.return_value = users_resp
        with mock.patch("urllib.request.urlopen", return_value=users_resp):
            tokens = send_alert.find_push_tokens_for_email(
                "https://x.supabase.co", "role-key", "nobody@example.test")
        self.assertEqual(tokens, [])


def _run(conclusion, created_at):
    return {"conclusion": conclusion, "created_at": created_at}


def _ts(hour, minute=0, day=16):
    return send_alert._parse_ts(f"2026-11-{day:02d}T{hour:02d}:{minute:02d}:00Z")


class StreakDecisionTests(unittest.TestCase):
    """CAS-1460: an alert is only sent when Lee has to act."""

    def test_single_red_run_is_suppressed_at_default_threshold(self):
        # a red qa run followed by a green one must not email: the red run alone is suppressed
        send, count, _, reason = send_alert.streak_decision(
            [_run("success", "2026-11-16T08:00:00Z")], _ts(10), 2, 0)
        self.assertFalse(send)
        self.assertEqual(count, 1)
        self.assertIn("suppressed: 1 consecutive failure(s)", reason)

    def test_sends_at_threshold(self):
        send, count, first_at, _ = send_alert.streak_decision(
            [_run("failure", "2026-11-16T09:00:00Z"), _run("success", "2026-11-16T08:00:00Z")],
            _ts(10), 2, 0)
        self.assertTrue(send)
        self.assertEqual(count, 2)
        self.assertEqual(first_at, _ts(9))

    def test_below_three_failures_suppressed_for_gate_workflows(self):
        send, count, _, _ = send_alert.streak_decision(
            [_run("failure", "2026-11-16T09:00:00Z"), _run("success", "2026-11-16T08:00:00Z")],
            _ts(10), 3, 6)
        self.assertFalse(send)
        self.assertEqual(count, 2)

    def test_min_red_hours_holds_the_alert_back(self):
        prior = [_run("failure", "2026-11-16T02:00:00Z"), _run("failure", "2026-11-16T01:00:00Z"),
                 _run("success", "2026-11-16T00:00:00Z")]
        # 3 failures but only 3h since the first -> still suppressed
        send, count, _, _ = send_alert.streak_decision(prior, _ts(4), 3, 6)
        self.assertFalse(send)
        self.assertEqual(count, 3)
        # same streak 6h+ after the first failure -> send
        send, _, _, _ = send_alert.streak_decision(prior, _ts(7), 3, 6)
        self.assertTrue(send)

    def test_sends_only_once_per_streak(self):
        # run 3 (10:00) met 2-in-a-row and alerted; run 4 (11:00) must not alert again
        prior = [_run("failure", "2026-11-16T10:00:00Z"), _run("failure", "2026-11-16T09:00:00Z"),
                 _run("success", "2026-11-16T08:00:00Z")]
        send, count, _, reason = send_alert.streak_decision(prior, _ts(11), 2, 0)
        self.assertFalse(send)
        self.assertEqual(count, 3)
        self.assertIn("already alerted", reason)

    def test_once_per_streak_also_holds_with_min_red_hours(self):
        # the 6h mark was crossed at run 4 (alerted); run 5 stays quiet
        prior = [_run("failure", "2026-11-16T08:00:00Z"), _run("failure", "2026-11-16T04:00:00Z"),
                 _run("failure", "2026-11-16T01:00:00Z"), _run("success", "2026-11-16T00:00:00Z")]
        send, _, _, _ = send_alert.streak_decision(prior[1:], _ts(8), 3, 6)  # run 4 itself
        self.assertTrue(send)
        send, _, _, reason = send_alert.streak_decision(prior, _ts(9), 3, 6)  # run 5
        self.assertFalse(send)
        self.assertIn("already alerted", reason)

    def test_green_run_resets_the_streak(self):
        # an old long red streak, then green, then a fresh single failure: starts again at 1
        prior = [_run("success", "2026-11-16T09:00:00Z"), _run("failure", "2026-11-16T08:00:00Z"),
                 _run("failure", "2026-11-16T07:00:00Z"), _run("failure", "2026-11-16T06:00:00Z")]
        send, count, _, _ = send_alert.streak_decision(prior, _ts(10), 2, 0)
        self.assertFalse(send)
        self.assertEqual(count, 1)

    def test_streak_can_alert_again_after_a_green_run(self):
        prior = [_run("failure", "2026-11-16T10:00:00Z"), _run("success", "2026-11-16T09:00:00Z"),
                 _run("failure", "2026-11-16T08:00:00Z"), _run("failure", "2026-11-16T07:00:00Z")]
        send, count, _, _ = send_alert.streak_decision(prior, _ts(11), 2, 0)
        self.assertTrue(send)
        self.assertEqual(count, 2)

    def test_cancelled_runs_do_not_break_or_extend_a_streak(self):
        prior = [_run("cancelled", "2026-11-16T09:30:00Z"), _run("failure", "2026-11-16T09:00:00Z"),
                 _run("success", "2026-11-16T08:00:00Z")]
        send, count, _, _ = send_alert.streak_decision(prior, _ts(10), 2, 0)
        self.assertTrue(send)
        self.assertEqual(count, 2)

    def test_threshold_of_one_always_sends_even_back_to_back(self):
        # ios-testflight: Lee dispatched it, every failure needs him
        prior = [_run("failure", "2026-11-16T09:00:00Z"), _run("failure", "2026-11-16T08:00:00Z")]
        send, count, _, _ = send_alert.streak_decision(prior, _ts(10), 1, 0)
        self.assertTrue(send)
        self.assertEqual(count, 3)


class FetchStreakTests(unittest.TestCase):
    def _resp(self, payload):
        resp = mock.MagicMock()
        resp.read.return_value = json.dumps(payload).encode("utf-8")
        resp.__enter__.return_value = resp
        return resp

    def test_reads_run_then_same_branch_history_and_excludes_itself(self):
        run = {"workflow_id": 77, "head_branch": "staging", "created_at": "2026-11-16T10:00:00Z",
               "run_started_at": "2026-11-16T10:00:05Z"}
        history = {"workflow_runs": [
            {"id": 42, "conclusion": "failure", "created_at": "2026-11-16T10:00:00Z"},
            {"id": 41, "conclusion": "failure", "created_at": "2026-11-16T09:00:00Z"},
            {"id": 40, "conclusion": "success", "created_at": "2026-11-16T08:00:00Z"},
        ]}
        with mock.patch("urllib.request.urlopen",
                        side_effect=[self._resp(run), self._resp(history)]) as urlopen:
            send, count, first_at, _ = send_alert.fetch_streak("o/r", "42", "tok", 2, 0)
        self.assertTrue(send)
        self.assertEqual(count, 2)
        self.assertTrue(first_at.startswith("2026-11-16T09:00:00"))
        history_url = urlopen.call_args_list[1][0][0].full_url
        self.assertIn("/actions/workflows/77/runs", history_url)
        self.assertIn("branch=staging", history_url)
        self.assertIn("status=completed", history_url)

    def test_history_api_failure_fails_open_and_sends(self):
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
            send, count, _, reason = send_alert.fetch_streak("o/r", "42", "tok", 3, 6)
        self.assertTrue(send)
        self.assertEqual(count, 0)
        self.assertIn("sending to be safe", reason)


class SuppressionEndToEndTests(unittest.TestCase):
    ENV = {"CASCADE_ALERT_TO": "lee@example.test", "RESEND_API_KEY": "key", "WORKFLOW_NAME": "qa",
           "GITHUB_REPOSITORY": "o/r", "GITHUB_RUN_ID": "42", "GITHUB_TOKEN": "tok",
           "CONSECUTIVE_FAILURES": "3", "MIN_RED_HOURS": "6"}

    def test_suppressed_run_sends_no_email_and_no_push(self):
        with mock.patch.dict(os.environ, self.ENV, clear=True), \
             mock.patch.object(send_alert, "fetch_streak",
                               return_value=(False, 1, "2026-11-16T10:00:00+00:00", "suppressed: 1")), \
             mock.patch.object(send_alert, "send_email_alert") as email, \
             mock.patch.object(send_alert, "send_push_alert") as push, \
             mock.patch("urllib.request.urlopen") as urlopen:
            rc = send_alert.main()
        self.assertEqual(rc, 0)
        email.assert_not_called()
        push.assert_not_called()
        urlopen.assert_not_called()

    def test_thresholds_come_from_the_environment(self):
        with mock.patch.dict(os.environ, self.ENV, clear=True), \
             mock.patch.object(send_alert, "fetch_streak", return_value=(False, 1, "", "x")) as fetch:
            send_alert.main()
        self.assertEqual(fetch.call_args[0][3:], (3, 6.0))

    def test_default_threshold_is_two_failures_no_hours(self):
        env = {k: v for k, v in self.ENV.items() if k not in ("CONSECUTIVE_FAILURES", "MIN_RED_HOURS")}
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(send_alert, "fetch_streak", return_value=(False, 1, "", "x")) as fetch:
            send_alert.main()
        self.assertEqual(fetch.call_args[0][3:], (2, 0.0))

    def test_sent_alert_leads_with_action_and_streak_info(self):
        with mock.patch.dict(os.environ, self.ENV, clear=True), \
             mock.patch.object(send_alert, "fetch_streak",
                               return_value=(True, 3, "2026-11-16T01:00:00+00:00", "threshold met")), \
             mock.patch.object(send_alert, "find_failure", return_value=("engine", "Engine", "")), \
             mock.patch.object(send_alert, "send_email_alert", return_value=True) as email, \
             mock.patch.object(send_alert, "send_push_alert", return_value=True) as push:
            rc = send_alert.main()
        self.assertEqual(rc, 0)
        body = email.call_args[0][2]
        self.assertTrue(body.startswith(
            "Action: Open the Cascade Admin chat and say: check qa run https://github.com/o/r/actions/runs/42."))
        self.assertIn("Consecutive failures: 3 (since 2026-11-16T01:00:00+00:00)", body)
        self.assertTrue(push.call_args[0][4].startswith("Action: "))

    def test_ios_testflight_action_line_names_the_provisioning_profile(self):
        text = send_alert.build_message("ios-testflight", "https://x.test/r/1", "testflight", "build_app", "")[1]
        self.assertTrue(text.startswith("Action: Check the run; if it failed at build_app the provisioning profile"))


if __name__ == "__main__":
    unittest.main()
