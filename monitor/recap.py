"""CAS-1567: the day-7 recap - "Your first week with <agent>".

Who: every account whose sign-up was exactly RECAP_DAY Sydney calendar days before the 17:00 email phase's own
Sydney date, once. "Once" is durable - the member's alert batch for that Sydney date is kind `recap` with
`emailed_at` set (monitor.batches) - never a run-local flag; a failed send leaves it unstamped, so a re-run the
same day retries and a later day never sends one (day 8 is not day 7).

What (all from the member's own ledger and verdicts; nothing invented):
  alerted    distinct films the ledger alerted since sign-up
  to_decide  of those, films with no `answer` on any ledger row and no user_films verdict (watched or Never)
  ratings    the member's Watched verdicts (the app's own five Watched keys)
  films      up to RECAP_MAX_FILMS still-to-decide films, newest first

Every film the recap names gets a ledger row in the recap batch (moment `recap`), so Email = Alerts holds. Those
rows are written already-pushed: the recap has NO push (Lee, 25 Nov 2026).
"""
from __future__ import annotations

import datetime as _dt
import uuid

from .answer_links import WATCHED
from .batches import ensure_batch, sydney_date

RECAP_DAY = 7
RECAP_MAX_FILMS = 5
RECAP_MOMENT = "recap"
RATING_KEYS = frozenset(d["key"] for d in WATCHED)


def agent_headline(agent_name: str) -> str:
    return "Your first week with your agent"


def _sydney_day(ts) -> _dt.date:
    return _dt.date.fromisoformat(sydney_date(ts))


def due_users(store, now: _dt.datetime) -> list:
    """Members owed the recap in this run: signed up RECAP_DAY Sydney days ago, and not already recapped.
    A store that cannot say when accounts were created owes nobody (never guesses)."""
    fn = getattr(store, "fetch_user_created_at", None)
    if not callable(fn):
        return []
    today = _sydney_day(now)
    out = []
    for uid, raw in sorted((fn() or {}).items()):
        if not raw:
            continue
        try:
            signed_up = _sydney_day(str(raw))
        except ValueError:
            continue
        if (today - signed_up).days != RECAP_DAY:
            continue
        fetch = getattr(store, "fetch_alert_batch", None)
        batch = fetch(uid, today.isoformat()) if callable(fetch) else None
        if batch and batch.get("kind") == "recap" and batch.get("emailed_at"):
            continue
        out.append(str(uid))
    return out


def compute(user_id, ledger_rows, user_film_rows, created_at, now: _dt.datetime) -> dict:
    """The recap's numbers and the still-to-decide ledger rows, newest first (see the module header).
    `ledger_rows` is the member's whole ledger; recap rows themselves are never counted as alerts."""
    since = str(created_at or "")
    alerts = [r for r in ledger_rows
              if r.get("moment") != RECAP_MOMENT and str(r.get("found_at") or "") >= since]
    alerted = {str(r.get("movie_id")) for r in alerts}
    mine = [r for r in user_film_rows if str(r.get("user_id")) == str(user_id)]
    decided = {str(r.get("movie_id")) for r in mine}
    decided |= {str(r.get("movie_id")) for r in alerts if r.get("answer")}
    newest: dict = {}
    for r in alerts:
        mid = str(r.get("movie_id"))
        if mid in decided:
            continue
        key = (str(r.get("found_at") or ""), str(r.get("id") or ""))
        if mid not in newest or key > newest[mid][0]:
            newest[mid] = (key, r)
    ordered = [r for _, r in sorted(newest.values(), key=lambda kv: kv[0], reverse=True)]
    return {"alerted": len(alerted), "to_decide": len(ordered),
            "ratings": sum(1 for r in mine if r.get("status") in RATING_KEYS),
            "rows": ordered}


def write_ledger(store, user_id, batch_id, rows, now: _dt.datetime) -> dict:
    """One `recap` ledger row per named film in the recap batch (a re-run reuses the ones already written).
    Born pushed (no push for the recap); `emailed_at` is stamped only after the send.
    Returns {movie_id: ledger row id} for every named film."""
    existing = {str(r.get("movie_id")): r.get("id")
                for r in store.fetch_user_notifications(user_id)
                if r.get("moment") == RECAP_MOMENT and str(r.get("batch_id")) == str(batch_id)}
    fresh = []
    for r in rows:
        mid = str(r.get("movie_id"))
        if mid in existing:
            continue
        row = {"id": str(uuid.uuid4()), "user_id": user_id, "cascade_id": r.get("cascade_id"), "movie_id": mid,
               "moment": RECAP_MOMENT, "cascade_name": r.get("cascade_name"), "title": r.get("title"),
               "detail": {}, "found_at": now.isoformat(), "pushed_at": now.isoformat(), "batch_id": batch_id}
        existing[mid] = row["id"]
        fresh.append(row)
    if fresh:
        store.insert_notifications(fresh)
    return existing


def prepare(store, user_id, agent_name, today_by_id, cascades_by_id, now: _dt.datetime, skip_movie_ids=(),
            write: bool = True):
    """Build everything the email needs for one member: (recap dict for emailer.render_digest, recap ledger row
    ids by film, recap batch id). With write=False (dry run) nothing is written and the batch id is None.
    `skip_movie_ids` are films the same email already shows as ordinary alert cards - not repeated here."""
    from .matching import Hit, agent_channels
    from .transitions import Transition
    created = (store.fetch_user_created_at() or {}).get(str(user_id))
    stats = compute(user_id, store.fetch_user_notifications(user_id), store.fetch_user_films(), created, now)
    skip = {str(m) for m in skip_movie_ids}
    chosen = [r for r in stats["rows"] if str(r.get("movie_id")) not in skip][:RECAP_MAX_FILMS]
    batch_id, row_ids = None, {}
    if write:
        batch = ensure_batch(store, user_id, sydney_date(now), "recap", agent_headline(agent_name))
        batch_id = str(batch["id"]) if batch else None
        if batch_id:
            row_ids = write_ledger(store, user_id, batch_id, chosen, now)
    hits = []
    for r in chosen:
        mid = str(r.get("movie_id"))
        t = Transition(movie_id=mid, title=r.get("title") or "", moment=RECAP_MOMENT, services=[], price=None,
                       movie=today_by_id.get(mid) or {}, stage=None)
        cascade = cascades_by_id.get(str(r.get("cascade_id"))) if r.get("cascade_id") else None
        hits.append(Hit(user_id=str(user_id), cascade_id=r.get("cascade_id"),
                        cascade_name=r.get("cascade_name") or agent_name, transition=t,
                        channels=agent_channels((cascade or {}).get("criteria") or {})))
    recap = {"agent": agent_name, "alerted": stats["alerted"], "to_decide": stats["to_decide"],
             "ratings": stats["ratings"], "hits": hits, "batch_id": batch_id}
    return recap, row_ids, batch_id
