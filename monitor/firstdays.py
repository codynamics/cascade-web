"""CAS-1555: the first-ten-days simulator - age a staging QA account day by day and check each day.

    python -m monitor.firstdays --accounts a,b,c,d [--accounts-file accounts.txt] [--send]

Every first-days behaviour keys off the account's creation time (auth.users.created_at): the day +1 catch-up
(monitor/catchup.py due_users) and the tutorial banner (the app's tutBannerDecide). So for day 0 to 10 this moves
each account's created_at back (qa.sim.age_account), runs the find / push / email phases for that account against
an UNCHANGED catalogue (yesterday == today, so only first-days behaviour can alert), reads back its alert batches,
notifications, push and email records, and checks them against qa/firstdays/<account>.json. App-side rules are not
re-derived: monitor/firstdays_shim.mjs asks the built index.html's own tutBannerDecide with the aged created_at.

CAS-1567: the day-7 recap lands on whichever nightly run is 7 Sydney calendar days after the aged sign-up date
(that depends on the clock's time of day, so it is computed here from the same date rule monitor/recap.py uses,
not hard-coded to a day number): it must bring exactly one recap batch + one email and no push.

Day N's created_at is `now - (N - 0.5) days` (day 0: now): at day 1 the account is 12 h old, inside the catch-up
window (CATCHUP_WINDOW_H), so day 1 is the first nightly run after sign-up; from day 2 it is outside it. Day 0 has
`"run": false`: the account was just created and no nightly run has happened, so nothing runs and nothing is owed.

CAS-1592: a day's expectation may carry `"taste_line": true` - the one-time "<agent> has learned something" email line
(an account seeded with 10 Watched ratings and a 5+ point genre pair). Absent means NO line that day, so an unexpected
line is a FAIL too; none of the shipped accounts a-d is seeded with ratings, so none expects it. (Not checked with --send:
the delivered email is not read back.)

One line per account per day, PASS or FAIL; exit 1 on any FAIL. The accounts' real created_at is restored at the end
(also after a FAIL or an error), and their ledger rows and alert batches are removed before and after the run.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import io
import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path
from unittest import mock

from . import __main__ as monitor_main
from .catalogue import load_catalogue_file, load_today
from .journey import (JourneyStore, Sends, SetupFail, _ledger, _run_engine_find, _write_catalogue,
                      accounts_from_list, neutralise)
from . import recap as recap_mod
from .phases import email_phase, push_phase

ROOT = Path(__file__).resolve().parent.parent
FIRSTDAYS_DIR = ROOT / "qa" / "firstdays"
_SHIM = Path(__file__).resolve().parent / "firstdays_shim.mjs"
DAYS = range(0, 11)
NO_FILM = "0"   # purge_journey_state(movie_id=...) with a film id that exists nowhere: keeps Watched / Not for me rows


def load_expectations(key: str, directory=FIRSTDAYS_DIR) -> dict:
    with open(Path(directory) / f"{key}.json", encoding="utf-8") as fh:
        spec = json.load(fh)
    missing = [str(d) for d in DAYS if str(d) not in spec.get("days", {})]
    if missing:
        raise SetupFail(f"qa/firstdays/{key}.json has no entry for day(s) " + ", ".join(missing))
    return spec


def created_at_for_day(day: int, now: _dt.datetime) -> _dt.datetime:
    return now if day == 0 else now - _dt.timedelta(days=day - 0.5)


def app_banner(cases: list) -> list:
    """The app's own tutBannerDecide for each {key, createdAt, now(ms)} case."""
    proc = subprocess.run(["node", str(_SHIM)], input=json.dumps({"cases": cases}), capture_output=True,
                          text=True, encoding="utf-8", timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(f"firstdays_shim.mjs failed (exit {proc.returncode}): {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def check_day(exp: dict, obs: dict) -> list:
    """Problems (empty = PASS) between one day's expectation and what was observed."""
    problems = []
    if not exp.get("run", True):
        if obs["new_rows"] or obs["new_batches"] or obs["total_catchup_batches"]:
            problems.append("nothing was due yet but the account already has alerts or a catch-up batch")
    elif exp.get("catchup") == "arrives":
        if obs["new_catchup_batches"] != 1:
            problems.append(f"expected exactly 1 new catchup batch, got {obs['new_catchup_batches']}")
        if obs["total_catchup_batches"] != 1:
            problems.append(f"expected exactly 1 catchup batch in total, got {obs['total_catchup_batches']}")
        if obs["catchup_rows"] < exp.get("min_films", 1):
            problems.append(f"expected at least {exp.get('min_films', 1)} catch-up film(s), got {obs['catchup_rows']}")
    elif obs.get("recap_due"):
        # CAS-1567: the day-7 recap - exactly one recap batch and one email, no push, and no ordinary alert
        # (the catalogue is unchanged, so every new row can only be a row the recap itself names).
        if obs["new_recap_batches"] != 1:
            problems.append(f"expected exactly 1 new recap batch, got {obs['new_recap_batches']}")
        if obs["new_rows"] != obs["recap_rows"]:
            problems.append(f"expected only recap rows, got {obs['new_rows']} new row(s) / {obs['recap_rows']} recap")
        if obs["pushes"]:
            problems.append(f"expected no push for the recap, got push={obs['pushes']}")
        if obs["mails"] < 1 and (obs["recap_rows"] or not obs.get("send")):
            problems.append("expected the recap email, none was sent")
    else:
        if obs["new_batches"] or obs["new_rows"]:
            problems.append(f"expected no new alerts, got {obs['new_batches']} batch(es) / {obs['new_rows']} row(s)")
        if obs["pushes"] or obs["mails"]:
            problems.append(f"expected no push or email, got push={obs['pushes']} email={obs['mails']}")
    # CAS-1592: the one-time "<agent> has learned something" line. A day's expectation says `"taste_line": true`
    # only for an account seeded with 10 Watched ratings and a 5+ point pair; every other day expects none.
    if obs.get("taste_lines") is not None and obs["taste_lines"] != (1 if exp.get("taste_line") else 0):
        problems.append(f"expected {1 if exp.get('taste_line') else 0} taste line(s) in the email, got {obs['taste_lines']}")
    if obs["banner"] != bool(exp.get("banner")):
        problems.append(f"expected banner eligible={bool(exp.get('banner'))}, the app says {obs['banner']}")
    return problems


def _fake_datetime(clock):
    class _FakeDatetime(_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            t = clock()
            return t.astimezone(tz) if tz else t.replace(tzinfo=None)
    return types.SimpleNamespace(datetime=_FakeDatetime, date=_dt.date, time=_dt.time,
                                 timedelta=_dt.timedelta, timezone=_dt.timezone)


def _kinds(batches, kind):
    return [b for b in batches if b.get("kind") == kind]


def run_firstdays(store, accounts: dict, catalogue: list, set_created_at, send: bool = False, out=print,
                  clock=None, expectations_dir=FIRSTDAYS_DIR, banner_fn=app_banner) -> int:
    """Days 0..10 for each account. `set_created_at(uid, iso)` moves an account's creation time (the real one
    writes auth.users; tests pass the in-memory store's). Returns 0 (all PASS), 1 (any FAIL) or 2 (SETUP FAIL)."""
    uids = list(accounts.values())
    now_fn = clock or (lambda: _dt.datetime.now(_dt.timezone.utc))
    try:
        specs = {k: load_expectations(k, expectations_dir) for k in accounts}
    except (SetupFail, OSError) as err:
        out(f"SETUP FAIL firstdays: {err}")
        return 2
    originals = dict(store.fetch_user_created_at() or {})
    missing = [k for k, u in accounts.items() if not originals.get(u)]
    if missing:
        out("SETUP FAIL firstdays: no created_at on record for account(s) " + ", ".join(missing))
        return 2
    jstore = JourneyStore(store, accounts, send)
    catalogue = neutralise(catalogue)
    fails = 0
    patch = mock.patch.object(monitor_main, "_dt", _fake_datetime(now_fn)) if clock else contextlib.nullcontext()
    try:
        store.purge_journey_state(uids, NO_FILM)   # a clean start: no ledger rows, no catch-up batch
        prefs = store.fetch_notify_prefs()
        emails = {(prefs.get(u) or {}).get("email_address") or "": u for u in uids}
        sends = Sends(accounts, emails)
        tmp = tempfile.mkdtemp(prefix="firstdays-")
        cat_path, held = os.path.join(tmp, "catalogue.json"), os.path.join(tmp, "held.json")
        run_date = now_fn().astimezone(_dt.timezone.utc).date().isoformat()
        _write_catalogue(cat_path, catalogue, run_date)   # yesterday == today: no film changes state
        today_movies = load_catalogue_file(cat_path)
        with patch:
            for day in DAYS:
                now = now_fn()
                created = created_at_for_day(day, now)
                for k, uid in accounts.items():
                    set_created_at(uid, created.isoformat())
                banners = banner_fn([{"key": specs[k].get("tutorial_banner_key", "moods"),
                                      "createdAt": created.isoformat(),
                                      "now": int((created + _dt.timedelta(days=day)).timestamp() * 1000)}
                                     for k in accounts])
                for (k, uid), banner in zip(accounts.items(), banners):
                    exp = specs[k]["days"][str(day)]
                    seen = set(_ledger(store, uid))
                    batches_before = store.fetch_alert_batches(uid)
                    sends.reset()
                    if exp.get("run", True):
                        _run_engine_find(jstore, cat_path, cat_path, run_date, uid, held)
                        stamp = now_fn()
                        with contextlib.redirect_stdout(io.StringIO()):
                            push_phase(jstore, stamp, target_user=uid, **({} if send else {"send": sends.push}))
                            email_phase(jstore, today_movies, stamp, target_user=uid,
                                        **({} if send else {"send": sends.mail}))
                    new_rows = [r for i, r in _ledger(store, uid).items() if i not in seen]
                    batches = store.fetch_alert_batches(uid)
                    if send:
                        pushes = sum(1 for r in new_rows if r.get("pushed_at"))
                        mails = sum(1 for r in new_rows if r.get("emailed_at"))
                    else:
                        pushes = len([p for p in sends.pushes if p[0] == uid])
                        mails = len([m for m in sends.mails if emails.get(m[0]) == uid])
                    recap_due = exp.get("run", True) and (
                        recap_mod._sydney_day(now) - recap_mod._sydney_day(created)).days == recap_mod.RECAP_DAY
                    obs = {"banner": bool(banner), "send": send, "recap_due": bool(recap_due),
                           "new_recap_batches": len(_kinds(batches, "recap")) - len(_kinds(batches_before, "recap")),
                           "recap_rows": sum(1 for r in new_rows if r.get("moment") == recap_mod.RECAP_MOMENT),
                           "new_rows": len(new_rows),
                           "catchup_rows": sum(1 for r in new_rows if r.get("moment") == "catchup"),
                           "new_batches": len(batches) - len(batches_before),
                           "new_catchup_batches": len(_kinds(batches, "catchup")) - len(_kinds(batches_before, "catchup")),
                           "total_catchup_batches": len(_kinds(batches, "catchup")),
                           "pushes": pushes, "mails": mails,
                           "taste_lines": None if send else len([e for e in sends.taste_lines if emails.get(e) == uid])}
                    problems = check_day(exp, obs)
                    fails += bool(problems)
                    out(f"{'FAIL' if problems else 'PASS'} firstdays account={k} day={day} "
                        f"catchup={exp.get('catchup', 'none')} batches=+{obs['new_batches']} rows=+{obs['new_rows']} "
                        f"catchup_films={obs['catchup_rows']} push={obs['pushes']} email={obs['mails']} "
                        f"banner={obs['banner']}" + (" - " + "; ".join(problems) if problems else ""))
        return 1 if fails else 0
    finally:
        for k, uid in accounts.items():   # the accounts' real creation time, whatever happened above
            set_created_at(uid, originals[uid])
        store.purge_journey_state(uids, NO_FILM)


def main(argv=None, store=None, catalogue=None, out=print, accounts=None, set_created_at=None) -> int:
    p = argparse.ArgumentParser(prog="python -m monitor.firstdays", description=__doc__.split("\n")[0])
    p.add_argument("--accounts", default="a,b,c,d", help="comma list of QA account keys (a,b,c,d)")
    p.add_argument("--accounts-file", help="output of `python -m qa.sim.accounts list` (account ids)")
    p.add_argument("--send", action="store_true", help="really deliver push/email (default: render and record only)")
    args = p.parse_args(sys.argv[1:] if argv is None else argv)
    keys = [k.strip() for k in args.accounts.split(",") if k.strip()]
    if store is None:
        from qa.sim.accounts import guard
        guard(os.environ.get("SUPABASE_URL", ""))   # staging only - before any network call or write
        from .store import store_from_env
        store = store_from_env()
        if store is None:
            raise SystemExit("monitor.firstdays: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    if set_created_at is None:
        from qa.sim import age_account
        db_url = os.environ.get("SUPABASE_DB_URL", "")
        age_account.guard(db_url)
        set_created_at = lambda uid, iso: age_account.set_created_at(db_url, uid, iso)   # noqa: E731
    if catalogue is None:
        catalogue = load_today()
    try:
        if accounts is not None:
            accounts = {k: accounts[k] for k in keys}
        elif args.accounts_file:
            with open(args.accounts_file, encoding="utf-8") as fh:
                accounts = accounts_from_list(fh.read(), keys)
        else:
            from qa.sim.accounts import Api, email_for
            api = Api(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"], "")
            users = api.find_users()
            accounts = {k: users[email_for(k)] for k in keys if email_for(k) in users}
            if len(accounts) != len(keys):
                raise SetupFail("some QA accounts are missing - run `python -m qa.sim.accounts create`")
    except SetupFail as err:
        out(f"SETUP FAIL: {err}")
        return 2
    rc = run_firstdays(store, accounts, catalogue, set_created_at, send=args.send, out=out)
    out("firstdays: " + {0: "all PASS", 1: "FAIL", 2: "SETUP FAIL"}[rc])
    return rc


if __name__ == "__main__":
    sys.exit(main())
