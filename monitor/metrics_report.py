"""Standalone daily summary email (CAS-1021, reshaped by CAS-1526).

One short email Lee can read in ten seconds: a subject carrying the verdict, then three small
sections — System health, Members, Onboarding — and one link to the admin site for detail. No raw
tables. Sent via Resend to ``CASCADE_ALERT_TO``.

    python -m monitor.metrics_report            # live: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY,
                                                  # sends via Resend
    python -m monitor.metrics_report --dry-run   # prints the HTML, sends nothing

Auto-dry-run: any of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY / CASCADE_ALERT_TO
missing runs as if --dry-run had been passed. Health comes from state/health.json (nightly),
state/uptime.json (hourly) and state/refresh_log.json — the same files the admin site's System
health tab reads. An unreadable source renders "unavailable" for its section; the run carries on.
"""
from __future__ import annotations

import argparse
import collections
import datetime as _dt
import html as _html
import json
import os
import sys

from .emailer import send_via_resend
from .store import SERVICE_KEY_ENV, SUPABASE_URL_ENV, store_from_env

RESEND_API_KEY_ENV = "RESEND_API_KEY"
ALERT_TO_ENV = "CASCADE_ALERT_TO"
REQUIRED_ENV = (SUPABASE_URL_ENV, SERVICE_KEY_ENV, RESEND_API_KEY_ENV, ALERT_TO_ENV)

ADMIN_URL = "https://cascade-admin.pages.dev"
ROBOT_EMAILS = frozenset({"lee+canary@codynamics.com.au"})
STATE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state")
HOURLY_MAX_AGE = _dt.timedelta(hours=3)    # the hourly monitor is expected well inside this
NIGHTLY_MAX_AGE = _dt.timedelta(hours=36)  # the nightly run is expected inside this

# What a failing check means, in words; anything unlisted falls back to its own detail.
CHECK_MEANING = {
    "site_up": "the live site is not answering",
    "movies_json": "movies.json is missing or unreadable",
    "supabase_canary": "the Supabase canary read failed",
    "signup": "sign-up is failing",
    "orphan_probe_accounts": "a monitoring probe account was left behind",
    "usage_events_insert": "usage events cannot be written",
    "pages_head": "the Pages host is not answering",
    "catalogue_size": "the film catalogue is smaller than expected",
    "catalogue_integrity": "the film catalogue has malformed records",
    "tmdb_fetch": "TMDB fetches are failing",
    "watchmode_fetch": "Watchmode fetches are failing",
    "auth_signin": "sign-in is failing",
}


def _parse_ts(value):
    if not value:
        return None
    try:
        ts = _dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=_dt.timezone.utc)


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _problem_line(name, detail):
    meaning = CHECK_MEANING.get(name)
    detail = (detail or "").strip()
    if meaning and detail:
        return f"{name}: {meaning} ({detail})"
    return f"{name}: {meaning or detail or 'failing'}"


def build_health(now, health, uptime, refresh_log) -> dict:
    """{'problems': [line, ...], 'movie': line}. Inputs are the parsed state files (None =
    unreadable). Only checks that ran and failed (ok is False) count: an "unknown" check never ran,
    which is not a problem. A monitor that has not reported inside its window is itself a problem."""
    problems = []
    if uptime is None:
        problems.append("hourly monitor: no report available (state/uptime.json unreadable)")
    else:
        last = _parse_ts(uptime.get("lastRun"))
        if last is None or now - last > HOURLY_MAX_AGE:
            problems.append("hourly monitor: has not reported in the last 3 hours")
        for c in uptime.get("checks", []):
            if c.get("ok") is False:
                problems.append(_problem_line(c.get("name", "?"), c.get("detail")))
    if health is None:
        problems.append("nightly monitor: no report available (state/health.json unreadable)")
    else:
        last = _parse_ts(health.get("checked_at"))
        if last is None or now - last > NIGHTLY_MAX_AGE:
            problems.append("nightly monitor: has not reported in the last 36 hours")
        for c in health.get("checks", []):
            if c.get("ok") is False:
                problems.append(_problem_line(c.get("name", "?"), c.get("detail")))

    runs = (refresh_log or {}).get("runs") or []
    if not runs:
        movie = "Movie data: unavailable (no refresh log)"
        problems.append("movie data: no refresh recorded")
    else:
        run = runs[0]
        cat = run.get("catalogue", {})
        ts = _parse_ts(run.get("run_at"))
        when = ts.strftime("%Y-%m-%d %H:%M UTC") if ts else "unknown time"
        movie = (f"Movie data: refreshed {when}, {cat.get('after', '?')} films "
                 f"(+{cat.get('new', 0)} new)")
        if ts is None or now - ts > NIGHTLY_MAX_AGE:
            problems.append("movie data: the daily refresh has not run in the last 36 hours")
    return {"problems": problems, "movie": movie}


def build_members(now, users):
    """Counts of real accounts (monitoring robots excluded) by created_at. None = unavailable."""
    if users is None:
        return None
    real = [u for u in users if (u.get("email") or "").lower() not in ROBOT_EMAILS]
    created = [_parse_ts(u.get("created_at")) for u in real]

    def since(days):
        return sum(1 for c in created if c and now - c <= _dt.timedelta(days=days))

    return {"total": len(real), "d1": since(1), "d7": since(7), "d30": since(30)}


def build_onboarding(now, users, events):
    """First-run summary over members created in the last 7 days. None = unavailable;
    {'no_data': True} when no onbstep_shown step data exists for them yet."""
    if users is None or events is None:
        return None
    cutoff = now - _dt.timedelta(days=7)
    new_ids = set()
    for u in users:
        if (u.get("email") or "").lower() in ROBOT_EMAILS:
            continue
        created = _parse_ts(u.get("created_at"))
        if created and created >= cutoff:
            new_ids.add(u.get("id"))
    last_step = {}
    finished = set()
    for e in sorted(events, key=lambda e: (e.get("created_at") or "")):
        uid = e.get("user_id")
        step = (e.get("data") or {}).get("step")
        if uid not in new_ids or not step:
            continue
        last_step[uid] = step
        if step == "oaf_done":
            finished.add(uid)
    if not last_step:
        return {"no_data": True, "new": len(new_ids)}
    stopped = collections.Counter(step for uid, step in last_step.items() if uid not in finished)
    top = stopped.most_common(1)[0] if stopped else None
    return {"no_data": False, "new": len(new_ids), "finished": len(finished),
            "top_step": top[0] if top else None, "top_count": top[1] if top else 0}


def gather(store, now, state_dir=STATE_DIR) -> dict:
    """Everything the email needs. Each live source fails independently into None."""
    health = _read_json(os.path.join(state_dir, "health.json"))
    uptime = _read_json(os.path.join(state_dir, "uptime.json"))
    refresh = _read_json(os.path.join(state_dir, "refresh_log.json"))
    users = events = None
    if store is not None:
        try:
            users = store.fetch_auth_users()
        except Exception as err:  # noqa: BLE001 — a read failure is a result, never a crash
            print(f"[metrics_report] members: unavailable ({type(err).__name__}: {err})")
        try:
            since = (now - _dt.timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
            events = store.fetch_onbstep_events(since)
        except Exception as err:  # noqa: BLE001
            print(f"[metrics_report] onboarding: unavailable ({type(err).__name__}: {err})")
    return {
        "health": build_health(now, health, uptime, refresh),
        "members": build_members(now, users),
        "onboarding": build_onboarding(now, users, events),
    }


def _h(text):
    return ('<div style="font-size:14px;font-weight:800;color:#141A2A;margin:18px 0 6px;">'
            f'{_html.escape(text)}</div>')


def _p(text, color="#141A2A"):
    return f'<div style="font-size:13px;color:{color};margin:2px 0;">{_html.escape(text)}</div>'


def render_report(data: dict, report_date: _dt.date) -> dict:
    """data: the dict gather() returns. Returns {'subject', 'html'}."""
    esc = _html.escape
    problems = data["health"]["problems"]
    verdict = "All good" if not problems else f"{len(problems)} problem{'s' if len(problems) != 1 else ''}"
    subject = f"Cascade daily — {report_date.isoformat()} — {verdict}"

    health = _h("System health") + _p(verdict, "#141A2A" if not problems else "#c0392b")
    health += "".join(_p(line, "#c0392b") for line in problems)
    health += _p(data["health"]["movie"])

    m = data.get("members")
    members = _h("Members")
    if m is None:
        members += _p("unavailable", "#8b95a5")
    else:
        members += _p(f"{m['total']} members")
        members += _p(f"New: {m['d1']} in 24 hours · {m['d7']} in 7 days · {m['d30']} in 30 days")

    o = data.get("onboarding")
    onboarding = _h("Onboarding")
    if o is None:
        onboarding += _p("unavailable", "#8b95a5")
    elif o["no_data"]:
        onboarding += _p("no first-run step data yet")
    else:
        onboarding += _p(f"Of {o['new']} new members in the last 7 days, {o['finished']} finished the first run.")
        if o["top_step"]:
            onboarding += _p(f"Most of the rest stopped at: {o['top_step']} ({o['top_count']}).")

    link = (f'<div style="font-size:13px;margin-top:20px;">Details: '
            f'<a href="{esc(ADMIN_URL)}" style="color:#7C5CFF;">{esc(ADMIN_URL)}</a></div>')
    html_doc = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        '<body style="margin:0;background:#f4f5f8;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        '<div style="max-width:640px;margin:24px auto;background:#ffffff;border-radius:14px;padding:24px;">'
        '<div style="font-size:18px;font-weight:700;letter-spacing:1px;color:#7C5CFF;'
        'text-transform:uppercase;">Cascade daily</div>'
        f'<div style="font-size:12px;color:#8b95a5;margin-top:2px;">{esc(report_date.isoformat())}</div>'
        + health + members + onboarding + link +
        '</div></body></html>'
    )
    return {"subject": subject, "html": html_doc}


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.metrics_report",
                                description="Daily summary email (CAS-1021 / CAS-1526).")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the HTML and send nothing.")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    now = _dt.datetime.now(_dt.timezone.utc)

    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    dry_run = args.dry_run or bool(missing)
    if missing:
        print(f"[metrics_report] missing secret(s) {', '.join(missing)} — running --dry-run.")

    store = store_from_env()
    report = render_report(gather(store, now), now.date())
    print(report["html"])

    if dry_run:
        return 0

    send_via_resend(os.environ[ALERT_TO_ENV], report["subject"], report["html"], text="")
    print(f"[metrics_report] sent to {os.environ[ALERT_TO_ENV]}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
