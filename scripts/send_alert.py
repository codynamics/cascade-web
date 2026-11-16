"""CAS-973/CAS-995: reusable failure alert — email via Resend AND push via APNs when a
scheduled/CI workflow fails.

Invoked from .github/workflows/alert.yml's single step, which runs inside the SAME run as the
workflow that called it (a `workflow_call` job shares the caller's run id) — so the failing job,
its failing step, and that step's log tail are all read straight off this run via the Actions
API. The caller only has to pass its own human-readable name (WORKFLOW_NAME).

Reads everything from the environment (no argv) so the calling step stays a one-liner `run:`.

CAS-995: CASCADE_ALERT_TO is no longer optional-and-silent — with nothing configured to alert
to, this now exits non-zero so the run itself shows red (which emails the repo owner via
GitHub's own notifications) instead of silently doing nothing. Each of the two channels below is
independent: RESEND_API_KEY absent skips email only, SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY or
APNS_* absent skips push only, and a real send failure on one channel never stops the other from
being attempted — the whole point of a second channel is that it doesn't share a single point of
failure (a Resend outage) with the first.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime
import urllib.error
import urllib.parse
import urllib.request

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from monitor import pusher  # noqa: E402

GITHUB_API = "https://api.github.com"
RESEND_ENDPOINT = "https://api.resend.com/emails"
DEFAULT_FROM = "Cascade <onboarding@resend.dev>"
USER_AGENT = "cascade-alert/1.0 (+https://cascademovies.com)"
LOG_TAIL_LINES = 40
PUSH_TITLE = "Cascade Alert"
GOTRUE_ADMIN_USERS_PAGE_SIZE = 200
GOTRUE_ADMIN_USERS_MAX_PAGES = 25

# CAS-1460: an alert must be an actionable item. Only these conclusions of a *previous* run
# count as red; "cancelled" and "skipped" say nothing about health and are stepped over rather
# than ending (or extending) a streak. "success" ends the streak.
RED_CONCLUSIONS = {"failure", "timed_out", "startup_failure"}
HISTORY_PER_PAGE = 50
DEFAULT_ACTION = "Open the Cascade Admin chat and say: check {workflow} run {run_url}."
ACTION_BY_WORKFLOW = {
    "ios-testflight": ("Check the run; if it failed at build_app the provisioning profile needs "
                       "regenerating in the Apple Developer Portal."),
}


def _api_get(url: str, token: str, parse_json: bool = True):
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read()
    return json.loads(body) if parse_json else body.decode("utf-8", "replace")


def find_failure(repo: str, run_id: str, token: str):
    """(failed_job_name, failed_step_name, log_tail) for this run — best-effort. Any piece the
    API doesn't make available comes back as "" rather than raising, so a GitHub API hiccup here
    still lets the alert email go out with whatever it did find."""
    failed_job = failed_step = log_tail = ""
    try:
        data = _api_get(f"{GITHUB_API}/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100", token)
        failed = next((j for j in data.get("jobs", []) if j.get("conclusion") == "failure"), None)
        if failed:
            failed_job = failed.get("name", "")
            step = next((s for s in (failed.get("steps") or []) if s.get("conclusion") == "failure"), None)
            if step:
                failed_step = step.get("name", "")
            job_id = failed.get("id")
            if job_id:
                try:
                    raw = _api_get(f"{GITHUB_API}/repos/{repo}/actions/jobs/{job_id}/logs", token, parse_json=False)
                    log_tail = "\n".join(raw.splitlines()[-LOG_TAIL_LINES:])
                except (urllib.error.URLError, urllib.error.HTTPError):
                    pass
    except (urllib.error.URLError, urllib.error.HTTPError):
        pass
    return failed_job, failed_step, log_tail


def _parse_ts(value: str):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _env_number(name: str, default, cast):
    raw = os.environ.get(name, "")
    try:
        return cast(raw) if raw.strip() else default
    except ValueError:
        return default


def threshold_met(count: int, first_at, at, consecutive_failures: int, min_red_hours: float) -> bool:
    """True when `count` consecutive red runs, the first at `first_at`, have - as of `at` -
    reached the caller's threshold on BOTH axes (run count and hours red)."""
    if count < consecutive_failures:
        return False
    return (at - first_at).total_seconds() / 3600.0 >= min_red_hours


def streak_decision(prior_runs: list, current_started, consecutive_failures: int, min_red_hours: float):
    """CAS-1460: decide whether the current (red) run should alert.

    `prior_runs` are this workflow's earlier *completed* runs on the same branch, newest first,
    each {"conclusion", "created_at"}. The current run is red by definition (the alert job only
    runs `if: failure()`). Returns (send, count, first_at, reason):
      - count/first_at describe the streak ending with the current run;
      - a green (success) prior run resets the streak; cancelled/skipped runs are stepped over;
      - one alert per streak: if the previous run's own streak had already met the threshold it
        alerted, so this one stays quiet until a green run resets things. A threshold of 1 means
        "always alert" (e.g. ios-testflight, which Lee dispatched by hand), so it is exempt.
    """
    streak = []  # red prior runs, newest first
    for run in prior_runs:
        conclusion = run.get("conclusion")
        if conclusion in RED_CONCLUSIONS:
            streak.append(run)
        elif conclusion == "success":
            break
    count = len(streak) + 1
    first_at = _parse_ts(streak[-1]["created_at"]) if streak else current_started
    if not threshold_met(count, first_at, current_started, consecutive_failures, min_red_hours):
        return False, count, first_at, (
            f"suppressed: {count} consecutive failure(s), first at {first_at.isoformat()}, "
            f"threshold {consecutive_failures} failure(s) and {min_red_hours:g}h red")
    if consecutive_failures > 1 and streak:
        prev_at = _parse_ts(streak[0]["created_at"])
        if threshold_met(len(streak), first_at, prev_at, consecutive_failures, min_red_hours):
            return False, count, first_at, (
                f"suppressed: already alerted for this red streak ({count} consecutive failure(s), "
                f"first at {first_at.isoformat()}); waiting for a green run to reset it")
    return True, count, first_at, "threshold met"


def fetch_streak(repo: str, run_id: str, token: str, consecutive_failures: int, min_red_hours: float):
    """(send, count, first_at_iso, reason) using the Actions API. Fails OPEN - if the history
    can't be read the alert is sent (count/first unknown), because a false alert is cheaper than
    a silent real failure."""
    try:
        run = _api_get(f"{GITHUB_API}/repos/{repo}/actions/runs/{run_id}", token)
        started = _parse_ts(run.get("run_started_at") or run["created_at"])
        workflow_id = run["workflow_id"]
        query = {"status": "completed", "per_page": HISTORY_PER_PAGE}
        if run.get("head_branch"):
            query["branch"] = run["head_branch"]
        data = _api_get(
            f"{GITHUB_API}/repos/{repo}/actions/workflows/{workflow_id}/runs?{urllib.parse.urlencode(query)}",
            token)
        prior = [r for r in data.get("workflow_runs", [])
                 if str(r.get("id")) != str(run_id) and r.get("created_at")
                 and _parse_ts(r["created_at"]) < started]
        prior.sort(key=lambda r: r["created_at"], reverse=True)
        send, count, first_at, reason = streak_decision(prior, started, consecutive_failures, min_red_hours)
        return send, count, first_at.isoformat(), reason
    except (urllib.error.URLError, urllib.error.HTTPError, KeyError, ValueError) as err:
        return True, 0, "", f"could not read run history ({err}); sending to be safe"


def action_line(workflow_name: str, run_url: str) -> str:
    return "Action: " + ACTION_BY_WORKFLOW.get(
        workflow_name, DEFAULT_ACTION.format(workflow=workflow_name, run_url=run_url))


def build_message(workflow_name: str, run_url: str, failed_job: str, failed_step: str, log_tail: str,
                  count: int = 0, first_at: str = ""):
    subject = f"[Cascade ALERT] {workflow_name} failed"
    lines = [action_line(workflow_name, run_url), ""]
    if count:
        lines.append(f"Consecutive failures: {count}" + (f" (since {first_at})" if first_at else ""))
    lines += [
        f"Workflow: {workflow_name}",
        f"Run: {run_url}",
        f"Failing job: {failed_job or '(unknown)'}",
        f"Failing step: {failed_step or '(unknown)'}",
    ]
    if log_tail:
        lines += ["", f"Last {LOG_TAIL_LINES} lines of the failing step's log:", "", log_tail]
    return subject, "\n".join(lines)


def send_via_resend(to_addr: str, subject: str, text: str, api_key: str, from_addr: str) -> None:
    payload = json.dumps({"from": from_addr, "to": [to_addr], "subject": subject, "text": text}).encode("utf-8")
    req = urllib.request.Request(
        RESEND_ENDPOINT, data=payload, method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def _find_user_id_by_email(supabase_url: str, service_role_key: str, email: str):
    """Paginate the GoTrue admin users listing looking for an exact (case-insensitive) email
    match. Pagination, not an email filter param, because GoTrue's admin API does not document a
    stable server-side exact-email filter across versions — a handful of users on this project
    makes a few pages of listing cheap and dependency-free."""
    base = supabase_url.rstrip("/")
    headers = {"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}",
              "User-Agent": USER_AGENT, "Accept": "application/json"}
    target = email.lower()
    for page in range(1, GOTRUE_ADMIN_USERS_MAX_PAGES + 1):
        req = urllib.request.Request(
            f"{base}/auth/v1/admin/users?page={page}&per_page={GOTRUE_ADMIN_USERS_PAGE_SIZE}",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        users = data.get("users") if isinstance(data, dict) else data
        users = users or []
        for u in users:
            if (u.get("email") or "").lower() == target:
                return u.get("id")
        if len(users) < GOTRUE_ADMIN_USERS_PAGE_SIZE:
            break
    return None


def find_push_tokens_for_email(supabase_url: str, service_role_key: str, email: str) -> list:
    """Device tokens registered in push_tokens for the account whose email equals `email`, read
    with the service_role key (push_tokens' RLS only lets a user read their own rows)."""
    user_id = _find_user_id_by_email(supabase_url, service_role_key, email)
    if not user_id:
        return []
    base = supabase_url.rstrip("/")
    headers = {"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}",
              "User-Agent": USER_AGENT, "Accept": "application/json"}
    req = urllib.request.Request(
        f"{base}/rest/v1/push_tokens?select=device_token&user_id=eq.{urllib.parse.quote(user_id)}",
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        rows = json.loads(resp.read())
    return [r["device_token"] for r in rows if r.get("device_token")]


def send_email_alert(to_addr: str, subject: str, text: str) -> bool:
    """True unless a configured Resend send was actually attempted and failed. RESEND_API_KEY
    absent is a tolerated, not-yet-configured state (mirrors monitor/emailer.py), not a failure —
    the push channel below is independent and may still get the alert out."""
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        print("RESEND_API_KEY not set — skipping email.")
        return True
    from_addr = os.environ.get("CASCADE_EMAIL_FROM") or DEFAULT_FROM
    try:
        send_via_resend(to_addr, subject, text, api_key, from_addr)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace") if err.fp else ""
        print(f"::error::Resend send failed: HTTP {err.code}, body={detail[:500]!r}")
        return False
    print(f"Alert email sent to {to_addr}.")
    return True


def send_push_alert(workflow_name: str, failed_job: str, failed_step: str, to_addr: str,
                    action: str = "") -> bool:
    """True unless push was configured and a real attempt at it failed outright (the token
    lookup itself errored). No SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, or no push tokens
    registered for `to_addr`, are tolerated skips — same convention as email above — because a
    push channel that isn't set up yet, or a recipient who hasn't installed the app, must not
    fail every alert."""
    supabase_url = os.environ.get("SUPABASE_URL")
    service_role_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (supabase_url and service_role_key):
        print("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping push.")
        return True
    try:
        tokens = find_push_tokens_for_email(supabase_url, service_role_key, to_addr)
    except (urllib.error.URLError, urllib.error.HTTPError) as err:
        print(f"::error::push token lookup failed: {err}")
        return False
    if not tokens:
        print(f"No push tokens registered for {to_addr} — skipping push.")
        return True
    body = f"Cascade alert: {workflow_name} failed at {failed_step or failed_job or '(unknown step)'}"
    if action:
        body += f". {action}"
    delivered = sum(1 for tok in tokens if pusher.send_via_apns(tok, PUSH_TITLE, body))
    print(f"Push sent to {delivered}/{len(tokens)} device(s).")
    return True


def main() -> int:
    to_addr = os.environ.get("CASCADE_ALERT_TO")
    if not to_addr:
        print("::error::CASCADE_ALERT_TO not set — nothing can be alerted, exiting non-zero "
              "so this run shows red.")
        return 1

    workflow_name = os.environ.get("WORKFLOW_NAME", "(unknown workflow)")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    run_url = f"{server_url}/{repo}/actions/runs/{run_id}" if repo and run_id else "(unknown run)"
    token = os.environ.get("GITHUB_TOKEN", "")

    consecutive_failures = _env_number("CONSECUTIVE_FAILURES", 2, int)
    min_red_hours = _env_number("MIN_RED_HOURS", 0.0, float)
    count, first_at = 0, ""
    if repo and run_id and token:
        send, count, first_at, reason = fetch_streak(repo, run_id, token, consecutive_failures, min_red_hours)
        print(reason)
        if not send:
            return 0

    failed_job = failed_step = log_tail = ""
    if repo and run_id and token:
        failed_job, failed_step, log_tail = find_failure(repo, run_id, token)

    subject, text = build_message(workflow_name, run_url, failed_job, failed_step, log_tail, count, first_at)

    email_ok = send_email_alert(to_addr, subject, text)
    push_ok = send_push_alert(workflow_name, failed_job, failed_step, to_addr,
                              action_line(workflow_name, run_url))

    return 0 if (email_ok and push_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
