"""CAS-1554: the film journey simulator - one film moved through every stage, every alert checked.

    python -m monitor.journey --journey qa/journeys/full-run.json --accounts a,b,c,d
    python -m monitor.journey --journey all --accounts-file accounts.txt [--send]

A journey file (qa/journeys/*.json) names CRITERIA, not a fixed film:

    {"name": "...", "description": "...",
     "criteria": {"genres": ["Drama"],                  # the film's MAIN (first) genre is one of these
                  "age_rating": ["R 18+"],              # optional
                  "qualifies": ["a"],                   # accounts whose own agent must admit the film
                  "not_qualifies": ["d"],               # accounts whose agent must not
                  "genre_state": {"a": "alerts_off"},   # optional: how the account's agent treats that genre
                                                        #   on | alerts_off | off  (read off criteria.styles)
                  "below_bar": ["a"]},                  # optional: genre on, alerts on, score under the bar
     "start": {"status": [...], "release_date": ..., "offers": [...]},   # optional: yesterday of step 1
     "steps": [{"name": "...", "date": "YYYY-MM-DD", "status": [...], "release_date": "YYYY-MM-DD"|null,
                "offers": [...], "before": [<member action>], "after": [<member action>],
                "expect": {"a": [{"moment": "announced", "channels": ["in_app", "push", "email"]}],
                           "b": "none"}}]}          # an account not named expects "none"

Member actions: {"account": "a", "action": "watched" | "not_for_me" | "watch_on" | "catchup", ...}.

HOW QUALIFICATION IS PROVED: at the start of a run the app's OWN admission engine (matching.compute_admission ->
monitor/admit_shim.mjs -> the built index.html) is asked which catalogue films each QA account's agent admits at
the journey's final step. The simulator picks a film that meets the criteria and records why. If none does it
stops with `SETUP FAIL` (a test-setup problem, not a product fail). It never uses notify_test.arm_watch, which
would bypass real qualification.

NOTHING REAL IS CHANGED: the film's moves exist only in temporary catalogue files built per engine run. What a
run writes is confined to the QA accounts (ledger rows, alert batches, push/email stamps, and the Watch On /
Watched / Not for me the member steps set); all of it is deleted before the run and again after it, FAIL or not.

EVERY ALERT COUNTS: for each step and each account the complete set of NEW alerts that account received (every
film) is compared with `expect`. A missing one is a FAIL; so is any one not in `expect`, so is a push or email
sent when nothing was expected. The yesterday/today catalogues differ in one film only.
"""
from __future__ import annotations

import argparse
import contextlib
import copy
import datetime as _dt
import glob
import io
import json
import os
import subprocess
import sys
import tempfile
import uuid
from unittest import mock

from . import __main__ as monitor_main
from .batches import sydney_date  # noqa: F401  (re-exported for tests that fake a clock)
from .catalogue import load_catalogue_file, load_today
from poc_pipeline import tier_rank

from .matching import compute_admission, compute_scores
from .notify_test import _account_prefs_for_user
from .phases import email_phase, push_phase

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JOURNEY_DIR = os.path.join(_ROOT, "qa", "journeys")
ACCOUNT_KEYS = ("a", "b", "c", "d")
EPOCH = "1970-01-01T00:00:00+00:00"
_SHIM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "journey_shim.mjs")
WATCHED = "enjoyed"
NOT_FOR_ME = "notfor"
STATUS_TO_STAGE = {"upcoming": "coming", "in_cinema": "cinema", "included_streaming": "streaming"}


class SetupFail(Exception):
    """The journey could not be set up (no film meets the criteria, unknown account...). Not a product fail."""


# --------------------------------------------------------------------------------------------------------------
# journey files
# --------------------------------------------------------------------------------------------------------------
def load_journey(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        j = json.load(fh)
    j.setdefault("name", os.path.splitext(os.path.basename(path))[0])
    if not j.get("steps"):
        raise ValueError(f"{path}: a journey needs at least one step")
    for i, s in enumerate(j["steps"], 1):
        s.setdefault("name", f"step {i}")
        for k in ("date", "status"):
            if k not in s:
                raise ValueError(f"{path}: step {i} has no {k!r}")
    return j


def journey_files(spec: str) -> list:
    if spec == "all":
        return sorted(glob.glob(os.path.join(JOURNEY_DIR, "*.json")))
    if os.path.exists(spec):
        return [spec]
    alt = os.path.join(JOURNEY_DIR, spec if spec.endswith(".json") else spec + ".json")
    if os.path.exists(alt):
        return [alt]
    raise SystemExit(f"journey {spec!r} not found")


def _expected(step: dict, key: str) -> list:
    """-> sorted ['moment:chan+chan', ...] this account must have received in this step."""
    raw = (step.get("expect") or {}).get(key, "none")
    if raw in ("none", None, []):
        return []
    return sorted(f"{e['moment']}:{'+'.join(sorted(e.get('channels') or ['in_app']))}" for e in raw)


# --------------------------------------------------------------------------------------------------------------
# the film
# --------------------------------------------------------------------------------------------------------------
def film_variant(base: dict, state: dict) -> dict:
    """`base` (a real catalogue film) in the state a step describes - nothing else about it changes."""
    m = copy.deepcopy(base)
    m["status"] = list(state["status"])
    m["cinema_date"] = state.get("release_date")
    m["offers"] = copy.deepcopy(state.get("offers") or [])
    m["window_dates"] = {s: state.get("date") or state.get("release_date") for s in state["status"]}
    return m


def variant_scores(movies: list) -> dict:
    """{tmdb_id: Cascade score | None} for the film variants themselves, asked of the shipped engine
    (journey_shim.mjs) - never the real film's score, which belongs to its real status."""
    movies = list(movies)
    if not movies:
        return {}
    proc = subprocess.run(["node", _SHIM], input=json.dumps({"movies": movies}), capture_output=True, text=True,
                          encoding="utf-8", timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(f"journey_shim.mjs failed: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def neutralise(catalogue: list) -> list:
    """The catalogue with every film's `cinema_date` cleared. The opens_soon / past_opening_weekend moments are
    computed from a film's REAL release date against the run date, so on an invented journey date other real
    films would fire them and swamp the check. Cleared, only the journey film (whose release date a step sets)
    can. Applied to the engine's admission questions too, so both see the same catalogue. Temp copies only."""
    return [dict(m, cinema_date=None) for m in catalogue]


def build_pair(base_catalogue: list, film_id: str, before: dict, after: dict):
    """-> (yesterday, today): the real catalogue with ONLY the journey film changed. `before` None = the film is
    not in yesterday at all (its first sighting)."""
    base = next(m for m in base_catalogue if str(m.get("tmdb_id")) == film_id)
    yesterday, today = [], []
    for m in base_catalogue:
        if str(m.get("tmdb_id")) == film_id:
            today.append(film_variant(base, after))
            if before is not None:
                yesterday.append(film_variant(base, before))
        else:
            today.append(m)
            yesterday.append(m)
    return yesterday, today


def _write_catalogue(path: str, movies: list, run_date: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"generated": run_date, "region": "AU", "currency": "AUD", "live": False, "movies": movies}, fh)


# --------------------------------------------------------------------------------------------------------------
# qualification, proved by the shipped engine
# --------------------------------------------------------------------------------------------------------------
def _accounts_context(store, accounts: dict):
    uids = set(accounts.values())
    cascades = [c for c in store.fetch_active_cascades() if str(c.get("user_id")) in uids]
    prefs_rows = store.fetch_user_prefs()
    films_rows = store.fetch_user_films()
    account_prefs = {}
    for uid in uids:
        account_prefs.update(_account_prefs_for_user(prefs_rows, films_rows, uid))
    return cascades, account_prefs


def _main_genre_style(cascade: dict, film: dict):
    genres = film.get("genres") or []
    styles = (cascade.get("criteria") or {}).get("styles") or {}
    if not genres:
        return None, None
    return genres[0], styles.get(genres[0])


def genre_state(cascade: dict, film: dict) -> str:
    """How the account's agent treats the film's main genre: `off` (no style entry), `alerts_off` (a style with
    no window alerting) or `on`. Read straight off the agent's own criteria.styles."""
    _, style = _main_genre_style(cascade, film)
    if style is None:
        return "off"
    if not any((style.get("al") or {}).values()):
        return "alerts_off"
    return "on"


def select_film(store, catalogue: list, journey: dict, accounts: dict, engine=compute_admission, scorer=variant_scores):
    """-> (film_id, why). Raises SetupFail with the reason when no catalogue film meets the criteria."""
    crit = journey.get("criteria") or {}
    for k in list(crit.get("qualifies", [])) + list(crit.get("not_qualifies", [])) + list(crit.get("genre_state", {})):
        if k not in accounts:
            raise SetupFail(f"the journey names account {k!r}, which is not in this run's accounts {sorted(accounts)}")
    cascades, account_prefs = _accounts_context(store, accounts)
    cascade_of = {}
    for k, uid in accounts.items():
        mine = [c for c in cascades if str(c.get("user_id")) == uid]
        if not mine:
            raise SetupFail(f"account {k!r} has no active agent - run `python -m qa.sim.accounts reset`")
        cascade_of[k] = mine[0]
    last = journey["steps"][-1]
    genres, ages = crit.get("genres"), crit.get("age_rating")
    held = {k: {str(r.get("movie_id")) for r in store.fetch_user_films() if str(r.get("user_id")) == uid}
            for k, uid in accounts.items()}

    pool = []
    for m in catalogue:
        g = m.get("genres") or []
        if not g or not m.get("poster"):
            continue
        if genres and g[0] not in genres:
            continue
        if ages and m.get("age_rating") not in ages:
            continue
        if any(str(m.get("tmdb_id")) in held[k] for k in held):
            continue
        pool.append(m)
    if not pool:
        raise SetupFail(f"no catalogue film has main genre {genres} and age rating {ages}")

    variants = [film_variant(m, last) for m in pool]
    admission = engine(list(cascade_of.values()), {"final": variants}, account_prefs=account_prefs)

    def admitted(k, film):
        return str(film["tmdb_id"]) in (admission.get(cascade_of[k]["id"], {}).get("final") or set())

    survivors = []
    for film in variants:
        ok = all(admitted(k, film) for k in crit.get("qualifies", []))
        ok = ok and not any(admitted(k, film) for k in crit.get("not_qualifies", []))
        ok = ok and all(genre_state(cascade_of[k], film) == want for k, want in crit.get("genre_state", {}).items())
        if ok:
            survivors.append(film)
    if survivors and crit.get("below_bar"):
        # genre on and alerting for the account, yet the film's score is under that genre's bar at EVERY step
        # (the score is the shipped engine's own, asked of the film as each step has moved it).
        scored = {}
        for step in journey["steps"]:
            by_id = {str(f["tmdb_id"]): film_variant(f, step) for f in survivors}
            for fid, sc in (scorer(list(by_id.values())) or {}).items():
                scored.setdefault(fid, []).append(sc)
        keep = []
        for film in survivors:
            scs = scored.get(str(film["tmdb_id"])) or []
            good = bool(scs) and all(sc is not None and sc != -1 for sc in scs)
            for k in crit["below_bar"]:
                _, style = _main_genre_style(cascade_of[k], film)
                good = good and style is not None and genre_state(cascade_of[k], film) == "on"                     and all(sc < style.get("bar", 0) for sc in scs)
            if good:
                keep.append(film)
        survivors = keep
    if not survivors:
        raise SetupFail(
            f"no catalogue film meets the criteria {json.dumps(crit, sort_keys=True)} at the final step "
            f"({len(pool)} film(s) with the right genre/age were asked of the engine; none had every account "
            "agree). Setup problem, not a product fail.")
    survivors.sort(key=lambda f: (-(f.get("popularity") or 0), str(f.get("tmdb_id"))))
    pick = survivors[0]
    why = (f"{pick.get('title')!r} [{pick['tmdb_id']}] main genre {pick['genres'][0]}, {pick.get('age_rating')}: "
           f"engine admits it for {sorted(crit.get('qualifies', []))}, not for {sorted(crit.get('not_qualifies', []))}"
           f" ({len(survivors)} qualifying film(s) of {len(pool)} candidates)")
    return str(pick["tmdb_id"]), why


# --------------------------------------------------------------------------------------------------------------
# the store the engine runs against
# --------------------------------------------------------------------------------------------------------------
class JourneyStore:
    """The real (or in-memory) store, with the three things a journey must never do switched off: the daily
    housekeeping deletes `monitor find` runs (usage_events retention, deleted-row purge) and the held-ids file
    export. When `send` is off it also gives each QA account one synthetic device token, so the push is
    rendered and recorded without a real device."""

    def __init__(self, inner, accounts: dict, send: bool):
        self._inner, self._accounts, self._send = inner, accounts, send

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def delete_old_usage_events(self, days=180):
        return 0

    def purge_deleted_rows(self, days=30):
        return 0

    def fetch_user_held_ids(self):
        return None

    def fetch_push_tokens(self):
        if self._send:
            return self._inner.fetch_push_tokens()
        return {uid: [f"journey-token-{uid}"] for uid in self._accounts.values()}


class Sends:
    """Records every push and email a step sends. With send off it is also the (fake) transport."""

    def __init__(self, accounts: dict, emails: dict):
        self.by_uid = {uid: k for k, uid in accounts.items()}
        self.emails = emails
        self.pushes, self.mails = [], []

    def push(self, token, title, body, **kw):
        uid = token.replace("journey-token-", "")
        self.pushes.append((uid, title))
        return True

    def mail(self, to, subject, html, text, **kw):
        self.mails.append((to, subject))
        return {"fake": True}

    def reset(self):
        self.pushes, self.mails = [], []


# --------------------------------------------------------------------------------------------------------------
# running
# --------------------------------------------------------------------------------------------------------------
def _ledger(store, uid) -> dict:
    return {str(r.get("id")): r for r in store.fetch_recent_notifications(EPOCH) if str(r.get("user_id")) == uid}


def _channels(row: dict, send: bool) -> str:
    ch = ["in_app"]
    if row.get("pushed_at") or (send and os.environ.get("CASCADE_ENV", "").lower() == "staging"):
        ch.append("push")   # staging never pushes (CAS-1523): a recorded push is all a staging run can show
    if row.get("emailed_at"):
        ch.append("email")
    return "+".join(sorted(ch))


def _apply(store, uid_of: dict, film_id: str, action: dict) -> None:
    uid = uid_of[action["account"]]
    kind = action["action"]
    if kind == "watched":
        store.upsert_user_film(uid, film_id, WATCHED)
    elif kind == "not_for_me":
        store.upsert_user_film(uid, film_id, NOT_FOR_ME)
    elif kind == "watch_on":
        store.upsert_film_watch(uid, film_id, action.get("window", "stream"))
    elif kind == "catchup":
        # a day +1 catch-up row already announcing this film for a stage (CAS-1535). Marked read / pushed / emailed:
        # the member has had it, so the push and email phases must not send it again.
        cascade = next(c for c in store.fetch_active_cascades() if str(c.get("user_id")) == uid)
        now = _dt.datetime.now(_dt.timezone.utc).isoformat()
        store.insert_notifications([{
            "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"journey-catchup/{uid}/{film_id}/{action['stage']}")),
            "user_id": uid, "cascade_id": cascade["id"], "movie_id": film_id, "moment": "catchup",
            "cascade_name": cascade.get("name") or "My agent", "title": "catch-up",
            "detail": {"stage": action["stage"]}, "found_at": now, "read_at": now, "pushed_at": now,
            "emailed_at": now}])
    else:
        raise ValueError(f"unknown member action {kind!r}")


def _sync_admissions(store, accounts, catalogue, film_id, before, journey, engine, scorer) -> None:
    """What the member's device does before the nightly run: a film its agent admits (in YESTERDAY's state) is
    recorded in `agent_films` with the score it had when admitted - the row the nightly placement check reads. The
    engine is asked first (never assumed); a film the agent does not admit gets no row. First admission wins."""
    if before is None:
        return    # the film was not in yesterday's catalogue: nothing for a device to have admitted
    base = next(m for m in catalogue if str(m.get("tmdb_id")) == film_id)
    variant = film_variant(base, before)
    cascades, account_prefs = _accounts_context(store, accounts)
    admission = engine(cascades, {"y": [variant]}, account_prefs=account_prefs)
    score = (scorer([variant]) or {}).get(film_id)
    if score is None:
        return
    status = max(before["status"], key=lambda s: tier_rank([s])) if before.get("status") else "upcoming"
    for c in cascades:
        if film_id in (admission.get(c["id"], {}).get("y") or set()):
            store.upsert_agent_film({"user_id": c["user_id"], "cascade_id": c["id"], "movie_id": film_id,
                                     "admission_score": int(score), "admission_status": status})


def _run_engine_find(store, today_path, yesterday_path, date, uid, held_file) -> str:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), mock.patch.object(monitor_main, "store_from_env", lambda: store), \
            mock.patch.object(monitor_main, "USER_HELD_IDS_FILE", held_file):
        rc = monitor_main.main(["--today", today_path, "--yesterday", yesterday_path, "--date", date,
                                "--phase", "find", "--target-user", uid])
    if rc not in (0, None):
        raise RuntimeError(f"monitor find exited {rc}")
    return buf.getvalue()


def run_journey(journey: dict, store, accounts: dict, catalogue: list, send: bool = False, out=print,
                engine=compute_admission, scorer=variant_scores, clock=None) -> int:
    """Run one journey. Returns 0 (all PASS), 1 (any FAIL) or 2 (SETUP FAIL). Cleans up before and after."""
    name = journey["name"]
    uids = list(accounts.values())
    now = clock or (lambda: _dt.datetime.now(_dt.timezone.utc))
    emails = {}
    jstore = JourneyStore(store, accounts, send)
    fails = 0
    film_id = None
    catalogue = neutralise(catalogue)
    try:
        try:
            film_id, why = select_film(store, catalogue, journey, accounts, engine=engine, scorer=scorer)
        except SetupFail as err:
            out(f"SETUP FAIL journey={name}: {err}")
            return 2
        out(f"journey={name} film chosen: {why}")
        store.purge_journey_state(uids, film_id)   # a clean start for this film and these accounts
        prefs = store.fetch_notify_prefs()
        for k, uid in accounts.items():
            emails[(prefs.get(uid) or {}).get("email_address") or ""] = uid
        sends = Sends(accounts, emails)
        tmp = tempfile.mkdtemp(prefix="journey-")
        held_file = os.path.join(tmp, "held.json")
        before = copy.deepcopy(journey.get("start"))
        uid_of = dict(accounts)
        befores = {}
        for n, step in enumerate(journey["steps"], 1):
            befores[n] = before
            if step.get("repeat_of"):   # the SAME step run again: same yesterday, same today
                ref = journey["steps"][step["repeat_of"] - 1]
                step = dict(ref, name=step.get("name", f"repeat of {step['repeat_of']}"), expect=step.get("expect"),
                            before=step.get("before"), after=step.get("after"))
                before = befores[journey["steps"][n - 1]["repeat_of"]]
            for act in step.get("before") or []:
                _apply(store, uid_of, film_id, act)
            y, t = build_pair(catalogue, film_id, before, step)
            ypath, tpath = os.path.join(tmp, "yesterday.json"), os.path.join(tmp, "today.json")
            _write_catalogue(ypath, y, step["date"])
            _write_catalogue(tpath, t, step["date"])
            _sync_admissions(store, accounts, catalogue, film_id, before, journey, engine, scorer)
            sends.reset()
            seen = {k: set(_ledger(store, uid)) for k, uid in accounts.items()}
            log = {}
            for k, uid in accounts.items():
                log[k] = _run_engine_find(jstore, tpath, ypath, step["date"], uid, held_file)
            stamp = now()
            for k, uid in accounts.items():
                kw = {} if send else {"send": sends.push}
                with contextlib.redirect_stdout(io.StringIO()):
                    push_phase(jstore, stamp, target_user=uid, **kw)
            today_movies = load_catalogue_file(tpath)
            for k, uid in accounts.items():
                kw = {} if send else {"send": sends.mail}
                with contextlib.redirect_stdout(io.StringIO()):
                    email_phase(jstore, today_movies, stamp, target_user=uid, **kw)
            for k, uid in accounts.items():
                rows = [r for i, r in _ledger(store, uid).items() if i not in seen[k]]
                got = sorted(
                    (f"{r.get('moment')}:{_channels(r, send)}" if str(r.get('movie_id')) == film_id
                     else f"OTHER[{r.get('movie_id')}]:{r.get('moment')}:{_channels(r, send)}") for r in rows)
                want = _expected(step, k)
                problems = []
                if got != want:
                    missing = [w for w in want if w not in got]
                    extra = [g for g in got if g not in want]
                    if missing:
                        problems.append(f"missing {missing}")
                    if extra:
                        problems.append(f"unexpected {extra}")
                if not send and not want and (sends.pushes or sends.mails):
                    mine = [p for p in sends.pushes if p[0] == uid] + \
                           [m for m in sends.mails if emails.get(m[0]) == uid]
                    if mine:
                        problems.append(f"unexpected push/email sent {mine}")
                verdict = "FAIL" if problems else "PASS"
                fails += bool(problems)
                out(f"{verdict} journey={name} step={n} ({step['name']}) account={k} "
                    f"expected={want or 'none'} got={got or 'none'}" + (f" - {'; '.join(problems)}" if problems else ""))
                if problems and os.environ.get("JOURNEY_VERBOSE"):
                    out(log.get(k, ""))
            for act in step.get("after") or []:
                _apply(store, uid_of, film_id, act)
            before = {k: step.get(k) for k in ("date", "status", "release_date", "offers")}
        return 1 if fails else 0
    finally:
        store.purge_journey_state(uids, film_id)   # after, whatever happened (including a FAIL)


# --------------------------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------------------------
def accounts_from_list(text: str, keys) -> dict:
    """Parse `python -m qa.sim.accounts list` output: 'lee+qa-a@... <uuid>' per line."""
    from qa.sim.accounts import email_for
    found = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2:
            found[parts[0].lower()] = parts[1]
    out = {}
    for k in keys:
        uid = found.get(email_for(k))
        if not uid or uid == "(missing)":
            raise SetupFail(f"QA account {email_for(k)} is missing - run `python -m qa.sim.accounts create`")
        out[k] = uid
    return out


def main(argv=None, store=None, catalogue=None, out=print, accounts=None) -> int:
    p = argparse.ArgumentParser(prog="python -m monitor.journey", description=__doc__.split("\n")[0])
    p.add_argument("--journey", required=True, help="a journey file, a name in qa/journeys, or `all`")
    p.add_argument("--accounts", default=",".join(ACCOUNT_KEYS), help="comma list of QA account keys (a,b,c,d)")
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
            raise SystemExit("monitor.journey: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    if catalogue is None:
        catalogue = load_today()
    try:
        if accounts is not None:   # injected (tests): {key: uid}
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
    worst = 0
    for path in journey_files(args.journey):
        rc = run_journey(load_journey(path), store, accounts, catalogue, send=args.send, out=out)
        worst = max(worst, rc)
    out("journeys: " + {0: "all PASS", 1: "FAIL", 2: "SETUP FAIL"}[worst])
    return worst


if __name__ == "__main__":
    sys.exit(main())
