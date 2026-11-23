"""Core diff logic: yesterday's catalogue + today's -> per-movie transitions.

Pure and side-effect free (no network, no disk writes) so it unit-tests cleanly and
the caller (the daily job) owns all I/O.

A *transition* is one movie crossing into one *moment*. The four moments mirror the
``alert_moments`` a Cascade stores (see supabase/schema.sql and the front-end
``CascadeShape`` mapping in app_template.html):

    hits_cinema           — the film's theatrical window opened (status gained "in_cinema")
    hits_pvod             — it reached premium home video: buy, or rent above the standard rental
                            ceiling (status gained "pvod"). Added by CAS-103 so the editor's
                            Purchase button drives a moment that can really fire — before that it
                            was a UI-only toggle wired to nothing.
    hits_rent             — it became available to rent (status gained "rental")
    hits_stream           — it landed on an included/free streaming service (status gained
                            "included_streaming")
    past_opening_weekend  — today is exactly ``opening_date + N`` days (N=4, tunable). This is
                            NOT a catalogue diff: it's computed from the film's REAL cinema
                            date, so it only ever fires on real dates (honesty guardrail; ref CAS-68).
    announced             — a title Cascade has never held before arrived, and it is UNRELEASED. Added by
                            CAS-242 for the cinema agent's Upcoming bell. It is the one moment a first
                            sighting legitimately IS the news: for every other moment a first sighting would
                            be reporting state that was simply already true, which is why they are guarded,
                            but "a film worth knowing about has turned up" is a change from the reader's
                            side too. What it is NOT is the studio's announcement date — nobody publishes
                            that — so the front end says "first reaches Cascade" and the email says the same.
    opens_soon            — the film's cinema_date is between 1 and N days ahead of today, inclusive
                            (N=7, tunable; CAS-926). Computed from the film's own published date, and
                            like past_opening_weekend it can only ever fire on a real date — but unlike
                            it, this is a WINDOW test, not an exact-day one: a film missed on one day
                            (a late daily run, a date that moved, admission arriving late) still fires
                            on a later day inside the window, and the notifications ledger's existing
                            de-dupe (see ``monitor.matching.match``) stops it firing more than once.
    newly_qualifies       — a film already held in BOTH catalogues whose own attributes changed so it now
                            matches an agent's criteria and did not yesterday (CAS-602): an IMDb rating
                            crossing the bar, a metacritic score/award/gross arriving, a genre/age
                            correction. NOT produced here — there is no catalogue transition to hang it
                            off, since the film was already held — it is agent-dependent and computed
                            during matching (see ``monitor.matching.match_newly_qualified``).
    new_to_agent          — the same "matches today, did not match yesterday" test as newly_qualifies,
                            but fired ONLY when the agent itself has been stable across the comparison
                            (CAS-785): its `updated_at` predates the start of the previous run. An agent
                            edited inside that window stays silent for this run (Lee's 2026-08-24 rule:
                            an edit must never fire the user's whole list) rather than deferring the
                            alert to later. NOT produced here for the same reason as newly_qualifies —
                            see ``monitor.matching.match_new_to_agent``.

Honesty guardrail: the three status moments only fire on a *genuine transition* — the film
must have been in yesterday's catalogue and NOT already in that window. A film's very first
sighting never fires an alert (you'd be "notified" about state that was simply already true).
"""
from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Optional

# Single source of truth for the rental price ceiling + subscription test. poc_pipeline
# already classified each film into its `status` set using these; we reuse the same number
# only to pick the SERVICE NAMES / PRICE to show for a moment, never to re-decide the window.
# tier_rank is the same monotonic-progress test poc_pipeline uses to guard m["status"]
# itself (CAS-355) — reused here so a moment only ever fires for FORWARD progress.
from poc_pipeline import RENTAL_MAX_PRICE, tier_rank

DEFAULT_WEEKEND_N = 4  # days after opening that "past opening weekend" fires (tunable)
DEFAULT_SOON_N    = 7  # days BEFORE opening that "opening next week" fires (tunable) — CAS-242

# moment -> the status-set member whose *arrival* triggers it. past_opening_weekend is absent
# here because it is date-computed, not status-derived.
_STATUS_MOMENTS = (
    ("hits_cinema", "in_cinema"),
    ("hits_pvod", "pvod"),
    ("hits_rent", "rental"),
    ("hits_stream", "included_streaming"),
)
MOMENTS = ("hits_cinema", "hits_pvod", "hits_rent", "hits_stream", "past_opening_weekend",
           "announced", "opens_soon", "newly_qualifies", "new_to_agent")


@dataclass
class Transition:
    """One movie entering one moment."""
    movie_id: str          # str(tmdb_id) — matches the text `movie_id` column in `notifications`
    title: str
    moment: str            # one of MOMENTS
    services: list = field(default_factory=list)  # service names relevant to this moment (streaming/rent)
    price: Optional[float] = None                  # cheapest relevant price for rent moments; else None
    movie: dict = field(default_factory=dict)      # the full today record, for downstream criteria matching
    stage: Optional[str] = None                    # CAS-1535: the catch-up group (cinema|coming|streaming)

    def summary(self) -> str:
        bits = self.moment
        if self.services:
            bits += " · " + ", ".join(self.services)
        if self.price is not None:
            bits += f" · ${self.price:.2f}"
        return f"{self.title} [{self.movie_id}] -> {bits}"

    def to_dict(self) -> dict:
        return {
            "movie_id": self.movie_id,
            "title": self.title,
            "moment": self.moment,
            "services": list(self.services),
            "price": self.price,
        }


def _movie_id(m: dict) -> str:
    return str(m.get("tmdb_id"))


def _parse_date(value) -> Optional[_dt.date]:
    """Parse an ISO date string; return None for anything not a real date (honesty guardrail —
    a computed 'past opening weekend' must never rest on a missing/garbage date)."""
    if not value:
        return None
    try:
        return _dt.date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def _offer_window(offer: dict) -> str:
    """Classify one offer into a window — mirrors poc_pipeline._window_of so the service/price
    we surface for a moment agree with how the film's status was derived."""
    t = offer.get("type")
    if t in ("sub", "free"):
        return "included_streaming"
    if t == "buy":
        return "pvod"
    if t == "rent":
        return "rental" if (offer.get("price") or 99) <= RENTAL_MAX_PRICE else "pvod"
    return ""


def _detail_for(moment: str, movie: dict):
    """(services, price) to show for a moment, read from the film's real offers."""
    offers = movie.get("offers", []) or []
    if moment == "hits_stream":
        svcs = [o.get("service") for o in offers if _offer_window(o) == "included_streaming"]
        return _dedupe(svcs), None
    if moment == "hits_rent":
        rents = [o for o in offers if _offer_window(o) == "rental"]
        svcs = [o.get("service") for o in rents]
        prices = [o.get("price") for o in rents if o.get("price") is not None]
        return _dedupe(svcs), (min(prices) if prices else None)
    if moment == "hits_pvod":
        # Premium covers both shapes of early home release — a buy, and a rent priced above the
        # standard rental ceiling — so read the price off whichever offers actually landed.
        prem = [o for o in offers if _offer_window(o) == "pvod"]
        svcs = [o.get("service") for o in prem]
        prices = [o.get("price") for o in prem if o.get("price") is not None]
        return _dedupe(svcs), (min(prices) if prices else None)
    # cinema moments carry no service/price
    return [], None


def _dedupe(seq) -> list:
    out = []
    for s in seq:
        if s and s not in out:
            out.append(s)
    return out


def compute_transitions(
    prev_movies: list,
    today_movies: list,
    today: _dt.date,
    weekend_n: int = DEFAULT_WEEKEND_N,
    soon_n: int = DEFAULT_SOON_N,
) -> list:
    """Return the list of Transition objects for today.

    prev_movies / today_movies : lists of movie records (poc_pipeline shape).
    today                       : the run date, used for the past-opening-weekend computation.
    weekend_n                   : days after opening that past_opening_weekend fires.
    soon_n                      : the outer edge (in days) of the opens_soon run-up window; it fires
                                  for cinema_date 1..soon_n days ahead of today, inclusive.
    """
    prev = {_movie_id(m): m for m in prev_movies}
    transitions: list = []

    for m in today_movies:
        mid = _movie_id(m)
        before = set(prev.get(mid, {}).get("status", []) or [])
        after = set(m.get("status", []) or [])
        seen_before = mid in prev

        # --- status-derived moments: a window the film has newly ENTERED ---
        # Guarded by seen_before so a film's first appearance never fires (it wasn't a change).
        # CAS-355: also guarded to FORWARD progress only — a moment's tier must rank higher than
        # anything the film already held. Without this, a title that lost a high tier and landed
        # on a lower one (e.g. included_streaming -> rental, from a transient AU provider gap)
        # read as "gained rental" and fired a false downgrade alert; a real backward move never
        # should generate one, confirmed regression or not.
        if seen_before:
            before_rank = tier_rank(before)
            for moment, status in _STATUS_MOMENTS:
                if status in after and status not in before and tier_rank([status]) > before_rank:
                    services, price = _detail_for(moment, m)
                    transitions.append(Transition(mid, m.get("title", ""), moment,
                                                  services=services, price=price, movie=m))

        # --- CAS-242: a title Cascade has never held before, and it is not out yet ---
        # The one moment where a first sighting IS the news rather than state that was already true. It is
        # deliberately restricted to UNRELEASED titles: a film that turns up already streaming is not an
        # announcement, it is a gap in yesterday's catalogue, and calling that "announced" would be a claim
        # about the world made out of a fact about our own polling.
        if not seen_before and "upcoming" in after:
            transitions.append(Transition(mid, m.get("title", ""), "announced",
                                          services=[], price=None, movie=m))

        # --- computed moments: exactly N days either side of a REAL opening date ---
        opened = _parse_date(m.get("cinema_date"))
        if opened is not None and today == opened + _dt.timedelta(days=weekend_n):
            transitions.append(Transition(mid, m.get("title", ""), "past_opening_weekend",
                                          services=[], price=None, movie=m))
        if opened is not None and 1 <= (opened - today).days <= soon_n:
            transitions.append(Transition(mid, m.get("title", ""), "opens_soon",
                                          services=[], price=None, movie=m))

    return transitions
