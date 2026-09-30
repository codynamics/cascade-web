"""Invite emails — the outgoing queue for a multi-recipient Invite's email leg (CAS-930/M12).

A WhatsApp/SMS recipient gets their own device's app opened for them (app_template.html); only an
email recipient's own address is queued into `invite_emails` for Cascade itself to send, and this
module is what actually sends it — one email per row, each carrying the film, the sender's name and
that row's own invite link (joined back to `invites` by token, since `invite_emails` does not itself
carry the film or sender). Same send-before-ledger discipline as monitor/recommend.py: a row's email
goes out first, and its own `sent_at` is stamped only once that send has actually succeeded, so a
failed send is retried next run without touching any other row. A row whose invite has gone missing
skips rather than crashes the job.

Runs as a second step in the same hourly workflow as Recommend Cascade
(.github/workflows/recommend.yml), right after monitor.recommend.

    python -m monitor.invitemail                                # live (needs SUPABASE_*, RESEND_API_KEY)
    python -m monitor.invitemail --dry-run                       # render only; sends nothing, stamps nothing
    python -m monitor.invitemail --dry-run --invite-emails monitor/fixtures/invite_emails.json

Nothing unsent: exits 0 silently, sends no email.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html as _html
import json
import os
import sys

from .catalogue import load_today
from .emailer import DEFAULT_SITE_URL, SITE_URL_ENV, send_via_resend
from .store import InMemoryStore, store_from_env


def invite_url(row) -> str:
    site_url = os.environ.get(SITE_URL_ENV) or DEFAULT_SITE_URL
    return f"{site_url}?inv={row.get('token')}#/film/{row.get('tmdb_id')}"


def email_subject(row) -> str:
    sender = row.get("sender_name") or "A friend"
    film = row.get("film_title") or "a film"
    return f"{sender} invited you to watch {film}"


def render_email(row, movie=None) -> dict:
    """Return {'subject', 'html', 'text'} for one invite_emails row. `movie` is the invited
    film's today-catalogue record (for its poster), or None if it has since dropped out of the
    catalogue — the same resolve-by-caller shape format_invite_reply (emailer.py) already uses."""
    esc = _html.escape
    subject = email_subject(row)
    to_name = row.get("to_name") or "there"
    sender = row.get("sender_name") or "A friend"
    film = row.get("film_title") or "a film"
    url = invite_url(row)
    poster = (movie or {}).get("poster")

    text = (
        f"{sender} has invited you to watch {film}.\n\n"
        f"View invite: {url}"
    )
    poster_img = (
        f'<img src="https://image.tmdb.org/t/p/w342{esc(poster)}" width="160" '
        f'style="border-radius:10px;display:block;margin-top:14px;" alt="{esc(film)}">'
    ) if poster else ''
    html_doc = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        '<body style="margin:0;background:#f4f5f8;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="background:#f4f5f8;padding:24px 0;">'
        '<tr><td align="center">'
        '<table role="presentation" width="480" cellpadding="0" cellspacing="0" '
        'style="max-width:480px;background:#ffffff;border-radius:14px;padding:24px;">'
        '<tr><td>'
        '<div style="font-size:18px;font-weight:700;letter-spacing:1px;color:#7C5CFF;'
        'text-transform:uppercase;">Cascade</div>'
        f'{poster_img}'
        f'<div style="font-size:15px;color:#141A2A;margin-top:14px;">'
        f'{esc(sender)} has invited you to watch <b>{esc(film)}</b>.</div>'
        '</td></tr>'
        '<tr><td style="padding-top:20px;">'
        f'<a href="{esc(url)}" style="display:inline-block;background:#6b48f2;color:#ffffff;'
        'text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:11px;">'
        'View invite</a>'
        '</td></tr>'
        '<tr><td style="padding-top:18px;font-size:12px;color:#8b95a5;">'
        f'{esc(to_name)}, you got this because {esc(sender)} invited you to watch with them.'
        '</td></tr>'
        '</table></td></tr></table></body></html>'
    )
    return {"subject": subject, "html": html_doc, "text": text}


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.invitemail",
                                 description="Render + send unsent multi-recipient Invite emails.")
    p.add_argument("--dry-run", action="store_true",
                   help="Render every unsent invite email; send no email and stamp no rows.")
    p.add_argument("--invite-emails", metavar="PATH",
                   help="Unsent invite_emails JSON, already flattened with the film/sender context "
                        "fetch_unsent_invite_emails() would join in (default: Supabase via service_role).")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    if args.invite_emails is not None:
        with open(args.invite_emails, encoding="utf-8") as fh:
            rows = json.load(fh)
        store = InMemoryStore(invite_emails=rows)
        rows = store.fetch_unsent_invite_emails()
    else:
        store = store_from_env()
        if store is None:
            print("[monitor.invitemail] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and no "
                  "--invite-emails — nothing to do.")
            return 0
        rows = store.fetch_unsent_invite_emails()

    if not rows:
        return 0

    print(f"[monitor.invitemail] {len(rows)} unsent invite email(s).")

    movies_by_id = {str(m.get("tmdb_id")): m for m in load_today()}

    sent, skipped, failed = 0, 0, 0
    for row in rows:
        if row.get("tmdb_id") is None:
            print(f"[monitor.invitemail] invite_emails id={row.get('id')!r} has no matching "
                  "invite — skipping.")
            skipped += 1
            continue
        movie = movies_by_id.get(str(row.get("tmdb_id")))
        email = render_email(row, movie)
        if args.dry_run:
            print(f"[monitor.invitemail] would send to {row.get('to_email')!r}: {email['subject']!r}")
            print(email["text"])
            continue
        try:
            send_via_resend(row["to_email"], email["subject"], email["html"], email["text"])
        except Exception as err:  # noqa: BLE001 — a failed send must not stamp sent_at
            print(f"[monitor.invitemail] send to {row.get('to_email')!r} failed: {err} — "
                  "not marking sent, will retry next run.")
            failed += 1
            continue
        sent_at = _dt.datetime.now(_dt.timezone.utc).isoformat()
        store.mark_invite_emails_sent([row["id"]], sent_at)
        sent += 1

    if args.dry_run:
        return 0
    print(f"[monitor.invitemail] sent {sent} of {len(rows)}; {skipped} skipped, {failed} failed and will retry.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
