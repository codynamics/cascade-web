"""Recommend Cascade — the send half of Refer a friend (CAS-884/M11).

Reads every unsent `recommendations` row and sends ONE email per (sender, lower-cased address)
group (not a digest — each recommendation is its own introduction, from its own sender, to its
own recipient). Runs from a new hourly workflow (.github/workflows/recommend.yml) rather than the
daily 6am one, so a recommendation lands within the hour. Same send-before-ledger discipline as
monitor/contact.py: a group's email goes out first, and `sent_at` is stamped on every row in that
group only once the send has actually succeeded, so a failed send is retried next run without
touching any other group.

CAS-1131: a duplicate queued for the same (sender, address) is never emailed twice. Two unsent
rows for the same pair fold into one send (the newest row's message), both stamped. A row whose
pair was already sent within the last 7 days is stamped without sending at all.

    python -m monitor.recommend                              # live (needs SUPABASE_*, RESEND_API_KEY)
    python -m monitor.recommend --dry-run                     # render only; sends nothing, stamps nothing
    python -m monitor.recommend --dry-run --recommendations monitor/fixtures/recommendations.json

Nothing unsent: exits 0 silently, sends no email. CAS-808 still owns attribution and any reward;
this module only ever sends the one introduction email.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html as _html
import json
import sys

from .emailer import send_via_resend
from .store import InMemoryStore, store_from_env

SIGNUP_URL = "https://cascademovies.com"


def email_subject(row) -> str:
    sender = row.get("sender_name") or "A friend"
    return f"{sender} thinks you'd like Cascade"


def render_email(row) -> dict:
    """Return {'subject', 'html', 'text'} for one recommendation row."""
    esc = _html.escape
    subject = email_subject(row)
    to_name = row.get("to_name") or "there"
    message = row.get("message") or ""

    text = (
        f"{message}\n\n"
        f"Sign up: {SIGNUP_URL}"
    )
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
        f'<div style="font-size:15px;color:#141A2A;margin-top:14px;white-space:pre-wrap;">{esc(message)}</div>'
        '</td></tr>'
        '<tr><td style="padding-top:20px;">'
        f'<a href="{esc(SIGNUP_URL)}" style="display:inline-block;background:#6b48f2;color:#ffffff;'
        'text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:11px;">'
        'Sign up to Cascade</a>'
        '</td></tr>'
        '<tr><td style="padding-top:18px;font-size:12px;color:#8b95a5;">'
        f'{esc(to_name)}, you got this because someone who uses Cascade thought you would too.'
        '</td></tr>'
        '</table></td></tr></table></body></html>'
    )
    return {"subject": subject, "html": html_doc, "text": text}


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.recommend",
                                 description="Render + send unsent Recommend Cascade introductions.")
    p.add_argument("--dry-run", action="store_true",
                   help="Render every unsent recommendation; send no email and stamp no rows.")
    p.add_argument("--recommendations", metavar="PATH",
                   help="Unsent recommendations JSON (default: Supabase via service_role).")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    if args.recommendations is not None:
        with open(args.recommendations, encoding="utf-8") as fh:
            rows = json.load(fh)
        store = InMemoryStore(recommendations=rows)
        rows = store.fetch_unsent_recommendations()
    else:
        store = store_from_env()
        if store is None:
            print("[monitor.recommend] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and no "
                  "--recommendations — nothing to do.")
            return 0
        rows = store.fetch_unsent_recommendations()

    if not rows:
        return 0

    print(f"[monitor.recommend] {len(rows)} unsent recommendation(s).")

    # CAS-1131: fold same (sender, lower-cased address) rows in this batch into one send, and skip
    # (but still stamp) any pair already sent in the last 7 days — a duplicate must never be emailed.
    cooldown_since = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=7)).isoformat()
    recently_sent = {
        (r["sender_id"], (r.get("to_email") or "").lower())
        for r in store.fetch_recent_sent_recommendations(cooldown_since)
    }

    groups = {}
    for row in rows:
        key = (row["sender_id"], (row.get("to_email") or "").lower())
        groups.setdefault(key, []).append(row)
    folded = len(rows) - len(groups)
    if folded:
        print(f"[monitor.recommend] folded {folded} duplicate unsent row(s) into "
              f"{len(groups)} sender/address group(s).")

    sent, failed = 0, 0
    for key, group_rows in groups.items():
        ids = [r["id"] for r in group_rows]
        if key in recently_sent:
            if not args.dry_run:
                sent_at = _dt.datetime.now(_dt.timezone.utc).isoformat()
                store.mark_recommendations_sent(ids, sent_at)
            continue
        newest = max(group_rows, key=lambda r: r.get("created_at") or "")
        email = render_email(newest)
        if args.dry_run:
            print(f"[monitor.recommend] would send to {newest.get('to_email')!r}: {email['subject']!r}")
            print(email["text"])
            continue
        try:
            send_via_resend(newest["to_email"], email["subject"], email["html"], email["text"])
        except Exception as err:  # noqa: BLE001 — a failed send must not stamp sent_at
            print(f"[monitor.recommend] send to {newest.get('to_email')!r} failed: {err} — "
                  "not marking sent, will retry next run.")
            failed += 1
            continue
        sent_at = _dt.datetime.now(_dt.timezone.utc).isoformat()
        store.mark_recommendations_sent(ids, sent_at)
        sent += 1

    if args.dry_run:
        return 0
    print(f"[monitor.recommend] sent {sent} of {len(groups)} group(s); {failed} failed and will retry.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
