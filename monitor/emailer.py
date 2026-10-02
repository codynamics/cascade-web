"""Render + send the digest email (CAS-86 / spec 26771457 §6).

One consolidated email per user per run. Each item names the film, its transition in the
agent's voice, which Cascade caught it, and links back to the site.

Honesty guardrail (spec §5/§6): every line is built from real data only. Prices are the real
offer price; service names are the real services; the "past opening weekend" line states the
plain fact (the opening weekend has passed) with no invented "leaving soon" countdown. We never
show a saving, a timer, or an urgency we can't back up.

``send_via_resend`` posts to the Resend API with the ``RESEND_API_KEY`` secret read from the
environment (never hardcoded). ``--dry-run`` in the CLI renders the HTML and sends nothing.
"""
from __future__ import annotations

import datetime as _dt
import html as _html
import json
import os
import urllib.error
import urllib.request

# Same monotonic tier order poc_pipeline itself uses to decide a film's `status` — reused here
# only to pick which window is CURRENT for the invite-replies block, never to re-derive it.
from poc_pipeline import AVAILABILITY_TIERS, tier_rank

USER_AGENT = "cascade-monitor/1.0 (+https://cascademovies.com)"

RESEND_API_KEY_ENV = "RESEND_API_KEY"
RESEND_ENDPOINT = "https://api.resend.com/emails"

# Overridable via env so nothing site-specific is baked in.
DEFAULT_SITE_URL = "https://cascademovies.com/"
# Resend's shared test sender works without domain verification (delivers to your own account
# email). Lee swaps this for a verified sender once his domain is set up.
DEFAULT_FROM = "Cascade <onboarding@resend.dev>"

SITE_URL_ENV = "CASCADE_SITE_URL"
FROM_ENV = "CASCADE_EMAIL_FROM"


def _money(value):
    try:
        return f"${float(value):.2f}"
    except (TypeError, ValueError):
        return None


def moment_phrase(transition) -> str:
    """The agent-voice line for one transition — built only from real data on the transition."""
    m = transition.moment
    services = [s for s in (transition.services or []) if s]
    if m == "hits_stream":
        return "Now on " + " / ".join(services) if services else "Now streaming — included on your subscription"
    if m == "hits_rent":
        price = _money(transition.price)
        where = (" on " + " / ".join(services)) if services else ""
        return (f"Dropped to rent — {price}{where}" if price
                else f"Now available to rent{where}")
    if m == "hits_pvod":
        price = _money(transition.price)
        where = (" on " + " / ".join(services)) if services else ""
        return (f"Out early on premium — {price}{where}" if price
                else f"Out early on premium{where}")
    if m == "hits_cinema":
        return "In cinemas now"
    if m == "past_opening_weekend":
        return "Past its opening weekend"
    if m == "announced":
        return "Newly announced"
    if m == "opens_soon":
        return "In cinemas next week"
    if m == "newly_qualifies":
        return "Now matches this agent"
    if m == "new_to_agent":
        return "New to this agent"
    return m


# A short, honest sub-line per moment (no invented urgency).
_MOMENT_NOTE = {
    "hits_stream": "You can watch it now at no extra cost.",
    "hits_pvod": "It's available at home early, at the premium price.",
    "hits_rent": "It's reached the standard rental window.",
    "hits_cinema": "Its cinema run has begun.",
    "past_opening_weekend": "The opening weekend has passed — often a quieter time to see it.",
    # CAS-242. "Reached Cascade", not "was announced by the studio": nobody publishes an announcement date,
    # so this line says the thing we actually know instead of the thing it would be nicer to claim.
    "announced": "It has just reached Cascade, and it matches what you asked for.",
    "opens_soon": "Its published opening date is a week away.",
    "new_to_agent": "It just started matching this agent.",
    # CAS-849: newly_qualifies has no single cause (a rating crossing the bar, a metacritic score
    # or award arriving, a genre/age-rating correction) — this states the honest common fact
    # instead of guessing which one it was.
    "newly_qualifies": "Something about it changed, and now it matches this agent.",
}


def digest_subject(hits, replies=None) -> str:
    """CAS-887: a reply is worth opening the email for on its own, so it leads the subject when
    there are any — built only from the real counts (honesty guardrail), never an invented "someone
    replied!" urgency line."""
    replies = replies or []
    n = len(hits)
    if replies:
        r_word = "reply" if len(replies) == 1 else "replies"
        subject = f"{len(replies)} {r_word} to your invites"
        if n:
            subject += f", {n} update{'' if n == 1 else 's'}"
        return subject
    return f"Cascade found {n} update{'' if n == 1 else 's'} for you"


# moment -> the window it lands the film in, for the "prior -> destination" move line.
_DEST_WINDOW = {
    "hits_cinema": "in_cinema",
    "hits_pvod": "pvod",
    "hits_rent": "rental",
    "hits_stream": "included_streaming",
}

_WINDOW_LABEL = {
    "upcoming": "Upcoming",
    "in_cinema": "In cinema",
    "rental": "Rent",
    "included_streaming": "Stream",
    "pvod": "Premium",
}


def _move_phrase(transition) -> str:
    """'Prior window -> destination window' (e.g. "Upcoming -> In cinema"), only when the
    transition actually carries a known prior window. Transition does not have that field yet,
    so this reads it via getattr and returns "" rather than invent one (honesty guardrail)."""
    prior = getattr(transition, "prior_window", None)
    dest = _DEST_WINDOW.get(transition.moment)
    if not prior or dest is None or prior not in _WINDOW_LABEL:
        return ""
    return f"{_WINDOW_LABEL[prior]} → {_WINDOW_LABEL[dest]}"


def _header_line(transition) -> str:
    move = _move_phrase(transition)
    phrase = moment_phrase(transition)
    return f"{phrase} · {move}" if move else phrase


# CAS-849: the app's own agrank tokens (app_template.html ~L79-80) — rank 1 first, repeating the
# last colour beyond rank 6, exactly as the app's cascadeRankTint()/.agrank-N CSS already does.
_RANK_COLORS = ["#A78BFF", "#22D3EE", "#F06FB0", "#FFD166", "#7DD3A0", "#9BA5B5"]


def _rank_color(index: int) -> str:
    return _RANK_COLORS[index] if index < len(_RANK_COLORS) else _RANK_COLORS[-1]


def _tint(hex_color: str, alpha: float = 0.08) -> str:
    """A light wash of `hex_color`, mirroring the app's `color-mix(in srgb, var(--rt) 6%, var(--bg))`
    heading background (app_template.html ~L500-511) in a form email clients actually render."""
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r},{g},{b},{alpha})"


def is_new_moment(moment: str) -> bool:
    """CAS-849: the shared classification rule — New = the film's first appearance for this agent
    (`new_to_agent` / `newly_qualifies`); Changed = every other moment. Nothing is both. Mirrors
    app_template.html's movingIsNewMoment() so the email and the Moving screen never disagree."""
    return moment in ("new_to_agent", "newly_qualifies")


# CAS-924: the app's own LISTING_ORDER/STATUS_LABEL (app_template.html ~L4073-4089), mirrored here
# so the digest's outer grouping can never disagree with Moving's. opening_week is kept in the order
# for the same reason it's in the app's — but poc_pipeline.AVAILABILITY_TIERS (the only tiers a
# monitor-side movie record's `status` can ever hold) has no such member, so that section can never
# actually populate; it stays listed rather than silently diverging from the app's constant.
LISTING_ORDER = ["upcoming", "opening_week", "in_cinema", "pvod", "rental", "included_streaming"]

STATUS_LABEL = {
    "upcoming": "Upcoming",
    "opening_week": "In Cinema · Opening week",
    "in_cinema": "In Cinema",
    "pvod": "Premium/Rent (~$30)",
    "rental": "Rent (~$7)",
    "included_streaming": "Stream (included)",
}


def _primary_status(movie):
    """A movie's primary status for grouping — the furthest-along AVAILABILITY_TIERS member its
    status set holds (poc_pipeline.tier_rank), the same "furthest travelled" reduction the app's
    own primaryStatus makes. None if the movie carries none of the named tiers."""
    tier = tier_rank((movie or {}).get("status") or [])
    return AVAILABILITY_TIERS[tier] if tier >= 0 else None


def _status_sections(hits):
    """CAS-924: the MAJOR grouping — one outer section per film status, in LISTING_ORDER, each
    holding the hits for that status (still to be split into per-agent sections by _agent_sections).
    A hit whose movie carries no resolvable status is never dropped — it lands in a final, unlabelled
    section instead, the outer-grouping equivalent of _agent_sections' own untinted trailing section.

    Returns a list of {"key", "hits"} — "key" is a LISTING_ORDER member, or None for that fallback."""
    by_status = {}
    for h in hits:
        by_status.setdefault(_primary_status(h.transition.movie), []).append(h)
    sections = [{"key": k, "hits": by_status[k]} for k in LISTING_ORDER if k in by_status]
    if None in by_status:
        sections.append({"key": None, "hits": by_status[None]})
    return sections


def _agent_sections(hits):
    """Group hits into per-agent sections (CAS-849), ordered by each cascade's own `rank` — the
    `_rank_key()` tuple matching.py already computed and carried onto the Hit, not re-derived here.
    A hit with no cascade (a per-film Watch it tick, cascade_name "Your picks") is grouped into its
    own final, untinted section instead, in the order those hits first arrived.

    Returns a list of {"name", "color" (None for the untinted trailing sections), "hits"}."""
    ranked, ranked_order = {}, []
    other, other_order = {}, []
    for h in hits:
        if h.cascade_id is None:
            key, bucket, order = h.cascade_name, other, other_order
        else:
            key, bucket, order = h.cascade_id, ranked, ranked_order
        entry = bucket.get(key)
        if entry is None:
            entry = {"name": h.cascade_name, "rank": h.rank or (float("inf"), "", ""), "hits": []}
            bucket[key] = entry
            order.append(key)
        entry["hits"].append(h)

    sections = sorted((ranked[k] for k in ranked_order), key=lambda e: e["rank"])
    for i, section in enumerate(sections):
        section["color"] = _rank_color(i)
        del section["rank"]
    for key in other_order:
        section = other[key]
        section["color"] = None
        del section["rank"]
        sections.append(section)
    return sections


def _row_text(hit, site_url) -> list:
    t = hit.transition
    tag = "New" if is_new_moment(t.moment) else "Changed"
    return [f"  [{tag}] {t.title}", f"    {_header_line(t)}", f"    {site_url}#/film/{t.movie_id}"]


def _row_html(hit, esc, site_url) -> str:
    t = hit.transition
    is_new = is_new_moment(t.moment)
    pill_bg, pill_fg = ("#E6F9EE", "#1A9C5C") if is_new else ("#E8ECFF", "#3B4FE0")
    note = _MOMENT_NOTE.get(t.moment, "")
    # CAS-524: same #/film/<id> hash route inviteUrlFor() builds in the app itself (CAS-883 renamed it
    # from shareUrlFor), so the link
    # is the real, permanent film page — tapping it on a device with the app installed is what
    # the universal-link/AASA setup turns into an in-app open instead of a browser tab.
    film_url = f"{site_url}#/film/{t.movie_id}"
    return (
        '<tr><td style="padding:14px 0;border-bottom:1px solid #e6e8ee;">'
        f'<a href="{esc(film_url)}" style="text-decoration:none;color:inherit;display:block;">'
        f'<span style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:0.4px;'
        f'text-transform:uppercase;padding:2px 9px;border-radius:20px;background:{pill_bg};'
        f'color:{pill_fg};">{"New" if is_new else "Changed"}</span>'
        f'<div style="font-size:16px;font-weight:600;color:#141A2A;margin-top:6px;">{esc(t.title)}</div>'
        f'<div style="font-size:14px;color:#4C7DFF;font-weight:600;margin-top:2px;">{esc(_header_line(t))}</div>'
        + (f'<div style="font-size:13px;color:#6b7280;margin-top:2px;">{esc(note)}</div>' if note else "")
        + '</a></td></tr>'
    )


def _status_heading_html(key, count, esc) -> str:
    return (
        '<tr><td style="padding:16px 0 6px;">'
        '<span style="font-size:12px;font-weight:800;letter-spacing:0.4px;text-transform:uppercase;'
        f'color:#8b95a5;">{esc(STATUS_LABEL[key])} ({count})</span></td></tr>'
    )


def _section_heading_html(section, esc) -> str:
    color = section["color"]
    if color:
        style = f'padding:12px 14px;border-radius:12px;border-left:3px solid {color};background:{_tint(color)};'
        text_style = f'font-size:13px;font-weight:800;letter-spacing:0.3px;color:{color};'
    else:
        style = 'padding:12px 14px;border-radius:12px;background:#f4f5f8;'
        text_style = 'font-size:13px;font-weight:800;letter-spacing:0.3px;color:#4b5563;'
    return f'<tr><td style="{style}"><span style="{text_style}">{esc(section["name"])}</span></td></tr>'


# CAS-887: label per window, for the replies block's second line (design image: "In cinemas 17
# Sep" / "Upcoming 24 Sep"). Deliberately its own small map rather than emailer.py's _WINDOW_LABEL
# above — that one reads as half of a "prior -> destination" move, this reads as a plain fact.
_INVITE_WINDOW_LABEL = {
    "upcoming": "Upcoming",
    "in_cinema": "In cinemas",
    "pvod": "Premium",
    "rental": "Rent",
    "included_streaming": "Streaming",
}


def _format_short_date(value) -> str:
    """'17 Sep' — day-of-month, no leading zero, abbreviated month, no year (the design image's own
    date shape). Returns "" for anything not a real date, never a placeholder (honesty guardrail)."""
    if not value:
        return ""
    try:
        d = _dt.date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return ""
    return f"{d.day} {d.strftime('%b')}"


def _invite_window_text(movie) -> str:
    """The invited film's CURRENT window + date, e.g. "In cinemas 17 Sep". `movie` is today's
    catalogue record (or None/{} if the film has since dropped out of the catalogue). Only ever
    states a date the catalogue actually carries for that window — upcoming/in_cinema fall back to
    `cinema_date` (the one date poc_pipeline derives those two windows from itself); a home window
    with no `window_dates` entry shows its label alone rather than inventing a date."""
    if not movie:
        return ""
    tier = tier_rank(movie.get("status") or [])
    if tier < 0:
        return ""
    window = AVAILABILITY_TIERS[tier]
    label = _INVITE_WINDOW_LABEL.get(window)
    if not label:
        return ""
    date_str = (movie.get("window_dates") or {}).get(window)
    if not date_str and window in ("upcoming", "in_cinema"):
        date_str = movie.get("cinema_date")
    date_text = _format_short_date(date_str)
    return f"{label} {date_text}" if date_text else label


def _invite_age_text(created_at, now=None) -> str:
    """Mirrors the app's own inviteAgeText (app_template.html) so the digest and the Invites
    screen never disagree about how fresh a reply reads."""
    if not created_at:
        return ""
    try:
        t = _dt.datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    except ValueError:
        return ""
    if t.tzinfo is None:
        t = t.replace(tzinfo=_dt.timezone.utc)
    now = now or _dt.datetime.now(_dt.timezone.utc)
    mins = int((now - t).total_seconds() // 60)
    if mins < 1:
        return "just now"
    if mins < 60:
        return f"{mins} min ago"
    hours = mins // 60
    if hours < 24:
        return f"{hours}h ago"
    days = hours // 24
    if days == 1:
        return "yesterday"
    return f"{days} days ago"


def format_invite_reply(row: dict, movie=None, now=None) -> dict:
    """One invite_replies row (plus its film's today-catalogue record, if still present) resolved
    into the shape render_digest's `replies` wants — the window text and reply age are computed
    here so render_digest itself stays a pure formatter, the same division of labour Transition/Hit
    already have with moment_phrase above."""
    return {
        "to_name": row.get("to_name") or "Someone",
        "answer": row.get("answer"),
        "film_title": row.get("film_title") or "",
        "window_text": _invite_window_text(movie),
        "when_text": _invite_age_text(row.get("created_at"), now=now),
    }


def _replies_block_text(replies) -> list:
    lines = ["Replies to your invites"]
    for r in replies:
        verb = "yes" if r.get("answer") == "yes" else "no"
        lines.append(f"  {r['to_name']} said {verb} to {r['film_title']}")
        sub = " · ".join(x for x in (r.get("window_text"), r.get("when_text")) if x)
        if sub:
            lines.append(f"    {sub}")
    lines.append("")
    return lines


def _replies_block_html(replies, esc) -> str:
    heading = ('<div style="font-size:12px;font-weight:800;letter-spacing:0.4px;'
               'text-transform:uppercase;color:#7C5CFF;">Replies to your invites</div>')
    rows = []
    for i, r in enumerate(replies):
        verb = "yes" if r.get("answer") == "yes" else "no"
        verb_color = "#1A9C5C" if verb == "yes" else "#6b7280"
        sub = " · ".join(x for x in (r.get("window_text"), r.get("when_text")) if x)
        divider = '<div style="height:1px;background:#e0dbfa;margin:10px 0;"></div>' if i else ''
        rows.append(
            divider +
            f'<div style="font-size:15px;color:#141A2A;margin-top:{"10px" if not i else "0"};">'
            f'<b>{esc(r["to_name"])}</b> said <b style="color:{verb_color};">{verb}</b> to '
            f'<b>{esc(r["film_title"])}</b></div>'
            + (f'<div style="font-size:13px;color:#6b7280;margin-top:2px;">{esc(sub)}</div>' if sub else '')
        )
    return (
        '<tr><td style="padding-top:14px;">'
        '<div style="padding:14px 16px;border-radius:14px;background:#F1EEFE;">'
        + heading + "".join(rows) +
        '</div></td></tr>'
    )


def render_digest(hits, site_url: str = None, replies=None) -> dict:
    """Return {'subject', 'html', 'text'} for one user's consolidated digest.

    CAS-924: grouped into outer status sections in LISTING_ORDER (see _status_sections), each
    holding its own per-agent sections in rank order (see _agent_sections) — the same two levels
    of grouping as the Moving screen (app_template.html), so the two never disagree about where a
    film sits. CAS-849: each row tagged New or Changed (see is_new_moment).

    hits: list of monitor.matching.Hit (all for the same user)."""
    site_url = site_url or os.environ.get(SITE_URL_ENV) or DEFAULT_SITE_URL
    replies = list(replies or [])
    subject = digest_subject(hits, replies)
    status_sections = _status_sections(hits)
    esc = _html.escape

    # ---- plain-text part ----
    # CAS-887: replies lead — added first, ahead of the "Your agents have been watching" section,
    # which itself only appears when there is a film transition to report (AC2: a replies-only
    # digest must not claim "here's what changed" over an empty list).
    text_lines = []
    if replies:
        text_lines.extend(_replies_block_text(replies))
    if status_sections:
        text_lines.append("Your agents have been watching. Here's today.")
        text_lines.append("")
        for status_section in status_sections:
            if status_section["key"] is not None:
                text_lines.append(f"{STATUS_LABEL[status_section['key']]} ({len(status_section['hits'])})")
                text_lines.append("")
            for section in _agent_sections(status_section["hits"]):
                text_lines.append(section["name"])
                for h in section["hits"]:
                    text_lines.extend(_row_text(h, site_url))
                text_lines.append("")
    text_lines += [f"Open Cascade: {site_url}",
                   "You're getting this because Cascade is watching films for you."]
    text = "\n".join(text_lines)

    # ---- HTML part (inline styles; email-client safe — no <style>, no class=, no display:flex) ----
    section_html = []
    for status_section in status_sections:
        if status_section["key"] is not None:
            section_html.append(_status_heading_html(status_section["key"], len(status_section["hits"]), esc))
        for section in _agent_sections(status_section["hits"]):
            section_html.append(_section_heading_html(section, esc))
            section_html.extend(_row_html(h, esc, site_url) for h in section["hits"])
    body_rows = ""
    if replies:
        body_rows += _replies_block_html(replies, esc)
    if status_sections:
        body_rows += (
            '<tr><td style="padding-top:14px;">'
            '<div style="font-size:15px;color:#141A2A;font-weight:600;">'
            "Your agents have been watching. Here's today.</div>"
            '</td></tr>'
            '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">'
            + "".join(section_html) +
            '</table></td></tr>'
        )
    html_doc = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        '<body style="margin:0;background:#f4f5f8;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;padding:24px 0;">'
        '<tr><td align="center">'
        '<table role="presentation" width="480" cellpadding="0" cellspacing="0" '
        'style="max-width:480px;background:#ffffff;border-radius:14px;padding:24px;">'
        '<tr><td>'
        '<div style="font-size:18px;font-weight:700;letter-spacing:1px;color:#7C5CFF;'
        'text-transform:uppercase;">Cascade</div>'
        '</td></tr>'
        + body_rows +
        '<tr><td style="padding-top:20px;">'
        f'<a href="{esc(site_url)}" style="display:inline-block;background:#6b48f2;color:#ffffff;'
        'text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:11px;">'
        'Open Cascade</a>'
        '</td></tr>'
        '<tr><td style="padding-top:18px;font-size:12px;color:#8b95a5;">'
        'You&rsquo;re getting this because Cascade is watching films for you. '
        'Every update here is a real change to a film one of your Cascades was watching.'
        '</td></tr>'
        '</table></td></tr></table></body></html>'
    )
    return {"subject": subject, "html": html_doc, "text": text}


def send_via_resend(to_addr, subject, html, text, api_key=None, from_addr=None, timeout=30) -> dict:
    """POST one email to Resend. Reads RESEND_API_KEY / CASCADE_EMAIL_FROM from env when not
    passed. Raises if there's no API key (callers gate this behind --dry-run)."""
    api_key = api_key or os.environ.get(RESEND_API_KEY_ENV)
    if not api_key:
        raise RuntimeError(f"{RESEND_API_KEY_ENV} is not set — cannot send email.")
    from_addr = from_addr or os.environ.get(FROM_ENV) or DEFAULT_FROM
    payload = json.dumps({
        "from": from_addr, "to": [to_addr], "subject": subject, "html": html, "text": text,
    }).encode("utf-8")
    req = urllib.request.Request(
        RESEND_ENDPOINT, data=payload, method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        # CAS-495: the bare HTTPError swallowed everything Resend told us — surface status,
        # content-type, and a truncated body so the cause is legible from the run log alone.
        # Never the API key: only the from-address, which is not secret.
        content_type = err.headers.get("Content-Type", "") if err.headers else ""
        detail = err.read().decode("utf-8", "replace") if err.fp else ""
        raise RuntimeError(
            f"Resend send failed: HTTP {err.code}, content-type={content_type!r}, "
            f"from={from_addr!r}, body={detail[:500]!r}"
        ) from err
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body}
