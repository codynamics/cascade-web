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
import re
import urllib.error
import urllib.request

# Same monotonic tier order poc_pipeline itself uses to decide a film's `status` — reused here to
# find a film's current window (for grouping, pill colour and button choice), never to re-derive it.
from poc_pipeline import AVAILABILITY_TIERS, tier_rank

from .answer_links import WATCHED, WATCH_ON, answer_url
from .batches import batch_url, headline_for

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

# CAS-1523: staging must never email real customers. When CASCADE_ENV=staging only +tagged
# Lee addresses may be mailed; every other send is skipped and logged.
CASCADE_ENV_ENV = "CASCADE_ENV"
STAGING_ALLOWED_RECIPIENT = re.compile(r"^lee\+.*@codynamics\.com\.au$", re.IGNORECASE)


def is_staging() -> bool:
    return (os.environ.get(CASCADE_ENV_ENV) or "").strip().lower() == "staging"


def staging_blocks_recipient(to_addr) -> bool:
    """True when this run is staging and `to_addr` is not an allowed Lee test address."""
    return is_staging() and not STAGING_ALLOWED_RECIPIENT.match(str(to_addr or "").strip())


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
    if m == "catchup":   # CAS-1535: the day +1 catch-up; the stage says which window the film is in
        if transition.stage == "streaming":
            return ((f"NOW STREAMING · {svc}" if svc else "NOW STREAMING"), "green")
        if transition.stage == "coming":
            date = _weekday_date(movie.get("cinema_date"))
            return ((f"COMING {date}" if date else "COMING TO CINEMAS"), "violet")
        return ("IN CINEMAS NOW", "violet")
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
    if m == "catchup":
        return "from your Me list"
    return ""


def _context_line(hit, today) -> str:
    phrase = _event_context(hit.transition, hit.transition.movie or {}, today)
    who = f"Agent: {hit.cascade_name}" if hit.cascade_id else "Your pick"
    return f"{who} · {phrase}" if phrase else who


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
    "catchup": "is on your Me list",
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


# ---- Watch On / Watched buttons (CAS-1196 item 3; CAS-1537: the app's own buttons, one shared definition) ----
# Keys, labels and order come from supabase/functions/_shared/answer_keys.json (answer_links.WATCH_ON /
# WATCHED) - the same file the alert-answer edge function reads - and equal the app's WATCH_LEVEL_SHORT_LABEL +
# Never and WATCH_STEPS (a test compares them against app_template.html). Nothing is hand-copied here.
_WATCH_ON_HEADING = "WATCH ON"
_WATCHED_HEADING = "WATCHED"
# Where a film sits on the app's ladder (STATUS_RUNG in app_template.html); a Watch On window whose rung is
# strictly behind it is spent - greyed and not tappable, exactly as the app greys it.
_FILM_RUNG = {"upcoming": 0, "opening_week": 1, "in_cinema": 1, "pvod": 2, "rental": 3, "included_streaming": 4}
# A window absent from the account's watch_windows object reads as its own on-device default
# (watchPrefsDefaults() in app_template.html) - in_cinema/rent/stream start ON, premium starts OFF; only an
# explicit {"list": true/false} overrides.
_WATCH_WINDOW_DEFAULT_ON = {"in_cinema": True, "premium": False, "rent": True, "stream": True}


def _window_tracked(watch_windows, key) -> bool:
    if key is None:
        return True
    entry = (watch_windows or {}).get(key)
    if entry is None:
        return _WATCH_WINDOW_DEFAULT_ON.get(key, True)
    return bool(entry.get("list"))


def track_url(url: str, cmp: str, cta: str) -> str:
    """CAS-1513: tag an email link with its click-through attribution — src=email, cmp=<email kind>,
    cta=<button key> — added to the query string ahead of any #fragment. The app logs email_click from
    these on arrival and strips them. No open-tracking pixel: attribution only ever rides a link."""
    base, hash_sep, frag = url.partition("#")
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}src=email&cmp={cmp}&cta={cta}{hash_sep}{frag}"


def _answer_href(key, movie_id, site_url, batch_id, kind, answers):
    """The link behind one button: a signed single-purpose answer link when this email can sign one (the
    secret is set and the film's ledger row is known), else the film in Cascade where the same buttons live."""
    token = answers.token_for(movie_id, key) if answers else None
    if token:
        return track_url(answer_url(site_url, token), kind, f"answer_{key}")
    return _film_link(site_url, batch_id, movie_id, kind, cta=f"answer_{key}")


def _buttons_for(movie, movie_id, site_url, watch_windows, kind="daily_alert", batch_id=None, answers=None):
    """[{"key","label","href","spent"}, ...] for the WATCH ON column of one film: the app's Cinema, Premium,
    Rent, Stream (only the windows switched on in Service tracking) then Never. A window the film has
    already passed is `spent` - greyed, no href."""
    rung = _FILM_RUNG.get(_primary_status(movie), -1)
    buttons = []
    for d in WATCH_ON:
        key = d["key"]
        if not _window_tracked(watch_windows, key if key != "never" else None):
            continue
        spent = d["rung"] is not None and d["rung"] < rung
        buttons.append({"key": key, "label": d["label"], "spent": spent,
                        "href": None if spent else _answer_href(key, movie_id, site_url, batch_id, kind, answers)})
    return buttons


def _watched_buttons_for(movie_id, site_url, kind="daily_alert", batch_id=None, answers=None):
    return [{"key": d["key"], "label": d["label"], "color": d["color"], "spent": False,
             "href": _answer_href(d["key"], movie_id, site_url, batch_id, kind, answers)}
            for d in WATCHED]


# ---- HTML building blocks --------------------------------------------------------------------------

def _poster_html(movie, esc, title, w: int = 92, h: int = 138) -> str:
    poster = movie.get("poster")
    if poster:
        src = f"https://image.tmdb.org/t/p/w185{poster}"
        return (f'<img src="{esc(src)}" width="{w}" height="{h}" alt="{esc(title)}" '
                f'style="display:block;width:{w}px;height:{h}px;border-radius:10px;object-fit:cover;'
                'background:#e6e8ee;">')
    return (f'<div style="width:{w}px;height:{h}px;border-radius:10px;background:#e6e8ee;">'
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
    if btn.get("spent"):
        style = "background:#F4F5F8;color:#B4BAC6;"
    elif btn.get("color"):
        style = f"background:#F4F5F8;color:{btn['color']};"
    elif btn["key"] == "never":
        style = "background:#FBEAEA;color:#B23B3B;"
    else:
        style = "background:#EEF0F5;color:#141A2A;"
    style = ("display:block;font-weight:700;font-size:13px;line-height:16px;padding:9px 6px;"
             "border-radius:9px;text-decoration:none;text-align:center;margin:0 0 6px 0;") + style
    if btn.get("spent"):    # already reached: shown, never linked (the app's .spent segment)
        return f'<span title="Already reached" style="{style}">{esc(btn["label"])}</span>'
    return f'<a href="{esc(btn["href"])}" style="{style}">{esc(btn["label"])}</a>'


def _column_html(heading, buttons, esc) -> str:
    return ('<div style="font-size:11px;font-weight:800;letter-spacing:0.5px;text-transform:uppercase;'
            f'color:#8b95a5;margin-bottom:7px;">{esc(heading)}</div>'
            + "".join(_button_html(b, esc) for b in buttons))


def _film_link(site_url, batch_id, movie_id, kind, cta="view_film") -> str:
    """CAS-1535: a film link opens the film inside the night's batch view in Alerts when there is a batch
    (`?dl=alerts:batch:<id>&film=<movie_id>`), else the film page as before."""
    if batch_id:
        return track_url(batch_url(site_url, batch_id, movie_id), kind, cta)
    return track_url(f"{site_url}#/film/{movie_id}", kind, cta)


def _see_all_link(site_url, batch_id, kind, cta="more_in_cascade") -> str:
    return track_url(batch_url(site_url, batch_id), kind, cta) if batch_id else track_url(site_url, kind, cta)


def _answer_columns_html(movie, movie_id, esc, site_url, watch_windows, kind, batch_id, answers) -> str:
    """CAS-1537: the WATCH ON and WATCHED columns every film card in every alert email carries."""
    on = _buttons_for(movie, movie_id, site_url, watch_windows, kind, batch_id, answers)
    watched = _watched_buttons_for(movie_id, site_url, kind, batch_id, answers)
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr>'
        f'<td width="50%" valign="top" style="padding-right:6px;">{_column_html(_WATCH_ON_HEADING, on, esc)}</td>'
        f'<td width="50%" valign="top" style="padding-left:6px;">{_column_html(_WATCHED_HEADING, watched, esc)}</td>'
        '</tr></table>'
    )


def _card_html(hit, esc, site_url, score, watch_windows, today, kind="daily_alert", batch_id=None,
               answers=None) -> str:
    t = hit.transition
    m = t.movie or {}
    pill_text, color_key = _event_pill(t, m, today)
    fg, bg = _EVENT_COLORS[color_key]
    year = m.get("year")
    year_html = (f' <span style="font-weight:400;color:#8b95a5;font-size:14px;">{esc(year)}</span>'
                 if year and year != "----" else "")
    meta = _meta_line(m)
    film_url = _film_link(site_url, batch_id, t.movie_id, kind)
    buttons_html = _answer_columns_html(m, t.movie_id, esc, site_url, watch_windows, kind, batch_id, answers)

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
        + f'<div style="margin-top:10px;"><a href="{esc(film_url)}" style="font-size:13px;color:#6b48f2;'
        'font-weight:700;text-decoration:none;">View in Cascade ›</a></div>'
        '</td></tr></table>'
        + buttons_html
        + '</td></tr>'
    )


def _card_text(hit, score, today, site_url, kind="daily_alert", batch_id=None) -> list:
    t = hit.transition
    m = t.movie or {}
    year = m.get("year")
    year_s = f" ({year})" if year and year != "----" else ""
    pill_text, _ = _event_pill(t, m, today)
    return [
        f"{t.title}{year_s} — {pill_text}",
        f"  {_context_line(hit, today)}",
        f"  {_film_link(site_url, batch_id, t.movie_id, kind)}",
        "",
    ]


# ---- the day +1 catch-up layout (CAS-1535) ---------------------------------------------------------------

def _compact_date(hit) -> str:
    """The real date the compact card shows: the cinema date for a cinema/coming film, the date the film
    reached streaming for a streaming one. "" when the catalogue carries none - never a placeholder."""
    t = hit.transition
    m = t.movie or {}
    if t.moment == "catchup":
        window = {"cinema": "in_cinema", "coming": "upcoming", "streaming": "included_streaming"}.get(t.stage)
    else:
        window = _primary_status(m)
    return _weekday_date(_window_date(m, window)) if window else ""


def _compact_card_html(hit, esc, site_url, score, kind, batch_id, watch_windows=None, answers=None) -> str:
    t = hit.transition
    m = t.movie or {}
    date = _compact_date(hit)
    score_html = _score_chip_html(score, esc)
    return (
        '<tr><td style="padding:12px 0;border-bottom:1px solid #e6e8ee;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
        f'<td width="60" valign="top">{_poster_html(m, esc, t.title, 60, 90)}</td>'
        '<td valign="top" style="padding-left:12px;">'
        f'<div style="font-size:16px;font-weight:700;color:#141A2A;">{esc(t.title)}</div>'
        + (f'<div style="font-size:13px;color:#4b5563;margin-top:2px;">{esc(date)}</div>' if date else "")
        + (f'<div style="margin-top:6px;">{score_html}</div>' if score_html else "")
        + f'<div style="margin-top:8px;"><a href="{esc(_film_link(site_url, batch_id, t.movie_id, kind))}" '
        'style="font-size:13px;color:#6b48f2;font-weight:700;text-decoration:none;">View in Cascade ›</a></div>'
        '</td></tr></table>'
        + _answer_columns_html(m, t.movie_id, esc, site_url, watch_windows, kind, batch_id, answers)
        + '</td></tr>'
    )


def _compact_groups(ordered_hits):
    """[(heading, [hits])] - the three catch-up groups in their fixed order (a group with no films is
    left out), then every other unread alert in the batch as one more group."""
    from .catchup import STAGES   # local: catchup imports matching, which does not import this module
    groups = []
    for stage, heading in STAGES:
        hs = [h for h in ordered_hits if h.transition.moment == "catchup" and h.transition.stage == stage]
        if hs:
            groups.append((heading, hs))
    rest = [h for h in ordered_hits if h.transition.moment != "catchup"]
    if rest:
        groups.append(("Also found for you", rest))
    return groups


def _render_catchup(hits, site_url, replies, scores, kind, batch_id, esc, watch_windows=None, answers=None) -> dict:
    """The catch-up email: compact cards under the three group headings, "See all in Cascade" at the top
    and the bottom. Each group keeps the Me list's own order (the hits arrive in it); the non-catch-up
    group is ordered by score like any digest."""
    cu = [h for h in hits if h.transition.moment == "catchup"]
    other = _ordered_by_score([h for h in hits if h.transition.moment != "catchup"], scores)
    ordered = cu + other
    n = len({h.transition.movie_id for h in ordered})
    agent = cu[0].cascade_name or "Cascade"
    subject = headline_for(agent, n)
    see_all = _see_all_link(site_url, batch_id, kind, "see_all")
    groups = _compact_groups(ordered)

    text_lines = []
    if replies:
        text_lines.extend(_replies_block_text(replies))
    text_lines += [subject, f"See all in Cascade: {see_all}", ""]
    for heading, hs in groups:
        text_lines.append(heading.upper())
        for h in hs:
            t = h.transition
            date = _compact_date(h)
            score = _score_of(scores, t.movie_id)
            bits = [b for b in (date, f"Cascade score {score}" if score is not None else "") if b]
            text_lines.append(f"- {t.title}" + (f" - {' - '.join(bits)}" if bits else ""))
            text_lines.append(f"  {_film_link(site_url, batch_id, t.movie_id, kind)}")
        text_lines.append("")
    text_lines += [f"See all in Cascade: {see_all}",
                   f"Change what I'm told: {track_url(site_url, kind, 'change_alerts')}"]

    link_style = "font-size:14px;color:#6b48f2;font-weight:700;text-decoration:none;"
    see_all_html = f'<a href="{esc(see_all)}" style="{link_style}">See all in Cascade ›</a>'
    body_rows = _replies_block_html(replies, esc) if replies else ""
    body_rows += (
        '<tr><td style="padding-bottom:4px;">'
        f'<div style="font-size:20px;font-weight:800;color:#141A2A;">{esc(subject)}</div>'
        f'<div style="margin-top:6px;">{see_all_html}</div></td></tr>')
    for heading, hs in groups:
        body_rows += (
            '<tr><td style="padding-top:16px;">'
            '<div style="font-size:12px;font-weight:800;letter-spacing:0.5px;text-transform:uppercase;'
            f'color:#7C5CFF;">{esc(heading)}</div>'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
            + "".join(_compact_card_html(h, esc, site_url, _score_of(scores, h.transition.movie_id), kind, batch_id,
                                                 watch_windows, answers)
                      for h in hs)
            + '</table></td></tr>')
    body_rows += f'<tr><td style="padding-top:14px;">{see_all_html}</td></tr>'
    return {"subject": subject, "html": _wrap_html(body_rows, site_url, kind, esc),
            "text": "\n".join(text_lines)}


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

def _wrap_html(body_rows, site_url, kind, esc) -> str:
    """The email shell (logo row, footer) shared by the ordinary digest and the catch-up layout."""
    return (
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
        f'<a href="{esc(track_url(site_url, kind, "change_alerts"))}" style="color:#6b48f2;font-weight:700;text-decoration:none;">'
        'Change what I&rsquo;m told</a>'
        '</td></tr>'
        '</table></td></tr></table></body></html>'
    )


def render_digest(hits, site_url: str = None, replies=None, scores=None, watch_windows=None,
                  today=None, kind: str = "daily_alert", batch_id=None, answers=None) -> dict:
    """Return {'subject', 'html', 'text'} for one user's consolidated digest (CAS-1196: one card
    per film, no status/agent section headings — see the per-film helpers above).

    hits          : list of monitor.matching.Hit (all for the same user).
    scores        : {movie_id str: int|None} — monitor.matching.compute_scores()'s answer; a film
                    absent here, or mapped to None, shows no score chip (honesty guardrail).
    watch_windows : the account's own Service tracking object (user_prefs.watch_windows) — gates
                    which "when will you watch it?" buttons are offered (item 3). None reads as the
                    on-device "never touched this" default (every window on).
    kind          : the email kind for click-through attribution (CAS-1513): "daily_alert", or
                    "unseen_alert" for the 5pm unseen-alerts email.
    answers       : CAS-1537 - an answer_links.AnswerContext (secret, member, {film: ledger row id}). With it
                    every button is a signed one-tap link to the confirmation page; without it (no secret
                    set, or no ledger row for the film) a button opens the film in Cascade instead.
    today         : the date "in N days"/subject phrasing is relative to; defaults to today (UTC).
    batch_id      : CAS-1535 - the night's alert batch (monitor.batches). When given, every film link and
                    the "See all in Cascade" link open that batch's own view in Alerts
                    (`?dl=alerts:batch:<id>[&film=<movie_id>]`) instead of the film page / home screen;
                    the Watch On / Watched buttons are signed answer links (see `answers`). A digest holding any `catchup` hit renders the
                    compact catch-up layout instead (_render_catchup).
    """
    site_url = site_url or os.environ.get(SITE_URL_ENV) or DEFAULT_SITE_URL
    replies = list(replies or [])
    scores = scores or {}
    today = today or _dt.datetime.now(_dt.timezone.utc).date()
    if any(h.transition.moment == "catchup" for h in hits):
        return _render_catchup(hits, site_url, replies, scores, kind, batch_id, _html.escape, watch_windows, answers)
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
            text_lines.extend(_card_text(h, _score_of(scores, h.transition.movie_id), today, site_url, kind,
                                         batch_id))
        if overflow > 0:
            text_lines.append(f"...and {overflow} more in Cascade: {_see_all_link(site_url, batch_id, kind)}")
            text_lines.append("")
        if batch_id:
            text_lines.append(f"See all in Cascade: {_see_all_link(site_url, batch_id, kind, 'see_all')}")
            text_lines.append("")
    text_lines += [
        f"Change what I'm told: {track_url(site_url, kind, 'change_alerts')}",
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
                                 watch_windows, today, kind, batch_id, answers) for h in shown)
            + '</table></td></tr>'
        )
        if overflow > 0:
            body_rows += (
                '<tr><td style="padding-top:12px;">'
                f'<a href="{esc(_see_all_link(site_url, batch_id, kind))}" style="font-size:14px;color:#6b48f2;font-weight:700;'
                f'text-decoration:none;">and {overflow} more in Cascade</a></td></tr>'
            )
        if batch_id:
            body_rows += (
                '<tr><td style="padding-top:12px;">'
                f'<a href="{esc(_see_all_link(site_url, batch_id, kind, "see_all"))}" style="font-size:14px;color:#6b48f2;'
                'font-weight:700;text-decoration:none;">See all in Cascade ›</a></td></tr>'
            )
    return {"subject": subject, "html": _wrap_html(body_rows, site_url, kind, esc), "text": text}


def send_via_resend(to_addr, subject, html, text, api_key=None, from_addr=None, timeout=30) -> dict:
    """POST one email to Resend. Reads RESEND_API_KEY / CASCADE_EMAIL_FROM from env when not
    passed. Raises if there's no API key (callers gate this behind --dry-run).
    CAS-1523: under CASCADE_ENV=staging, a recipient other than lee+*@codynamics.com.au is skipped
    (logged, returns {"skipped": ...}) before anything else — staging never emails customers."""
    if staging_blocks_recipient(to_addr):
        print("[monitor] staging: email skipped — recipient is not a lee+*@codynamics.com.au test address.")
        return {"skipped": "staging-recipient-not-allowed"}
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
