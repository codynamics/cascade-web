"""CAS-1504: the push (07:30) and email (17:00) phases of the alert pipeline.

The 03:00 "find" phase (monitor.__main__, --phase find) records the night's alerts to the
`notifications` ledger and sends nothing. These two phases only READ that ledger - they never re-run
the catalogue diff - and each is idempotent: a row is stamped `pushed_at` / `emailed_at` once the send
succeeded, and a stamped row is never picked up again, so re-running a phase the same day sends
nothing twice.

  push_phase   one push per member who has unread, not-yet-pushed rows from the last PUSH_LOOKBACK_H
               hours ("Cascade found 3 films for you"). None for a member whose rows are all read.
  email_phase  one digest per member of ONLY the rows they have not seen in the app (`read_at` null),
               from the last EMAIL_LOOKBACK_H hours. No email at all when every row has been seen.

"Seen" means `read_at` is set, which the app stamps when Alerts shows the row.

Senders and the score lookup are injected (defaults are the real ones) so tests drive these with a fixed
clock and no network.
"""
from __future__ import annotations

import datetime as _dt

from .answer_links import AnswerContext, secret_from_env
from .batches import agent_name_for, batch_id_of, ensure_batch, headline_for, sydney_date
from .catchup import STAGE_ORDER
from .emailer import format_invite_reply, render_digest, send_via_resend
from .matching import Hit, agent_channels, compute_scores, delivery_plan, prefs_for
from .pusher import send_via_apns
from . import recap as recap_mod
from . import tasteline
from .transitions import Transition

PUSH_LOOKBACK_H = 12    # the push covers last night's 03:00 run, with slack for a late or re-dispatched run
EMAIL_LOOKBACK_H = 24   # the email covers "that day's alerts"


def _since(now: _dt.datetime, hours: int) -> str:
    return (now - _dt.timedelta(hours=hours)).isoformat()


def _store_get(store, name, default, *args):
    """Optional store read: a store without it (or a failing read) degrades to `default`, the same
    convention monitor.__main__._store_call uses."""
    fn = getattr(store, name, None)
    if not callable(fn):
        return default
    try:
        return fn(*args)
    except Exception as err:   # noqa: BLE001 - a missing table must not abort the run
        print(f"[monitor] could not read {name}: {err} - carrying on with defaults.")
        return default


def _channels_of(row: dict, cascades_by_id: dict):
    """The owning agent's own channel switches (CAS-244), or None for a row with no agent (a per-film
    Watch-it tick) or one whose agent has since been deleted - both accept whatever the account allows."""
    cascade = cascades_by_id.get(str(row.get("cascade_id"))) if row.get("cascade_id") else None
    return agent_channels((cascade or {}).get("criteria") or {})


def _wants(channels, channel: str) -> bool:
    if channel == "push":
        channel = "in_app"
    if not channels:
        return True
    return bool(channels.get(channel, True))


def _group_by_user(rows) -> dict:
    out: dict = {}
    for r in rows:
        out.setdefault(str(r.get("user_id")), []).append(r)
    return out


def _catchup_first(rows) -> list:
    """CAS-1535: catch-up rows lead, in the catch-up order (cinemas now, coming, streaming - each group
    already in the Me list's own order, which is the order they were written in); every other row follows
    unchanged. Python's sort is stable, so nothing else moves."""
    def key(r):
        if r.get("moment") != "catchup":
            return (1, 0)
        return (0, STAGE_ORDER.get((r.get("detail") or {}).get("stage"), len(STAGE_ORDER)))
    return sorted(rows, key=key)


def push_copy_for(rows, agent_name: str = "Cascade") -> dict:
    """{'title', 'body'} for ONE member's push covering `rows` (their unread alerts from last night).
    Built only from the real rows: the count of distinct films, and the first one or two titles.
    CAS-1535: the title leads with the member's own agent's name ("Max found 10 films for you")."""
    titles, seen = [], set()
    for r in _catchup_first(rows):
        mid = str(r.get("movie_id"))
        if mid in seen:
            continue
        seen.add(mid)
        titles.append(r.get("title") or "A film")
    n = len(titles)
    title = headline_for(agent_name or "Cascade", n)
    if n == 1:
        body = f"{titles[0]} is in your Alerts."
    elif n == 2:
        body = f"{titles[0]} and {titles[1]}."
    else:
        body = f"{titles[0]}, {titles[1]} and {n - 2} more."
    return {"title": title, "body": body}


def _batch_for_rows(store, user_id, rows, cascades_by_id, headline: str = None):
    """CAS-1535: the batch id `rows` belong to (the newest row's). A row from before batches - or one a
    find run could not stamp - joins the member's batch for the Sydney date it was found, created now if
    need be, and the id is written onto every unstamped row BEFORE anything is sent. Returns the id, or
    None for a store with no batches. Raises if the batch cannot be written; the email phase then sends
    nothing for the member, the push phase carries on without a link."""
    if not callable(getattr(store, "fetch_alert_batch", None)):
        return None
    batch_id = batch_id_of(rows)
    unstamped = [r for r in rows if not r.get("batch_id")]
    if batch_id is None:
        newest = max(rows, key=lambda r: r.get("found_at") or "")
        names = {str(r.get("movie_id")) for r in rows}
        batch = ensure_batch(store, user_id, sydney_date(newest.get("found_at") or _dt.datetime.now(_dt.timezone.utc)),
                             "daily", headline or headline_for(agent_name_for(cascades_by_id.values(), user_id),
                                                               len(names)))
        batch_id = str(batch["id"]) if batch else None
    if batch_id and unstamped:
        store.set_notification_batch([r.get("id") for r in unstamped], batch_id)
        for r in unstamped:
            r["batch_id"] = batch_id
    return batch_id


def _stamp_batch(store, batch_id, column: str, now) -> None:
    """Best-effort: record when the batch's push/email went out. The rows' own stamps are what de-dupe."""
    fn = getattr(store, "update_alert_batch", None)
    if not batch_id or not callable(fn):
        return
    try:
        fn(batch_id, {column: now.isoformat()})
    except Exception as err:   # noqa: BLE001
        print(f"[monitor] could not stamp alert_batches.{column}: {err}")


def push_phase(store, now: _dt.datetime, send=send_via_apns, dry_run: bool = False,
               target_user: str = None) -> dict:
    """The 07:30 phase. Returns {'users', 'attempted', 'delivered', 'failed'} (attempted/delivered/
    failed count device sends, the same unit the all-in-one run feeds monitor.health's push_send)."""
    stats = {"users": 0, "attempted": 0, "delivered": 0, "failed": 0}
    rows = _store_get(store, "fetch_recent_notifications", [], _since(now, PUSH_LOOKBACK_H))
    prefs = _store_get(store, "fetch_notify_prefs", {})
    tokens_by_user = _store_get(store, "fetch_push_tokens", {})
    cascades_by_id = {str(c.get("id")): c for c in _store_get(store, "fetch_active_cascades", [])}
    unread_counts = _store_get(store, "fetch_unread_counts", {})

    for user_id, urows in sorted(_group_by_user(rows).items()):
        if target_user and user_id != str(target_user):
            continue
        # Unseen, not already pushed, and the owning agent accepts push (it rides the in-app answer).
        mine = [r for r in urows if not r.get("read_at") and not r.get("pushed_at")
                and _wants(_channels_of(r, cascades_by_id), "push")]
        if not mine:
            print(f"[monitor] push: {user_id} has nothing unread to push.")
            continue
        pref = prefs_for(prefs, user_id)
        tokens = tokens_by_user.get(user_id) or []
        if not pref["in_app"] or not tokens:
            print(f"[monitor] push: {user_id} has in-app off or no registered device - no push.")
            continue
        copy = push_copy_for(mine, agent_name_for(cascades_by_id.values(), user_id))
        # CAS-1535: the push opens the night's batch in Alerts. A legacy row from before batches gets one
        # now; if that fails the push still goes, just without the batch link.
        try:
            batch_id = _batch_for_rows(store, user_id, mine, cascades_by_id, copy["title"])
        except Exception as err:   # noqa: BLE001 - a batch hiccup must not cost the member their push
            batch_id = None
            print(f"[monitor] push: could not resolve a batch for {user_id}: {err} - pushing without a link.")
        print(f"[monitor] push: {user_id}: {copy['title']!r} - {copy['body']!r}")
        if dry_run:
            continue
        stats["users"] += 1
        badge = unread_counts.get(user_id, len(mine))
        delivered_any = False
        dead = set()
        for tok in tokens:
            if tok in dead:
                continue
            stats["attempted"] += 1

            def _on_invalid(dead_tok=tok):
                dead.add(dead_tok)
                fn = getattr(store, "delete_push_token", None)
                if callable(fn):
                    try:
                        fn(dead_tok)
                    except Exception as err:   # noqa: BLE001
                        print(f"[monitor] could not delete push token: {err}")

            payload = {"open": "alerts", "src": "push",
                       "cmp": "catchup_alert" if any(r.get("moment") == "catchup" for r in mine) else "alert"}
            if batch_id:
                payload["batch"] = batch_id
            if send(tok, copy["title"], copy["body"], badge=badge,
                    payload=payload, on_invalid_token=_on_invalid):
                stats["delivered"] += 1
                delivered_any = True
            else:
                stats["failed"] += 1
        # Stamp only after a send actually landed, so a failed push is retried by a re-run.
        if delivered_any:
            try:
                store.mark_notifications([r.get("id") for r in mine], "pushed_at", now.isoformat())
            except Exception as err:   # noqa: BLE001 - the push already went; a ledger hiccup must not abort
                print(f"[monitor] could not stamp pushed_at for {user_id}: {err}")
            _stamp_batch(store, batch_id, "pushed_at", now)
    print(f"[monitor] push phase: {stats['delivered']}/{stats['attempted']} device push(es) delivered "
          f"to {stats['users']} member(s).")
    return stats


def _hits_from_rows(rows, today_by_id: dict, cascades_by_id: dict) -> list:
    """Rebuild digest Hits from ledger rows plus today's catalogue record for each film. A film that
    has since left the catalogue renders from the row's own title with no extra detail (honesty: nothing
    is invented to fill the gap)."""
    hits = []
    for r in rows:
        detail = r.get("detail") or {}
        t = Transition(movie_id=str(r.get("movie_id")), title=r.get("title") or "",
                       moment=r.get("moment"), services=list(detail.get("services") or []),
                       price=detail.get("price"), movie=today_by_id.get(str(r.get("movie_id"))) or {},
                       stage=detail.get("stage"))
        hits.append(Hit(user_id=str(r.get("user_id")), cascade_id=r.get("cascade_id"),
                        cascade_name=r.get("cascade_name") or "My Cascade", transition=t,
                        channels=_channels_of(r, cascades_by_id)))
    return hits


def _recap_due(store, now) -> list:
    """CAS-1567: members owed the day-7 recap this run; a failing read owes nobody (never guesses)."""
    try:
        return recap_mod.due_users(store, now)
    except Exception as err:   # noqa: BLE001
        print(f"[monitor] could not work out who is due a day-7 recap: {err} - none this run.")
        return []


def _films_by_user(store) -> dict:
    """{user_id: [user_films rows]} for the taste line; an unreadable table owes nobody the line."""
    out: dict = {}
    for r in _store_get(store, "fetch_user_films", []):
        out.setdefault(str(r.get("user_id")), []).append(r)
    return out


def email_phase(store, today_movies, now: _dt.datetime, send=send_via_resend, scores_fn=compute_scores,
                dry_run: bool = False, target_user: str = None) -> dict:
    """The 17:00 phase. Returns {'users', 'attempted', 'sent', 'failed'}."""
    stats = {"users": 0, "attempted": 0, "sent": 0, "failed": 0}
    rows = _store_get(store, "fetch_recent_notifications", [], _since(now, EMAIL_LOOKBACK_H))
    prefs = _store_get(store, "fetch_notify_prefs", {})
    cascades_by_id = {str(c.get("id")): c for c in _store_get(store, "fetch_active_cascades", [])}
    today_by_id = {str(m.get("tmdb_id")): m for m in today_movies}
    by_user = _group_by_user(rows)
    user_prefs = _store_get(store, "fetch_user_prefs", {})    # CAS-1537: Service tracking gates Watch On

    # Invite replies ride the account's email plan alone (CAS-887) - they were part of the old single
    # digest and stay part of this one, so a member with replies but no unseen films still gets them.
    replies_rows = _store_get(store, "fetch_undigested_invite_replies", [])
    replies_by_user: dict = {}
    for r in replies_rows:
        replies_by_user.setdefault(str(r.get("sender_id")), []).append(r)

    # CAS-1567: members whose day 7 is today (Sydney) and who have not had their recap. They join the loop even
    # with nothing new found - the recap is sent regardless - and merge into the same email as any alerts.
    recap_users = set(_recap_due(store, now))
    films_by_user = None   # CAS-1592: read lazily, once, only if someone is actually getting an email

    for user_id in sorted(set(by_user) | set(replies_by_user) | recap_users):
        if target_user and user_id != str(target_user):
            continue
        pref = prefs_for(prefs, user_id)
        email = pref["email_address"] or _store_get(store, "fetch_user_email", None, user_id)
        if delivery_plan(pref, email) != "email":
            continue    # email off, or no address: nothing to send (and the rows stay unstamped)
        # Only what the member has NOT seen in the app, not already emailed, and the agent allows email.
        mine = [r for r in by_user.get(user_id, [])
                if not r.get("read_at") and not r.get("emailed_at") and r.get("moment") != recap_mod.RECAP_MOMENT
                and _wants(_channels_of(r, cascades_by_id), "email")]
        replies = replies_by_user.get(user_id, [])
        recap_due = user_id in recap_users
        if not mine and not replies and not recap_due:
            print(f"[monitor] email: {user_id} has nothing unseen - no email.")
            continue
        batch_id = None
        if mine:
            # CAS-1535: every film the email names carries the batch id BEFORE the send - if it cannot be
            # written, nothing is sent and the rows stay unstamped for a re-run.
            try:
                batch_id = _batch_for_rows(store, user_id, mine, cascades_by_id)
            except Exception as err:   # noqa: BLE001
                stats["failed"] += 1
                print(f"[monitor] email: {user_id}: could not write the alert batch: {err} - not sending.")
                continue
        hits = _hits_from_rows(_catchup_first(mine), today_by_id, cascades_by_id)
        # CAS-1567: the day-7 recap rides this same email. Its ledger rows (recap batch) are written BEFORE the
        # send, like every alert; if that fails the recap is left out (a same-day re-run retries it) and the
        # rest still goes.
        recap = recap_rows = recap_batch_id = None
        if recap_due:
            try:
                recap, recap_rows, recap_batch_id = recap_mod.prepare(
                    store, user_id, agent_name_for(cascades_by_id.values(), user_id), today_by_id, cascades_by_id,
                    now, skip_movie_ids={h.transition.movie_id for h in hits}, write=not dry_run)
            except Exception as err:   # noqa: BLE001
                stats["failed"] += 1
                print(f"[monitor] email: {user_id}: could not prepare the day-7 recap: {err} - leaving it out.")
                if not mine and not replies:
                    continue
        # CAS-1592: the one-time "<agent> has learned something" line rides this email (never a catch-up, never an
        # email of its own - this member is already getting one). Recorded only after the send lands.
        taste_text = None
        if not any(h.transition.moment == "catchup" for h in hits):
            try:
                if films_by_user is None:
                    films_by_user = _films_by_user(store)
                taste_text = tasteline.line_for(store, user_id, films_by_user)
            except Exception as err:   # noqa: BLE001 - the line is a bonus; it must never cost the member their email
                print(f"[monitor] email: {user_id}: could not work out the taste line: {err} - leaving it out.")
        taste_line = ({"agent": agent_name_for(cascades_by_id.values(), user_id), "text": taste_text}
                      if taste_text else None)
        recap_hits = recap["hits"] if recap else []
        scores = scores_fn({h.transition.movie_id for h in hits + recap_hits}) if (hits or recap_hits) else {}
        catchup = any(h.transition.moment == "catchup" for h in hits)
        # CAS-1537: sign each film's buttons for this member against its ledger row (secret from the env).
        row_ids = {str(r.get("movie_id")): r.get("id") for r in reversed(mine) if r.get("id")}
        row_ids.update({str(m): i for m, i in (recap_rows or {}).items() if str(m) not in row_ids})
        answers = AnswerContext(secret_from_env(), user_id, row_ids, now=now.timestamp())
        digest = render_digest(
            hits, replies=[format_invite_reply(r, today_by_id.get(str(r.get("tmdb_id"))), now=now)
                           for r in replies],
            scores=scores, watch_windows=(user_prefs.get(user_id) or {}).get("watch_windows"), today=now.date(),
            kind="catchup_alert" if catchup else "unseen_alert", batch_id=batch_id, answers=answers,
            recap=recap, taste_line=taste_line)
        print(f"[monitor] email: {user_id} ({email}): {len(hits)} unseen alert(s), {len(replies)} "
              f"invite reply(s){', day-7 recap' if recap else ''}{', taste line' if taste_line else ''} - subject: {digest['subject']!r}")
        if dry_run:
            continue
        stats["users"] += 1
        stats["attempted"] += 1
        try:
            send(email, digest["subject"], digest["html"], digest["text"])
        except Exception as err:   # noqa: BLE001 - one bad send must not abort the rest
            stats["failed"] += 1
            print(f"[monitor] email: {user_id} failed: {err} - rows left unstamped, a re-run retries.")
            continue
        stats["sent"] += 1
        stamp = now.isoformat()
        if taste_line:
            tasteline.record_sent(store, user_id, stamp)
        try:
            store.mark_notifications([r.get("id") for r in mine], "emailed_at", stamp)
        except Exception as err:   # noqa: BLE001 - the batch id is already on every row, so the link stays right
            print(f"[monitor] could not stamp emailed_at for {user_id}: {err}")
        _stamp_batch(store, batch_id, "emailed_at", now)
        if recap and recap_batch_id:
            try:
                store.mark_notifications(list((recap_rows or {}).values()), "emailed_at", stamp)
            except Exception as err:   # noqa: BLE001 - the send already landed; the recap batch stamp below de-dupes
                print(f"[monitor] could not stamp emailed_at on the recap rows for {user_id}: {err}")
            _stamp_batch(store, recap_batch_id, "emailed_at", now)
        if replies:
            try:
                store.mark_invite_replies_digested([r.get("id") for r in replies], stamp)
            except Exception as err:   # noqa: BLE001
                print(f"[monitor] could not mark invite replies digested for {user_id}: {err}")
    print(f"[monitor] email phase: sent {stats['sent']} digest(s), {stats['failed']} failed.")
    return stats
