"""Nightly health assertions (CAS-974, CAS-985).

Every silent failure Cascade has actually had passed CI: a green `daily.yml` run is not
evidence the night's work actually happened. This module asserts nineteen concrete things about
the run that just finished and writes the answer to ``state/health.json`` as
``{checked_at, checks: [{name, ok, value, threshold, detail}], ok}`` — exiting non-zero on any
real failure so `alert.yml` (CAS-973) fires.

    python -m monitor.health                 # live: reads movies.json, git history, env vars,
                                              # state/run_stats.json, and probes Supabase directly
    python -m monitor.health --dry-run       # offline demo against a synthetic all-green fixture
    python -m monitor.health --scope daily   # CAS-993: every check except email_send/push_send
    python -m monitor.health --scope alerts  # CAS-993: only email_send/push_send

Tolerance: a check whose inputs are unavailable this run because the run itself didn't produce
them yet (no run_stats.json section this scope, too few usage rows to mean anything, no previous
refresh to diff against) reports ``ok: null`` ("unknown") and does NOT fail the run — except
``catalogue_size``/``catalogue_integrity``, whose input (``movies.json``) is never optional, so
those two always resolve to a real pass/fail. CAS-995: a check that instead cannot run because a
*credential it needs is simply not set* (SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
CASCADE_CANARY_EMAIL) is a different case — a configuration gap someone needs to fix, not a quiet
night — so it reports ``ok: false`` ("fail") with detail ``"not configured: <NAME>"`` naming
exactly which secret(s) are missing, and DOES fail the run.

CAS-993: the monitor moved out of daily.yml into its own alerts.yml, so this module now has two
scoped callers instead of one. ``--scope daily`` (daily.yml, straight after the catalogue refresh)
and ``--scope alerts`` (alerts.yml, straight after its own monitor step) each assert a different
subset of ``CHECK_NAMES`` and merge their result into the same day's ``state/health.json`` (see
``merge_report``) rather than overwriting each other. Plain ``--dry-run``/no ``--scope`` keeps the
original all-fourteen-checks-in-one-file behaviour.

CAS-985's three client-side checks (client_error_rate, empty_account_rate, activity_floor) read
the last 24h of usage_events. usage_events has no anon select grant at all (CAS-942: only an
`authenticated` caller listed in analytics_admins may read it), so these three probe by signing
in as the SAME canary account probe_auth_signin uses and reading with that session's own JWT —
never with SUPABASE_SERVICE_ROLE_KEY directly, which would sail straight past the RLS this
account actually sits behind (the same reasoning probe_usage_events_insert below already
documents). Until CAS-942's select policy is live AND that canary account is added to
analytics_admins, RLS silently returns zero rows rather than an error — indistinguishable from a
genuinely quiet window, so it is reported the same way: unknown, under the shared <50-app_open
floor below, naming CAS-942 as one of the two possible reasons.

CAS-996: Cascade accounts are passwordless (magic-link/emailed-code sign-in only), so the canary
session cannot be minted with `grant_type=password` — no such account password secret exists, and
none ever will. Instead SUPABASE_SERVICE_ROLE_KEY calls `admin/generate_link` for
CASCADE_CANARY_EMAIL (this does not send an email) and the returned `hashed_token` is exchanged
at `/auth/v1/verify` for a normal access_token — exactly the session a real magic-link click
would produce. The service-role key mints the session only; every read that follows still goes
through with that session's own (RLS-bound) JWT, so the CAS-942/probe_usage_events_insert
reasoning above is unaffected.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

import poc_pipeline as pp
import runstats

from .catalogue import load_catalogue_file, load_today, load_yesterday_from_git, movies_of

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEALTH_FILE = os.path.join(_REPO_ROOT, "state", "health.json")

SUPABASE_URL_ENV = "SUPABASE_URL"
SUPABASE_ANON_KEY_ENV = "SUPABASE_ANON_KEY"
SUPABASE_SERVICE_ROLE_KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY"
CANARY_EMAIL_ENV = "CASCADE_CANARY_EMAIL"
APNS_ENV_VARS = ("APNS_KEY_ID", "APNS_TEAM_ID", "APNS_AUTH_KEY", "APNS_BUNDLE_ID")

CATALOGUE_MIN = 5500
CATALOGUE_DROP_PCT = 0.05
SCORE_COVERAGE_MIN_PCT = 0.90
# CAS-997: a TMDB 404 (a title TMDB itself has deleted) is not a fetch outage — tmdb_fetch only
# fails on a real error, or when not-found calls exceed this share of the run's total TMDB calls.
TMDB_NOT_FOUND_MAX_PCT = 0.02
# CAS-988: the floor is 15% of the REAL quota (state/api_budget.json, CAS-987's cycle shape),
# never a hard-coded plan size — the account has moved plans before (see CAS-987) and will again.
WATCHMODE_FLOOR_PCT = 0.15
WATCHMODE_PACE_LOOKBACK_DAYS = 7
WATCHMODE_PACE_MIN_DAYS = 3
# CAS-985: shared precondition for all three usage_events checks below — fewer app_open rows than this
# in the trailing 24h reads as unknown rather than a false alarm (a quiet pre-launch day, or CAS-942's
# live grant not applied yet — the two are indistinguishable from this probe's own vantage point).
USAGE_WINDOW_MIN_APP_OPEN = 50
CLIENT_ERROR_RATE_MAX_PCT = 0.05
CLIENT_ERROR_RATE_MAX_ABS = 20
EMPTY_ACCOUNT_RATE_MAX_PCT = 0.10

# CAS-1139: the two cohorts CAS-1139's nightly refresh re-orders for — weekly-TTL (pp._is_wm_
# weekly_cohort) and within-a-year (pp.WM_RECENT_YEAR_DAYS) — must not go stale even on the free
# plan's small credit pot. 5% tolerance; older films carry no threshold at all (see the ticket's
# own Do-not-re-raise), so the check's detail reports their oldest stamp without failing on it.
WM_FRESHNESS_MAX_PCT = 0.05
WM_FRESHNESS_WEEKLY_MAX_AGE_DAYS = 14
WM_FRESHNESS_YEAR_MAX_AGE_DAYS = 45

# CAS-1135: a short, fixed list of films certain to be in Australian distribution and highly
# rated — never an attempt to cover the whole catalogue, just a tripwire for the CAS-1134 class of
# defect (a published film silently carrying a TV show's ratings, or hidden behind its empty ones).
LANDMARK_FILMS = {
    286217: "The Martian",
    105: "Back to the Future",
    578: "Jaws",
    240: "The Godfather Part II",
    324857: "Spider-Man: Into the Spider-Verse",
    330457: "Frozen II",
    271110: "Captain America: Civil War",
}

# CAS-1135: written once a run by poc_pipeline._save_watchmode_tv_tmdb_ids — this process has no
# id map of its own and must never download one just to run watchmode_remap_backlog.
WM_TV_TMDB_IDS_FILE = os.path.join(_REPO_ROOT, "state", "wm_tv_tmdb_ids.json")


# ---------------------------------------------------------------------------
# one check result
# ---------------------------------------------------------------------------
def _check(name: str, ok, value, threshold, detail: str, status: str | None = None) -> dict:
    """ok is True/False/None (None == 'unknown'). status defaults from ok but can be overridden
    to 'skipped' — a check whose precondition (e.g. APNS_* configured) was never met, distinct
    from 'unknown' (a check that WOULD apply but this run carries no data for it)."""
    if status is None:
        status = "ok" if ok is True else "fail" if ok is False else "unknown"
    return {"name": name, "ok": ok, "value": value, "threshold": threshold, "detail": detail,
            "status": status}


# ---------------------------------------------------------------------------
# catalogue_size / catalogue_integrity — movies.json is never optional, so these never go unknown
# ---------------------------------------------------------------------------
def check_catalogue_size(today_movies: list, prev_movies: list) -> dict:
    n, prev_n = len(today_movies), len(prev_movies)
    if n < CATALOGUE_MIN:
        return _check("catalogue_size", False, n, CATALOGUE_MIN,
                      f"{n} record(s) — below the {CATALOGUE_MIN}-record floor.")
    if prev_n and n < prev_n * (1 - CATALOGUE_DROP_PCT):
        return _check("catalogue_size", False, n, prev_n,
                      f"{n} record(s) — down from {prev_n} last refresh, more than "
                      f"{CATALOGUE_DROP_PCT:.0%}.")
    return _check("catalogue_size", True, n, CATALOGUE_MIN, f"{n} record(s).")


def check_catalogue_integrity(today_movies: list) -> dict:
    seen_ids, dup, bad = set(), 0, 0
    for m in today_movies:
        tmdb_id, title = m.get("tmdb_id"), m.get("title")
        # "release_date or window": poc_pipeline's own record shape never carries a literal
        # release_date field — cinema_date is the date TMDB record; status is the current
        # window(s) — so a record is sound if it carries either.
        has_release_or_window = bool(m.get("cinema_date") or m.get("status"))
        if tmdb_id is None or not title or not has_release_or_window:
            bad += 1
            continue
        if tmdb_id in seen_ids:
            dup += 1
        else:
            seen_ids.add(tmdb_id)
    if bad or dup:
        return _check("catalogue_integrity", False, {"bad": bad, "duplicates": dup}, 0,
                      f"{bad} record(s) missing tmdb_id/title/release info, {dup} duplicate "
                      f"tmdb_id(s).")
    return _check("catalogue_integrity", True, len(today_movies), 0,
                  "every record parses, carries tmdb_id + title + release info, no duplicates.")


# ---------------------------------------------------------------------------
# tmdb_fetch / watchmode_fetch / oscarbase_fetch — from state/run_stats.json
# ---------------------------------------------------------------------------
def _check_fetch(name: str, stats: dict | None) -> dict:
    if not stats:
        return _check(name, None, None, None, "no run_stats.json entry this run — unavailable.")
    calls, errors = stats.get("calls", 0), stats.get("errors", 0)
    if calls <= 0:
        return _check(name, False, calls, 0, "0 calls made this run.")
    if errors:
        return _check(name, False, errors, 0, f"{errors} error(s) across {calls} call(s).")
    return _check(name, True, calls, 0, f"{calls} call(s), 0 errors.")


def _status_breakdown(stats: dict) -> str:
    """CAS-1011: render run_stats.json's tmdb.status_counts (real per-HTTP-status tally from
    poc_pipeline.py's _api_call) as a stable, human-readable suffix — 404 first, since that's the
    one callers most want to see excluded from the error count, then the rest sorted."""
    status_counts = stats.get("status_counts") or {}
    if not status_counts:
        return ""
    breakdown = ", ".join(f"{status}:{n}" for status, n in
                          sorted(status_counts.items(), key=lambda kv: (kv[0] != "404", kv[0])))
    return f" Status breakdown: {breakdown}."


def check_tmdb_fetch(stats: dict | None) -> dict:
    """CAS-997: unlike the other *_fetch checks, a TMDB 404 (`not_found` in run_stats.json — TMDB
    itself has deleted/withdrawn the title, poc_pipeline.py already keeps its previous data) must
    never read as a fetch outage on its own. This still fails on any OTHER error, exactly like
    `_check_fetch`, and separately fails when not-found calls exceed TMDB_NOT_FOUND_MAX_PCT of the
    run's total calls — a real spike in vendor deletions is still worth knowing about.

    CAS-1011: `errors` (bumped by poc_pipeline.py from its real per-status tally, not from the
    per-title *_fails counters that also count titles skipped untried after an earlier call
    already tripped `stop`) already excludes 404s — this only adds the breakdown to the detail
    so a real, non-404 failure says exactly which status codes it was."""
    if not stats:
        return _check("tmdb_fetch", None, None, None, "no run_stats.json entry this run — unavailable.")
    calls = stats.get("calls", 0)
    errors = stats.get("errors", 0)
    not_found = stats.get("not_found", 0)
    breakdown = _status_breakdown(stats)
    if calls <= 0:
        return _check("tmdb_fetch", False, calls, 0, "0 calls made this run.")
    if errors:
        return _check("tmdb_fetch", False, errors, 0,
                      f"{errors} error(s) across {calls} call(s) ({not_found} not-found, not "
                      f"counted as errors).{breakdown}")
    not_found_pct = not_found / calls
    if not_found_pct > TMDB_NOT_FOUND_MAX_PCT:
        floor = round(calls * TMDB_NOT_FOUND_MAX_PCT)
        return _check("tmdb_fetch", False, not_found, floor,
                      f"{not_found} not-found across {calls} call(s) ({not_found_pct:.1%}) — above "
                      f"the {TMDB_NOT_FOUND_MAX_PCT:.0%} floor.{breakdown}")
    return _check("tmdb_fetch", True, calls, 0,
                  f"{calls} call(s), 0 error(s), {not_found} not-found ({not_found_pct:.1%})."
                  f"{breakdown}")


def check_oscarbase_fetch(stats: dict | None) -> dict:
    return _check_fetch("oscarbase_fetch", stats)


def check_watchmode_fetch(stats: dict | None, run_max_credits_raw: str | None = None,
                          unfilled_count: int = 0) -> dict:
    """CAS-988: the floor is 15% of the quota. CAS-1138: that quota is read from `stats['quota']`
    — this run's own live Watchmode /status figure (poc_pipeline.wm_run_allowance via
    state/run_stats.json), never a passed-in cycle number or a hard-coded plan size, so a plan
    change (the account has moved plans before) moves the floor with it automatically.

    CAS-994: an explicit WM_RUN_MAX_CREDITS of 0 means the run is DELIBERATELY spending nothing
    on Watchmode this run — 0 calls is then the expected, correct outcome, not the failure
    `_check_fetch` would otherwise report it as.

    CAS-1003: `run_max_credits_raw` is the RAW string read from the environment — None (or "")
    when the WM_RUN_MAX_CREDITS repo variable was never set at all — not the already-coerced
    `pp.WM_RUN_MAX_CREDITS` int, whose `int(os.getenv(..., "0") or 0)` collapses "nobody
    configured this" and "someone explicitly paused it" into the same 0, so both used to read as
    the same harmless "skipped". An explicit "0" is still a real decision and still reports
    "skipped". UNSET only reports "fail" (naming WM_RUN_MAX_CREDITS and `unfilled_count`) when the
    catalogue still holds records with no wm_fields_fetched_at — an unset variable over an
    already fully-enriched catalogue hasn't cost anything, so isn't worth failing the run over."""
    if not run_max_credits_raw:
        if unfilled_count > 0:
            return _check("watchmode_fetch", False, unfilled_count, 0,
                          f"WM_RUN_MAX_CREDITS is unset and {unfilled_count} record(s) carry no "
                          "wm_fields_fetched_at — Watchmode enrichment is silently paused.")
        return _check("watchmode_fetch", None, 0, None,
                      "WM_RUN_MAX_CREDITS is unset, but every record already carries "
                      "wm_fields_fetched_at.", status="skipped")
    run_max_credits = int(run_max_credits_raw)
    if run_max_credits <= 0:
        return _check("watchmode_fetch", None, 0, None,
                      "Watchmode spend paused (WM_RUN_MAX_CREDITS=0) — 0 calls is expected.",
                      status="skipped")
    base = _check_fetch("watchmode_fetch", stats)
    if base["ok"] is not True:
        return base
    quota = (stats or {}).get("quota")
    remaining = (stats or {}).get("remaining_monthly_credits")
    if quota is None or remaining is None:
        return _check("watchmode_fetch", None, base["value"], None,
                      "calls/errors OK but the live Watchmode quota is unavailable this run.")
    floor = round(quota * WATCHMODE_FLOOR_PCT)
    if remaining < floor:
        return _check("watchmode_fetch", False, remaining, floor,
                      f"only {remaining} of {quota} Watchmode credit(s) remaining this month "
                      f"(floor {floor}, 15% of quota).")
    return _check("watchmode_fetch", True, base["value"], floor,
                  f"{base['value']} call(s), 0 errors, {remaining} of {quota} credit(s) "
                  f"remaining this month (floor {floor}).")


# ---------------------------------------------------------------------------
# watchmode_pace — extrapolate the cycle's recent daily burn to the reset date
# ---------------------------------------------------------------------------
def _wm_recent_daily_avg(days_map: dict) -> float:
    recent = sorted(days_map.items())[-WATCHMODE_PACE_LOOKBACK_DAYS:]
    return sum(v for _, v in recent) / len(recent)


def check_watchmode_pace(cycle: dict | None, today: _dt.date) -> dict:
    """CAS-988: a floor only tells you after the quota's half gone. This projects the last (up to)
    seven days of state/api_budget.json's `days` map forward to the cycle's reset date, and fires
    red when that projection would exceed the quota — in time to act, not after the fact. Too few
    days of cycle data (a fresh cycle) reports unknown rather than false-alarming.

    CAS-1138: `cycle['quota']` defaults to WM_MONTHLY_QUOTA (poc_pipeline._load_wm_cycle_budget)
    until a live /status call has actually confirmed it — `quota_live` is that confirmation, and
    this reports unavailable rather than pacing against a plan size nobody has verified."""
    if not cycle:
        return _check("watchmode_pace", None, None, None,
                      "no state/api_budget.json — unavailable.")
    if not cycle.get("quota_live"):
        return _check("watchmode_pace", None, None, None,
                      "the live Watchmode quota hasn't been confirmed this cycle — unavailable.")
    days_map = cycle.get("days") or {}
    if len(days_map) < WATCHMODE_PACE_MIN_DAYS:
        return _check("watchmode_pace", None, len(days_map), WATCHMODE_PACE_MIN_DAYS,
                      f"only {len(days_map)} day(s) of cycle data — too early to pace.")
    avg = _wm_recent_daily_avg(days_map)
    quota = cycle["quota"]
    spent = cycle.get("spent", sum(days_map.values()))
    cycle_end = _dt.date.fromisoformat(cycle["cycle_end"])
    days_remaining = max(0, (cycle_end - today).days)
    projected_total = spent + avg * days_remaining
    ok = projected_total <= quota
    detail = (f"{avg:.0f} credit(s)/day average, projecting {round(projected_total)} of "
              f"{quota} by the {cycle['cycle_end']} reset.")
    if not ok and avg > 0:
        exhausts = today + _dt.timedelta(days=int((quota - spent) / avg))
        detail += f" Quota exhausts around {exhausts.isoformat()}."
    return _check("watchmode_pace", ok, round(projected_total), quota, detail)


# ---------------------------------------------------------------------------
# score_coverage
# ---------------------------------------------------------------------------
def _score_count(movies: list) -> int:
    return sum(1 for m in movies
               if m.get("wm_user_rating") is not None or m.get("wm_critic_score") is not None)


def check_score_coverage(today_movies: list, prev_movies: list) -> dict:
    today_n = _score_count(today_movies)
    prev_n = _score_count(prev_movies)
    if not prev_n:
        return _check("score_coverage", None, today_n, None,
                      "no previous refresh to compare against.")
    threshold = prev_n * SCORE_COVERAGE_MIN_PCT
    ok = today_n >= threshold
    return _check("score_coverage", ok, today_n, round(threshold),
                  f"{today_n} scored film(s) vs {prev_n} last refresh "
                  f"({SCORE_COVERAGE_MIN_PCT:.0%} floor).")


# ---------------------------------------------------------------------------
# email_send / push_send — from state/run_stats.json
# ---------------------------------------------------------------------------
def check_email_send(stats: dict | None) -> dict:
    if not stats or not stats.get("attempted"):
        return _check("email_send", None, 0, 0, "no email attempted this run — unavailable.")
    attempted, delivered, errors = stats["attempted"], stats.get("delivered", 0), stats.get("errors", 0)
    ok = errors == 0
    return _check("email_send", ok, delivered, attempted,
                  f"{delivered}/{attempted} Resend call(s) delivered, {errors} error(s).")


def check_push_send(stats: dict | None, apns_configured: bool) -> dict:
    if not apns_configured:
        return _check("push_send", None, None, None,
                      "skipped — APNS_* secrets not configured.", status="skipped")
    if not stats or not stats.get("attempted"):
        return _check("push_send", None, 0, 0,
                      "APNs configured but no push attempted this run — unavailable.")
    attempted, delivered, errors = stats["attempted"], stats.get("delivered", 0), stats.get("errors", 0)
    ok = errors == 0
    return _check("push_send", ok, delivered, attempted,
                  f"{delivered}/{attempted} push(es) delivered, {errors} error(s).")


# ---------------------------------------------------------------------------
# usage_events_insert / auth_signin — live Supabase probes (anon role)
# ---------------------------------------------------------------------------
def _post_json(url: str, headers: dict, payload: dict, timeout: int = 15):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        body = (err.read() or b"").decode("utf-8", "replace") if err.fp else ""
        return err.code, body


def _missing_names(*pairs) -> list:
    """CAS-995: the exact env var names among `pairs` (name, value) whose value is falsy — used
    to build the "not configured: <NAME>" detail a credential-gated check reports instead of the
    old, never-failing "unknown" when its inputs simply aren't there."""
    return [name for name, value in pairs if not value]


def probe_usage_events_insert(supabase_url: str | None, anon_key: str | None) -> dict | None:
    """Insert one canary row into usage_events AS THE ANON ROLE — the check that would have
    caught the live defect (CAS-974's own Problem statement): a service_role write would sail
    straight past the RLS policy an anon client actually hits."""
    missing = _missing_names((SUPABASE_URL_ENV, supabase_url), (SUPABASE_ANON_KEY_ENV, anon_key))
    if missing:
        return {"not_configured": missing}
    headers = {"apikey": anon_key, "Authorization": f"Bearer {anon_key}",
               "Content-Type": "application/json", "Prefer": "return=minimal"}
    payload = {"client_key": "cascade-health-canary", "type": "health_canary",
               "data": {"source": "monitor.health"}}
    try:
        status, body = _post_json(f"{supabase_url.rstrip('/')}/rest/v1/usage_events", headers, payload)
    except Exception as err:  # noqa: BLE001 — a probe failure is a result, never a crash
        return {"ok": False, "detail": f"{type(err).__name__}: {err}"}
    ok = 200 <= status < 300
    return {"ok": ok, "detail": f"HTTP {status}" + (f" — {body[:200]}" if not ok and body else "")}


def _mint_canary_session(supabase_url: str | None, anon_key: str | None,
                         service_role_key: str | None, email: str | None) -> dict:
    """CAS-996: the passwordless equivalent of a `grant_type=password` sign-in — generate_link
    (service-role key) creates no email, just a `hashed_token`; verify (anon key) exchanges it for
    a real session, exactly as a real magic-link click would. Returns {"not_configured": [...]},
    {"ok": False, "detail": ...}, or {"ok": True, "token": <access_token>}."""
    missing = _missing_names(
        (SUPABASE_URL_ENV, supabase_url), (SUPABASE_ANON_KEY_ENV, anon_key),
        (SUPABASE_SERVICE_ROLE_KEY_ENV, service_role_key), (CANARY_EMAIL_ENV, email))
    if missing:
        return {"not_configured": missing}
    gen_headers = {"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}",
                  "Content-Type": "application/json"}
    try:
        status, body = _post_json(f"{supabase_url.rstrip('/')}/auth/v1/admin/generate_link",
                                  gen_headers, {"type": "magiclink", "email": email})
    except Exception as err:  # noqa: BLE001 — a probe failure is a result, never a crash
        return {"ok": False, "detail": f"{type(err).__name__}: {err}"}
    if not (200 <= status < 300):
        return {"ok": False,
                "detail": f"generate_link failed: HTTP {status}" + (f" — {body[:200]}" if body else "")}
    # CAS-998: the raw GoTrue response carries hashed_token at the TOP LEVEL of the body,
    # alongside the user fields — `properties.hashed_token` is supabase-js's client-side wrapper
    # shape, not what the HTTP endpoint itself sends. Check the top level first, keep the wrapper
    # shape as a fallback in case a future GoTrue version reintroduces it.
    try:
        parsed = json.loads(body)
    except Exception:
        parsed = {}
    hashed_token = parsed.get("hashed_token") or (parsed.get("properties") or {}).get("hashed_token")
    if not hashed_token:
        return {"ok": False, "detail": "generate_link response carried no hashed_token."}

    verify_headers = {"apikey": anon_key, "Content-Type": "application/json"}
    try:
        status, body = _post_json(f"{supabase_url.rstrip('/')}/auth/v1/verify",
                                  verify_headers, {"type": "magiclink", "token_hash": hashed_token})
    except Exception as err:  # noqa: BLE001 — a probe failure is a result, never a crash
        return {"ok": False, "detail": f"{type(err).__name__}: {err}"}
    if not (200 <= status < 300):
        return {"ok": False,
                "detail": f"verify failed: HTTP {status}" + (f" — {body[:200]}" if body else "")}
    try:
        token = json.loads(body).get("access_token")
    except Exception:
        token = None
    if not token:
        return {"ok": False, "detail": "verify response carried no access_token."}
    return {"ok": True, "token": token}


def probe_auth_signin(supabase_url: str | None, anon_key: str | None,
                      service_role_key: str | None, email: str | None) -> dict | None:
    session = _mint_canary_session(supabase_url, anon_key, service_role_key, email)
    if session.get("not_configured"):
        return session
    if not session.get("ok"):
        return {"ok": False, "detail": session.get("detail", "canary sign-in failed.")}
    return {"ok": True, "detail": "session returned.", "token": session["token"]}


def check_usage_events_insert(probe: dict | None) -> dict:
    if probe is None:
        return _check("usage_events_insert", None, None, None,
                      "no SUPABASE_URL/SUPABASE_ANON_KEY — unavailable.")
    if probe.get("not_configured"):
        return _check("usage_events_insert", False, None, None,
                      f"not configured: {', '.join(probe['not_configured'])}")
    return _check("usage_events_insert", bool(probe.get("ok")), 1 if probe.get("ok") else 0, 1,
                  probe.get("detail", ""))


def check_auth_signin(probe: dict | None) -> dict:
    if probe is None:
        return _check("auth_signin", None, None, None,
                      "no SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY/"
                      "CASCADE_CANARY_EMAIL — unavailable.")
    if probe.get("not_configured"):
        return _check("auth_signin", False, None, None,
                      f"not configured: {', '.join(probe['not_configured'])}")
    return _check("auth_signin", bool(probe.get("ok")), 1 if probe.get("ok") else 0, 1,
                  probe.get("detail", ""))


# ---------------------------------------------------------------------------
# client_error_rate / empty_account_rate / activity_floor — CAS-985, see the module docstring for
# why these read as the canary account rather than anon or service_role.
# ---------------------------------------------------------------------------
def _get_json(url: str, headers: dict, timeout: int = 15):
    req = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        body = (err.read() or b"").decode("utf-8", "replace") if err.fp else ""
        return err.code, body


def probe_usage_window(supabase_url: str | None, anon_key: str | None, service_role_key: str | None,
                       email: str | None, now: _dt.datetime) -> dict | None:
    """Signs in with the canary account and reads the trailing 24h (`rows24`) and the 24h before
    that (`rows_prev`, for activity_floor's day-over-day comparison) of usage_events with that
    session's own JWT. None when the credentials aren't configured; otherwise a dict carrying
    either "error" (the sign-in or the read itself failed outright) or the two row lists — RLS
    quietly returning zero rows (no select grant applied yet) is NOT an error here, it's read the
    same as a genuinely quiet window, by design (see the module docstring)."""
    session = _mint_canary_session(supabase_url, anon_key, service_role_key, email)
    if session.get("not_configured"):
        return session
    if not session.get("ok"):
        return {"error": session.get("detail", "canary sign-in failed.")}
    try:
        token = session["token"]
        headers = {"apikey": anon_key, "Authorization": f"Bearer {token}"}
        # PostgREST decodes an unescaped "+" in a query string as a space (the
        # application/x-www-form-urlencoded convention), which corrupts a UTC isoformat()
        # timestamp's "+00:00" offset and gets the whole request rejected with HTTP 400 — quote()
        # so the "+" survives as "%2B".
        since24 = urllib.parse.quote((now - _dt.timedelta(hours=24)).isoformat(), safe="")
        since48 = urllib.parse.quote((now - _dt.timedelta(hours=48)).isoformat(), safe="")
        base = f"{supabase_url.rstrip('/')}/rest/v1/usage_events"
        r24_status, r24_body = _get_json(
            f"{base}?select=type,client_key,data&created_at=gte.{since24}&limit=10000", headers)
        rprev_status, rprev_body = _get_json(
            f"{base}?select=type,client_key&created_at=gte.{since48}&created_at=lt.{since24}&limit=10000",
            headers)
        if not (200 <= r24_status < 300 and 200 <= rprev_status < 300):
            return {"error": f"usage_events read failed (HTTP {r24_status}/{rprev_status})."}
        return {"rows24": json.loads(r24_body), "rows_prev": json.loads(rprev_body)}
    except Exception as err:  # noqa: BLE001 — a probe failure is a result, never a crash
        return {"error": f"{type(err).__name__}: {err}"}


def _app_open_count(rows: list) -> int:
    return sum(1 for r in rows if r.get("type") == "app_open")


def _usage_window_gate(name: str, window: dict | None):
    """The precondition every one of the three checks below shares: no credentials, the probe itself
    failed outright, or too few app_open rows to mean anything. Returns a `_check` dict to return
    immediately, or None when the caller should go on and compute the real answer."""
    if window is None:
        return _check(name, None, None, None,
                      "no SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY/"
                      "CASCADE_CANARY_EMAIL — unavailable.")
    if window.get("not_configured"):
        return _check(name, False, None, None,
                      f"not configured: {', '.join(window['not_configured'])}")
    if window.get("error"):
        return _check(name, None, None, None, window["error"])
    app_open = _app_open_count(window["rows24"])
    if app_open < USAGE_WINDOW_MIN_APP_OPEN:
        return _check(name, None, app_open, USAGE_WINDOW_MIN_APP_OPEN,
                      f"only {app_open} app_open row(s) in the last 24h (floor {USAGE_WINDOW_MIN_APP_OPEN}) "
                      f"— a quiet window, or CAS-942's live select grant for this account isn't applied yet.")
    return None


def check_client_error_rate(window: dict | None) -> dict:
    gate = _usage_window_gate("client_error_rate", window)
    if gate is not None:
        return gate
    rows = window["rows24"]
    app_open = _app_open_count(rows)
    errs = [r for r in rows if r.get("type") in ("client_error", "client_rejection")]
    n = len(errs)
    pct = n / app_open
    ok = not (pct > CLIENT_ERROR_RATE_MAX_PCT or n > CLIENT_ERROR_RATE_MAX_ABS)
    top = Counter((r.get("data") or {}).get("message") or "(no message)" for r in errs).most_common(3)
    detail = f"{n} client_error/client_rejection row(s) of {app_open} app_open ({pct:.1%})."
    if top:
        detail += " Top: " + "; ".join(f"{m} x{c}" for m, c in top)
    return _check("client_error_rate", ok, n, CLIENT_ERROR_RATE_MAX_ABS, detail)


def check_empty_account_rate(window: dict | None) -> dict:
    gate = _usage_window_gate("empty_account_rate", window)
    if gate is not None:
        return gate
    rows = window["rows24"]
    empty = sum(1 for r in rows if r.get("type") == "signin_empty_account")
    returning = sum(1 for r in rows if r.get("type") == "signin_returning")
    total = empty + returning
    if not total:
        return _check("empty_account_rate", None, 0, None,
                      "no signin_returning/signin_empty_account rows in the last 24h.")
    pct = empty / total
    ok = pct <= EMPTY_ACCOUNT_RATE_MAX_PCT
    return _check("empty_account_rate", ok, empty, total,
                  f"{empty} of {total} sign-in(s) landed on an empty account ({pct:.1%}).")


def check_activity_floor(window: dict | None) -> dict:
    gate = _usage_window_gate("activity_floor", window)
    if gate is not None:
        return gate
    today_keys = {r.get("client_key") for r in window["rows24"] if r.get("type") == "app_open"}
    prev_keys = {r.get("client_key") for r in window["rows_prev"] if r.get("type") == "app_open"}
    ok = not (len(today_keys) == 0 and len(prev_keys) > 0)
    return _check("activity_floor", ok, len(today_keys), len(prev_keys),
                  f"{len(today_keys)} distinct device(s) opened the app in the last 24h "
                  f"(previous 24h: {len(prev_keys)}).")


# ---------------------------------------------------------------------------
# watchmode_identity / watchmode_remap_backlog / released_scored_without_rating / landmark_films
# — CAS-1135: none of CAS-974's original fourteen checks measure identity (only volume/coverage),
# so CAS-1134's movie/TV id-map collision tripped none of them. See each check's own docstring.
# ---------------------------------------------------------------------------
def check_watchmode_identity(stats: dict | None) -> dict:
    """CAS-1134's details-response identity guard (poc_pipeline.enrich_watchmode_fields) returns
    'mismatch' — writing nothing — whenever a Watchmode id it was about to trust turns out to
    identify a different tmdb_id or a non-movie type. Zero is the only acceptable count; this is
    exactly the check that would have caught CAS-1134's own defect before Lee found it by hand."""
    if not stats:
        return _check("watchmode_identity", None, None, None,
                      "no run_stats.json entry this run — unavailable.")
    mismatches = stats.get("mismatch", 0)
    if not mismatches:
        return _check("watchmode_identity", True, 0, 0, "0 identity mismatch(es) this run.")
    names = ", ".join(str(i) for i in (stats.get("mismatch_ids") or [])[:5])
    detail = f"{mismatches} identity mismatch(es) this run."
    if names:
        detail += f" TMDB id(s): {names}."
    return _check("watchmode_identity", False, mismatches, 0, detail)


def _load_watchmode_tv_tmdb_ids(today: _dt.date):
    """None when the id map wasn't downloaded by today's poc_pipeline.py run (the file is absent,
    unreadable, or stamped an earlier date) — never re-fetched here; a second Watchmode download
    just so this check can run is not worth the credit (CAS-1135)."""
    if not os.path.exists(WM_TV_TMDB_IDS_FILE):
        return None
    try:
        data = json.load(open(WM_TV_TMDB_IDS_FILE, encoding="utf-8"))
    except Exception:
        return None
    if data.get("date") != today.isoformat():
        return None
    return set(data.get("tv_tmdb_ids") or [])


def check_watchmode_remap_backlog(records: list, tv_tmdb_ids, prev_value) -> dict:
    """The count of records still carrying a wm_fields_fetched_at stamp but no wm_id, whose
    tmdb_id also carries a TV row in the id map — exactly the shape CAS-1134's repair tier
    (poc_pipeline.enrich_watchmode_fields_nightly/probe_candidates tier 0) re-fetches, a few at a
    time, every night. `tv_tmdb_ids` is None when this run's id map was never downloaded —
    reported skipped rather than claiming a count that can't be measured. `prev_value` is last
    night's own count (read back from state/health.json): a shrinking backlog warns rather than
    fails, since the repair tier is visibly working; a stalled or growing one fails."""
    if tv_tmdb_ids is None:
        return _check("watchmode_remap_backlog", None, None, None,
                      "the id map wasn't downloaded this run — unavailable.", status="skipped")
    backlog = sum(1 for r in records
                 if r.get("wm_fields_fetched_at") and not r.get("wm_id")
                 and r.get("tmdb_id") in tv_tmdb_ids)
    if backlog == 0:
        return _check("watchmode_remap_backlog", True, 0, 0, "0 record(s) awaiting repair.")
    if isinstance(prev_value, (int, float)) and backlog < prev_value:
        return _check("watchmode_remap_backlog", None, backlog, prev_value,
                      f"{backlog} record(s) awaiting repair, down from {prev_value} last night.",
                      status="warn")
    prev_text = f"{prev_value} last night" if isinstance(prev_value, (int, float)) else "no previous count"
    return _check("watchmode_remap_backlog", False, backlog, prev_value,
                  f"{backlog} record(s) awaiting repair, not down from {prev_text}.")


def check_released_scored_without_rating(candidates: list) -> dict:
    """CAS-1134 tightened 'scored' to require a real rating outside the upcoming/in_cinema ladder
    cohort (wm_popularity_percentile alone no longer counts) and swept the backlog once via
    reclassify_stale_scored_candidates — this asserts the rule actually holds every night, not
    just the one run it shipped in."""
    bad = [c.get("title", c.get("tmdb_id")) for c in candidates
          if c.get("outcome") == "scored" and not pp._is_ladder_cohort(c)
          and c.get("wm_user_rating") is None and c.get("wm_critic_score") is None]
    if bad:
        return _check("released_scored_without_rating", False, len(bad), 0,
                      f"{len(bad)} 'scored' candidate(s) outside the ladder cohort carry no "
                      f"rating: {bad[:5]}")
    return _check("released_scored_without_rating", True, 0, 0,
                  "every 'scored' candidate outside the ladder cohort carries a real rating.")


def _wm_fields_age_days(movie: dict, today: _dt.date) -> int | None:
    stamp = movie.get("wm_fields_fetched_at")
    if not stamp:
        return None
    try:
        return (today - _dt.date.fromisoformat(stamp)).days
    except ValueError:
        return None


def check_watchmode_freshness(movies: list, today: _dt.date) -> dict:
    """CAS-1139: the nightly fields pass and the scoreability probe now spend the free plan's
    small Watchmode pot on the titles whose ratings still move — this is the check that would
    catch that ordering silently failing (e.g. the repair/never-fetched tiers starving tier 2/3
    every night), never a volume check (catalogue_size/score_coverage) and never specific to one
    title (landmark_films).

    Fails once more than WM_FRESHNESS_MAX_PCT of the weekly-TTL cohort (pp._is_wm_weekly_cohort —
    upcoming/in_cinema, or released within pp.WM_RECENT_RELEASE_DAYS) carries a
    wm_fields_fetched_at older than WM_FRESHNESS_WEEKLY_MAX_AGE_DAYS, or more than
    WM_FRESHNESS_MAX_PCT of films released within pp.WM_RECENT_YEAR_DAYS carry one older than
    WM_FRESHNESS_YEAR_MAX_AGE_DAYS. A missing stamp counts as stale in both. Older films carry no
    threshold — the detail only ever reports their oldest stamp."""
    ages = [_wm_fields_age_days(m, today) for m in movies]
    known_ages = [a for a in ages if a is not None]
    oldest = max(known_ages) if known_ages else None

    weekly = [m for m in movies if pp._is_wm_weekly_cohort(m, today)]
    weekly_stale = sum(1 for m in weekly
                       if (_wm_fields_age_days(m, today) or 0) > WM_FRESHNESS_WEEKLY_MAX_AGE_DAYS
                       or m.get("wm_fields_fetched_at") is None)
    weekly_pct = (weekly_stale / len(weekly)) if weekly else 0.0

    within_year = [m for m in movies if pp._is_recent_release(m, today, pp.WM_RECENT_YEAR_DAYS)]
    year_stale = sum(1 for m in within_year
                     if (_wm_fields_age_days(m, today) or 0) > WM_FRESHNESS_YEAR_MAX_AGE_DAYS
                     or m.get("wm_fields_fetched_at") is None)
    year_pct = (year_stale / len(within_year)) if within_year else 0.0

    detail = (f"{weekly_pct:.1%} of weekly-TTL film(s) stale past "
             f"{WM_FRESHNESS_WEEKLY_MAX_AGE_DAYS}d, {year_pct:.1%} of film(s) released within "
             f"{pp.WM_RECENT_YEAR_DAYS}d stale past {WM_FRESHNESS_YEAR_MAX_AGE_DAYS}d, oldest "
             f"stamp in the catalogue is {oldest if oldest is not None else 'unknown'} day(s) old.")
    ok = weekly_pct <= WM_FRESHNESS_MAX_PCT and year_pct <= WM_FRESHNESS_MAX_PCT
    return _check("watchmode_freshness", ok, round(max(weekly_pct, year_pct) * 100, 1),
                 round(WM_FRESHNESS_MAX_PCT * 100, 1), detail)


def check_landmark_films(movies: list) -> dict:
    """Asks the shipped engine (poc_pipeline.scoreable_ids -> scripts/scoreable_shim.mjs ->
    isScoreable — the same route tests/test_data_quality.py's own publication-floor test uses,
    never a Python re-implementation of the score) whether each of LANDMARK_FILMS is published
    and clears WM_PUBLISH_FLOOR today. These are certain to be in Australian distribution and
    highly rated, so a failure here means something broke upstream in a way that moves neither
    the catalogue's volume nor its score-coverage checks (CAS-1134's own defect, exactly)."""
    by_id = {m.get("tmdb_id"): m for m in movies}
    scoreable = pp.scoreable_ids(movies, floor=pp.WM_PUBLISH_FLOOR)
    missing = [name for tmdb_id, name in LANDMARK_FILMS.items()
              if tmdb_id not in by_id or tmdb_id not in scoreable]
    if missing:
        return _check("landmark_films", False, len(missing), 0,
                      f"missing or below WM_PUBLISH_FLOOR: {', '.join(missing)}")
    return _check("landmark_films", True, len(LANDMARK_FILMS), len(LANDMARK_FILMS),
                  f"all {len(LANDMARK_FILMS)} landmark film(s) published and scoreable.")


# ---------------------------------------------------------------------------
# assemble + report
# ---------------------------------------------------------------------------
CHECK_NAMES = ("catalogue_size", "catalogue_integrity", "tmdb_fetch", "watchmode_fetch",
              "watchmode_pace", "oscarbase_fetch", "score_coverage", "email_send", "push_send",
              "usage_events_insert", "auth_signin",
              "client_error_rate", "empty_account_rate", "activity_floor",
              "watchmode_identity", "watchmode_remap_backlog", "released_scored_without_rating",
              "landmark_films", "watchmode_freshness")

# CAS-993: the monitor only runs in alerts.yml now, so email_send/push_send — the two checks that
# read THIS run's delivery stats — can only be asserted there. Every other check still runs in
# daily.yml, straight after the catalogue refresh, as before.
ALERT_CHECK_NAMES = ("email_send", "push_send")
DAILY_CHECK_NAMES = tuple(n for n in CHECK_NAMES if n not in ALERT_CHECK_NAMES)


def run_checks(*, today_movies=None, prev_movies=None, stats=None, usage_probe=None, auth_probe=None,
              apns_configured=None, wm_cycle=None, today=None, usage_window=None, names=None,
              candidates=None, tv_tmdb_ids=None, remap_backlog_prev=None) -> list:
    """Compute only the checks named in `names` (default: every check in CHECK_NAMES, unchanged
    legacy behaviour). Each check is a lazy thunk, so a scoped caller (daily.yml's
    DAILY_CHECK_NAMES or alerts.yml's ALERT_CHECK_NAMES) never pays for — or needs to supply
    inputs for — a check outside its own scope. This matters beyond cost: usage_probe's underlying
    probe_usage_events_insert() does a real Supabase INSERT, which must not fire twice a day."""
    names = set(CHECK_NAMES if names is None else names)
    thunks = {
        "catalogue_size": lambda: check_catalogue_size(today_movies, prev_movies),
        "catalogue_integrity": lambda: check_catalogue_integrity(today_movies),
        "tmdb_fetch": lambda: check_tmdb_fetch(stats.get("tmdb")),
        "watchmode_fetch": lambda: check_watchmode_fetch(
            stats.get("watchmode"),
            run_max_credits_raw=os.environ.get("WM_RUN_MAX_CREDITS"),
            unfilled_count=sum(1 for m in today_movies if not m.get("wm_fields_fetched_at"))),
        "watchmode_pace": lambda: check_watchmode_pace(wm_cycle, today),
        "oscarbase_fetch": lambda: check_oscarbase_fetch(stats.get("oscarbase")),
        "score_coverage": lambda: check_score_coverage(today_movies, prev_movies),
        "email_send": lambda: check_email_send(stats.get("email")),
        "push_send": lambda: check_push_send(stats.get("push"), apns_configured),
        "usage_events_insert": lambda: check_usage_events_insert(usage_probe),
        "auth_signin": lambda: check_auth_signin(auth_probe),
        "client_error_rate": lambda: check_client_error_rate(usage_window),
        "empty_account_rate": lambda: check_empty_account_rate(usage_window),
        "activity_floor": lambda: check_activity_floor(usage_window),
        "watchmode_identity": lambda: check_watchmode_identity(stats.get("watchmode")),
        "watchmode_remap_backlog": lambda: check_watchmode_remap_backlog(
            (today_movies or []) + (candidates or []), tv_tmdb_ids, remap_backlog_prev),
        "released_scored_without_rating": lambda: check_released_scored_without_rating(candidates or []),
        "landmark_films": lambda: check_landmark_films(today_movies or []),
        "watchmode_freshness": lambda: check_watchmode_freshness(today_movies or [], today),
    }
    return [thunks[n]() for n in CHECK_NAMES if n in names]


def build_report(checks: list, checked_at: str) -> dict:
    stamped = [dict(c, checked_at=checked_at) for c in checks]
    ok = all(c["ok"] is not False for c in stamped)
    return {"checked_at": checked_at, "checks": stamped, "ok": ok}


def merge_report(existing: dict | None, checks: list, checked_at: str) -> dict:
    """CAS-993: daily.yml and alerts.yml each assert a different subset of CHECK_NAMES now, in
    separate jobs — this lets the second job's write add its checks to the first job's own report
    rather than overwriting it down to just its own subset. CAS-1075: this used to only keep
    `existing`'s checks when it was written on the same UTC calendar date, but daily.yml (~20:00
    UTC) and alerts.yml (~07:00 UTC) always straddle a date boundary, so that gate discarded
    daily's 12 checks on every single alerts run. Each check now carries its own `checked_at`, so
    there's no need for a report-level date gate at all: merge by check name unconditionally,
    freshest entry per name wins. Prior checks written before per-check `checked_at` existed (or
    read from a report where the check itself never carried one) fall back to the report's own
    `checked_at`, so every merged check always has one."""
    existing_checked_at = existing.get("checked_at") if existing else None
    prior_checks = [
        c if "checked_at" in c else dict(c, checked_at=existing_checked_at)
        for c in (existing.get("checks", []) if existing else [])
    ]
    fresh_names = {c["name"] for c in checks}
    stamped = [dict(c, checked_at=checked_at) for c in checks]
    merged = [c for c in prior_checks if c["name"] not in fresh_names] + stamped
    ok = all(c["ok"] is not False for c in merged)
    return {"checked_at": checked_at, "checks": merged, "ok": ok}


# ---------------------------------------------------------------------------
# --dry-run: a synthetic, deterministic, fully-green fixture — built in code rather than
# committing a real ~5,500-record movies.json fixture, so AC1 stays offline and fast without
# bloating the repo.
# ---------------------------------------------------------------------------
def _synthetic_catalogue(n: int, scored_pct: float = 1.0) -> list:
    scored_n = round(n * scored_pct)
    out = []
    for i in range(n):
        out.append({
            "tmdb_id": 900000 + i,
            "title": f"Health Fixture Film {i}",
            "cinema_date": "2026-01-01",
            "status": ["in_cinema"],
            "wm_user_rating": 7.5 if i < scored_n else None,
            "wm_critic_score": None,
            # CAS-1003: every fixture record carries this so the dry-run's watchmode_fetch check
            # stays green regardless of whatever WM_RUN_MAX_CREDITS happens to be in the real
            # shell running the demo — an unset variable only fails when unfilled records exist.
            "wm_fields_fetched_at": "2026-09-14",
        })
    return out


def _dry_run_inputs():
    today = _dt.date(2026, 9, 15)
    today_movies = _synthetic_catalogue(5600, scored_pct=1.0)
    prev_movies = _synthetic_catalogue(5580, scored_pct=1.0)
    # CAS-1135: landmark_films needs each of LANDMARK_FILMS actually present and clearing
    # WM_PUBLISH_FLOOR — a real rating well above the floor, a non-ladder-cohort status so
    # isScoreable() scores it on wmQScore alone.
    for tmdb_id, name in LANDMARK_FILMS.items():
        today_movies.append({
            "tmdb_id": tmdb_id, "title": name, "cinema_date": "2020-01-01",
            "status": ["included_streaming"], "wm_user_rating": 8.5, "wm_critic_score": 85,
            "wm_fields_fetched_at": "2026-09-14", "wm_id": f"fixture-{tmdb_id}",
        })
    candidates = []   # CAS-1135: empty — released_scored_without_rating has nothing to flag.
    tv_tmdb_ids = set()   # CAS-1135: empty but not None — watchmode_remap_backlog runs at 0.
    stats = {
        "tmdb": {"calls": 5600, "errors": 0},
        "watchmode": {"calls": 40, "errors": 0, "quota": 40000, "quota_used": 10000,
                     "remaining_monthly_credits": 30000, "mismatch": 0},
        "oscarbase": {"calls": 20, "errors": 0},
        "email": {"attempted": 3, "delivered": 3, "errors": 0},
        "push": {"attempted": 2, "delivered": 2, "errors": 0},
    }
    usage_probe = {"ok": True, "detail": "fixture — offline demo."}
    auth_probe = {"ok": True, "detail": "fixture — offline demo."}
    # a well-paced cycle: 250 credit(s)/day over 3 days of a 40000-credit quota, nowhere near
    # exhausting before the reset — keeps the --dry-run fixture all-green.
    wm_cycle = {"cycle_start": "2026-09-12", "cycle_end": "2026-10-12", "quota": 40000,
               "quota_live": True, "spent": 750, "updated_at": today.isoformat(),
               "days": {"2026-09-12": 250, "2026-09-13": 250, "2026-09-14": 250}}
    # CAS-985: 200 app_open rows across 50 devices (well above the 50-row floor), 3 error rows (1.5%,
    # under both the 5%/20-row ceilings), 5 empty-account sign-ins of 155 (3.2%, under the 10% ceiling),
    # and the same 50 devices active the previous day too — an all-green window.
    rows24 = [{"type": "app_open", "client_key": f"fixture-device-{i % 50}", "data": None} for i in range(200)]
    rows24 += [{"type": "client_error", "client_key": "fixture-device-0",
               "data": {"message": "fixture error"}} for _ in range(3)]
    rows24 += [{"type": "signin_returning", "client_key": f"fixture-device-{i}", "data": None} for i in range(150)]
    rows24 += [{"type": "signin_empty_account", "client_key": f"fixture-device-{150+i}", "data": None}
              for i in range(5)]
    rows_prev = [{"type": "app_open", "client_key": f"fixture-device-{i % 50}", "data": None} for i in range(180)]
    usage_window = {"rows24": rows24, "rows_prev": rows_prev}
    return (today_movies, prev_movies, stats, usage_probe, auth_probe, True, wm_cycle, today,
           usage_window, candidates, tv_tmdb_ids)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.health",
                                description="Nightly health assertions (CAS-974).")
    p.add_argument("--dry-run", action="store_true",
                   help="Run offline against a synthetic all-green fixture; exits 0.")
    p.add_argument("--out", metavar="PATH", help="Where to write the report (default: state/health.json).")
    p.add_argument("--scope", choices=("all", "daily", "alerts"), default="all",
                   help="CAS-993: 'daily' asserts every check except email_send/push_send (the "
                        "monitor no longer runs in daily.yml, so this run has nothing to say about "
                        "delivery); 'alerts' asserts only those two, straight after alerts.yml's own "
                        "monitor step. Both merge into an existing same-day report rather than "
                        "overwriting it. Default 'all' is the unchanged legacy behaviour.")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    now_dt = _dt.datetime.now(_dt.timezone.utc)
    checked_at = now_dt.isoformat()

    names = {"daily": DAILY_CHECK_NAMES, "alerts": ALERT_CHECK_NAMES}.get(args.scope)

    out_path = args.out or HEALTH_FILE
    existing = None
    if os.path.exists(out_path):
        try:
            existing = json.load(open(out_path, encoding="utf-8"))
        except Exception:
            existing = None

    def _prev_check_value(name):
        return next((c.get("value") for c in (existing.get("checks", []) if existing else [])
                    if c.get("name") == name), None)

    if args.dry_run:
        (today_movies, prev_movies, stats, usage_probe, auth_probe, apns_configured,
         wm_cycle, today, usage_window, candidates, tv_tmdb_ids) = _dry_run_inputs()
        remap_backlog_prev = None
    elif args.scope == "alerts":
        # The only inputs email_send/push_send read are state/run_stats.json's email/push
        # sections (just written by this same job's monitor step) and the APNS_* env vars — skip
        # the rest of the live gather entirely, including probe_usage_events_insert's real INSERT,
        # which this scope must not repeat a second time in the same day.
        today = _dt.date.today()
        today_movies, prev_movies, candidates = [], [], []
        stats = runstats.load()
        usage_probe = auth_probe = usage_window = None
        apns_configured = all(os.environ.get(v) for v in APNS_ENV_VARS)
        wm_cycle = {}
        tv_tmdb_ids = None
        remap_backlog_prev = None
    else:
        today = _dt.date.today()
        today_movies = movies_of(load_today())
        prev_movies = movies_of(load_yesterday_from_git())
        candidates = list(pp.load_candidates().values())
        tv_tmdb_ids = _load_watchmode_tv_tmdb_ids(today)
        remap_backlog_prev = _prev_check_value("watchmode_remap_backlog")
        stats = runstats.load()
        supabase_url = os.environ.get(SUPABASE_URL_ENV)
        anon_key = os.environ.get(SUPABASE_ANON_KEY_ENV)
        service_role_key = os.environ.get(SUPABASE_SERVICE_ROLE_KEY_ENV)
        canary_email = os.environ.get(CANARY_EMAIL_ENV)
        usage_probe = probe_usage_events_insert(supabase_url, anon_key)
        auth_probe = probe_auth_signin(supabase_url, anon_key, service_role_key, canary_email)
        usage_window = probe_usage_window(supabase_url, anon_key, service_role_key, canary_email, now_dt)
        apns_configured = all(os.environ.get(v) for v in APNS_ENV_VARS)
        wm_cycle = pp._load_wm_cycle_budget(today)

    checks = run_checks(today_movies=today_movies, prev_movies=prev_movies, stats=stats,
                        usage_probe=usage_probe, auth_probe=auth_probe, apns_configured=apns_configured,
                        wm_cycle=wm_cycle, today=today, usage_window=usage_window, names=names,
                        candidates=candidates, tv_tmdb_ids=tv_tmdb_ids,
                        remap_backlog_prev=remap_backlog_prev)

    for c in checks:
        marker = {"ok": "OK", "fail": "FAIL", "unknown": "unknown", "skipped": "skipped",
                  "warn": "WARN"}[c["status"]]
        print(f"[health] {c['name']}: {marker} — {c['detail']}")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if args.scope in ("daily", "alerts"):
        report = merge_report(existing, checks, checked_at)
    else:
        report = build_report(checks, checked_at)
    json.dump(report, open(out_path, "w", encoding="utf-8"), indent=2)

    # Exit status is about THIS run's own checks, never a merged-in failure the other scope
    # already reported (and already alerted on) earlier today — merging two scopes into one
    # file must not make alerts.yml fail because daily.yml's catalogue check was red, or vice
    # versa.
    ok_this_run = all(c["ok"] is not False for c in checks)
    if not ok_this_run:
        failed = [c["name"] for c in checks if c["ok"] is False]
        print(f"[health] FAILED: {', '.join(failed)}")
        return 1
    print("[health] all checks passed (unknown/skipped tolerated).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
