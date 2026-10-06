"""On-demand notification test harness — orchestration only (CAS-486/CAS-1052/CAS-1203).

Builds a synthetic "yesterday"/"today" catalogue pair with exactly ONE scenario's transition
applied, then writes the pair to disk and prints where they landed. CAS-1203: the arm phase now
tries a REAL film from the live catalogue first — one that one of --target-user's own agents
would really alert on, caught unaided — and only falls back to the maintained fixture file
(tests/fixtures/notify-films.json) when nothing in the real catalogue qualifies.

No new engine code: matching, digesting and delivery all stay in the real monitor pipeline
(compute_transitions/match/render_digest/send_via_resend/send_via_apns via `python -m monitor`),
so a test run exercises the exact same code path a real day does. This module's own job is
narrow — pick/synthesise the two catalogue files, and delete only the ledger rows a run of its
own created.

CAS-1052: a fixture film matches an agent's real taste criteria only by luck (CAS-486's own
evidence: a real run against a real account's 6 agents produced zero alerts), so a green harness
run used to prove nothing. Two changes closed that gap, both in this module:

  · arm (fixture fallback only — CAS-1203's real-film mode never needs this) also ticks
    --target-user's per-film Watch-it (film_watch) for the scenario's own window —
    matching.match_film_watches() honours that independently of any agent's criteria (CAS-484),
    so the run is guaranteed a match without touching the user's real agents. "announced" has no
    window-arrival moment (matching.MOMENT_TO_WINDOW never maps to it) so it is left exactly as
    before — matched only through a real agent, same as CAS-506.
  · --verify (a second invocation, AFTER `python -m monitor` has run) tears the temporary tick back
    down (fixture mode only — CAS-1203's real-film mode never armed one), counts what actually
    landed in the `notifications` ledger for --target-user (CAS-486's "the ledger IS the in-app
    delivery", so this number covers every channel that succeeded), reports the run's own
    email/push attempted-vs-delivered deltas (via the shared runstats.py file `python -m monitor`
    already writes) and the target user's registered push-token count, and fails the run
    (non-zero exit) when nothing was recorded — the exact silent-green failure mode this ticket
    exists to catch.

CAS-1203: the real film, when one qualifies, is chosen by asking the SAME admission/placement/
matching code the daily run itself uses (compute_admission/compute_auto_placements/match() —
never a second, hand-ported guess), so the email it produces has a real poster, names the agent
that actually caught it, and its buttons open a real film.

    python -m monitor.notify_test --scenario hits_cinema --target-user <uuid> \\
        --out-dir /tmp/notify-test
    python -m monitor --today /tmp/notify-test/today.json --yesterday /tmp/notify-test/yesterday.json \\
        --date <same date> --target-user <uuid>
    python -m monitor.notify_test --scenario hits_cinema --target-user <uuid> \\
        --out-dir /tmp/notify-test --verify
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys

import runstats

from poc_pipeline import tier_rank

from .catalogue import load_today
from .matching import (MOMENT_TO_WINDOW, compute_admission, compute_auto_placements,
                        compute_scores, excludes_from_prefs, match, suppressed_pairs,
                        synthesize_auto_watch_rows)
from .store import FIXTURE_ID_MAX, FIXTURE_ID_MIN, store_from_env
from .transitions import Transition, _detail_for

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FIXTURES = os.path.join(_REPO_ROOT, "tests", "fixtures", "notify-films.json")

FIXTURE_MARKER = "TEST FIXTURE — not a real title"
SCENARIOS = ("announced", "hits_cinema", "hits_pvod", "hits_rent", "hits_stream")

# CAS-1052: the snapshot file --verify diffs against, taken by the arm phase right before
# `python -m monitor` runs — both live in --out-dir, the same directory the two monitor.notify_test
# invocations and the intervening `python -m monitor` call already share within one workflow run.
RUN_STATS_SNAPSHOT_NAME = "run_stats_before.json"

# CAS-1203: the real-film pick this run armed (if any), written by the arm phase and read back by
# --verify — both live in --out-dir, same as RUN_STATS_SNAPSHOT_NAME above. Absent means this run
# fell back to the fixture.
REAL_FILM_STATE_NAME = "real_film_armed.json"

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)

# CAS-1203: the status tier that IS the window each scenario is about — the real-film candidate
# filter's "it is in the window the scenario is about" test.
_TARGET_STATUS = {
    "hits_cinema": "in_cinema", "hits_pvod": "pvod", "hits_rent": "rental",
    "hits_stream": "included_streaming", "announced": "upcoming",
}
# CAS-1203: "moved back one step" — the AVAILABILITY_TIERS rung immediately before each scenario's
# own target tier, used to build the chosen film's yesterday record. `announced` has none: its
# film is absent from yesterday entirely (see build_real_catalogues()).
_STEP_BACK_STATUS = {
    "hits_cinema": "upcoming", "hits_pvod": "in_cinema", "hits_rent": "pvod", "hits_stream": "rental",
}


def validate_target_user(value) -> str:
    """Fail closed (CAS-486 AC): no default that resolves to "everyone" — an unset or
    unrecognised value must run nothing rather than deliver broadly."""
    if not value or not _UUID_RE.match(str(value).strip()):
        raise SystemExit(f"[notify_test] --target-user {value!r} is not a plausible Supabase "
                          "user id (expected a uuid) — refusing to run against 'everyone'.")
    return str(value).strip()


def load_fixture_films(path: str = DEFAULT_FIXTURES) -> list:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    films = data.get("films", [])
    for f in films:
        tid = f.get("tmdb_id")
        try:
            n = int(tid)
        except (TypeError, ValueError):
            n = None
        if n is None or not (FIXTURE_ID_MIN <= n <= FIXTURE_ID_MAX):
            raise ValueError(f"fixture film {f.get('title')!r} has tmdb_id {tid!r} outside the "
                              f"reserved fixture range {FIXTURE_ID_MIN}-{FIXTURE_ID_MAX} — refusing "
                              "to load this fixture file.")
        if f.get("director") != FIXTURE_MARKER:
            raise ValueError(f"fixture film {f.get('title')!r} is missing the fixture marker "
                              f"director={FIXTURE_MARKER!r} — refusing to load this fixture file.")
    return films


def _movie_record(f: dict, status: list, offers: list, run_date: str) -> dict:
    return {
        "tmdb_id": f["tmdb_id"],
        "title": f["title"],
        "director": f["director"],
        "genres": f.get("genres", []),
        "age_rating": f.get("age_rating", "M"),
        "poster": None,
        "synopsis": f.get("synopsis", FIXTURE_MARKER),
        "cinema_date": None,   # never a real date — keeps past_opening_weekend/opens_soon silent
        "status": list(status),
        "offers": list(offers),
        "window_dates": {s: run_date for s in status},
        # CAS-825/CAS-1015: admission is asked of the real engine now, which reads these beyond
        # taste criteria alone — language for the account taste baseline, popularity/wm_user_rating/
        # wm_critic_score/wm_popularity_percentile for the Cascade score (CAS-919/920 moved scoring
        # onto Watchmode's own fields; imdb_rating/rt_critic are dead on the engine side and were
        # silently leaving every fixture film unscored). Carried straight from the fixture film so a
        # harness scenario keeps producing a real, scoreable film rather than one the score gate
        # holds back regardless.
        "language": f.get("language"),
        "popularity": f.get("popularity"),
        "wm_user_rating": f.get("wm_user_rating"),
        "wm_critic_score": f.get("wm_critic_score"),
        "wm_popularity_percentile": f.get("wm_popularity_percentile"),
    }


def build_catalogues(films: list, scenario: str, run_date: str):
    """-> (yesterday_movies, today_movies). Only `scenario`'s film actually transitions; every
    other fixture film holds its own today-state on both days, so it never fires on its own."""
    if scenario not in {f.get("scenario") for f in films}:
        raise ValueError(f"no fixture film has scenario={scenario!r} (have: "
                          f"{sorted({f.get('scenario') for f in films})})")
    yesterday, today = [], []
    for f in films:
        today.append(_movie_record(f, f["today_status"], f.get("today_offers", []), run_date))
        if f.get("scenario") == scenario:
            if f.get("yesterday_present", True):
                yesterday.append(_movie_record(f, f["yesterday_status"], f.get("yesterday_offers", []),
                                                run_date))
            # else: absent from yesterday entirely — the "announced" case.
        else:
            yesterday.append(_movie_record(f, f["today_status"], f.get("today_offers", []), run_date))
    return yesterday, today


def _write_catalogue(path: str, movies: list, run_date: str):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"generated": run_date, "region": "AU", "currency": "AUD", "live": False,
                   "movies": movies}, fh)


def cleanup(films: list, store=None) -> int | None:
    """DELETE any existing `notifications` ledger rows for the fixture films (real Supabase only —
    scoped strictly to the reserved fixture range inside the store method itself). Returns the row
    count removed, or None if no Supabase credentials are set (fails soft: a missing secret here
    must not block the catalogue files from being written). `store` lets the arm phase share the
    one store_from_env() call it also needs for arm_watch(); omit it to resolve one here."""
    store = store if store is not None else store_from_env()
    if store is None:
        print("[notify_test] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping cleanup.")
        return None
    ids = [f["tmdb_id"] for f in films]
    removed = store.delete_notifications_for_movie_ids(ids)
    print(f"[notify_test] cleanup: removed {removed} existing notification row(s) for "
          f"{len(ids)} fixture film id(s) {ids}.")
    return removed


def _fixture_film_for_scenario(films: list, scenario: str) -> dict:
    for f in films:
        if f.get("scenario") == scenario:
            return f
    raise ValueError(f"no fixture film has scenario={scenario!r}")


def arm_watch(store, target_user: str, films: list, scenario: str) -> None:
    """CAS-1052: guarantee a match for --target-user's scenario without touching their real
    agents — tick the scenario's own window on its fixture film via a temporary film_watch row,
    which matching.match_film_watches() honours independently of any cascade's own criteria
    (CAS-484). "announced" has no window-arrival moment (MOMENT_TO_WINDOW never maps to it), so it
    is left to fire — or not — through a real cascade's own criteria exactly as before this ticket;
    calling this for that scenario is a deliberate no-op."""
    window = MOMENT_TO_WINDOW.get(scenario)
    if window is None:
        return
    film = _fixture_film_for_scenario(films, scenario)
    store.upsert_film_watch(target_user, film["tmdb_id"], window)
    print(f"[notify_test] armed a temporary Watch-it tick: user={target_user} "
          f"movie={film['tmdb_id']} window={window!r} (scenario={scenario}) — guarantees a match "
          "independent of this user's real agents.")


def _qualifies_status(film: dict, scenario: str) -> bool:
    """CAS-1203: `film` IS the window `scenario` is about right now — its own status holds the
    target tier AND nothing ranked higher (via poc_pipeline.AVAILABILITY_TIERS), so "move it back
    one step" (build_real_catalogues() below) produces a clean, single transition rather than
    also uncovering a later tier the film has already passed."""
    status = film.get("status") or []
    target = _TARGET_STATUS[scenario]
    if target not in status:
        return False
    return scenario == "announced" or tier_rank(status) == tier_rank([target])


def _account_prefs_for_user(user_prefs_rows: dict, user_films_rows: list, user_id: str) -> dict:
    """The one-user slice of the account_prefs shape monitor.__main__.main() builds for the whole
    run (CAS-825/CAS-1097) — the account facts compute_admission()/compute_auto_placements() read
    beyond an agent's own criteria."""
    row = (user_prefs_rows or {}).get(user_id) or {}
    taste = row.get("taste") or {}
    film_statuses = [{"movie_id": r.get("movie_id"), "status": r.get("status")}
                      for r in (user_films_rows or []) if str(r.get("user_id")) == user_id]
    return {user_id: {
        "langs": taste.get("langs"),
        "subServices": row.get("sub_services") or [],
        "storeServices": row.get("store_services") or [],
        "filmStatuses": film_statuses,
        "servicesOnly": bool(row.get("services_only")),
        "watchWindows": row.get("watch_windows"),
    }}


def find_real_film(store, target_user: str, scenario: str, today_movies: list):
    """CAS-1203: pick ONE real film from `today_movies` that one of --target-user's own active
    agents, with this scenario's Alert toggle on, would really catch right now — judged by the
    SAME admission/placement/matching code the daily run uses (compute_admission(),
    compute_auto_placements(), match()), never a second hand-ported guess. Returns
    (pick, reason):

      pick   : None, or {"film": movie dict, "cascade_id", "cascade_name"} for the single
               qualifying film with the highest Cascade score (matching.compute_scores()).
      reason : None when `pick` is set; otherwise a short, human-readable explanation of why
               nothing qualified, for the fallback line AC5 requires.

    A film is never a candidate when it already carries ANY real state on this account — a
    notifications ledger row for this (cascade, film, scenario), a film_watch row (whatever its
    windows), or a user_films verdict — the safety rule: this harness must never overwrite or
    delete anything real. Admission/placement/matching is then asked only of films that already
    passed that safety filter.
    """
    user_cascades = [c for c in store.fetch_active_cascades() if str(c.get("user_id")) == target_user]
    if not any(scenario in (c.get("alert_moments") or []) for c in user_cascades):
        return None, f"no agent has the {scenario!r} Alert on for this user"

    already = store.fetch_notification_keys()
    user_cascade_ids = {c["id"] for c in user_cascades}
    verdicted = {str(r.get("movie_id")) for r in store.fetch_user_films()
                 if str(r.get("user_id")) == target_user}
    watch_ticked = {str(r.get("movie_id")) for r in store.fetch_film_watches()
                    if str(r.get("user_id")) == target_user}

    candidates = []
    for film in today_movies:
        mid = str(film.get("tmdb_id"))
        if not film.get("poster"):
            continue
        if not _qualifies_status(film, scenario):
            continue
        if mid in verdicted or mid in watch_ticked:
            continue
        if any((cid, mid, scenario) in already for cid in user_cascade_ids):
            continue
        candidates.append(film)
    if not candidates:
        return None, (f"no unseen film holds the {_TARGET_STATUS[scenario]!r} window with a poster "
                       "and no existing ledger/Watch-it/verdict row for this user")

    account_prefs = _account_prefs_for_user(store.fetch_user_prefs(), store.fetch_user_films(), target_user)
    admission = compute_admission(user_cascades, {"today": today_movies}, account_prefs=account_prefs)

    watches = [w for w in store.fetch_film_watches() if str(w.get("user_id")) == target_user]
    window = MOMENT_TO_WINDOW.get(scenario)
    if window is not None:
        agent_films_rows = [r for r in store.fetch_agent_films() if str(r.get("user_id")) == target_user]
        auto_placements = compute_auto_placements(agent_films_rows, user_cascades, today_movies,
                                                   account_prefs=account_prefs)
        placed_keys = {(str(w.get("user_id")), str(w.get("movie_id"))) for w in watches if (w.get("windows") or [])}
        watches = watches + synthesize_auto_watch_rows(auto_placements, placed_keys)

    muted = excludes_from_prefs(store.fetch_notify_prefs())
    picks = store.fetch_picks()
    suppressed = suppressed_pairs(picks)

    qualifying = []
    for film in candidates:
        services, price = _detail_for(scenario, film)
        transition = Transition(str(film["tmdb_id"]), film.get("title", ""), scenario,
                                 services=services, price=price, movie=film)
        hits = match(user_cascades, [transition], already=already, admission=admission,
                     suppressed=suppressed, excluded=muted, film_watches=watches, picks=picks)
        own_hits = hits.get(target_user) or []
        if own_hits:
            qualifying.append((film, own_hits[0]))
    if not qualifying:
        return None, (f"{len(candidates)} candidate film(s) hold the right window, but no agent "
                       f"with the {scenario!r} Alert on actually admits (and places) any of them")

    scores = compute_scores(str(f["tmdb_id"]) for f, _ in qualifying)
    best_film, best_hit = max(qualifying,
                               key=lambda pair: scores.get(str(pair[0]["tmdb_id"])) if
                               scores.get(str(pair[0]["tmdb_id"])) is not None else -1)
    return {"film": best_film, "cascade_id": best_hit.cascade_id, "cascade_name": best_hit.cascade_name}, None


def build_real_catalogues(today_movies: list, chosen_film: dict, scenario: str) -> tuple:
    """CAS-1203: "today" is the real catalogue, byte-for-byte unchanged (scores are ranked against
    the whole catalogue, so a one-film catalogue would change which films an agent admits);
    "yesterday" is the same list with ONLY `chosen_film` moved back one AVAILABILITY_TIERS step
    (or, for `announced`, left out of yesterday entirely) — every other film holds its own
    today-state on both days, so compute_transitions() can fire no other transition."""
    chosen_id = str(chosen_film.get("tmdb_id"))
    yesterday = []
    for m in today_movies:
        if str(m.get("tmdb_id")) != chosen_id:
            yesterday.append(m)
            continue
        if scenario == "announced":
            continue   # absent from yesterday entirely, same as the fixture's own announced case
        yesterday.append({**m, "status": [_STEP_BACK_STATUS[scenario]]})
    return yesterday, today_movies


def _write_real_film_state(out_dir: str, real_film: dict) -> None:
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, REAL_FILM_STATE_NAME), "w", encoding="utf-8") as fh:
        json.dump(real_film, fh)


def _load_real_film_state(out_dir: str):
    path = os.path.join(out_dir, REAL_FILM_STATE_NAME)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def cleanup_stale_real_film(store, target_user: str, stale: dict, cleanup: bool = True) -> int:
    """CAS-1207: now that verify() counts a real-film row instead of deleting it (so the member
    keeps seeing it in Alerts), a leftover row from an EARLIER arm in this --out-dir would
    otherwise sit in the ledger forever and permanently block find_real_film() from re-choosing
    the same film for a repeat run — its own de-dupe check (`already` in find_real_film) treats
    any existing (cascade, movie, moment) row as "already notified". Deletes it regardless of age
    (store.delete_notifications_for_user_film(..., since="") — "" sorts before every real
    timestamp, so every matching row qualifies), via the SAME store method the old delete-on-
    verify behaviour used. `stale` is the earlier run's real_film_armed.json contents (None if
    there wasn't one); skipped entirely under --no-cleanup."""
    if stale is None or not cleanup:
        return 0
    return store.delete_notifications_for_user_film(target_user, stale["tmdb_id"], stale["moment"], "")


def _snapshot_run_stats(out_dir: str) -> None:
    """CAS-1052: today's runstats.py totals, taken right before `python -m monitor` runs, so
    --verify can isolate THIS run's own email/push attempted/delivered deltas from whatever a same-
    day daily.yml run already committed into state/run_stats.json."""
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, RUN_STATS_SNAPSHOT_NAME), "w", encoding="utf-8") as fh:
        json.dump(runstats.load(), fh)


def _section_delta(before: dict, after: dict, section: str) -> dict:
    """{attempted, delivered, errors} `after` minus `before` for one runstats.py section. Treats
    `before` as empty if the two don't share a `date` — runstats.py resets its whole file the
    moment the date rolls over, so a stale snapshot from the day before would otherwise read as a
    huge (and wrong) negative delta rather than "nothing to subtract"."""
    if not isinstance(before, dict) or before.get("date") != (after or {}).get("date"):
        before = {}
    b = before.get(section) or {}
    a = (after or {}).get(section) or {}
    return {k: a.get(k, 0) - b.get(k, 0) for k in ("attempted", "delivered", "errors")}


def report_and_verify(store, target_user: str, films: list, before_stats: dict, after_stats: dict,
                       real_film: dict = None) -> tuple:
    """CAS-1052/CAS-1203/CAS-1207: the harness's proof step. In fixture mode, deletes this run's
    own ledger rows (their count IS "in-app rows written" — CAS-486's ledger doubles as the in-app
    delivery for every channel that succeeded, see matching.Hit.notification_row). In real-film
    mode (CAS-1207), it COUNTS instead: the row stays in the member's own Alerts, where it was
    delivered. Reports the run's email/push attempted/delivered deltas and the target user's
    registered push-token count, and returns (returncode, message) — a tuple rather than exiting
    directly, so this is unit-testable without a process boundary.

    real_film : None for fixture mode (unchanged: the fixture-range ledger sweep, plus tearing
                down arm_watch()'s temporary Watch-it tick). Otherwise {"tmdb_id", "title",
                "moment", "cascade_name", "armed_at"} — CAS-1203's real-film mode: COUNT (CAS-1207;
                never delete) the (target_user, tmdb_id, moment) ledger rows created at or after
                `armed_at` (store.count_notifications_for_user_film(), never the fixture-range
                sweep — a real film's id lives outside that range by definition), and there is no
                tick to tear down (none was ever armed). Names the film and agent in the report
                line (AC4); fixture mode says "fixture" instead.

    A `found` count of zero is the ONLY failure signal: it means no channel wrote a ledger row for
    `target_user` this run — exactly the silent-green failure this ticket exists to catch. The
    run_stats deltas and push-token count are reported for visibility (so "no device registered" or
    "email never even attempted" is legible), not as a second gate.
    """
    if real_film is not None:
        found = store.count_notifications_for_user_film(
            target_user, real_film["tmdb_id"], real_film["moment"], real_film["armed_at"])
        watch_removed = 0
        subject = f"film {real_film['title']!r} [{real_film['tmdb_id']}] via agent {real_film['cascade_name']!r}"
    else:
        ids = [f["tmdb_id"] for f in films]
        found = store.delete_notifications_for_movie_ids(ids)
        watch_removed = store.delete_film_watch_for_movie_ids(ids)
        subject = "fixture"

    push_tokens = len(store.fetch_push_tokens().get(str(target_user)) or ())
    email_delta = _section_delta(before_stats, after_stats, "email")
    push_delta = _section_delta(before_stats, after_stats, "push")

    message = (
        f"[notify_test] verify target_user={target_user} ({subject}): in-app rows written {found}; "
        f"email attempted {email_delta['attempted']}/delivered {email_delta['delivered']}; "
        f"push attempted {push_delta['attempted']}/delivered {push_delta['delivered']}; "
        f"{push_tokens} registered push token(s) for this user"
        + (f"; cleaned up {watch_removed} temporary Watch-it row(s)." if real_film is None else ".")
    )
    if found == 0:
        return 1, message + (" FAILED: 0 alert(s) were recorded for this user — the harness "
                              "cannot prove delivery.")
    return 0, message


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.notify_test",
                                 description="CAS-486/CAS-1052/CAS-1203 notification test harness — "
                                             "builds a yesterday/today catalogue pair for a real "
                                             "film one of --target-user's own agents would catch "
                                             "(falling back to the fixture film plus a guaranteed "
                                             "Watch-it tick when none qualifies), and (with "
                                             "--verify, after `python -m monitor` has run) proves "
                                             "delivery and tears any temporary tick back down.")
    p.add_argument("--scenario", required=True, choices=SCENARIOS)
    p.add_argument("--target-user", required=True, metavar="USER_ID",
                   help="Supabase user_id (uuid) to deliver to. Required — fails closed on an "
                        "empty/unrecognised value rather than running against 'everyone'.")
    p.add_argument("--out-dir", required=True, help="Directory to write yesterday.json/today.json into.")
    p.add_argument("--fixtures", default=DEFAULT_FIXTURES, metavar="PATH")
    p.add_argument("--date", metavar="YYYY-MM-DD", help="Run date (default: today, UTC).")
    p.add_argument("--cleanup", dest="cleanup", action="store_true", default=True,
                   help="Delete prior ledger rows for the fixture films first (default: on).")
    p.add_argument("--no-cleanup", dest="cleanup", action="store_false",
                   help="Skip cleanup — leaves any earlier run's ledger rows in place.")
    p.add_argument("--verify", action="store_true",
                   help="Run AFTER `python -m monitor`: report per-channel delivery counts for "
                        "--target-user and the fixture films, fail (non-zero exit) if nothing was "
                        "delivered, then delete the temporary film_watch row and ledger rows this "
                        "harness run created.")
    return p.parse_args(argv)


def _run_verify(args, target_user: str, films: list) -> int:
    store = store_from_env()
    if store is None:
        raise SystemExit("[notify_test] --verify needs real SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY "
                          "— the harness cannot prove anything without the real pipeline.")
    before_path = os.path.join(args.out_dir, RUN_STATS_SNAPSHOT_NAME)
    before_stats = _load_json(before_path) if os.path.exists(before_path) else {}
    after_stats = runstats.load()
    real_film = _load_real_film_state(args.out_dir)
    rc, message = report_and_verify(store, target_user, films, before_stats, after_stats,
                                    real_film=real_film)
    print(message)
    return rc


def _load_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _run_arm(args, target_user: str, films: list) -> int:
    run_date = args.date or _dt.date.today().isoformat()
    store = store_from_env()

    # CAS-1203: never let a stale real-film state from an earlier run in this --out-dir leak into
    # this run's --verify, whichever path below is taken.
    real_state_path = os.path.join(args.out_dir, REAL_FILM_STATE_NAME)
    stale_real_film = _load_real_film_state(args.out_dir)
    if os.path.exists(real_state_path):
        os.remove(real_state_path)

    # CAS-1207: verify() no longer deletes a real-film row once delivered (so the member keeps
    # seeing it), so a repeat run needs its own cleanup here instead — otherwise that earlier run's
    # leftover row would permanently block find_real_film() from re-choosing the same film.
    if stale_real_film is not None and store is not None:
        if args.cleanup:
            removed = cleanup_stale_real_film(store, target_user, stale_real_film, args.cleanup)
            print(f"[notify_test] pre-send cleanup: removed {removed} earlier ledger row(s) for "
                  f"{stale_real_film.get('title')!r} [{stale_real_film.get('tmdb_id')}] "
                  f"moment={stale_real_film.get('moment')!r}, whatever their age.")
        else:
            print("[notify_test] --no-cleanup: leaving the earlier armed film's ledger row(s) in place.")

    y_path = os.path.join(args.out_dir, "yesterday.json")
    t_path = os.path.join(args.out_dir, "today.json")

    if store is not None:
        today_movies = load_today()
        pick, reason = find_real_film(store, target_user, args.scenario, today_movies)
        if pick is not None:
            armed_at = _dt.datetime.now(_dt.timezone.utc).isoformat()
            yesterday, today = build_real_catalogues(today_movies, pick["film"], args.scenario)
            os.makedirs(args.out_dir, exist_ok=True)
            _write_catalogue(y_path, yesterday, run_date)
            _write_catalogue(t_path, today, run_date)
            real_film = {
                "tmdb_id": str(pick["film"]["tmdb_id"]), "title": pick["film"].get("title", ""),
                "moment": args.scenario, "cascade_id": pick["cascade_id"],
                "cascade_name": pick["cascade_name"], "armed_at": armed_at,
            }
            _write_real_film_state(args.out_dir, real_film)
            print(f"[notify_test] REAL FILM: scenario={args.scenario} target_user={target_user} "
                  f"date={run_date} — chose {real_film['title']!r} [{real_film['tmdb_id']}], caught "
                  f"by agent {real_film['cascade_name']!r}. Wrote {len(yesterday)} yesterday film(s) "
                  f"-> {y_path}, {len(today)} today film(s) -> {t_path}. No temporary Watch-it tick "
                  "armed — the agent catches it unaided.")
            _snapshot_run_stats(args.out_dir)
            print(f"[notify_test] next: python -m monitor --today {t_path} --yesterday {y_path} "
                  f"--date {run_date} --target-user {target_user}")
            return 0
        print(f"[notify_test] falling back to the fixture film: {reason}.")

    yesterday, today = build_catalogues(films, args.scenario, run_date)

    os.makedirs(args.out_dir, exist_ok=True)
    _write_catalogue(y_path, yesterday, run_date)
    _write_catalogue(t_path, today, run_date)
    print(f"[notify_test] scenario={args.scenario} target_user={target_user} date={run_date} — "
          f"wrote {len(yesterday)} yesterday film(s) -> {y_path}, {len(today)} today film(s) -> {t_path}.")

    if args.cleanup:
        cleanup(films, store)
    else:
        print("[notify_test] --no-cleanup: leaving any existing ledger rows for the fixture films in place.")

    if store is None:
        print("[notify_test] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping the "
              "guaranteed-match Watch-it tick; the next `python -m monitor` step will only match "
              "this user's REAL agents, exactly as before CAS-1052.")
    else:
        arm_watch(store, target_user, films, args.scenario)

    _snapshot_run_stats(args.out_dir)

    print(f"[notify_test] next: python -m monitor --today {t_path} --yesterday {y_path} "
          f"--date {run_date} --target-user {target_user}")
    return 0


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    target_user = validate_target_user(args.target_user)
    films = load_fixture_films(args.fixtures)

    if args.verify:
        return _run_verify(args, target_user, films)
    return _run_arm(args, target_user, films)


if __name__ == "__main__":
    raise SystemExit(main())
