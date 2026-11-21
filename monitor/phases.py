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

from .emailer import format_invite_reply, render_digest, send_via_resend
from .matching import Hit, agent_channels, compute_scores, delivery_plan, prefs_for
from .pusher import send_via_apns
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


def push_copy_for(rows) -> dict:
    """{'title', 'body'} for ONE member's push covering `rows` (their unread alerts from last night).
    Built only from the real rows: the count of distinct films, and the first one or two titles."""
    titles, seen = [], set()
    for r in rows:
        mid = str(r.get("movie_id"))
        if mid in seen:
            continue
        seen.add(mid)
        titles.append(r.get("title") or "A film")
    n = len(titles)
    title = f"Cascade found {n} film{'' if n == 1 else 's'} for you"
    if n == 1:
        body = f"{titles[0]} is in your Alerts."
    elif n == 2:
        body = f"{titles[0]} and {titles[1]}."
    else:
        body = f"{titles[0]}, {titles[1]} and {n - 2} more."
    return {"title": title, "body": body}


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
        copy = push_copy_for(mine)
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

            if send(tok, copy["title"], copy["body"], badge=badge,
                    payload={"open": "alerts"}, on_invalid_token=_on_invalid):
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
                       price=detail.get("price"), movie=today_by_id.get(str(r.get("movie_id"))) or {})
        hits.append(Hit(user_id=str(r.get("user_id")), cascade_id=r.get("cascade_id"),
                        cascade_name=r.get("cascade_name") or "My Cascade", transition=t,
                        channels=_channels_of(r, cascades_by_id)))
    return hits


def email_phase(store, today_movies, now: _dt.datetime, send=send_via_resend, scores_fn=compute_scores,
                dry_run: bool = False, target_user: str = None) -> dict:
    """The 17:00 phase. Returns {'users', 'attempted', 'sent', 'failed'}."""
    stats = {"users": 0, "attempted": 0, "sent": 0, "failed": 0}
    rows = _store_get(store, "fetch_recent_notifications", [], _since(now, EMAIL_LOOKBACK_H))
    prefs = _store_get(store, "fetch_notify_prefs", {})
    cascades_by_id = {str(c.get("id")): c for c in _store_get(store, "fetch_active_cascades", [])}
    today_by_id = {str(m.get("tmdb_id")): m for m in today_movies}
    by_user = _group_by_user(rows)

    # Invite replies ride the account's email plan alone (CAS-887) - they were part of the old single
    # digest and stay part of this one, so a member with replies but no unseen films still gets them.
    replies_rows = _store_get(store, "fetch_undigested_invite_replies", [])
    replies_by_user: dict = {}
    for r in replies_rows:
        replies_by_user.setdefault(str(r.get("sender_id")), []).append(r)

    for user_id in sorted(set(by_user) | set(replies_by_user)):
        if target_user and user_id != str(target_user):
            continue
        pref = prefs_for(prefs, user_id)
        email = pref["email_address"] or _store_get(store, "fetch_user_email", None, user_id)
        if delivery_plan(pref, email) != "email":
            continue    # email off, or no address: nothing to send (and the rows stay unstamped)
        # Only what the member has NOT seen in the app, not already emailed, and the agent allows email.
        mine = [r for r in by_user.get(user_id, [])
                if not r.get("read_at") and not r.get("emailed_at")
                and _wants(_channels_of(r, cascades_by_id), "email")]
        replies = replies_by_user.get(user_id, [])
        if not mine and not replies:
            print(f"[monitor] email: {user_id} has nothing unseen - no email.")
            continue
        hits = _hits_from_rows(mine, today_by_id, cascades_by_id)
        scores = scores_fn({h.transition.movie_id for h in hits}) if hits else {}
        digest = render_digest(
            hits, replies=[format_invite_reply(r, today_by_id.get(str(r.get("tmdb_id"))), now=now)
                           for r in replies],
            scores=scores, today=now.date())
        print(f"[monitor] email: {user_id} ({email}): {len(hits)} unseen alert(s), {len(replies)} "
              f"invite reply(s) - subject: {digest['subject']!r}")
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
        try:
            store.mark_notifications([r.get("id") for r in mine], "emailed_at", stamp)
        except Exception as err:   # noqa: BLE001
            print(f"[monitor] could not stamp emailed_at for {user_id}: {err}")
        if replies:
            try:
                store.mark_invite_replies_digested([r.get("id") for r in replies], stamp)
            except Exception as err:   # noqa: BLE001
                print(f"[monitor] could not mark invite replies digested for {user_id}: {err}")
    print(f"[monitor] email phase: sent {stats['sent']} digest(s), {stats['failed']} failed.")
    return stats
