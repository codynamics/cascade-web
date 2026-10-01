"""CLI for the monitoring pipeline (spec 26771457 §5-§6).

    # diff only, against the live catalogue:
    python -m monitor --dry-run

    # full diff -> match -> de-dupe -> render digest, against fixtures (deterministic, no keys):
    python -m monitor --dry-run \
        --today monitor/fixtures/today.json --yesterday monitor/fixtures/yesterday.json \
        --date 2026-07-16 --cascades monitor/fixtures/cascades.json \
        --notifications monitor/fixtures/notifications.json --emails monitor/fixtures/emails.json

Default catalogue: today = movies.json, yesterday = git show HEAD~1:movies.json.
Default Cascade source: Supabase via the service_role key.

Stages:
  1. diff today vs yesterday  -> transitions                                       (CAS-84)
  2. match the `announced` moment to active Cascades' taste (agent-level, CAS-506) and every other
     moment to per-film Watch-it ticks (CAS-484), de-dupe against `notifications`, group per user
     (CAS-85; CAS-502 stopped ALL cascade-level delivery, CAS-506 restores it for `announced` only)
  3. render ONE consolidated digest per user and email it via Resend               (CAS-86)
     --dry-run: print the digest HTML, send nothing, write nothing.
     off --dry-run: send the email, then write that user's notifications rows (send-before-ledger,
     so a failed send is retried next run rather than silently marked done).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys

import runstats

from . import (compute_transitions, DEFAULT_WEEKEND_N, MOMENTS, match, notification_rows,
               render_digest, send_via_resend, excluded_moments,
               prefs_for, excludes_from_prefs, delivery_plan, send_via_apns, push_copy,
               match_film_watches, match_newly_qualified, match_new_to_agent, suppressed_pairs,
               compute_admission, compute_auto_placements, synthesize_auto_watch_rows,
               format_invite_reply)
from .catalogue import load_catalogue_file, load_today, load_yesterday_from_git
from .store import FIXTURE_ID_MAX, FIXTURE_ID_MIN, InMemoryStore, store_from_env

# CAS-986: the two-tier catalogue's demotion-safety net. Written at the end of every real (non-
# --dry-run) monitor run — poc_pipeline.py reads it off disk, never Supabase directly, so the
# nightly build never needs its own service_role credential.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER_HELD_IDS_FILE = os.path.join(_REPO_ROOT, "state", "user_held_ids.json")


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor", description="Cascade daily monitoring pipeline.")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the digest HTML; send no email and write nothing.")
    p.add_argument("--today", metavar="PATH", help="Today's catalogue JSON (default: movies.json).")
    p.add_argument("--yesterday", metavar="PATH",
                   help="Yesterday's catalogue JSON (default: git show HEAD~1:movies.json).")
    p.add_argument("--date", metavar="YYYY-MM-DD", help="Override the run date (default: today).")
    p.add_argument("--weekend-n", type=int, default=DEFAULT_WEEKEND_N,
                   help=f"Days after opening that past_opening_weekend fires (default: {DEFAULT_WEEKEND_N}).")
    p.add_argument("--cascades", metavar="PATH",
                   help="Active-cascades JSON to match against (default: Supabase via service_role).")
    p.add_argument("--notifications", metavar="PATH",
                   help="Existing notifications JSON for de-dupe (default: Supabase).")
    p.add_argument("--emails", metavar="PATH",
                   help="user_id -> email JSON map (dry-run/fixtures; default: Supabase auth).")
    p.add_argument("--picks", metavar="PATH",
                   help="Personal Pick overrides JSON: [{user_id, movie_id, state}] where state "
                        "'off' suppresses that film for that user (CAS-100). Overrides the "
                        "`film_picks` table, which is the default source since CAS-185.")
    p.add_argument("--prefs", metavar="PATH",
                   help="Delivery preferences JSON: {user_id: {in_app, email_on, email_address, "
                        "excluded_moments}} (CAS-185). Overrides the `notify_prefs` table.")
    p.add_argument("--watches", metavar="PATH",
                   help="Per-film Watch-it ticks JSON: [{user_id, movie_id, windows}] (CAS-484). "
                        "Overrides the `film_watch` table, which is the default source.")
    p.add_argument("--agent-films", metavar="PATH",
                   help="Agent admission history JSON: [{user_id, cascade_id, movie_id, "
                        "admission_score, admission_status}] (CAS-726/CAS-1097), fed into an "
                        "admitted-but-unwatched film's automatic Watch-On placement. Overrides the "
                        "`agent_films` table, which is the default source.")
    p.add_argument("--user-prefs", metavar="PATH",
                   help="Account services/taste JSON: {user_id: {sub_services, store_services, "
                        "taste}} (CAS-825). Overrides the `user_prefs` table.")
    p.add_argument("--user-films", metavar="PATH",
                   help="Watched-film opinions JSON: [{user_id, movie_id, status}] (CAS-825). "
                        "Overrides the `user_films` table.")
    p.add_argument("--excluded", metavar="PATH",
                   help="Global alert-type excludes JSON: {user_id: [moment, ...]} (or a list of "
                        "{user_id, excluded_moments}). A muted TYPE never fires for that user, "
                        "whatever their Cascades say (CAS-103 AC4). Since CAS-185 this also comes "
                        "from notify_prefs.excluded_moments; this flag adds to that.")
    p.add_argument("--replies", metavar="PATH",
                   help="Undigested invite_replies JSON: [{id, sender_id, to_name, film_title, "
                        "tmdb_id, answer, created_at}] (CAS-887). Overrides the "
                        "fetch_undigested_invite_replies() store call.")
    p.add_argument("--print-html", action="store_true",
                   help="With --dry-run, print the full digest HTML (default: subject + text preview).")
    p.add_argument("--target-user", metavar="USER_ID",
                   help="CAS-486 test-harness safety valve: restrict matching to exactly this "
                        "user_id — every other user's cascades and per-film watches are dropped "
                        "before matching, so a scoped test run can never spray real users. Unused "
                        "by the daily job.")
    return p.parse_args(argv)


def _load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _is_int_in_range(value, lo, hi) -> bool:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return False
    return lo <= n <= hi


def _store_call(store, name, default):
    """Call an optional store method. A store that predates CAS-185 (or a hand-rolled one in a
    test) simply does not have these, and a monitor run must not die over a preference table —
    the honest fallback is "nobody has expressed a preference", which is what the defaults say."""
    fn = getattr(store, name, None)
    if not callable(fn):
        return default
    try:
        return fn()
    except Exception as err:   # noqa: BLE001 - a missing table must not abort the whole run
        print(f"[monitor] could not read {name}: {err} - carrying on with defaults.")
        return default


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    today_movies = load_catalogue_file(args.today) if args.today else load_today()
    prev_movies = load_catalogue_file(args.yesterday) if args.yesterday else load_yesterday_from_git()
    run_date = _dt.date.fromisoformat(args.date) if args.date else _dt.date.today()

    transitions = compute_transitions(prev_movies, today_movies, run_date, weekend_n=args.weekend_n)
    print(f"[monitor] run date {run_date.isoformat()} · today {len(today_movies)} films · "
          f"yesterday {len(prev_movies)} films · N={args.weekend_n}")
    counts = {mo: sum(1 for t in transitions if t.moment == mo) for mo in MOMENTS}
    print("[monitor] transitions: " + ", ".join(f"{mo}={counts[mo]}" for mo in MOMENTS))
    for t in transitions:
        print("    • " + t.summary())

    # --- Cascade / notifications / email source ---
    if args.cascades is not None:
        store = InMemoryStore(cascades=_load_json(args.cascades),
                              notifications=_load_json(args.notifications) if args.notifications else [],
                              emails=_load_json(args.emails) if args.emails else {},
                              prefs=_load_json(args.prefs) if args.prefs else {},
                              picks=_load_json(args.picks) if args.picks else [],
                              watches=_load_json(args.watches) if args.watches else [],
                              agent_films=_load_json(args.agent_films) if args.agent_films else [],
                              invite_replies=_load_json(args.replies) if args.replies else [])
        source = "fixtures"
    else:
        store = store_from_env()
        source = "supabase(service_role)"
        if store is None:
            print("[monitor] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and no --cascades — "
                  "skipping match/email (diff only).")
            return 0

    # CAS-942: 180-day retention for usage_events, run once per day alongside everything else this
    # job already does with the service_role credential. Skipped on --dry-run, same as every other
    # write in this file — a demo run must not delete real data.
    if not args.dry_run:
        purged = _store_call(store, "delete_old_usage_events", 0)
        if purged:
            print(f"[monitor] usage_events retention: purged {purged} row(s) older than 180 days.")

    # CAS-986: the two-tier catalogue's demotion-safety net — every tmdb_id a user holds state on,
    # written once per real run so poc_pipeline.py can read it off disk without its own Supabase
    # credential. Skipped on --dry-run, same as every other write in this file (the docstring's own
    # "write nothing" promise) — a demo run must not touch real state.
    if not args.dry_run:
        held_ids = _store_call(store, "fetch_user_held_ids", None)
        if held_ids is not None:
            os.makedirs(os.path.dirname(USER_HELD_IDS_FILE), exist_ok=True)
            json.dump(sorted(held_ids), open(USER_HELD_IDS_FILE, "w", encoding="utf-8"), indent=2)
            print(f"[monitor] wrote {len(held_ids)} held id(s) to state/user_held_ids.json.")

    # CAS-506: active cascades are back, but scoped to feed ONLY the `announced` moment below — see
    # the comment further down for why.
    cascades = store.fetch_active_cascades()
    if args.target_user:
        before = len(cascades)
        cascades = [c for c in cascades if str(c.get("user_id")) == args.target_user]
        print(f"[monitor] --target-user {args.target_user}: kept {len(cascades)}/{before} cascade(s), "
              "every other user's excluded.")
    already = store.fetch_notification_keys()

    # CAS-185: both of these are stored per account now, so the default source is the store rather
    # than a flag. The flags still win where given — that is what makes a fixture run reproducible.
    prefs = _load_json(args.prefs) if args.prefs else _store_call(store, "fetch_notify_prefs", {})
    # CAS-465: who to push to, and the badge count each push should carry (the same number the
    # in-app bell badge shows), read once up front like prefs above.
    push_tokens = _store_call(store, "fetch_push_tokens", {})
    unread_counts = _store_call(store, "fetch_unread_counts", {})
    # An alert TYPE the user muted everywhere outranks their Cascades (CAS-103 AC4). Two sources, one
    # meaning: the stored preference, plus anything the flag adds.
    muted = excludes_from_prefs(prefs)
    if args.excluded:
        for u, ms in excluded_moments(_load_json(args.excluded)).items():
            muted.setdefault(u, set()).update(ms)

    # CAS-788: the personal-override "off" answer (CAS-100/CAS-185's film_picks) outranks every
    # Cascade and every per-film tick, same as it always has — wired in here for the first time.
    picks = _load_json(args.picks) if args.picks else _store_call(store, "fetch_picks", [])
    suppressed = suppressed_pairs(picks)

    # CAS-825: the account facts the real engine's matchesCriteria reads beyond an agent's own
    # criteria — CAS-146's language taste baseline and CAS-211's services from `user_prefs`, CAS-183's
    # watched/blocked opinions from `user_films`. A user absent from either source gets the engine's
    # own permissive "never touched this" defaults (see admit_shim.mjs).
    user_prefs_rows = (_load_json(args.user_prefs) if args.user_prefs
                       else _store_call(store, "fetch_user_prefs", {}))
    user_films_rows = (_load_json(args.user_films) if args.user_films
                       else _store_call(store, "fetch_user_films", []))
    film_statuses_by_user: dict = {}
    for r in user_films_rows:
        film_statuses_by_user.setdefault(str(r.get("user_id")), []).append(
            {"movie_id": r.get("movie_id"), "status": r.get("status")})
    account_prefs = {}
    for uid in set(user_prefs_rows) | set(film_statuses_by_user):
        row = user_prefs_rows.get(uid) or {}
        taste = row.get("taste") or {}
        account_prefs[uid] = {
            "langs": taste.get("langs"),
            "subServices": row.get("sub_services") or [],
            "storeServices": row.get("store_services") or [],
            "filmStatuses": film_statuses_by_user.get(uid, []),
            # CAS-853: the "only show films on my services" switch — authoritative over every agent's
            # own myServices now, so it has to reach admission the same way langs/subServices do.
            "servicesOnly": bool(row.get("services_only")),
            # CAS-1097: Where & when you'll watch — compute_auto_placements()'s own windowUsable/
            # windowFollowed gate, read the same way every other account fact here is.
            "watchWindows": row.get("watch_windows"),
        }

    # CAS-825: ONE call to the shipped engine for the whole run — never once per film, never once
    # per agent (see compute_admission()'s own docstring). Both catalogue snapshots are included
    # since match_newly_qualified/match_new_to_agent below need to ask "admitted today, but not in
    # yesterday's own record of this film" — a question match() itself never asks.
    admission = compute_admission(cascades, {"today": today_movies, "yesterday": prev_movies},
                                  account_prefs=account_prefs)

    # CAS-841: fetched here (rather than down by match_film_watches() as before) so match() can
    # also read it — an agent's window-arrival moment must agree with where the app actually
    # placed the film, not just admit it.
    watches = _load_json(args.watches) if args.watches else _store_call(store, "fetch_film_watches", [])
    if args.target_user:
        watches = [w for w in watches if str(w.get("user_id")) == args.target_user]

    # CAS-1097: an admitted film with no film_watch row of its own (automatic placement stopped being
    # client-pushed per CAS-1096) still needs a placement for match()'s own window-arrival gate to see
    # it — synthesize one from agent_films' frozen admission_score, the same arithmetic
    # recomputeFound's own placement block runs on the device. A real film_watch row (manual, or a
    # legacy pre-CAS-1096 auto one) always wins; this only ever fills a gap.
    agent_films_rows = _load_json(args.agent_films) if args.agent_films else _store_call(store, "fetch_agent_films", [])
    if args.target_user:
        agent_films_rows = [r for r in agent_films_rows if str(r.get("user_id")) == args.target_user]
    auto_placements = compute_auto_placements(agent_films_rows, cascades, today_movies,
                                              account_prefs=account_prefs)
    placed_keys = {(str(w.get("user_id")), str(w.get("movie_id"))) for w in watches if (w.get("windows") or [])}
    auto_watch_rows = synthesize_auto_watch_rows(auto_placements, placed_keys)
    if auto_watch_rows:
        print(f"[monitor] auto placement (CAS-1097): {len(auto_watch_rows)} admitted film(s) placed "
              "from agent_films with no film_watch row of their own.")
    watches = watches + auto_watch_rows

    # CAS-601: an agent's own Alert toggles are the control again (Lee's decision of 2026-08-24,
    # reversing CAS-502 AC1/widening CAS-506) — every moment a cascade's `alert_moments` names can
    # notify, not just `announced`. match() already gates on `alert_moments`/admission/suppressed/
    # excluded, so feeding it every transition is the whole change; nothing in match() itself moves.
    placement_counts = {}
    agent_hits = match(cascades, transitions, already=already, admission=admission,
                       suppressed=suppressed, excluded=muted, film_watches=watches,
                       placement_counts=placement_counts, picks=picks)
    # CAS-841 AC5: the size of the placement change, measurable on the first live run rather than
    # inferred.
    print(f"[monitor] window placement (CAS-841): {placement_counts.get('wrong_window', 0)} "
          f"hit(s) suppressed for the wrong window, {placement_counts.get('no_placement', 0)} "
          f"for no placement row.")

    # CAS-602: a film already held in both catalogues that newly qualifies for an agent because its
    # OWN attributes changed — no catalogue transition to hang this off, so its "newly_qualifies"
    # moment is computed straight from the prev/today records rather than from `transitions`.
    # CAS-796: match()'s own hits are passed in as `covered` so a film that both newly qualifies and
    # hits a real window on the same day resolves to the one window hit, not two — the same
    # `covered` shape match_new_to_agent already uses below. Keyed by user_id, not cascade_id
    # (CAS-1041): CAS-925 can re-attribute a Hit to a different owner cascade than the one whose own
    # criteria actually changed, so a cascade_id-keyed set can miss a same-user, same-film overlap.
    window_covered = {(h.user_id, h.transition.movie_id)
                      for hits in agent_hits.values() for h in hits}
    newly_qualified_hits = match_newly_qualified(cascades, prev_movies, today_movies, already=already,
                                                 admission=admission, excluded=muted,
                                                 covered=window_covered, picks=picks)
    for user_id, hits in newly_qualified_hits.items():
        agent_hits.setdefault(user_id, []).extend(hits)

    # CAS-785: a film already held in both catalogues that starts matching an agent for the first
    # time — fired only for an agent that has been stable (unedited) since before the previous
    # run, so a fresh edit widening the criteria stays silent (Lee's 2026-08-24 rule) rather than
    # spraying the agent's whole newly-widened list. `previous_run_start` is approximated as
    # midnight UTC the day before this run, since no per-run timestamp is persisted (by design —
    # the ticket explicitly rules out a new schema column). Folded in before `agent_seen` below,
    # and de-duped against every hit already produced this run, so a first appearance landing on
    # the same day as a real window transition still alerts once, not twice (CAS-785 AC1c).
    previous_run_start = _dt.datetime.combine(
        run_date - _dt.timedelta(days=1), _dt.time.min, tzinfo=_dt.timezone.utc)
    covered_films = {(h.user_id, h.transition.movie_id)
                     for hits in agent_hits.values() for h in hits}
    new_to_agent_hits = match_new_to_agent(cascades, prev_movies, today_movies, previous_run_start,
                                           already=already, admission=admission, excluded=muted,
                                           covered=covered_films, picks=picks)
    for user_id, hits in new_to_agent_hits.items():
        agent_hits.setdefault(user_id, []).extend(hits)

    # CAS-484: a per-film "Watch it" tick is the sole source for every OTHER moment. Run after the
    # agent match so `agent_seen` can carry the (user, movie, moment) pairs `announced` already
    # caught this run — belt-and-braces de-dupe (WINDOW_TO_MOMENT never maps to `announced`, so the
    # two paths cannot really collide, but a film covered twice must still resolve to one alert).
    watch_already = _store_call(store, "fetch_watch_notification_keys", set())
    agent_seen = {(str(uid), h.transition.movie_id, h.transition.moment)
                  for uid, hits in agent_hits.items() for h in hits}
    watch_hits = match_film_watches(watches, transitions, already=watch_already,
                                    cascade_hits=agent_seen, excluded=muted, suppressed=suppressed)
    by_user: dict = {u: list(hits) for u, hits in agent_hits.items()}
    for user_id, hits in watch_hits.items():
        by_user.setdefault(user_id, []).extend(hits)

    # CAS-486: belt-and-braces — cascades and watches are already filtered above, so by_user should
    # only ever hold the target user's key, but a test harness that emails/pushes real people on a
    # bug elsewhere is the one failure mode worth double-guarding against.
    if args.target_user:
        by_user = {u: hits for u, hits in by_user.items() if str(u) == args.target_user}

    total_hits = sum(len(v) for v in by_user.values())

    # CAS-887: undigested invite replies, grouped by the SENDER (the account that gets told "X
    # replied to your invite" — there is no account on the recipient side here). Each is resolved
    # against today's catalogue for its window text; a film that has since left the catalogue just
    # renders with no window line rather than inventing one (honesty guardrail). `replies_rows`
    # follows the same override-else-store pattern as --picks/--watches above.
    replies_rows = (_load_json(args.replies) if args.replies
                    else _store_call(store, "fetch_undigested_invite_replies", []))
    if args.target_user:
        replies_rows = [r for r in replies_rows if str(r.get("sender_id")) == args.target_user]
        # CAS-1015: --target-user is the notify-test harness's own safety valve (never set by the
        # daily job — see its help text above), so a run wearing it must never fold a REAL invite
        # reply into the digest just because it happens to belong to the same target account. Only
        # replies about a fixture film (the reserved 999000001-999000999 tmdb_id range) can be a
        # harness-run's own doing; anything else is real correspondence and stays untouched here,
        # so it is neither delivered nor stamped digested_at by this run.
        replies_rows = [r for r in replies_rows
                        if _is_int_in_range(r.get("tmdb_id"), FIXTURE_ID_MIN, FIXTURE_ID_MAX)]
    movies_by_id = {str(m.get("tmdb_id")): m for m in today_movies}
    _digest_now = _dt.datetime.now(_dt.timezone.utc)
    replies_by_user: dict = {}
    for row in replies_rows:
        uid = str(row.get("sender_id"))
        movie = movies_by_id.get(str(row.get("tmdb_id")))
        replies_by_user.setdefault(uid, []).append(
            (row.get("id"), format_invite_reply(row, movie, now=_digest_now)))
    total_replies = sum(len(v) for v in replies_by_user.values())

    print(f"[monitor] matching against {len(cascades)} active cascade(s) from {source} "
          f"and {len(watches)} per-film Watch-it row(s); "
          f"{sum(len(v) for v in muted.values())} global alert-type exclude(s) across "
          f"{len(muted)} user(s); {total_hits} new alert(s); {total_replies} undigested invite "
          f"reply(s) across {len(replies_by_user)} user(s).")
    if args.dry_run:
        # CAS-825 AC4: the pre/post-change hit count against the committed catalogue, for the
        # ticket's own before/after comparison — written even when it's zero, so a dry-run always
        # leaves a real answer rather than only a log line a caller has to scrape.
        with open("monitor-dryrun-hits.txt", "w", encoding="utf-8") as fh:
            fh.write(f"{total_hits}\n")
    all_user_ids = set(by_user) | set(replies_by_user)
    if not all_user_ids:
        print("[monitor] no new alerts for anyone — no email will be sent.")
        return 0

    # --- one consolidated digest per user ---
    # CAS-185: there are TWO deliveries now, and they have different failure modes.
    #   email  — goes out only if the user asked for it AND we have an address. A failed send
    #            leaves the ledger unwritten so the next run retries it.
    #   in-app — IS the ledger row. There is nothing to fail, so it is written whenever the user
    #            has in-app on, whether or not an email went with it.
    # A user with both switched off gets nothing and no row: turning notifications on later must
    # not be met with silence about the very thing that just happened.
    # CAS-887 AC2: a user with replies but no film transitions still reaches this loop (from
    # replies_by_user) and still gets an email — the replies alone are worth sending.
    sent, written_total, inapp, pushed_total = 0, 0, 0, 0
    # CAS-974: attempted/failed tallies alongside the existing sent/pushed_total counters above,
    # for monitor.health's email_send/push_send checks — written to runstats at the end of this
    # function, never mid-loop, so a run that sends nothing writes nothing (an absent section
    # reads as "unknown", the honest answer, not a fabricated all-zero "pass").
    email_attempted = email_failed = 0
    push_attempted = push_failed = 0
    for user_id in sorted(all_user_ids):
        hits = by_user.get(user_id, [])
        reply_pairs = replies_by_user.get(user_id, [])
        replies = [f for _, f in reply_pairs]
        digest = render_digest(hits, replies=replies)
        pref = prefs_for(prefs, user_id)
        email = pref["email_address"] or store.fetch_user_email(user_id)
        print(f"[monitor] user {user_id} ({email or 'email unknown'}): "
              f"{len(hits)} alert(s), {len(replies)} invite reply(s) — in-app "
              f"{'on' if pref['in_app'] else 'off'}, email {'on' if pref['email_on'] else 'off'} "
              f"— subject: {digest['subject']!r}")
        for h in hits:
            print(f"    • [{h.cascade_name}] {h.transition.summary()}")

        if args.dry_run:
            if args.print_html:
                print("---- digest HTML ----\n" + digest["html"] + "\n---- end HTML ----")
            else:
                print("    digest preview:\n      " + digest["text"].replace("\n", "\n      "))
            continue

        plan = delivery_plan(pref, email)
        if plan == "none":
            print(f"[monitor] {user_id} has both channels off — nothing sent, nothing written.")
            continue
        if plan == "wait":
            print(f"[monitor] {user_id} wants email but has no address — skipping (will retry).")
            continue

        # CAS-244: the account decided WHICH channels exist (that is `plan`); each agent decides which of
        # them it will use. So the user's hits split here rather than at the top: one agent set to in-app
        # only must not put its films in the email digest, and an agent with both switched off is delivered
        # by neither — which means no ledger row either, because the ledger IS the record that we told them.
        mailable = [h for h in hits if h.wants("email")] if plan == "email" else []
        appable = [h for h in hits if h.wants("in_app")] if pref["in_app"] else []
        # CAS-465: push is not a fourth independent switch — it rides the same "in-app" gate as
        # `appable` above, and only fires where the user actually has a live device registered.
        tokens = push_tokens.get(str(user_id)) or []
        pushable = [h for h in hits if h.wants("push")] if (pref["in_app"] and tokens) else []
        # CAS-887: a reply has no per-agent channel — it rides the account's own email plan alone.
        # There is no in-app/push delivery for a reply here; the Invites screen and its own Moving
        # alert already cover that, live, straight off invite_replies.
        mail_replies = reply_pairs if plan == "email" else []
        if not mailable and not appable and not mail_replies:
            print(f"[monitor] {user_id}: every matching agent has its channels off — nothing sent or written.")
            continue

        # CAS-493: channels are independent — a failed send on one must not stop the others, so a
        # failure here is a logged outcome for THIS channel only, never a `continue` that skips the
        # in-app/push delivery and the ledger write still owed to this user.
        email_ok = False
        if mailable or mail_replies:
            digest = render_digest(mailable, replies=[f for _, f in mail_replies])  # only what's delivered
            email_attempted += 1
            try:
                send_via_resend(email, digest["subject"], digest["html"], digest["text"])
                email_ok = True
                sent += 1
                print(f"[monitor] {user_id}: email channel — sent ({len(mailable)} alert(s), "
                      f"{len(mail_replies)} invite reply(s)).")
            except Exception as err:  # noqa: BLE001 — never let one bad send abort the run
                email_failed += 1
                print(f"[monitor] {user_id}: email channel — failed: {err} — ledger not written for "
                      "it, will retry; in-app/push are unaffected.")
        if appable:
            print(f"[monitor] {user_id}: in-app channel — delivered ({len(appable)} alert(s)).")
            if not email_ok:
                inapp += 1
        # One row per hit that WAS delivered, by either channel, and never one for a hit whose only
        # offered channel(s) all failed — that's what keeps a failed channel retried next run.
        delivered = {}
        if email_ok:
            delivered.update({id(h): h for h in mailable})
        delivered.update({id(h): h for h in appable})
        # CAS-465: sent before the ledger insert below (same send-before-ledger ordering as email),
        # to every registered device, one push per hit. Badge = what the bell badge will read once
        # this run's in-app rows land — the existing unread count plus what this run is delivering.
        if pushable:
            badge = unread_counts.get(str(user_id), 0) + len(delivered)
            pushed = 0
            for h in pushable:
                copy = push_copy(h)
                payload = {"movie_id": h.transition.movie_id, "moment": h.transition.moment,
                           "cascade_id": h.cascade_id}
                for tok in tokens:
                    push_attempted += 1
                    if send_via_apns(tok, copy["title"], copy["body"], badge=badge, payload=payload):
                        pushed += 1
                    else:
                        push_failed += 1
            if pushed:
                print(f"[monitor] {user_id}: sent {pushed} push notification(s) across "
                      f"{len(tokens)} device(s).")
                pushed_total += pushed
        # CAS-416: the ledger write is best-effort. Delivery already happened above (the email sent,
        # or in-app was chosen), so a DB/ledger hiccup here must be a logged warning, never a crash
        # that aborts the rest of the run — the alternative is silently dropping every later user.
        try:
            written_total += store.insert_notifications(notification_rows({user_id: list(delivered.values())}))
        except Exception as err:  # noqa: BLE001 — a ledger-write failure must not abort the run
            print(f"[monitor] could not write ledger for {user_id}: {err} — delivery stands, will "
                  "retry the ledger row next run.")
        # CAS-887: mark digested only once the send actually succeeded (send-before-ledger, same
        # ordering as insert_notifications above) — stamps digested_at, never seen_at (item 5):
        # that column stays the app's alone, so this can never clear a badge nobody has seen yet.
        if email_ok and mail_replies:
            try:
                store.mark_invite_replies_digested(
                    [rid for rid, _ in mail_replies], _dt.datetime.now(_dt.timezone.utc).isoformat())
            except Exception as err:  # noqa: BLE001 — a ledger-write failure must not abort the run
                print(f"[monitor] could not mark invite replies digested for {user_id}: {err} — "
                      "delivery stands, will retry next run.")

    if args.dry_run:
        would = sum(len(h) for h in by_user.values())
        would_replies = sum(len(v) for v in replies_by_user.values())
        print(f"[monitor] --dry-run: rendered {len(all_user_ids)} digest(s) covering {would} "
              f"alert(s) and {would_replies} invite reply(s); sent NOTHING, wrote NOTHING.")
    else:
        print(f"[monitor] sent {sent} email digest(s), {inapp} in-app-only, {pushed_total} push "
              f"notification(s); wrote {written_total} notification row(s).")
        # CAS-974: for monitor.health's email_send/push_send checks — only written on a real run
        # (never --dry-run, which sends nothing) and only when this pass actually attempted a
        # channel, so a night with nobody to notify leaves the section unwritten ("unknown") rather
        # than a fabricated all-zero "pass".
        if email_attempted:
            runstats.bump("email", attempted=email_attempted, delivered=sent, errors=email_failed)
        if push_attempted:
            runstats.bump("push", attempted=push_attempted, delivered=pushed_total, errors=push_failed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
