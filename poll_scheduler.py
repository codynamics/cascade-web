#!/usr/bin/env python3
"""
CAS-109 — poll tiering + free-tier-capped daily scheduler + status estimator.

Pure functions over catalogue records + accrued window_dates. NO API keys needed
(these decide WHAT to poll and estimate the rest; the actual Watchmode call stays
in poc_pipeline.poll_watchmode).

Tiers:
  none   : upcoming / cinema date still ahead        -> never polled
  active : window in {in_cinema,pvod,rental} OR AU cinema release <= 6 months
           (even if already on streaming)            -> polled DAILY (capped)
  slow   : settled on streaming AND > 6 months       -> 4-week round-robin sweep
"""
import datetime, statistics

ACTIVE_WINDOW = {"in_cinema", "pvod", "rental"}
SIX_MONTHS = 180

# --- default poll-set shape --------------------------------------------------
# CAS-987: no longer fixed free-tier caps — poc_pipeline.run() scales these three with the real
# Watchmode plan's billing-cycle allowance (compute_wm_today_allowance) and passes the scaled
# values into select_daily_poll_set. The numbers below are the DEFAULT shape (and the ratio the
# scaling itself is measured against) for a caller that doesn't override them — this module still
# decides WHICH titles are worth polling; the allocator decides how many are affordable today.
DAILY_BUDGET   = 80      # ~2500/31, integer daily ceiling
ONDEMAND_RESERVE = 15    # calls/day held for user-triggered confirms
ACTIVE_CAP     = 65      # max daily-active titles (<= free ceiling ~68; keeps headroom)
SWEEP_DAYS     = 28      # 4-week slow sweep

# estimate model fallback: median days from cinema to each downstream window
DEFAULT_OFFSETS = {"pvod": 75, "rental": 120, "included_streaming": 210}
# CAS-237: the shortest a window has ever plausibly run in AU. A learned median below its floor is not a
# fact about release windows — it is an artefact of how long Cascade has been watching, because a median
# cannot come out longer than the observation log is old.
OFFSET_FLOORS = {"pvod": 21, "rental": 45, "included_streaming": 75}
# CAS-289: there is no cinema-END date in any data source, so "in cinemas" is always a guess made from the
# opening date alone. OFFSET_FLOORS keeps that guess from learning something implausibly short, but it can
# still hold a film in the estimated in_cinema window for 21+ days, which is longer than "likely still in
# cinemas" should ever claim without a real offer to back it up. This is a second, independent ceiling on
# the SAME window, not a replacement for the floor above.
# CAS-476: the original 14-day cap was too short for a real wide release — Toy Story 5 and The Odyssey were
# both still genuinely in cinemas past it (55 and 27 days respectively) with zero offers to confirm against,
# and app_template.html's twin of this constant then filed them onto "pvod" anyway, which is unshowable
# without a real offer — so the film vanished rather than moving to a visible next window. Raised to match
# DEFAULT_OFFSETS["pvod"] (75 days), the same median cinema-to-pvod gap already trusted for this exact
# question elsewhere in this module, which comfortably covers both real titles and keeps this ceiling
# stricter than the eventual pvod/rental/streaming ladder it feeds into.
CINEMA_ESTIMATE_CAP_DAYS = 75


def _date(s):
    try: return datetime.date.fromisoformat(s) if s else None
    except Exception: return None

def cinema_date(m): return _date(m.get("cinema_date"))


def _release_year(m):
    y = m.get("year")
    try:
        return int(y)
    except (TypeError, ValueError):
        return None


def has_future_au_release(m, today):
    """True if any AU release_dates entry (any type — CAS-360 keeps them all) is still ahead of
    `today`, even with no cinema_date at all: a title can carry an announced digital/physical AU
    date with no theatrical one."""
    today_iso = today.isoformat()
    return any((rd.get("date") or "") > today_iso for rd in (m.get("release_dates") or []))


def classify_tier(m, today):
    """CAS-472: `st == {"upcoming"}` alone used to also mean "none", so a title that fell all the
    way back to upcoming (a real AU-delisting, offer-less catalogue drift, or the CAS-472 bug
    itself) stayed poll_tier "none" forever afterward — the branch that writes that status is
    the ONLY thing gated on this tier, so nothing ever polled it again to find out it had moved
    on. Only a cinema_date genuinely unknown-or-still-ahead may skip polling; once it is known
    and has passed, the title is always active/slow, never none, regardless of what `status`
    currently holds.

    CAS-1078: a cinema_date of None is not, on its own, evidence a title is still ahead of us —
    82 back-catalogue titles with a release year already behind us and no AU release_dates entry
    (any type) still in the future latched at "none"/upcoming forever, because nothing ever
    polled them again to learn they had no real AU availability either. Only genuinely open
    questions (no year yet, a year that hasn't arrived, or a still-future AU date of any kind)
    may skip polling now; a title whose own year is already behind us gets treated the same way
    a known-and-passed cinema_date already is — active/slow, never none."""
    st = set(m.get("status", []))
    c = cinema_date(m)
    if c and c > today:
        return "none"
    year = _release_year(m)
    still_open = year is None or year >= today.year or has_future_au_release(m, today)
    if c is None and st == {"upcoming"} and still_open:
        return "none"
    recent = bool(c and 0 <= (today - c).days <= SIX_MONTHS)
    if (st & ACTIVE_WINDOW) or recent:
        return "active"
    return "slow"


def select_daily_poll_set(movies, today, ondemand_ids=None,
                          active_cap=ACTIVE_CAP, daily_budget=DAILY_BUDGET,
                          reserve=ONDEMAND_RESERVE, sweep_days=SWEEP_DAYS):
    """Choose the titles to Watchmode-poll TODAY inside the free-tier cap.
    Priority: active (by popularity, capped) -> slow round-robin fills what's left.
    On-demand is served immediately and counts against the reserve."""
    ondemand_ids = set(ondemand_ids or [])
    active = [m for m in movies if classify_tier(m, today) == "active"]
    slow   = [m for m in movies if classify_tier(m, today) == "slow"]

    active.sort(key=lambda m: m.get("popularity") or 0, reverse=True)
    capped_active  = active[:active_cap]
    skipped_active = active[active_cap:]              # overflow -> demoted to sweep

    slow_pool = skipped_active + slow                 # sweep also mops up active overflow
    slow_pool.sort(key=lambda m: _date(m.get("last_polled")) or datetime.date.min)
    fair_share = -(-len(slow_pool) // sweep_days)      # ceil: keep the whole tail on rotation
    remaining  = max(0, daily_budget - reserve - len(capped_active))
    slow_today = slow_pool[:min(fair_share, remaining)]

    return {
        "active":   capped_active,
        "slow":     slow_today,
        "ondemand": [m for m in movies if m.get("tmdb_id") in ondemand_ids],
        "counts": {
            "active": len(capped_active), "active_total": len(active),
            "skipped_active": len(skipped_active),
            "slow_today": len(slow_today), "slow_pool": len(slow_pool),
            "daily_calls": len(capped_active) + len(slow_today),
            "est_monthly": round((len(capped_active) + len(slow_today)) * 30 + reserve * 30),
        },
    }


def _sane_offsets(offsets, defaults=DEFAULT_OFFSETS):
    """Any offset shorter than its floor is discarded for the default, and the journey is then forced to run
    forwards. Both halves matter: a window that opens before the one ahead of it makes estimate_status file
    films into whichever test happens to fire first, which is not a window so much as an accident."""
    out = {}
    for w in ("pvod", "rental", "included_streaming"):
        v = offsets.get(w) if isinstance(offsets, dict) else None
        out[w] = defaults[w] if not isinstance(v, (int, float)) or v < OFFSET_FLOORS[w] else int(v)
    out["rental"] = max(out["rental"], out["pvod"])
    out["included_streaming"] = max(out["included_streaming"], out["rental"])
    return out


def compute_median_offsets(window_dates, defaults=DEFAULT_OFFSETS, min_samples=5):
    """Median days from cinema to each downstream window, learned from accrued window_dates; fall back to
    defaults until enough REAL samples exist.

    "Real" is doing the work here, and CAS-237 is what happens without it. window_dates is an OBSERVATION
    log — it records when Cascade first SAW a film in each window, not when the film moved — so a title that
    was already streaming when polling began gets its cinema stamp and its streaming stamp on the same day
    and contributes a gap of zero. On 2026-07-30, eighteen days into the log, this function had learned
    {pvod: 75, rental: 0, included_streaming: 1}. estimate_status then filed every unpolled film that had
    opened at all straight onto streaming — 1,614 of 1,961 titles — and estimated not one film into a cinema,
    which is why a cinema agent's listing had nothing In Cinema to show.

    So a sample now has to come from a journey we actually FOLLOWED: the film must carry an `upcoming` stamp
    at or before its cinema stamp, which is the evidence that we were watching before it opened and the
    cinema stamp is the real thing rather than the day the film entered the log. That gate is self-clearing —
    it admits more titles every week Cascade runs — and until it admits min_samples of them, the defaults are
    the honest answer. The floors in _sane_offsets are the backstop: a learned median cannot be longer than
    the log is old, so early on any short answer is an artefact of the start date, not a fact about windows.
    """
    samples = {w: [] for w in ("pvod", "rental", "included_streaming")}
    for wd in window_dates.values():
        base = _date(wd.get("in_cinema") or wd.get("opening_week"))
        if not base:
            continue
        watched_before = _date(wd.get("upcoming"))
        if not watched_before or watched_before > base:
            continue
        for w in samples:
            d = _date(wd.get(w))
            if d and (d - base).days >= 0:
                samples[w].append((d - base).days)
    learned = {w: (int(statistics.median(xs)) if len(xs) >= min_samples else defaults[w])
               for w, xs in samples.items()}
    return _sane_offsets(learned, defaults)


def estimate_status(m, today, offsets=DEFAULT_OFFSETS):
    """Estimated current window for an UNPOLLED film from its cinema age.
    Returns (window, 'estimated'). Never fabricates price/services."""
    offsets = _sane_offsets(offsets)      # whatever the caller holds, the journey runs forwards from here
    c = cinema_date(m)
    if not c or c > today:
        return ("upcoming", "estimated")
    age = (today - c).days
    if   age >= offsets["included_streaming"]: w = "included_streaming"
    elif age >= offsets["rental"]:             w = "rental"
    elif age >= offsets["pvod"]:               w = "pvod"
    elif age >= CINEMA_ESTIMATE_CAP_DAYS:      w = "pvod"   # CAS-289: in_cinema is capped, not the ladder
    else:                                      w = "in_cinema"
    return (w, "estimated")
