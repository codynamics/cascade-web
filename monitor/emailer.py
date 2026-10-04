"""Render + send the digest email (CAS-86 / spec 26771457 §6; redesigned by CAS-1196).

One consolidated email per user per run: one card per film — poster, a real-dated event pill, the
film's Cascade score, which agent caught it, and "when will you watch it?" buttons that answer
themselves (see `?answer=` in app_template.html) — plus the invite-replies block (CAS-887),
unchanged by this redesign.

Honesty guardrail (spec §5/§6): every line is built from real data only. Prices are the real offer
price; service names are the real services; dates are the film's own real dates (never a bare
relative word); a film with no Cascade score yet shows no chip, never a fabricated one.

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

# Same monotonic tier order poc_pipeline itself uses to decide a film's `status` — reused here to
# find a film's current window (for grouping, pill colour and button choice), never to re-derive it.
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

# Cards show at most this many films; the rest get one "and N more" line (CAS-1196 item 6).
MAX_CARDS = 5


def _money(value):
    try:
        return f"${float(value):.2f}"
    except (TypeError, ValueError):
        return None


def _date_of(value):
    """A real `date`, or None for anything that isn't one (honesty guardrail — never a placeholder)."""
    if not value:
        return None
    try:
        return _dt.date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _format_short_date(value) -> str:
    """'17 Sep' — day-of-month, no leading zero, abbreviated month, no year. Returns "" for anything
    not a real date, never a placeholder (honesty guardrail)."""
    d = _date_of(value)
    return f"{d.day} {d.strftime('%b')}" if d else ""


def _weekday_date(value) -> str:
    """'Thu 8 Oct' — weekday, day-of-month, no leading zero, abbreviated month, no year (CAS-1196
    item 2's own date shape, used by every event pill/context that names a real date)."""
    d = _date_of(value)
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b')}" if d else ""


def _primary_status(movie):
    """A movie's primary status — the furthest-along AVAILABILITY_TIERS member its status set holds
    (poc_pipeline.tier_rank). None if the movie carries none of the named tiers."""
    tier = tier_rank((movie or {}).get("status") or [])
    return AVAILABILITY_TIERS[tier] if tier >= 0 else None


def _window_date(movie, window):
    """The real date `window` was reached, same resolve-by-window rule _invite_window_text uses:
    window_dates first, falling back to cinema_date for upcoming/in_cinema (the one date
    poc_pipeline derives those two windows from). None when the catalogue doesn't carry one."""
    date_str = (movie.get("window_dates") or {}).get(window)
    if not date_str and window in ("upcoming", "in_cinema"):
        date_str = movie.get("cinema_date")
    return date_str


# ---- event pill (CAS-1196 item 2) ------------------------------------------------------------------
# Pill colour follows the window the moment is ABOUT, not the moment name itself — violet for not yet
# released, green for streaming, amber for rent/buy (the design image's own three colours).
_EVENT_COLORS = {
    "violet": ("#7C5CFF", "#F1EEFE"),
    "green": ("#1A9C5C", "#E6F9EE"),
    "amber": ("#B06A00", "#FFF2DC"),
}
_WINDOW_COLOR_KEY = {
    "upcoming": "violet", "opening_week": "violet", "in_cinema": "violet",
    "pvod": "amber", "rental": "amber", "included_streaming": "green",
}


def _event_pill(transition, movie, today):
    """(text, colour-key) for one transition's event pill — every date in it is real (honesty
    guardrail: never a bare relative word like "soon")."""
    m = transition.moment
    services = [s for s in (transition.services or []) if s]
    svc = services[0].upper() if services else ""
    if m == "opens_soon":
        return (f"OPENS {_weekday_date(movie.get('cinema_date'))}".rstrip(), "violet")
    if m == "announced":
        date = _weekday_date(movie.get("cinema_date"))
        return ((f"COMING {date}" if date else "NEWLY ANNOUNCED"), "violet")
    if m == "hits_cinema":
        return ("IN CINEMAS NOW", "violet")
    if m == "past_opening_weekend":
        return ("IN CINEMAS · PAST OPENING WEEKEND", "violet")
    if m == "hits_pvod":
        text = f"NOW TO BUY OR RENT · {svc}" if svc else "NOW TO BUY OR RENT"
        price = _money(transition.price)
        return ((f"{text} · {price}" if price else text), "amber")
    if m == "hits_rent":
        text = f"NOW TO RENT · {svc}" if svc else "NOW TO RENT"
        price = _money(transition.price)
        return ((f"{text} · from {price}" if price else text), "amber")
    if m == "hits_stream":
        return ((f"NOW STREAMING · {svc}" if svc else "NOW STREAMING"), "green")
    if m in ("newly_qualifies", "new_to_agent"):
        window = _primary_status(movie)
        return ("NEW FOR YOU", _WINDOW_COLOR_KEY.get(window, "violet"))
    return (m.upper(), "violet")


# ---- context line (CAS-1196 item 1: "a context line starting with the agent's name") --------------
_INVITE_WINDOW_LABEL = {
    "upcoming": "Upcoming",
    "in_cinema": "In cinemas",
    "pvod": "Premium",
    "rental": "Rent",
    "included_streaming": "Streaming",
}


def _invite_window_text(movie) -> str:
    """The film's CURRENT window + date, e.g. "In cinemas 17 Sep" — shared by the invite-replies
    block and by newly_qualifies/new_to_agent's own context (CAS-1196 item 2: "the film's current
    window and date"). `movie` is today's catalogue record (or None/{} if it has since dropped out
    of the catalogue). A home window with no date on file shows its label alone rather than
    inventing one (honesty guardrail)."""
    if not movie:
        return ""
    window = _primary_status(movie)
    label = _INVITE_WINDOW_LABEL.get(window)
    if not label:
        return ""
    date_text = _format_short_date(_window_date(movie, window))
    return f"{label} {date_text}" if date_text else label


def _event_context(transition, movie, today):
    """The phrase after the agent's name on its context line, or "" for a moment with nothing to
    add (the line then reads as the agent's name alone)."""
    m = transition.moment
    services = [s for s in (transition.services or []) if s]
    if m == "opens_soon":
        d = _date_of(movie.get("cinema_date"))
        if d and today:
            n = (d - today).days
            if n > 0:
                return f"in cinemas in {n} day{'' if n == 1 else 's'}"
        return "in cinemas soon"
    if m == "hits_cinema":
        date = _weekday_date(_window_date(movie, "in_cinema"))
        return f"since {date}" if date else ""
    if m == "hits_rent":
        others = services[1:]
        return f"also on {' / '.join(others)}" if others else ""
    if m == "hits_stream":
        date = _weekday_date(_window_date(movie, "included_streaming"))
        svc = services[0] if services else ""
        if svc and date:
            return f"on {svc} since {date}"
        return f"since {date}" if date else ""
    if m in ("newly_qualifies", "new_to_agent"):
        return _invite_window_text(movie)
    return ""


def _context_line(hit, today) -> str:
    phrase = _event_context(hit.transition, hit.transition.movie or {}, today)
    return f"{hit.cascade_name} · {phrase}" if phrase else hit.cascade_name


# ---- subject (CAS-1196 item 5) ----------------------------------------------------------------------
_SUBJECT_PHRASE = {
    "hits_cinema": "is in cinemas now",
    "past_opening_weekend": "is in cinemas",
    "hits_pvod": "is out to buy or rent",
    "hits_rent": "is now to rent",
    "hits_stream": "is now streaming",
    "announced": "is newly announced",
    "newly_qualifies": "is new for you",
    "new_to_agent": "is new for you",
}


def _subject_event_phrase(transition, movie, today) -> str:
    if transition.moment == "opens_soon":
        d = _date_of(movie.get("cinema_date"))
        return f"opens {d.strftime('%A')}" if d else "opens soon"
    return _SUBJECT_PHRASE.get(transition.moment, "has an update")


def _score_of(scores, movie_id):
    return (scores or {}).get(str(movie_id))


def _ordered_by_score(hits, scores):
    """Highest Cascade score first; a hit with no score (None) sorts last — the same "no score sorts
    last" rule the app's own card list uses. Stable otherwise, so ties keep hit order."""
    return sorted(hits, key=lambda h: (_score_of(scores, h.transition.movie_id) is None,
                                        -(_score_of(scores, h.transition.movie_id) or 0)))


def digest_subject(hits, replies=None, scores=None, today=None) -> str:
    """CAS-887: a reply is worth opening the email for on its own, so it leads the subject when
    there are any — built only from the real counts (honesty guardrail), never an invented "someone
    replied!" urgency line. CAS-1196: otherwise the subject names the top film (highest Cascade
    score) and its event, e.g. "Other Mommy opens Thursday — and 2 more"."""
    replies = replies or []
    n = len(hits)
    if replies:
        r_word = "reply" if len(replies) == 1 else "replies"
        subject = f"{len(replies)} {r_word} to your invites"
        if n:
            subject += f", {n} update{'' if n == 1 else 's'}"
        return subject
    if not n:
        return "Cascade found 0 updates for you"
    top = _ordered_by_score(hits, scores)[0]
    phrase = _subject_event_phrase(top.transition, top.transition.movie or {}, today or _dt.date.today())
    subject = f"{top.transition.title} {phrase}"
    if n > 1:
        subject += f" — and {n - 1} more"
    return subject


# ---- "when will you watch it?" buttons (CAS-1196 item 3) --------------------------------------------
# (value, label, Service-tracking window key to gate on — None means always offered).
_BUTTON_DEFS = {
    "pre_release": ("WHEN WILL YOU WATCH IT?", [
        ("cinema", "At the cinema", "in_cinema"),
        ("rent", "When it's to rent", "rent"),
        ("stream", "When it's streaming", "stream"),
        ("never", "Not interested", None),
    ]),
    "home_pay": (None, [
        ("rent", "Rent it — add to my list", "rent"),
        ("stream", "Wait for streaming", "stream"),
        ("never", "Not interested", None),
    ]),
    "streaming": (None, [
        ("stream", "Add to my list", "stream"),
        ("seen", "Seen it", None),
        ("never", "Not interested", None),
    ]),
}
_BUCKET_FOR_WINDOW = {
    "upcoming": "pre_release", "opening_week": "pre_release", "in_cinema": "pre_release",
    "pvod": "home_pay", "rental": "home_pay",
    "included_streaming": "streaming",
}
# A window absent from the account's watch_windows object reads as its own on-device default
# (watchPrefsDefaults() in app_template.html) — in_cinema/rent/stream all start ON; only an
# explicit {"list": false} turns one off.
_WATCH_WINDOW_DEFAULT_ON = {"in_cinema": True, "rent": True, "stream": True}


def _window_tracked(watch_windows, key) -> bool:
    if key is None:
        return True
    entry = (watch_windows or {}).get(key)
    if entry is None:
        return _WATCH_WINDOW_DEFAULT_ON.get(key, True)
    return bool(entry.get("list"))


def _buttons_for(movie, movie_id, site_url, watch_windows):
    """(heading-or-None, [{"value","label","href","primary"}, ...]) for one film, filtered to the
    windows switched on in the account's Service tracking (CAS-1196 item 3) — "never"/"seen" are
    never gated. `primary` marks the bucket's own first-defined button (the filled blue one),
    regardless of which buttons survive the filter."""
    bucket_key = _BUCKET_FOR_WINDOW.get(_primary_status(movie), "pre_release")
    heading, defs = _BUTTON_DEFS[bucket_key]
    buttons = []
    for i, (value, label, gate) in enumerate(defs):
        if not _window_tracked(watch_windows, gate):
            continue
        buttons.append({"value": value, "label": label, "primary": i == 0,
                         "href": f"{site_url}?answer={value}#/film/{movie_id}"})
    return heading, buttons


# ---- HTML building blocks --------------------------------------------------------------------------

def _poster_html(movie, esc, title) -> str:
    poster = movie.get("poster")
    if poster:
        src = f"https://image.tmdb.org/t/p/w185{poster}"
        return (f'<img src="{esc(src)}" width="92" height="138" alt="{esc(title)}" '
                'style="display:block;width:92px;height:138px;border-radius:10px;object-fit:cover;'
                'background:#e6e8ee;">')
    return ('<div style="width:92px;height:138px;border-radius:10px;background:#e6e8ee;">'
            '</div>')


def _meta_line(movie) -> str:
    parts = []
    genres = [g for g in (movie.get("genres") or []) if g]
    if genres:
        parts.append(", ".join(genres))
    if movie.get("age_rating"):
        parts.append(movie["age_rating"])
    ur = movie.get("wm_user_rating")
    if isinstance(ur, (int, float)) and ur > 0:
        parts.append(f"People {ur:.1f}")
    cs = movie.get("wm_critic_score")
    if isinstance(cs, (int, float)) and cs > 0:
        parts.append(f"Critics {int(cs)}")
    return " · ".join(parts)


def _score_chip_html(score, esc) -> str:
    if score is None:
        return ""
    if score >= 85:
        fg, bg = "#1A9C5C", "#E6F9EE"
    elif score >= 70:
        fg, bg = "#3B4FE0", "#E8ECFF"
    else:
        fg, bg = "#6b7280", "#F4F5F8"
    return (f'<span style="display:inline-block;font-weight:800;font-size:13px;padding:2px 9px;'
            f'border-radius:8px;border:1px solid {fg};color:{fg};background:{bg};">{score}</span>')


def _button_html(btn, esc) -> str:
    if btn["primary"]:
        style = ("background:#3B5BFF;color:#ffffff;")
    elif btn["value"] == "never":
        style = ("background:#FBEAEA;color:#B23B3B;")
    else:
        style = ("background:#EEF0F5;color:#141A2A;")
    style = ("display:inline-block;font-weight:700;font-size:13px;padding:10px 16px;"
             "border-radius:10px;text-decoration:none;margin:0 8px 8px 0;") + style
    return f'<a href="{esc(btn["href"])}" style="{style}">{esc(btn["label"])}</a>'


def _card_html(hit, esc, site_url, score, watch_windows, today) -> str:
    t = hit.transition
    m = t.movie or {}
    pill_text, color_key = _event_pill(t, m, today)
    fg, bg = _EVENT_COLORS[color_key]
    year = m.get("year")
    year_html = (f' <span style="font-weight:400;color:#8b95a5;font-size:14px;">{esc(year)}</span>'
                 if year and year != "----" else "")
    meta = _meta_line(m)
    heading, buttons = _buttons_for(m, t.movie_id, site_url, watch_windows)
    film_url = f"{site_url}#/film/{t.movie_id}"

    buttons_html = ""
    if heading:
        buttons_html += ('<div style="font-size:12px;font-weight:800;letter-spacing:0.4px;'
                          f'text-transform:uppercase;color:#8b95a5;margin-top:14px;">{esc(heading)}</div>')
    buttons_html += '<div style="margin-top:8px;">' + "".join(_button_html(b, esc) for b in buttons) + '</div>'

    score_html = _score_chip_html(score, esc)

    return (
        '<tr><td style="padding:18px 0;border-bottom:1px solid #e6e8ee;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
        f'<td width="92" valign="top">{_poster_html(m, esc, t.title)}</td>'
        '<td valign="top" style="padding-left:14px;">'
        f'<span style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:0.4px;'
        f'text-transform:uppercase;padding:3px 10px;border-radius:20px;background:{bg};color:{fg};">'
        f'{esc(pill_text)}</span>'
        f'<div style="font-size:17px;font-weight:700;color:#141A2A;margin-top:8px;">{esc(t.title)}{year_html}</div>'
        + (f'<div style="font-size:13px;color:#4b5563;margin-top:2px;">{esc(meta)}</div>' if meta else "")
        + (f'<div style="margin-top:6px;">{score_html}</div>' if score_html else "")
        + f'<div style="font-size:13px;color:#6b7280;margin-top:4px;">{esc(_context_line(hit, today))}</div>'
        + buttons_html
        + f'<div style="margin-top:10px;"><a href="{esc(film_url)}" style="font-size:13px;color:#6b48f2;'
        'font-weight:700;text-decoration:none;">View in Cascade ›</a></div>'
        '</td></tr></table></td></tr>'
    )


def _card_text(hit, score, today, site_url) -> list:
    t = hit.transition
    m = t.movie or {}
    year = m.get("year")
    year_s = f" ({year})" if year and year != "----" else ""
    pill_text, _ = _event_pill(t, m, today)
    return [
        f"{t.title}{year_s} — {pill_text}",
        f"  {_context_line(hit, today)}",
        f"  {site_url}#/film/{t.movie_id}",
        "",
    ]


# ---- invite replies (CAS-887) — unchanged by the CAS-1196 redesign ----------------------------------

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
    here so render_digest itself stays a pure formatter, the same division of labour the score
    lookup (compute_scores, monitor.matching) and the button rules above have."""
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


# ---- the digest itself --------------------------------------------------------------------------

def render_digest(hits, site_url: str = None, replies=None, scores=None, watch_windows=None,
                  today=None) -> dict:
    """Return {'subject', 'html', 'text'} for one user's consolidated digest (CAS-1196: one card
    per film, no status/agent section headings — see the per-film helpers above).

    hits          : list of monitor.matching.Hit (all for the same user).
    scores        : {movie_id str: int|None} — monitor.matching.compute_scores()'s answer; a film
                    absent here, or mapped to None, shows no score chip (honesty guardrail).
    watch_windows : the account's own Service tracking object (user_prefs.watch_windows) — gates
                    which "when will you watch it?" buttons are offered (item 3). None reads as the
                    on-device "never touched this" default (every window on).
    today         : the date "in N days"/subject phrasing is relative to; defaults to today (UTC).
    """
    site_url = site_url or os.environ.get(SITE_URL_ENV) or DEFAULT_SITE_URL
    replies = list(replies or [])
    scores = scores or {}
    today = today or _dt.datetime.now(_dt.timezone.utc).date()
    ordered = _ordered_by_score(hits, scores)
    subject = digest_subject(ordered, replies, scores=scores, today=today)
    shown = ordered[:MAX_CARDS]
    overflow = len(ordered) - len(shown)
    esc = _html.escape

    # ---- plain-text part ----
    text_lines = []
    if replies:
        text_lines.extend(_replies_block_text(replies))
    if shown:
        text_lines.append(f"{len(ordered)} film{'' if len(ordered) == 1 else 's'} for you today")
        text_lines.append("")
        for h in shown:
            text_lines.extend(_card_text(h, _score_of(scores, h.transition.movie_id), today, site_url))
        if overflow > 0:
            text_lines.append(f"...and {overflow} more in Cascade: {site_url}")
            text_lines.append("")
    text_lines += [
        f"Change what I'm told: {site_url}",
        "Cascade only writes when one of your agents has something worth your time.",
    ]
    text = "\n".join(text_lines)

    # ---- HTML part (inline styles; email-client safe — no <style>, no class=, no display:flex/grid) ----
    body_rows = ""
    if replies:
        body_rows += _replies_block_html(replies, esc)
    if shown:
        header_text = "1 film for you today" if len(ordered) == 1 else f"{len(ordered)} films for you today"
        body_rows += (
            '<tr><td style="padding-bottom:4px;">'
            f'<div style="font-size:20px;font-weight:800;color:#141A2A;">{esc(header_text)}</div>'
            f'<div style="font-size:13px;color:#6b7280;margin-top:2px;">'
            f'{esc(_weekday_date(today.isoformat()))} · picked by your agents</div>'
            '</td></tr>'
            '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
            + "".join(_card_html(h, esc, site_url, _score_of(scores, h.transition.movie_id),
                                 watch_windows, today) for h in shown)
            + '</table></td></tr>'
        )
        if overflow > 0:
            body_rows += (
                '<tr><td style="padding-top:12px;">'
                f'<a href="{esc(site_url)}" style="font-size:14px;color:#6b48f2;font-weight:700;'
                f'text-decoration:none;">and {overflow} more in Cascade</a></td></tr>'
            )
    html_doc = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        '<body style="margin:0;background:#f4f5f8;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="background:#f4f5f8;padding:24px 0;">'
        '<tr><td align="center">'
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" '
        'style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;padding:24px;">'
        '<tr><td style="padding-bottom:10px;">'
        '<div style="font-size:18px;font-weight:700;letter-spacing:1px;color:#7C5CFF;'
        'text-transform:uppercase;">Cascade</div>'
        '</td></tr>'
        + body_rows +
        '<tr><td style="padding-top:20px;font-size:12px;color:#8b95a5;">'
        'Cascade only writes when one of your agents has something worth your time. '
        f'<a href="{esc(site_url)}" style="color:#6b48f2;font-weight:700;text-decoration:none;">'
        'Change what I&rsquo;m told</a>'
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
