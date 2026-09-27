#!/usr/bin/env python3
"""
Cascade Movies — proof-of-concept backend pipeline
===================================================

Demonstrates the full daily loop for the release-window tracker:

    ingest (TMDB) -> availability (TMDB Watch Providers, AU) -> awards (OscarBase)
        -> derive status -> diff vs yesterday -> emit alerts

CAS-127: the PRIMARY availability source is TMDB Watch Providers (free, data by
JustWatch — no monthly quota), one call per title per day across the whole
catalogue. Watchmode is demoted to optional ON-DEMAND enrichment (exact rent/buy
prices + verified deep-links) for titles a user opens or saves — never the daily
sweep. This is what lets availability scale to a big catalogue (CAS-128).

CAS-938: OMDb (ratings/RT/Metacritic) is gone — its terms forbade commercial use
and were silent on redistribution rights. Ratings/critic score now come from
Watchmode, awards from OscarBase (CAS-919/CAS-937).

Run WITHOUT keys and it uses the bundled illustrative sample data so you can
see the whole flow end-to-end. Set the two env vars and it hits the live
APIs instead. Nothing else changes.

    export TMDB_API_KEY=...          # https://www.themoviedb.org/settings/api   (free)
    export WATCHMODE_API_KEY=...     # https://api.watchmode.com/requestApiKey    (free 2.5k/mo)

    python3 poc_pipeline.py                 # one daily run
    python3 poc_pipeline.py --simulate-day  # run again with a scripted change, to see alerts fire

State persists between runs in ./state/ so the diff engine has a "yesterday"
to compare against. Output for the app front-end is written to movies.json.
"""

from __future__ import annotations
import os, sys, csv, io, re, json, time, shutil, calendar, datetime, subprocess, urllib.parse, urllib.request, urllib.error
from collections import Counter

import runstats

# CAS-771 — GUARDRAIL, DO NOT BREAK: tmdb_id is the join key for six Supabase tables of live user data
# (user_films, film_picks, film_watch, the cascade film rows, list_films, notifications — all keyed on a
# `movie_id text` that is always a tmdb_id, per supabase/schema.sql). It must survive any change of data
# provider, including the v2 migration to Watchmode as the catalogue spine. Watchmode returns tmdb_id on
# every title and publishes a free daily ID-map CSV (Watchmode ID <-> IMDb ID <-> TMDB ID) precisely so this
# never has to change. Re-keying these records on any other id would silently strip every account of its
# Watch-it ticks, seen marks, list membership, personal overrides and its whole alert ledger. Enforced by
# tests/js/data-integrity.test.mjs's tmdb_id tests.

REGION = "AU"                      # the country this instance tracks
CURRENCY = "AUD"

# --- catalogue scope: work BACKWARDS from cinema, not just "now playing" ---
# CAS-128: the ~300 cap is lifted now that availability is free (TMDB Providers, CAS-127).
# All three are env-driven so widening — including the Phase-3 "drop the cinema-release
# requirement → all films" — is a one-line config change, no code edit.
LOOKBACK_DAYS = int(os.getenv("LOOKBACK_DAYS", "1095"))   # AU theatrical release lookback (~3 years)
MAX_TITLES    = int(os.getenv("MAX_TITLES", "5000"))      # ingest breadth: pull the full AU set in the window, not a top-N slice

# --- and FORWARDS from cinema: films announced for AU cinemas but not out yet ---
# These fill the stepper's "Upcoming" slot and feed the Blockbuster-radar Cascade.
# They cost ZERO Watchmode calls: a film that hasn't opened has no AU home offers to
# poll, so the free-tier budget stays entirely with the released catalogue above.
# CAS-125: widen the upcoming window so announced tentpoles (e.g. Avengers: Doomsday) appear.
# Zero availability budget — an unreleased film has no AU home offers to poll (no provider/Watchmode
# calls; TMDB detail only), so this never touches the free-tier availability sweep. Env-driven to widen further.
UPCOMING_LOOKAHEAD_DAYS = int(os.getenv("UPCOMING_LOOKAHEAD_DAYS", "540"))   # ~18 months ahead
MAX_UPCOMING            = int(os.getenv("MAX_UPCOMING", "100"))              # announced AU theatrical; TMDB detail calls only

# CAS-361: widen past the theatrical scope — the newest AU-available titles (stream/rent/buy),
# no release_type restriction, so recent streaming-only / direct-to-digital films that never
# played a cinema (and so never match with_release_type=2|3 above) are ingested too.
# CAS-422: this is the one ingest pass with real headroom — scripts/catalogue_sizing.py measured
# the widened AU-watchable pool at ~90,704 total_results, versus the theatrical pass's ~1,870
# (already near-saturated per CAS-335's appraisal). Raising this cap is what grows the catalogue;
# raising MAX_TITLES would buy nothing, since the theatrical pool itself is the smaller number.
MAX_STREAMING_ONLY = int(os.getenv("MAX_STREAMING_ONLY", "4000"))   # first 200 pages @ 20/page

# --- window heuristics (this is YOUR business logic, not something an API gives you) ---
PVOD_MIN_PRICE   = 19.99          # a buy/rent at or above this, with no subscription yet, = premium early window
RENTAL_MAX_PRICE = 9.99           # a rent at or below this = standard rental window
# CAS-395: how long after its AU cinema_date a title still counts as "in cinema now" — independent of
# whether it has ALSO picked up a home (buy/rent/stream) offer. A film can be simultaneously on a screen
# and on premium/rental/streaming; the two are not exclusive. Matches app_template.html's client-side
# CINEMA_RUN_DAYS (also 90) so the pipeline's claim and the client's own confirmed-path cap never disagree,
# the mismatch CAS-314/CAS-318 had to reconcile.
CINEMA_RUN_DAYS = int(os.getenv("CINEMA_RUN_DAYS", "90"))

STATE_DIR = os.path.join(os.path.dirname(__file__), "state")
SNAPSHOT_FILE = os.path.join(STATE_DIR, "last_snapshot.json")
ALERTS_FILE   = os.path.join(STATE_DIR, "alerts.json")
WM_CACHE_FILE = os.path.join(STATE_DIR, "watchmode_ids.json")   # imdb_id -> watchmode_id (never changes)
WINDOW_DATES_FILE = os.path.join(STATE_DIR, "window_dates.json")  # tmdb_id -> {window: first_seen_date}
API_BUDGET_FILE = os.path.join(STATE_DIR, "api_budget.json")    # CAS-384: today's cross-run provider spend
WM_MONTHLY_FILE = os.path.join(STATE_DIR, "watchmode_monthly.json")   # CAS-974: cumulative spend this month
REFRESH_LOG_FILE = os.path.join(STATE_DIR, "refresh_log.json")   # CAS-1046: per-run history for the admin site
REFRESH_LOG_CAP = 120
# Watchmode's own quoted allowance (see the REVALIDATION_DAILY_BUDGET comment above) — reused here
# rather than re-guessed, so monitor.health's remaining-credits check has a real number to compare
# this month's cumulative on-demand spend against.
WATCHMODE_MONTHLY_CREDITS = int(os.getenv("WATCHMODE_MONTHLY_CREDITS", "40000"))

# CAS-987: the real plan this key is on, and how state/api_budget.json paces nightly spend
# against it — a plan change (trial -> Startup -> Business) is one variable, not a code change.
WM_MONTHLY_QUOTA = int(os.getenv("WM_MONTHLY_QUOTA", "10000"))
WM_QUOTA_RESET_DAY = int(os.getenv("WM_QUOTA_RESET_DAY", "12"))
WM_CYCLE_RESERVE_PCT = float(os.getenv("WM_CYCLE_RESERVE_PCT", "10"))

# CAS-994: the whole run's hard ceiling on Watchmode credits, across every credit-costing call
# path (nightly fields, on-demand enrichment, the CAS-986 scoreability probe) — off by default,
# switched back on in stages via the WM_RUN_MAX_CREDITS repo variable (daily.yml). Unset reads as
# 0, same as an explicit 0: no credit-costing Watchmode call at all this run (see wm_run_allowance).
WM_RUN_MAX_CREDITS = int(os.getenv("WM_RUN_MAX_CREDITS", "0") or 0)

OUTPUT_FILE   = os.path.join(os.path.dirname(__file__), "movies.json")
SAMPLE_FILE   = os.path.join(os.path.dirname(__file__), "sample_data.json")
TEMPLATE_FILE = os.path.join(os.path.dirname(__file__), "app_template.html")
APP_FILE      = os.path.join(os.path.dirname(__file__), "index.html")
VERSION_FILE  = os.path.join(os.path.dirname(__file__), "VERSION")        # hand-bumped SemVer (CAS-124)
VERSION_JSON  = os.path.join(os.path.dirname(__file__), "version.json")   # machine-readable build stamp
BUILD_INFO_JS = os.path.join(os.path.dirname(__file__), "build-info.js")  # CAS-947: runtime-loadable twin of VERSION_JSON
HEADERS_FILE  = os.path.join(os.path.dirname(__file__), "_headers")       # Cloudflare Pages response headers (CAS-946)
IOS_WWW_DIR   = os.path.join(os.path.dirname(__file__), "www")            # Capacitor webDir mirror (CAS-453)
IOS_WWW_ASSETS = ("index.html", "config.js", "favicon.svg", "favicon.png",
                   "apple-touch-icon.png", "splash-logo.svg",
                   "supabase-js.js",  # CAS-765
                   "capacitor-core.js", "capacitor-push-notifications.js",  # CAS-463
                   "capacitor-app.js",  # CAS-524
                   "capacitor-in-app-review.js",  # CAS-969
                   "capacitor-contact-picker.js",  # CAS-932
                   "build-info.js")  # CAS-947

TMDB_KEY      = os.environ.get("TMDB_API_KEY")
WATCHMODE_KEY = os.environ.get("WATCHMODE_API_KEY")
LIVE = bool(TMDB_KEY and WATCHMODE_KEY)

# CAS-773 — v2 phase 1: which vendor is the catalogue spine. Defaults to "tmdb" so an unset env
# var is byte-identical to pre-v2 behaviour; only "watchmode" enters the new ingest path below,
# and only once the free-key trial (CAS-579) is validated and Lee flips it — never on its own.
CASCADE_SPINE = os.getenv("CASCADE_SPINE", "tmdb")

# CAS-109 — poll-tiering + free-tier-capped scheduler (staging prototype).
import poll_scheduler as ps
CATALOGUE_TARGET = int(os.getenv("CATALOGUE_TARGET", "6000"))
                         # CAS-128: persistent browsable catalogue size — was pinned to MAX_TITLES (the
                         # theatrical-pass cap) so the ~300 cap was gone and the full ingested AU set held.
                         # CAS-422: decoupled from MAX_TITLES — theatrical+upcoming+streaming can now sum
                         # past 5,000 (MAX_TITLES=5000 is the theatrical pass's own cap, not the merged
                         # total), so pinning this to it silently truncated the wider streaming ingest
                         # (CAS-361) back down. 6,000 covers the ~5,700 target with headroom; still
                         # env-overridable. Availability is free (TMDB Providers), so catalogue size no
                         # longer gates the daily budget.

# CAS-127 — TMDB Watch Providers is the primary availability source (free, no quota).
# It runs once per released title per day across the WHOLE catalogue, so pace it politely
# (TMDB historically allows ~50 req/s and no daily cap). Watchmode is now on-demand only.
TMDB_PACING      = float(os.getenv("TMDB_PACING", "0.05"))   # seconds between provider calls (~20/s)
ONDEMAND_WM_CAP  = int(os.getenv("ONDEMAND_WM_CAP", str(ps.ONDEMAND_RESERVE)))  # Watchmode enrich/day ceiling

# CAS-379: cinema_release (CAS-360) was added after the persistent catalogue already existed, and
# build_live_catalogue carries every pre-existing base record forward unchanged — only NEW titles
# `ingest_tmdb*` discovers ever pass through `_tmdb_record`. So every record from before the field
# existed is permanently missing it, which is why the streaming Mission's "Cinema Release" toggle
# matched nothing. Back-fill it under its own budget; TMDB has no daily cap (unlike Watchmode)
# but a one-shot full re-fetch of the whole catalogue is still wasteful, so this converges over a
# handful of runs instead.
CINEMA_RELEASE_BACKFILL_BUDGET = int(os.getenv("CINEMA_RELEASE_BACKFILL_BUDGET", "500"))

# CAS-937: Oscar award status + detail from OscarBase (free, no API key — like Wikidata before
# it, this needs no key to be "live", only a network path), replacing OMDb's Awards field and
# the retired Wikidata SPARQL detail backfill. Every catalogue title is a candidate (OscarBase is
# now the ONLY awards source, not gated behind an OMDb flag), but each title's fetch converges:
# a title with a cached row is only re-fetched while its release falls in the current awards
# cycle (`OSCARBASE_RECENT_CEREMONY_YEARS`), so the whole catalogue is not re-asked every night.
# Mirrored to `OSCARBASE_CACHE_FILE` (committed) so a free service disappearing costs a stale
# file, not the feature; runs unconditionally every night (live or sample data), the same
# tolerance `enrich_watchmode_fields_nightly` gives a missing Watchmode key.
OSCARBASE_BASE = "https://api.oscarbase.com"
OSCARBASE_CACHE_FILE = os.path.join(STATE_DIR, "oscarbase_cache.json")
OSCARBASE_BACKFILL_BUDGET = int(os.getenv("OSCARBASE_BACKFILL_BUDGET", "750"))
OSCARBASE_PACING = float(os.getenv("OSCARBASE_PACING", "0.65"))   # 100 req/min cap, 2 calls/title
OSCARBASE_RECENT_CEREMONY_YEARS = 2   # re-fetch a cached title while its release is this recent

# CAS-772: cache TTL — Watchmode's terms cap cached data at 30 days and require deleting it all
# on cancellation; TMDB's terms cap it at 6 months and require the same on termination. One
# mechanism, the SHORTER of the two applies, so it stays correct on whichever side of the v2
# migration CASCADE_SPINE ends up.
WATCHMODE_CACHE_TTL_DAYS = 30
TMDB_CACHE_TTL_DAYS = 183   # ~6 months
CACHE_TTL_DAYS = min(WATCHMODE_CACHE_TTL_DAYS, TMDB_CACHE_TTL_DAYS)
# Spread revalidation of the whole catalogue across the TTL window (~200/day for 6,000 titles)
# rather than one giant sweep — comfortably inside Watchmode's 40,000/month allowance.
REVALIDATION_DAILY_BUDGET = int(os.getenv("REVALIDATION_DAILY_BUDGET", "200"))


# ---------------------------------------------------------------------------
# tiny HTTP helper
# ---------------------------------------------------------------------------
def get_json(url: str, retries: int = 4, headers: dict | None = None) -> dict:
    """GET + parse JSON, with polite backoff on rate-limit / transient server errors.
    CAS-128: the full-catalogue ingest + daily provider sweep make many calls, so honour
    HTTP 429 (Retry-After when given, else exponential) and retry 5xx a few times."""
    req = urllib.request.Request(url, headers={"User-Agent": "cascade-poc/0.1", **(headers or {})})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                wait = e.headers.get("Retry-After") if e.code == 429 else None
                delay = float(wait) if (wait and str(wait).isdigit()) else min(30.0, 2.0 ** attempt)
                time.sleep(delay)
                continue
            raise


def get_text(url: str, retries: int = 4, headers: dict | None = None) -> str:
    """GET + return raw text, same polite backoff as get_json. CAS-773: Watchmode's ID-map is a
    CSV, not JSON, so it needs its own fetch — everything else about the retry behaviour matches."""
    req = urllib.request.Request(url, headers={"User-Agent": "cascade-poc/0.1", **(headers or {})})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                wait = e.headers.get("Retry-After") if e.code == 429 else None
                delay = float(wait) if (wait and str(wait).isdigit()) else min(30.0, 2.0 ** attempt)
                time.sleep(delay)
                continue
            raise


# ---------------------------------------------------------------------------
# CAS-161: one bad API answer must not cost us the whole day's refresh
# ---------------------------------------------------------------------------
# A single enrichment call used to raise straight out of build_live_catalogue and kill the run: no
# movies.json, no index.html, no version.json committed, for a whole day, because one title out of
# ~1,950 failed. That is exactly what happened on 2026-07-24, when a free tier's daily cap answered 401.
#
# The rule now: enrichment is BEST-EFFORT. A title whose enrichment fails keeps the data it already has —
# which is real, just a day older — and the run carries on to derive, build and commit. Only two outcomes
# are possible beyond success:
#   · skip — this title only. Transient, could work next time.
#   · stop — every remaining call to that API this run would get the same answer, so stop asking. A daily
#     cap or a bad key is not per-title, and burning ~1,900 more requests to be told so again is pure waste.
_LIMIT_MARKERS = ("limit reached", "request limit", "too many requests", "invalid api key")


def _api_call(label: str, fn, *args, status_counts: "Counter | None" = None):
    """Run one enrichment call. Returns (value, outcome) with outcome in {'ok','skip','stop'}.

    CAS-1011: `status_counts`, when given, tallies the REAL response actually received for
    this one call (HTTP status code, or 'other' for a non-HTTP exception) — a title skipped
    because an earlier call already tripped `stop` never reaches here, so it can never inflate
    this tally. This is what health.py's tmdb_fetch check now reads for its per-status
    breakdown, rather than the per-title *_fails counters below (which also count untried
    post-stop skips, and so are not a true error tally on their own)."""
    try:
        return fn(*args), "ok"
    except urllib.error.HTTPError as e:
        if status_counts is not None:
            status_counts[e.code] += 1
        body = ""
        try:
            body = (e.read() or b"").decode("utf-8", "replace")[:200].strip()
        except Exception:
            pass
        # CAS-997: a 404 means the vendor itself has deleted/withdrawn the resource — not a fetch
        # outage, and never a reason to stop calling (unlike 401/403 below). Kept as its own
        # outcome so a caller that cares (build_live_catalogue's TMDB call sites) can tally it
        # separately from a real error rather than folding it into 'skip'.
        if e.code == 404:
            print(f"[info] {label}: HTTP 404 — not found, keeping previous data")
            return None, "not_found"
        # 401/403 is the daily cap or a bad key — never a property of this one title.
        stop = e.code in (401, 403) or any(k in body.lower() for k in _LIMIT_MARKERS)
        detail = f" — {body}" if body else ""
        print(f"[warn] {label}: HTTP {e.code}{detail}"
              f"{f' — no further {label} calls this run' if stop else ' — skipping this title'}")
        return None, ("stop" if stop else "skip")
    except Exception as e:
        if status_counts is not None:
            status_counts["other"] += 1
        stop = any(k in str(e).lower() for k in _LIMIT_MARKERS)
        print(f"[warn] {label}: {type(e).__name__}: {e}"
              f"{f' — no further {label} calls this run' if stop else ' — skipping this title'}")
        return None, ("stop" if stop else "skip")


# ---------------------------------------------------------------------------
# 1. INGEST — which films are/were recently in AU cinemas
# ---------------------------------------------------------------------------
TMDB_BASE = "https://api.themoviedb.org/3"

# CAS-1048: TMDB's AU certification field carries both "MA15+"/"MA 15+" and "R18+"/"R 18+" for the
# same rating (a source-side spelling inconsistency, not two ratings) — the app rendered a chip per
# spelling and the default onboarding selection silently missed whichever the user hadn't seen. One
# canonical spelling per rating, applied the moment TMDB's cert string is read so no ingested record
# is ever written the un-canonical way.
AGE_RATING_CANON = {"MA15+": "MA 15+", "R18+": "R 18+"}


def canon_age_rating(cert):
    """The canonical spelling for a raw AU classification string, or `cert` unchanged if it is
    already canonical (or not one of the known duplicate spellings)."""
    return AGE_RATING_CANON.get(cert, cert)


def _tmdb_record(detail: dict) -> dict:
    """Map one TMDB detail payload to our skeleton record."""
    cinema_date, age_rating = None, None
    # CAS-360: every AU release_dates entry (all types 1-6), kept for future use — only type 3
    # (general theatrical) is acted on today, via cinema_release below.
    release_dates, cinema_release = [], False
    for entry in detail.get("release_dates", {}).get("results", []):
        if entry["iso_3166_1"] == REGION:
            for rd in entry["release_dates"]:
                rtype = rd["type"]
                release_dates.append({"region": REGION, "type": rtype, "date": rd["release_date"][:10]})
                if rtype == 3:
                    cinema_release = True
                if rtype in (2, 3):
                    cinema_date = rd["release_date"][:10]
                cert = (rd.get("certification") or "").strip()
                if cert and not age_rating:      # AU classification (G/PG/M/MA15+/R18+)
                    age_rating = canon_age_rating(cert)
    lang = detail.get("original_language")
    countries = [c["iso_3166_1"] for c in detail.get("production_countries", [])]
    vids = (detail.get("videos") or {}).get("results", [])
    trailers = [v["key"] for v in vids
                if v.get("site") == "YouTube" and v.get("type") in ("Trailer", "Teaser") and v.get("key")][:4]
    credits = detail.get("credits") or {}
    directors = [c["name"] for c in credits.get("crew", []) if c.get("job") == "Director"]
    cast = [c["name"] for c in sorted(credits.get("cast", []),
                                      key=lambda c: c.get("order", 999))][:4]
    return {
        "tmdb_id": detail["id"],
        "cache_stamped_at": _RUN_DATE,   # CAS-772: this fetch just confirmed every field below is fresh
        "imdb_id": detail.get("imdb_id"),
        "title": detail["title"],
        "year": (detail.get("release_date") or "----")[:4],
        "genres": [g["name"] for g in detail.get("genres", [])],
        "cinema_date": cinema_date,
        "cinema_release": cinema_release,     # CAS-360: had an AU type-3 (general theatrical) release
        "release_dates": release_dates,       # CAS-360: every AU release_dates type, stored for future use
        "age_rating": age_rating,
        "worldwide_gross": detail.get("revenue") or None,   # single global number, often incomplete
        "budget": detail.get("budget") or None,             # TMDB budget (0 when unknown) — a badge, never a ranker:
                                                            # TMDB knows it for only ~5 of our 12 upcoming titles
        "popularity": detail.get("popularity") or None,     # TMDB popularity — present for every title, so it's what
                                                            # ranks the un-released "Most anticipated" list
        "synopsis": (detail.get("overview") or "").strip(),
        "language": lang,
        "culture": _culture(lang, countries),
        "poster": detail.get("poster_path"),
        "trailers": trailers,
        "director": ", ".join(directors[:2]) or None,
        "cast": cast,
    }


def enrich_cinema_release(movie: dict) -> dict:
    """CAS-379: back-fill `cinema_release`/`release_dates` on a record built before CAS-360
    added them. One lighter release_dates-only call (not the full detail _tmdb_record uses,
    since everything else on the record is already populated)."""
    data = get_json(f"{TMDB_BASE}/movie/{movie['tmdb_id']}/release_dates?api_key={TMDB_KEY}")
    cinema_release, release_dates = False, []
    for entry in data.get("results", []):
        if entry["iso_3166_1"] == REGION:
            for rd in entry["release_dates"]:
                release_dates.append({"region": REGION, "type": rd["type"], "date": rd["release_date"][:10]})
                if rd["type"] == 3:
                    cinema_release = True
    movie["cinema_release"] = cinema_release
    movie["release_dates"] = release_dates
    return movie


def _discover_au_theatrical(start: str, end: str, cap: int, seen: set) -> list[dict]:
    """AU theatrical (type 3) or limited (2) releases dated in [start, end],
    most-popular first, up to `cap`. `seen` carries tmdb_ids already taken by an
    earlier pass so a title can't land in two groups.

    CAS-128: page depth scales with `cap` (was a hard 10 pages ≈ 200 titles) so a big
    cap pulls the full AU set, bounded by TMDB's 500-page discover limit. Detail calls
    are paced politely; get_json handles 429/5xx backoff."""
    movies, page = [], 1
    max_pages = min(500, max(1, -(-cap // 20)))              # ~20 results/page; ceil, capped at TMDB's max
    while len(movies) < cap and page <= max_pages:
        disc = get_json(
            f"{TMDB_BASE}/discover/movie?api_key={TMDB_KEY}&region={REGION}"
            f"&with_release_type=2|3"                         # AU theatrical (3) or limited (2)
            f"&release_date.gte={start}&release_date.lte={end}"
            f"&sort_by=popularity.desc&page={page}"
        )
        results = disc.get("results", [])
        if not results:
            break
        for m in results:
            if m["id"] in seen:
                continue
            seen.add(m["id"])
            detail = get_json(
                f"{TMDB_BASE}/movie/{m['id']}?api_key={TMDB_KEY}&append_to_response=release_dates,videos,credits"
            )
            movies.append(_tmdb_record(detail))
            if TMDB_PACING:
                time.sleep(TMDB_PACING)                       # polite pacing on the detail-call loop
            if len(movies) >= cap:
                break
        page += 1
    return movies


def _discover_au_streaming(cap: int, seen: set) -> list[dict]:
    """CAS-361: the widened AU-available scope — watch_region + monetization types, no
    release_type filter, newest-first (primary_release_date.desc). Catches recent
    streaming-only/direct-to-digital titles `_discover_au_theatrical`'s type=2|3 filter
    excludes. `seen` is shared with the theatrical/upcoming passes so nothing double-lands."""
    movies, page = [], 1
    max_pages = min(500, max(1, -(-cap // 20)))              # ~20 results/page; ceil, capped at TMDB's max
    while len(movies) < cap and page <= max_pages:
        disc = get_json(
            f"{TMDB_BASE}/discover/movie?api_key={TMDB_KEY}&watch_region={REGION}"
            f"&with_watch_monetization_types=flatrate|rent|buy"
            f"&sort_by=primary_release_date.desc&page={page}"
        )
        results = disc.get("results", [])
        if not results:
            break
        for m in results:
            if m["id"] in seen:
                continue
            seen.add(m["id"])
            detail = get_json(
                f"{TMDB_BASE}/movie/{m['id']}?api_key={TMDB_KEY}&append_to_response=release_dates,videos,credits"
            )
            movies.append(_tmdb_record(detail))
            if TMDB_PACING:
                time.sleep(TMDB_PACING)                       # polite pacing on the detail-call loop
            if len(movies) >= cap:
                break
        page += 1
    return movies


def ingest_tmdb_streaming(seen: set) -> list[dict]:
    """CAS-361: the 2000 most-recently-released AU-available movies (incl. streaming-only),
    merged/deduped into the persistent catalogue alongside the theatrical + upcoming ingest."""
    return _discover_au_streaming(MAX_STREAMING_ONLY, seen)


def ingest_tmdb(seen: set) -> list[dict]:
    """Work BACKWARDS from cinema: every film that had an AU theatrical release
    in the last LOOKBACK_DAYS, most-popular first — so the catalogue spans the
    whole cascade (still in cinemas -> PVOD -> rental -> included streaming),
    not just this week's new releases. Capped to MAX_TITLES for the Watchmode
    free-tier daily budget."""
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    return _discover_au_theatrical(start, today.isoformat(), MAX_TITLES, seen)


def ingest_tmdb_upcoming(seen: set) -> list[dict]:
    """Work FORWARDS from cinema: films with an announced AU theatrical date in the
    next UPCOMING_LOOKAHEAD_DAYS. These have not opened, so they carry no offers and
    derive to the "upcoming" window — the real state for the stepper's cinema slot,
    and the pool the Blockbuster-radar Cascade ranks by popularity ("Most anticipated")."""
    today = datetime.date.today()
    start = (today + datetime.timedelta(days=1)).isoformat()          # strictly future
    end   = (today + datetime.timedelta(days=UPCOMING_LOOKAHEAD_DAYS)).isoformat()
    return _discover_au_theatrical(start, end, MAX_UPCOMING, seen)


# ---------------------------------------------------------------------------
# 1b. INGEST (dormant) — CAS-773 v2 phase 1: Watchmode as the catalogue spine, ingest ONLY
#     (which titles exist). Field mapping (ratings/dates/classifications) is phase 3, after the
#     trial (CAS-579) reports — do not extend this to source those fields.
#
#     tmdb_id stays the join key (CAS-771 guardrail): Watchmode has no notion of it directly in
#     its title listing, so every listed title is resolved against Watchmode's free daily bulk
#     CSV (Watchmode id <-> IMDb id <-> TMDB id), fetched once per run and reused — never per
#     title. A title with no tmdb_id in the map is skipped and counted, never given a synthetic
#     id (Lee's call, not made here). Only entered when CASCADE_SPINE=watchmode.
# ---------------------------------------------------------------------------
WATCHMODE_BASE = "https://api.watchmode.com/v1"
# CAS-862: shape confirmed against the live trial key via CAS-579's Q5 report (run 2026-09-07) —
# the real header is `Watchmode ID, IMDB ID, TMDB ID, TMDB Type, Title, Year`, not the snake_case
# originally assumed. `_parse_watchmode_idmap_csv` below matches column names case/spacing-
# insensitively so either shape parses.
WATCHMODE_IDMAP_URL = "https://api.watchmode.com/datasets/title_id_map.csv"

_WM_ID_COL_NAMES = ("wm_id", "id", "watchmode id", "watchmode_id")
_TMDB_ID_COL_NAMES = ("tmdb_id", "tmdbid", "tmdb id")


def _parse_watchmode_idmap_csv(text: str) -> dict:
    """Watchmode id (str) -> tmdb_id (int) for every row that actually carries a tmdb_id. Column
    names are matched case/spacing-insensitively (exact match on the stripped/lowered name, so
    `TMDB Type` is never mistaken for `TMDB ID`). Pure and network-free so it's testable straight
    off a sample CSV string."""
    idmap = {}
    reader = csv.DictReader(io.StringIO(text))
    cols = reader.fieldnames or []
    wm_col = next((c for c in cols if c.strip().lower() in _WM_ID_COL_NAMES), None)
    tmdb_col = next((c for c in cols if c.strip().lower() in _TMDB_ID_COL_NAMES), None)
    if not wm_col or not tmdb_col:
        return idmap
    for row in reader:
        wm_id = row.get(wm_col)
        tmdb_id = row.get(tmdb_col)
        if not wm_id or not tmdb_id:
            continue
        try:
            idmap[str(wm_id)] = int(tmdb_id)
        except (TypeError, ValueError):
            continue
    return idmap


def _fetch_watchmode_idmap() -> dict:
    """The one network call for the whole run's ID map — see the module docstring above."""
    return _parse_watchmode_idmap_csv(get_text(f"{WATCHMODE_IDMAP_URL}?apiKey={WATCHMODE_KEY}"))


def _fetch_watchmode_status() -> dict:
    """CAS-994: Watchmode's own live account usage — {'quota', 'quotaUsed'} — costs 0 credits.
    Only called with a non-zero WM_RUN_MAX_CREDITS ceiling (see wm_run_allowance): it's not worth
    the round-trip when the ceiling has already decided this run spends nothing."""
    return get_json(f"{WATCHMODE_BASE}/status/?apiKey={WATCHMODE_KEY}")


def _list_watchmode_titles_page(page: int) -> dict:
    return get_json(
        f"{WATCHMODE_BASE}/list-titles/?apiKey={WATCHMODE_KEY}&types=movie"
        f"&regions={REGION}&sort_by=popularity_desc&page={page}"
    )


def _watchmode_record(title: dict, tmdb_id: int) -> dict:
    """The same record skeleton `_tmdb_record` produces, but only the fields ingest can actually
    source from Watchmode's title listing — ratings/dates/classifications/etc are left absent,
    not guessed. Phase 3 fills those in once the trial reports."""
    return {
        "tmdb_id": tmdb_id,
        "cache_stamped_at": _RUN_DATE,
        "imdb_id": title.get("imdb_id"),
        "title": title.get("title"),
        "year": str(title.get("year") or "----"),
    }


def ingest_watchmode(seen: set) -> list[dict]:
    """List the AU title universe and resolve each to a tmdb_id via the ID-map (fetched once,
    not per title). Every network call goes through `_api_call`'s budget/back-off wrapper, so a
    bad day degrades rather than storms the API — same discipline as every enrichment pass."""
    idmap, outcome = _api_call("Watchmode ID map", _fetch_watchmode_idmap)
    if outcome != "ok" or not idmap:
        return []

    movies, skipped, page, keep_going = [], 0, 1, True
    while len(movies) < MAX_TITLES and keep_going:
        data, outcome = _api_call("Watchmode list-titles", _list_watchmode_titles_page, page)
        if outcome != "ok":
            break
        titles = data.get("titles", [])
        if not titles:
            break
        for t in titles:
            tmdb_id = idmap.get(str(t.get("id")))
            if not tmdb_id:
                skipped += 1
                continue
            if tmdb_id in seen:
                continue
            seen.add(tmdb_id)
            movies.append(_watchmode_record(t, tmdb_id))
            if len(movies) >= MAX_TITLES:
                break
        keep_going = page < data.get("total_pages", page)
        page += 1

    print(f"[watchmode] ingested {len(movies)} title(s), skipped {skipped} with no tmdb_id")
    return movies


# ---------------------------------------------------------------------------
# CAS-830: v2 phase 3 — Watchmode user_rating / critic_score / popularity_percentile backfill.
# ADDITIVE ONLY: nothing reads these fields yet (not any score, not the agents, not a filter or
# sort) — that decision and the UI comparison line are separate tickets. Resolution uses the free
# daily ID-map CSV (_fetch_watchmode_idmap), never the per-title /search/ endpoint, which costs a
# credit. A record inside WATCHMODE_CACHE_TTL_DAYS of its last fetch is skipped, so a full
# catalogue backfill converges across several bounded runs — the same discipline CAS-772's
# revalidation sweep already uses for cache_stamped_at.
# ---------------------------------------------------------------------------
WM_FIELDS_MAX_CREDITS = int(os.getenv("WM_FIELDS_MAX_CREDITS", "500"))

# CAS-921: the nightly poc_pipeline.py run's own budget for the same fields, spent independently
# of WM_FIELDS_MAX_CREDITS above (the manual watchmode-backfill.yml dispatch's budget). CAS-987:
# no longer a fixed daily cap of its own — run() now uses this value only as a RATIO against
# ONDEMAND_WM_CAP/SCOREABILITY_PROBE_BUDGET to split the real cycle-paced allowance three ways.
WM_NIGHTLY_MAX_CREDITS = int(os.getenv("WM_NIGHTLY_MAX_CREDITS", "400"))
# A ladder-cohort title (upcoming/in_cinema) refreshes on a shorter TTL than WATCHMODE_CACHE_TTL_
# DAYS: Watchmode popularity is the whole score for a title with no other window's data yet.
WM_NIGHTLY_COHORT_TTL_DAYS = 7

# CAS-986: the two-tier catalogue. state/candidates.json is every title discovery has ever found —
# never shipped, never read by the app, never pruned. movies.json is the strict subset that can
# carry a Cascade score today, capped at CATALOGUE_TARGET (a ceiling now, not the mechanism — see
# select_publishable's docstring). SCOREABILITY_PROBE_BUDGET is this ticket's own pot, spent by
# probe_candidates() across the three tiers in the ticket's fixed order; separate from
# WM_NIGHTLY_MAX_CREDITS above so CAS-921's existing nightly pass (still wired into run()
# unchanged) is never starved by this one. CAS-987: run() now uses this value only as a RATIO
# (against WM_NIGHTLY_MAX_CREDITS/ONDEMAND_WM_CAP) to split the real cycle-paced allowance three
# ways — probe_candidates' own signature (a plain int budget) is untouched.
CANDIDATES_FILE = os.path.join(STATE_DIR, "candidates.json")
# CAS-991: CAS-989's --mode enumerate output (keyed on Watchmode id) — optional input, folded into
# CANDIDATES_FILE (keyed on tmdb_id) by merge_backcatalogue_candidates before the probe tiers run.
WM_BACKCATALOGUE_CANDIDATES_FILE = os.path.join(STATE_DIR, "wm_backcatalogue_candidates.json")
SCOREABILITY_PROBE_BUDGET = int(os.getenv("SCOREABILITY_PROBE_BUDGET", "200"))
SCOREABILITY_STALE_DAYS = WATCHMODE_CACHE_TTL_DAYS          # tier 1, non-ladder: 30 days
SCOREABILITY_LADDER_STALE_DAYS = WM_NIGHTLY_COHORT_TTL_DAYS  # tier 1, ladder cohort: 7 days
SCOREABILITY_RECOVERY_DAYS = 90                              # tier 3: no_score re-probe wait
# CAS-1024: the manual one-shot back-catalogue dispatch (watchmode-backfill.yml's
# target=backcatalogue) stops spending once Watchmode's live remaining-credits figure drops below
# this — the floor nightly upkeep (WM_NIGHTLY_MAX_CREDITS/CAS-987 pacing) still needs.
WM_BACKCAT_UPKEEP_FLOOR = 300
USER_HELD_IDS_FILE = os.path.join(STATE_DIR, "user_held_ids.json")   # CAS-986: monitor/store.py writes this
SCOREABLE_SHIM = os.path.join(os.path.dirname(__file__), "scripts", "scoreable_shim.mjs")

# CAS-997 Defect 1: a released title only publishes at or above this Cascade score; a genuinely
# upcoming title keeps publishing on cinema buzz alone, no floor (see scoreable_ids/isScoreable).
WM_PUBLISH_FLOOR = int(os.getenv("WM_PUBLISH_FLOOR", "60"))

# CAS-997 Defect 2: a title TMDB reports not-found (404) on this many CONSECUTIVE nightly runs is
# gone for good, not a transient blip — dropped from candidates.json/publication unless user-held.
TMDB_NOT_FOUND_DROP_STREAK = 3

# CAS-1029: how often enrich_candidates_for_publication persists candidates.json mid-batch, so a
# run that is killed before finishing its full eligible set (an external timeout, never a cap this
# code imposes itself) keeps every enrichment it already completed. 0 disables mid-batch saving.
PUBLISH_ENRICH_SAVE_EVERY = int(os.getenv("PUBLISH_ENRICH_SAVE_EVERY", "200"))


def _invert_watchmode_idmap(idmap: dict) -> dict:
    """`_fetch_watchmode_idmap` returns {wm_id: tmdb_id}; this backfill looks the other way
    around, so build the inverse once per run (never per title) and hand it to every call."""
    return {tmdb_id: wm_id for wm_id, tmdb_id in idmap.items()}


def _fetch_watchmode_title_details(wm_id) -> dict:
    return get_json(f"{WATCHMODE_BASE}/title/{wm_id}/details/?apiKey={WATCHMODE_KEY}")


def _watchmode_fields_stale(movie: dict, ttl_days: int = WATCHMODE_CACHE_TTL_DAYS) -> bool:
    """True once `wm_fields_fetched_at` is missing or at/past the TTL — unknown is never treated
    as fresh, the same rule CAS-772's needs_revalidation applies to cache_stamped_at."""
    stamp = movie.get("wm_fields_fetched_at")
    if not stamp:
        return True
    try:
        stamped = datetime.date.fromisoformat(stamp)
    except ValueError:
        return True
    return (datetime.date.fromisoformat(_RUN_DATE) - stamped).days >= ttl_days


def enrich_watchmode_fields(movie: dict, wm_idmap: dict, budget: dict,
                             ttl_days: int = WATCHMODE_CACHE_TTL_DAYS) -> str:
    """Backfill wm_user_rating / wm_critic_score / wm_popularity_percentile from Watchmode's
    /title/{id}/details/ endpoint. `wm_idmap` is the INVERSE map (tmdb_id -> wm_id) from
    `_invert_watchmode_idmap`, built once per run. `budget` is a shared, mutable counter —
    {"remaining": credits left, "skipped": titles that needed a call but found none left} — so a
    caller looping over many candidates spends one pot across every call, the same shape as every
    other bounded backfill in this module (CINEMA_RELEASE_BACKFILL_BUDGET, OSCARBASE_BACKFILL_
    BUDGET), except the spend/skip bookkeeping lives with the per-title call here since a fresh or
    unresolvable title must cost nothing while a stale one that finds the budget empty still
    counts. An absent field is stored as None — never guessed, never defaulted to 0.

    `ttl_days` lets a caller apply a shorter staleness window than the default
    WATCHMODE_CACHE_TTL_DAYS — CAS-921's nightly ladder-cohort tier passes
    WM_NIGHTLY_COHORT_TTL_DAYS so an upcoming/in_cinema title refreshes weekly, not monthly.

    Returns 'ok' (fetched and wrote fields), 'cached' (already fresh, no credit spent), 'no-id'
    (no Watchmode id resolves for this title), 'skip' (budget exhausted), or an `_api_call`
    outcome ('skip'/'stop') on a failed fetch.

    CAS-1023: this is the one call every Watchmode-scoreable title must pass through (isScoreable
    needs at least one of these fields), but a title ingested via `_watchmode_record` or
    `merge_backcatalogue_candidates` never gets a TMDB detail call, so `popularity`/`budget`/
    `worldwide_gross` (the scale dial's own fields, CAS-238) can otherwise stay null forever even
    once the title is scoreable and published. A successful fetch backfills `popularity` from the
    same percentile-to-TMDB-scale formula CAS-991's merge already uses, but only when the movie
    carries no scale signal of its own yet — a real TMDB popularity/budget/gross is never
    overwritten."""
    if not _watchmode_fields_stale(movie, ttl_days):
        return "cached"
    wm_id = wm_idmap.get(movie.get("tmdb_id"))
    if wm_id is None:
        return "no-id"
    if budget["remaining"] <= 0:
        budget["skipped"] += 1
        return "skip"
    detail, outcome = _api_call("Watchmode fields", _fetch_watchmode_title_details, wm_id)
    budget["remaining"] -= 1
    if outcome != "ok":
        return outcome
    movie["wm_user_rating"] = _num(detail.get("user_rating"))
    movie["wm_critic_score"] = _int(detail.get("critic_score"))
    percentile = _num(detail.get("popularity_percentile"))
    movie["wm_popularity_percentile"] = percentile
    movie["wm_fields_fetched_at"] = _RUN_DATE
    has_scale_signal = ((movie.get("budget") or 0) > 0 or (movie.get("worldwide_gross") or 0) > 0
                        or (movie.get("popularity") or 0) > 0)
    if not has_scale_signal and percentile is not None:
        movie["popularity"] = round(percentile / 10, 4)
    return "ok"


def _is_ladder_cohort(movie: dict) -> bool:
    """Upcoming/in_cinema — the two windows where Watchmode popularity IS the whole score
    (CAS-921's Observation), so these get the shorter WM_NIGHTLY_COHORT_TTL_DAYS refresh."""
    return bool({"upcoming", "in_cinema"} & set(movie.get("status") or []))


def enrich_watchmode_fields_nightly(movies: list, budget: dict | None = None) -> dict:
    """CAS-921: the nightly poc_pipeline.py run's own Watchmode fields pass. The earlier CAS-830/
    850 backfill only ever fires from the manual watchmode-backfill.yml dispatch, so a title added
    to the catalogue since the last manual run carried no Cascade score at all, and an upcoming
    title's popularity went stale until someone remembered to dispatch it.

    Spends one shared budget, WM_NIGHTLY_MAX_CREDITS by default, across three priority tiers,
    highest first:
      1. titles with no wm_fields_fetched_at at all (never fetched);
      2. upcoming/in_cinema titles stale past WM_NIGHTLY_COHORT_TTL_DAYS (7 days);
      3. every other title stale past WATCHMODE_CACHE_TTL_DAYS (30 days).
    Each tier is spent in full before the next one starts, so an empty budget always favours the
    higher tier — the same discipline `enrich_watchmode_fields`'s own {"remaining", "skipped"}
    shape already gives every other bounded backfill in this module.

    A missing or rejected WATCHMODE_API_KEY must not fail the nightly run: this prints a [warn]
    line and returns the zeroed outcome dict immediately, the same tolerance `check_provider_
    health` gives a throttled provider elsewhere in this module — `_api_call` already prints its
    own [warn]/[error] line and returns 'stop' for a rejected key encountered mid-run.

    Returns an {'ok', 'cached', 'no-id', 'skip', 'stop'} outcome-count dict."""
    outcomes = {"ok": 0, "cached": 0, "no-id": 0, "skip": 0, "stop": 0}
    if not WATCHMODE_KEY:
        print("[warn] Watchmode: WATCHMODE_API_KEY not set — skipping the nightly Watchmode "
              "fields step.")
        return outcomes
    # CAS-994: a 0 budget (WM_RUN_MAX_CREDITS=0, or this run's pot already spent) means no
    # Watchmode call at all for this pass — not even the free ID map, which nothing downstream
    # would use with a zeroed budget anyway.
    if budget is not None and budget.get("remaining", 0) <= 0:
        return outcomes

    idmap, idmap_outcome = _api_call("Watchmode ID map", _fetch_watchmode_idmap)
    if idmap_outcome != "ok" or not idmap:
        print("[warn] Watchmode: no usable ID map this run — skipping the nightly Watchmode "
              "fields step.")
        return outcomes
    wm_idmap = _invert_watchmode_idmap(idmap)

    if budget is None:
        budget = {"remaining": WM_NIGHTLY_MAX_CREDITS, "skipped": 0}

    seen = set()
    unfetched = []
    for m in movies:
        if not m.get("wm_fields_fetched_at"):
            unfetched.append(m)
            seen.add(id(m))

    cohort = []
    for m in movies:
        if id(m) in seen:
            continue
        if _is_ladder_cohort(m) and _watchmode_fields_stale(m, WM_NIGHTLY_COHORT_TTL_DAYS):
            cohort.append(m)
            seen.add(id(m))

    rest = [m for m in movies if id(m) not in seen and _watchmode_fields_stale(m)]

    for m in unfetched:
        outcomes[enrich_watchmode_fields(m, wm_idmap, budget)] += 1
    for m in cohort:
        outcomes[enrich_watchmode_fields(m, wm_idmap, budget, WM_NIGHTLY_COHORT_TTL_DAYS)] += 1
    for m in rest:
        outcomes[enrich_watchmode_fields(m, wm_idmap, budget)] += 1
    return outcomes


# ---------------------------------------------------------------------------
# CAS-986: the two-tier catalogue — a candidate pool (state/candidates.json), and publish only
# titles that carry a score (movies.json). See the ticket for the full design; in short:
# list-titles/title_id_map only give an id/title/year, so whether a title HAS a score costs
# exactly what fetching it costs — scoreability cannot gate discovery, only publication.
# ---------------------------------------------------------------------------
def load_candidates() -> dict:
    """tmdb_id (str) -> candidate record — every title discovery has ever found. Never shipped,
    never read by the app, never pruned (CAS-986)."""
    if not os.path.exists(CANDIDATES_FILE):
        return {}
    return json.load(open(CANDIDATES_FILE, encoding="utf-8"))


def save_candidates(candidates: dict) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(candidates, open(CANDIDATES_FILE, "w", encoding="utf-8"), indent=2, sort_keys=True)


def merge_backcatalogue_candidates(candidates: dict, today_iso: str, path: str | None = None) -> dict:
    """CAS-991: folds CAS-989's `--mode enumerate` output (state/wm_backcatalogue_candidates.json,
    keyed on Watchmode id) into the persistent candidates.json store (keyed on tmdb_id) — nothing
    else reads the back-catalogue file into the candidate pool, so an enumerate run would otherwise
    spend real Watchmode credits filling a file nothing consumes.

    Joins on tmdb_id, which `/list-titles` returns on every enumerated row. Makes no network calls.
    A row with no tmdb_id cannot join candidates.json (which is keyed by tmdb_id) — it is skipped
    and counted, never given a synthesised id. An id already tracked in candidates.json is left
    completely alone (its outcome/last_probed/probe_count are never reset), the same rule
    merge_candidates applies above, so re-running this is a no-op for anything already known. A
    genuinely new id enters as `outcome: unprobed`, carrying its tmdb_id, title, year and
    popularity_percentile, so tier 2 of probe_candidates picks it up.

    `path` defaults to WM_BACKCATALOGUE_CANDIDATES_FILE; absent is not an error — this file is
    optional input (no enumerate run has happened yet).

    Returns {'merged': int, 'already_known': int, 'no_tmdb_id': int}, and prints the same three
    figures as `backcat_merged=<n> already_known=<n> no_tmdb_id=<n>`."""
    path = path or WM_BACKCATALOGUE_CANDIDATES_FILE
    stats = {"merged": 0, "already_known": 0, "no_tmdb_id": 0}
    if not os.path.exists(path):
        print("[info] CAS-991: state/wm_backcatalogue_candidates.json absent — nothing to merge "
              "this run (optional input, no enumerate run has happened yet).")
        return stats

    rows = json.load(open(path, encoding="utf-8"))
    for row in rows:
        tmdb_id = row.get("tmdb_id")
        if tmdb_id is None:
            stats["no_tmdb_id"] += 1
            continue
        key = str(tmdb_id)
        if key in candidates:
            stats["already_known"] += 1
            continue
        # CAS-992: `status` must be a list — primaryStatus()/isScoreable() index into it and throw
        # on None/missing, which took down scoreable_ids()'s whole batch call. `popularity` is
        # scaled down from the 0-100 popularity_percentile (percentile / 10, so a 0-10 range) to
        # land within TMDB's own popularity distribution (movies.json: median 1.2, p75 2.7, p90
        # 8.2) rather than the raw percentile value, which would outrank most real TMDB titles.
        percentile = row.get("popularity_percentile") or 0
        candidates[key] = {
            "tmdb_id": tmdb_id,
            "title": row.get("title"),
            "year": str(row.get("year") or "----"),
            "popularity_percentile": row.get("popularity_percentile"),
            "popularity": round(percentile / 10, 4),
            "status": [],
            "first_seen": today_iso,
            "last_probed": None,
            "probe_count": 0,
            "outcome": "unprobed",
        }
        stats["merged"] += 1

    print(f"backcat_merged={stats['merged']} already_known={stats['already_known']} "
          f"no_tmdb_id={stats['no_tmdb_id']}")
    return stats


def merge_candidates(candidates: dict, pool: list, today_iso: str) -> int:
    """Union today's full discovery pool into the persistent candidates store. Only a genuinely
    new tmdb_id is added here (as unprobed) — an id already tracked is left alone by this
    function, because `pool` (build_live_catalogue's pre-slice union) carries no CAS-921/CAS-937
    enrichment for the portion that fell outside today's CATALOGUE_TARGET slice, and overwriting an
    already-probed candidate with that unenriched shape would erase its accumulated score data.
    See refresh_enriched_candidates below for syncing the enriched portion back in. Returns the
    number of new candidates added."""
    added = 0
    for m in pool:
        key = str(m["tmdb_id"])
        if key in candidates:
            continue
        rec = dict(m)
        rec["first_seen"] = today_iso
        rec["last_probed"] = None
        rec["probe_count"] = 0
        rec["outcome"] = "unprobed"
        candidates[key] = rec
        added += 1
    return added


_CANDIDATE_TRACKING_FIELDS = ("first_seen", "last_probed", "probe_count", "outcome")


def refresh_enriched_candidates(candidates: dict, enriched: list, today_iso: str) -> None:
    """Sync this run's freshly availability/score/awards-enriched records (`enriched` — the
    post-slice, post-CAS-921/CAS-937 `records`) back into candidates.json's own entries for the
    same ids, preserving each candidate's own tracking fields. A candidate outside this run's slice
    is left exactly as it was — its own accumulated data is never overwritten by an unenriched pass.

    Also recognises a candidate CAS-921's own (unchanged) nightly Watchmode-fields pass already
    probed today — via `wm_fields_fetched_at` landing on today's date — as a real probe, so
    outcome/last_probed/probe_count never drift out of sync with what the record actually carries
    just because probe_candidates() itself never touched it this run."""
    for m in enriched:
        key = str(m["tmdb_id"])
        if key not in candidates:
            continue
        prior = candidates[key]
        tracking = {k: prior.get(k) for k in _CANDIDATE_TRACKING_FIELDS}
        candidates[key] = dict(m)
        candidates[key].update(tracking)
        if m.get("wm_fields_fetched_at") == today_iso and prior.get("last_probed") != today_iso:
            candidates[key]["last_probed"] = today_iso
            candidates[key]["probe_count"] = (prior.get("probe_count") or 0) + 1
            has_score = (m.get("wm_user_rating") is not None or m.get("wm_critic_score") is not None
                        or m.get("wm_popularity_percentile") is not None)
            candidates[key]["outcome"] = "scored" if has_score else "no_score"


def _scoreability_recovery_due(c: dict, today: datetime.date) -> bool:
    """Tier 3: a no_score candidate is only re-probed once SCOREABILITY_RECOVERY_DAYS have passed
    since its last probe — recovers the tail without re-asking every night."""
    lp = c.get("last_probed")
    if not lp:
        return True
    try:
        stamped = datetime.date.fromisoformat(lp)
    except ValueError:
        return True
    return (today - stamped).days >= SCOREABILITY_RECOVERY_DAYS


def probe_candidates(candidates: dict, today: datetime.date, budget: int, wm_idmap: dict,
                      published_ids: set) -> dict:
    """CAS-986's own nightly scoreability probe, spending `budget` Watchmode credits across three
    priority tiers, highest first — the order matters and must not be rearranged:
      1. published titles (`published_ids` — yesterday's movies.json) whose Watchmode fields are
         stale (30 days, or 7 for an upcoming/in_cinema ladder-cohort title) — first, because
         letting a published title's fields expire silently removes it from the app.
      2. unprobed candidates, most popular first — this is what grows the catalogue.
      3. no_score candidates last probed more than SCOREABILITY_RECOVERY_DAYS ago — recovers the
         tail without re-asking every night.
    Reuses enrich_watchmode_fields for the actual per-title fetch (CAS-921) — never a second fetch/
    parse of Watchmode's response. Mutates each probed candidate's own last_probed/probe_count/
    outcome in place. Returns the {'ok','cached','no-id','skip','stop'} tally plus 'probed', the
    count of candidates that actually got a fresh answer (ok or no-id) this run."""
    bd = {"remaining": budget, "skipped": 0}
    today_iso = today.isoformat()

    def _by_popularity(items):
        return sorted(items, key=lambda m: m.get("popularity") or 0, reverse=True)

    tier1 = _by_popularity(
        c for c in candidates.values()
        if c["tmdb_id"] in published_ids
        and _watchmode_fields_stale(c, SCOREABILITY_LADDER_STALE_DAYS if _is_ladder_cohort(c)
                                    else SCOREABILITY_STALE_DAYS))
    tier2 = _by_popularity(c for c in candidates.values() if c.get("outcome") == "unprobed")
    tier3 = _by_popularity(c for c in candidates.values() if c.get("outcome") == "no_score"
                           and _scoreability_recovery_due(c, today))

    outcomes = {"ok": 0, "cached": 0, "no-id": 0, "skip": 0, "stop": 0, "probed": 0}
    for tier in (tier1, tier2, tier3):
        for c in tier:
            ttl = SCOREABILITY_LADDER_STALE_DAYS if _is_ladder_cohort(c) else SCOREABILITY_STALE_DAYS
            result = enrich_watchmode_fields(c, wm_idmap, bd, ttl)
            outcomes[result] = outcomes.get(result, 0) + 1
            if result in ("ok", "no-id"):
                outcomes["probed"] += 1
                c["last_probed"] = today_iso
                c["probe_count"] = c.get("probe_count", 0) + 1
                if result == "no-id":
                    c["outcome"] = "no_wm_id"
                else:
                    has_score = (c.get("wm_user_rating") is not None
                                or c.get("wm_critic_score") is not None
                                or c.get("wm_popularity_percentile") is not None)
                    c["outcome"] = "scored" if has_score else "no_score"
    outcomes["spent"] = budget - bd["remaining"]   # CAS-987: actual credits this pass drew from `budget`
    return outcomes


def run_backcatalogue_probe(candidates: dict, today: datetime.date, max_credits: int,
                            wm_idmap: dict, backcat_ids: set, fetch_remaining_credits,
                            upkeep_floor: int = WM_BACKCAT_UPKEEP_FLOOR) -> dict:
    """CAS-1024: the one-shot manual back-catalogue probe (watchmode-backfill.yml's
    target=backcatalogue mode). Probes only `backcat_ids` (tmdb_ids sourced from CAS-989's
    state/wm_backcatalogue_candidates.json) that are still `outcome: unprobed`, most popular
    first, reusing enrich_watchmode_fields for the actual per-title fetch — the SAME call
    CAS-986's nightly probe_candidates() uses; never a second scoring/probe implementation. A
    candidate already probed (scored/no_score/no_wm_id) is never revisited by this mode — unlike
    probe_candidates' tier 3, there is no recovery window here (the ticket's own Change #2).

    Deliberately NOT capped by wm_run_allowance/WM_RUN_MAX_CREDITS/the CAS-987 cycle pace: this is
    the manual dispatch's own explicit spend decision, so `max_credits` is the only ceiling this
    function itself enforces.

    Stops before spending the next credit when: `max_credits` is exhausted, the candidate list is
    exhausted, or `fetch_remaining_credits()` — Watchmode's live, 0-credit /status figure, called
    before every probe — reports fewer than `upkeep_floor` credits remaining on the account (the
    nightly upkeep path's own floor). `fetch_remaining_credits` is injected so callers/tests can
    supply a live status source or a canned sequence without a real network call; `None` (a failed
    status check) is treated as "unknown" and never stops the run on its own.

    Mutates each probed candidate's own last_probed/probe_count/outcome in place, the same
    bookkeeping probe_candidates() applies, so a second dispatch resumes correctly.

    Returns the same {'ok','cached','no-id','skip','stop','probed','spent'} tally as
    probe_candidates, plus 'stopped_on_floor' (bool) and this run's own 'no_score' count (an
    'ok' fetch that resolved no usable score field — distinct from 'no-id')."""
    bd = {"remaining": max_credits, "skipped": 0}
    today_iso = today.isoformat()

    targets = sorted(
        (c for c in candidates.values()
         if c.get("tmdb_id") in backcat_ids and c.get("outcome") == "unprobed"),
        key=lambda c: c.get("popularity") or 0, reverse=True)

    outcomes = {"ok": 0, "cached": 0, "no-id": 0, "skip": 0, "stop": 0, "probed": 0,
                "no_score": 0}
    stopped_on_floor = False
    for c in targets:
        if bd["remaining"] <= 0:
            break
        remaining_credits = fetch_remaining_credits()
        if remaining_credits is not None and remaining_credits < upkeep_floor:
            stopped_on_floor = True
            break
        ttl = SCOREABILITY_LADDER_STALE_DAYS if _is_ladder_cohort(c) else SCOREABILITY_STALE_DAYS
        result = enrich_watchmode_fields(c, wm_idmap, bd, ttl)
        outcomes[result] = outcomes.get(result, 0) + 1
        if result in ("ok", "no-id"):
            outcomes["probed"] += 1
            c["last_probed"] = today_iso
            c["probe_count"] = c.get("probe_count", 0) + 1
            if result == "no-id":
                c["outcome"] = "no_wm_id"
            else:
                has_score = (c.get("wm_user_rating") is not None
                            or c.get("wm_critic_score") is not None
                            or c.get("wm_popularity_percentile") is not None)
                c["outcome"] = "scored" if has_score else "no_score"
                if not has_score:
                    outcomes["no_score"] += 1
    outcomes["spent"] = max_credits - bd["remaining"]
    outcomes["stopped_on_floor"] = stopped_on_floor
    return outcomes


# CAS-1027: the exact shape CAS-991's merge_backcatalogue_candidates writes for a genuinely new
# tmdb_id — nothing else in the pipeline produces a record carrying ONLY these keys.
_CANDIDATE_STUB_KEYS = frozenset({
    "first_seen", "last_probed", "outcome", "popularity", "popularity_percentile",
    "probe_count", "status", "title", "tmdb_id", "year",
    "wm_user_rating", "wm_critic_score", "wm_popularity_percentile", "wm_fields_fetched_at",
})


def is_publishable_record(record: dict) -> bool:
    """CAS-1027's publication guard — every path that decides movies.json's membership must run
    each candidate through this before it publishes. Closes the defect CAS-1024's back-catalogue
    dispatch hit: a candidate the Watchmode probe scored, but that never got TMDB enrichment,
    published as a raw candidate-pool stub — an int `year` and none of the fields the app needs,
    which crashed the app's own `(m.cinema_date || m.year || "").slice` read and every engine/data-
    integrity check that assumes a string date.

    Requires a STRING `year` or `cinema_date` (CAS-991's merge_backcatalogue_candidates writes an
    int `year`, never a string), and rejects a record whose keys are ENTIRELY the candidate-pool
    bookkeeping set (`_CANDIDATE_STUB_KEYS`) — a record that thin has had no TMDB enrichment at
    all, even once the Watchmode probe has added every wm_* field it ever will.

    CAS-1055: also canonicalises `age_rating` in place, since this guard is the one boundary every
    publication path runs a candidate through. `canon_age_rating` already runs at fetch time
    (`_tmdb_record`), but a record cached before that canonicalisation existed keeps its raw TMDB
    spelling indefinitely (TTL-gated revalidation means it may not be re-fetched for months) — this
    is what stops that stale spelling from reaching movies.json regardless."""
    if "age_rating" in record:
        record["age_rating"] = canon_age_rating(record["age_rating"])
    year = record.get("year")
    cinema_date = record.get("cinema_date")
    has_date = (isinstance(year, str) and year != "") or (isinstance(cinema_date, str) and cinema_date != "")
    if not has_date:
        return False
    if set(record.keys()) <= _CANDIDATE_STUB_KEYS:
        return False
    return True


def enrich_candidate_for_publication(candidate: dict, today: datetime.date) -> str:
    """CAS-1027: give a stub candidate (CAS-991's merge_backcatalogue_candidates shape, or any
    other thin candidate) the exact TMDB-only enrichment and record shape build_live_catalogue
    gives every other title, in place, before select_publishable is allowed to publish it — never
    a second enrichment implementation. Reuses revalidate_record for the detail call (_tmdb_record)
    and tmdb_providers/derive_from_providers/apply_monotonic_status for availability, the same
    calls build_live_catalogue's own per-title loop makes. Spends no Watchmode credits; a
    candidate's existing wm_* fields (CAS-1023's scoreability probe) are untouched, since none of
    these calls read or write them, and a brand-new candidate's status ([]) ranks below every real
    tier so apply_monotonic_status always commits the fresh answer, never holds it back.

    Returns an _api_call outcome ('ok', 'skip', 'stop' or 'not_found'). Anything but 'ok' leaves
    `candidate` exactly as it was — still a stub, to retry next run."""
    _, outcome = _api_call("TMDB detail (publication enrich)", revalidate_record, candidate, today)
    if outcome != "ok":
        return outcome

    tier = ps.classify_tier(candidate, today)
    candidate["poll_tier"] = tier
    if tier == "none":
        candidate["offers"] = []
        candidate["status"] = ["upcoming"]
        candidate["availability_confidence"] = "confirmed"
        candidate["availability_source"] = "tmdb_date"
        return "ok"

    prov, prov_outcome = _api_call("TMDB providers (publication enrich)", tmdb_providers,
                                   candidate["tmdb_id"])
    if prov_outcome == "ok":
        candidate["jw_link"] = prov.get("jw_link")
        if has_provider_rows(prov):
            candidate["offers"] = provider_offers(prov)
            apply_monotonic_status(candidate, derive_from_providers(candidate, prov, today),
                                   "confirmed", today)
        else:
            candidate["offers"] = []
            apply_monotonic_status(candidate, derive_from_providers(candidate, {}, today),
                                   "estimated", today)
        candidate["last_polled"] = today.isoformat()
        candidate["availability_source"] = "tmdb_providers"
    else:
        w, conf = ps.estimate_status(candidate, today)
        candidate["offers"] = []
        candidate["status"] = [w]
        candidate["availability_confidence"] = conf
        candidate["availability_source"] = "estimated_unpolled"
    return "ok"


def enrich_candidates_for_publication(candidates: dict, engine_scoreable_ids: set,
                                      today: datetime.date) -> dict:
    """CAS-1027: before select_publishable runs, give every candidate the engine says is
    scoreable today — but that isn't yet a publishable record shape — the enrichment
    enrich_candidate_for_publication describes. A candidate that already satisfies
    is_publishable_record is left completely alone (no repeat TMDB calls for an already-enriched
    title). Mutates `candidates` in place; the caller's own save_candidates persists the result,
    so a candidate enriched here is never re-fetched on a later run.

    CAS-1029: every eligible candidate is attempted, most popular first, in a single run — no cap
    imposed here. save_candidates runs every PUBLISH_ENRICH_SAVE_EVERY titles so a run stopped
    early by something outside this code (a workflow timeout) keeps its completed work; the next
    run's eligible set naturally excludes anything already enriched. TMDB_PACING paces the calls,
    same as the discovery loops. No Watchmode call is ever made here — see
    enrich_candidate_for_publication.

    Returns {'eligible': int, 'enriched': int, 'failed': int, 'reasons': dict} — 'eligible' is the
    pre-loop count of scoreable-but-not-yet-publishable candidates; 'reasons' tallies every
    non-'ok' outcome (skip/stop/not_found) by name. Printed as
    `publish_guard_enriched=<n> publish_guard_failed=<n>`."""
    eligible = [c for c in candidates.values()
               if c["tmdb_id"] in engine_scoreable_ids and not is_publishable_record(c)]
    eligible.sort(key=lambda c: c.get("popularity") or 0, reverse=True)

    stats = {"eligible": len(eligible), "enriched": 0, "failed": 0, "reasons": {}}
    for i, c in enumerate(eligible, start=1):
        outcome = enrich_candidate_for_publication(c, today)
        if outcome == "ok":
            stats["enriched"] += 1
        else:
            stats["failed"] += 1
            stats["reasons"][outcome] = stats["reasons"].get(outcome, 0) + 1
        if PUBLISH_ENRICH_SAVE_EVERY > 0 and i % PUBLISH_ENRICH_SAVE_EVERY == 0:
            save_candidates(candidates)
        time.sleep(TMDB_PACING)
    print(f"publish_guard_enriched={stats['enriched']} publish_guard_failed={stats['failed']}")
    return stats


def publish_enrich_log_line(enrich_stats: dict, published: int) -> str:
    """CAS-1029's own required summary line, built once so both call sites (the nightly
    apply_two_tier_publication step and cas1024_backcatalogue_load.py's watchmode-backfill.yml
    target=backcatalogue dispatch) print it identically. `published` is select_publishable's own
    'promoted' count for this run — how many of this run's candidates actually reached
    movies.json, not the catalogue's whole published total."""
    reasons = ", ".join(f"{k}={v}" for k, v in sorted(enrich_stats["reasons"].items())) or "none"
    return (f"[enrich] eligible {enrich_stats['eligible']}, enriched {enrich_stats['enriched']}, "
            f"published {published}, failed {enrich_stats['failed']} ({reasons})")


def run_scoreability_probe(candidates: dict, today: datetime.date, budget: int,
                           published_ids: set) -> dict:
    """Fetch the Watchmode id map once, then run probe_candidates. Tolerates a missing/rejected
    WATCHMODE_API_KEY exactly like CAS-921's own nightly pass (enrich_watchmode_fields_nightly) —
    prints a [warn] and returns a zeroed tally rather than failing the run."""
    empty = {"ok": 0, "cached": 0, "no-id": 0, "skip": 0, "stop": 0, "probed": 0, "spent": 0}
    if not WATCHMODE_KEY:
        print("[warn] Watchmode: WATCHMODE_API_KEY not set — skipping the CAS-986 scoreability probe.")
        return empty
    # CAS-994: a 0 budget means no Watchmode call at all this pass — not even the free ID map.
    if budget <= 0:
        return empty
    idmap, idmap_outcome = _api_call("Watchmode ID map", _fetch_watchmode_idmap)
    if idmap_outcome != "ok" or not idmap:
        print("[warn] Watchmode: no usable ID map this run — skipping the CAS-986 scoreability probe.")
        return empty
    wm_idmap = _invert_watchmode_idmap(idmap)
    return probe_candidates(candidates, today, budget, wm_idmap, published_ids)


def scoreable_ids(movies: list, floor: int = 0) -> set:
    """CAS-986's publication test: ask the shipped engine (scripts/scoreable_shim.mjs, which calls
    isScoreable() — the same rule scripts/wm_scoreable_manifest.mjs already encodes for CAS-922)
    which of `movies` can carry a Cascade score today. One process for the whole batch, never per
    title. Writing a second copy of this rule in Python is the defect this function exists to
    avoid — if the app's scoring changes, this keeps changing with it automatically.

    CAS-997: `floor` defaults to 0 (the pre-CAS-997, unfloored rule) — the real publication path
    (apply_two_tier_publication) passes WM_PUBLISH_FLOOR explicitly; every other caller is
    unaffected unless it opts in.

    CAS-992: a candidate with no `status` (a shape gap in a legacy/pre-fix candidates.json entry —
    the shim itself is also hardened to never let one bad record fail the whole batch) is
    normalised to `status: []` here, in place, before the call — `primaryStatus()` indexes into
    `status` and throws on anything else."""
    for m in movies:
        if m.get("status") is None:
            m["status"] = []
    payload = json.dumps({"movies": movies, "floor": floor})
    proc = subprocess.run(["node", SCOREABLE_SHIM], input=payload, capture_output=True,
                          text=True, timeout=180, check=True)
    return {int(x) for x in json.loads(proc.stdout)["scoreable_ids"]}


def load_user_held_ids():
    """CAS-986's demotion-safety net: the union of tmdb_ids a user holds state on (user_films,
    film_watch, agent_films, notifications — written by monitor/store.py at the end of each
    monitor run). Returns None when the file is absent or unreadable, the caller's signal to
    demote nothing at all this run rather than orphan a film a user marked watched or pinned."""
    try:
        return set(json.load(open(USER_HELD_IDS_FILE, encoding="utf-8")))
    except (OSError, ValueError):
        return None


def drop_not_found_candidates(candidates: dict, held_ids) -> int:
    """CAS-997 Defect 2: a candidate whose `tmdb_not_found_streak` (set by build_live_catalogue's
    TMDB call sites) has reached TMDB_NOT_FOUND_DROP_STREAK consecutive nightly runs is gone from
    TMDB for good, not a transient 404 — remove it from `candidates` in place, so it is dropped
    from candidates.json and can never publish. Uses the same user-held exemption + fail-safe as
    select_publishable's own demotion: a held title is never dropped, and `held_ids=None` (the
    user-state tables were unreadable this run) means drop nothing at all rather than guess.

    Returns the number of candidates dropped."""
    if held_ids is None:
        return 0
    dropped = 0
    for key, c in list(candidates.items()):
        if (c.get("tmdb_not_found_streak") or 0) < TMDB_NOT_FOUND_DROP_STREAK:
            continue
        if c.get("tmdb_id") in held_ids:
            continue
        del candidates[key]
        dropped += 1
    return dropped


def select_publishable(candidates: dict, engine_scoreable_ids: set, previously_published_ids: set,
                       held_ids, catalogue_target: int) -> tuple:
    """Rebuild movies.json's own membership from `candidates` (CAS-986). A title publishes when
    the shipped engine says it's scoreable today AND it ranks inside `catalogue_target` by
    popularity among scoreable candidates — CATALOGUE_TARGET is a ceiling on the result now, not
    the mechanism that picks it. A title that WAS published (`previously_published_ids`) but would
    otherwise drop is still kept, and counted `exempt`, when a user holds state on it (`held_ids`)
    or when `held_ids` is None (the tables were unreadable this run — demote nothing at all,
    per the ticket's own fail-safe).

    CAS-1027: is_publishable_record gates every addition to `published_ids` below, ranked-in or
    exempt — the engine's scoreable answer is necessary but not sufficient; a candidate scoreable
    today that never got TMDB-enriched (a CAS-991 back-catalogue stub the enrichment pass upstream
    failed to complete) must never reach movies.json.

    Returns (published_records, stats) where stats has published/promoted/demoted/exempt."""
    scoreable = [c for c in candidates.values()
                if c["tmdb_id"] in engine_scoreable_ids and is_publishable_record(c)]
    scoreable.sort(key=lambda m: m.get("popularity") or 0, reverse=True)
    ranked_in = {c["tmdb_id"] for c in scoreable[:catalogue_target]}

    published_ids = set(ranked_in)
    exempt_ids = set()
    for tid in previously_published_ids - ranked_in:
        if str(tid) not in candidates or not is_publishable_record(candidates[str(tid)]):
            continue
        if held_ids is None or str(tid) in held_ids:
            published_ids.add(tid)
            exempt_ids.add(tid)

    promoted_ids = published_ids - previously_published_ids
    demoted_ids = previously_published_ids - published_ids
    published_records = [candidates[str(tid)] for tid in published_ids if str(tid) in candidates]
    published_records.sort(key=lambda m: m.get("popularity") or 0, reverse=True)

    stats = {"published": len(published_records), "promoted": len(promoted_ids),
             "demoted": len(demoted_ids), "exempt": len(exempt_ids)}
    return published_records, stats


def apply_two_tier_publication(candidates: dict, today: datetime.date, discovery_pool: list,
                               enriched_records: list, previously_published_ids: set,
                               probe_budget: int = SCOREABILITY_PROBE_BUDGET) -> tuple:
    """CAS-986's own top-level nightly step: merge today's discovery into candidates.json, sync in
    this run's already-enriched records, probe within budget, ask the engine which candidates are
    scoreable today, then rebuild movies.json's membership. Tolerant of a broken/unavailable Node
    engine (no `node` on PATH, a shim crash) — falls back to publishing exactly what was previously
    published, unchanged, rather than ever wiping the live catalogue over a tooling failure.

    Returns (published_records, report) where report has the ticket's seven reporting figures
    (candidates/unprobed/probed_today/published/promoted/demoted/exempt) plus 'engine_ok' and
    CAS-997's 'not_found_dropped'."""
    today_iso = today.isoformat()
    merge_candidates(candidates, discovery_pool, today_iso)
    refresh_enriched_candidates(candidates, enriched_records, today_iso)
    merge_backcatalogue_candidates(candidates, today_iso)

    held_ids = load_user_held_ids()
    if held_ids is None:
        print("[warn] CAS-986: state/user_held_ids.json absent or unreadable — demoting nothing "
              "this run.")

    # CAS-997 Defect 2: drop before the probe/engine pass, so a title TMDB has deleted is never
    # re-probed, never asked about, and never published this run.
    not_found_dropped = drop_not_found_candidates(candidates, held_ids)
    if not_found_dropped:
        print(f"[info] CAS-997: dropped {not_found_dropped} candidate(s) TMDB reported not-found "
              f"on {TMDB_NOT_FOUND_DROP_STREAK} consecutive nightly runs.")

    probe_outcomes = run_scoreability_probe(candidates, today, probe_budget, previously_published_ids)

    try:
        engine_ids = scoreable_ids(list(candidates.values()), floor=WM_PUBLISH_FLOOR)
        engine_ok = True
    except Exception as err:  # noqa: BLE001 — a broken engine call must never wipe the catalogue
        print(f"[warn] CAS-986: scoreability engine call failed ({err}) — publishing the "
              "previously-published set unchanged this run.")
        engine_ids = set(previously_published_ids)
        engine_ok = False

    # CAS-1027: a candidate the engine calls scoreable today may still be a raw candidate-pool
    # stub (CAS-991's merge_backcatalogue_candidates, or any other thin source) — give it the same
    # TMDB enrichment any other published title carries before select_publishable's own guard
    # (is_publishable_record) decides membership. No Watchmode credits spent; an already-enriched
    # candidate is left untouched.
    enrich_stats = enrich_candidates_for_publication(candidates, engine_ids, today)

    published_records, stats = select_publishable(candidates, engine_ids, previously_published_ids,
                                                   held_ids, CATALOGUE_TARGET)
    print(publish_enrich_log_line(enrich_stats, stats["promoted"]))
    unprobed = sum(1 for c in candidates.values() if c.get("outcome") == "unprobed")
    report = {
        "candidates": len(candidates), "unprobed": unprobed,
        "probed_today": probe_outcomes["probed"], "engine_ok": engine_ok,
        "wm_spent": probe_outcomes.get("spent", 0),   # CAS-987: this pass's actual draw on probe_budget
        "not_found_dropped": not_found_dropped,
        "publish_guard_eligible": enrich_stats["eligible"],
        "publish_guard_enriched": enrich_stats["enriched"],
        "publish_guard_failed": enrich_stats["failed"],
        **stats,
    }
    return published_records, report


# Map a film's original language (with production country as a tiebreak) to a
# broad "culture" bucket — an approximation of the audience it was made for.
_LANG_CULTURE = {
    "ko":"Korean", "ja":"Japanese", "zh":"Chinese", "cn":"Chinese", "yue":"Chinese",
    "hi":"Indian", "ta":"Indian", "te":"Indian", "ml":"Indian", "kn":"Indian",
    "bn":"Indian", "pa":"Indian", "mr":"Indian",
    "th":"Southeast Asian", "id":"Southeast Asian", "vi":"Southeast Asian", "tl":"Southeast Asian",
    "fr":"European", "de":"European", "it":"European", "ru":"European", "sv":"European",
    "es":"Spanish/Latin", "pt":"Spanish/Latin",
}
_WESTERN_COUNTRIES = {"US","GB","AU","NZ","CA","IE"}

def _culture(lang: str | None, countries: list[str]) -> str:
    if lang in _LANG_CULTURE:
        return _LANG_CULTURE[lang]
    if lang == "en":
        return "Western"
    if any(c in _WESTERN_COUNTRIES for c in countries):
        return "Western"
    return "Other"


# CAS-937: OscarBase — free, no API key, 100 requests/minute (https://api.oscarbase.com).
# `GET /api/movies?tmdb_id=<id>` returns `{"data": [...], "pagination": {"total": ...}}`, filtered
# exactly by tmdb_id (never title — the Kingdom collision, 2026-09-08). `GET /api/movies/{id}`
# returns `{"data": {..., "nominations": [{category, nominee, winner, ceremony_year}, ...]}}`.
# Validated live against Oppenheimer (tmdb_id 872585) during the build: 13 nominations across 8
# categories, 7 of them Won — matching OMDb's own historical "Won 7 Oscars" for that film exactly,
# which is why `_oscarbase_award_state` counts distinct WON CATEGORIES, not raw nomination rows
# (Best Picture alone carries 3 winning producer rows that must collapse to one won category).
def _oscarbase_award_state(nominations: list) -> tuple[str | None, str, list]:
    """Reduce OscarBase's flat nomination rows for one film into (award, award_text,
    oscar_detail) — the same `{category, result, person?}` shape `enrich_wikidata_awards` used to
    build (so `oscarChips` / `awardsBreakdownHTML` in app_template.html need no change). One entry
    per category: Won beats Nominated when a category carries both, and `person` is named only
    when exactly one nominee is credited for that result — an ensemble win like Best Picture's
    several producers collapses to the plain category line, same as Wikidata's shape did.
    `(None, "", [])` means no OscarBase row for this film — never write anything for it."""
    if not nominations:
        return None, "", []
    by_category: dict[str, dict] = {}
    for n in nominations:
        category = n.get("category")
        if not category:
            continue
        g = by_category.setdefault(category, {"won": set(), "nom": set()})
        (g["won"] if n.get("winner") else g["nom"]).add(n.get("nominee"))
    detail = []
    for category, g in by_category.items():
        result = "Won" if g["won"] else "Nominated"
        persons = g["won"] if result == "Won" else g["nom"]
        entry = {"category": category, "result": result}
        if len(persons) == 1:
            entry["person"] = next(iter(persons))
        detail.append(entry)
    wins = sum(1 for d in detail if d["result"] == "Won")
    if wins:
        award, award_text = "won", f"Won {wins} Oscar{'s' if wins != 1 else ''}."
    else:
        award, award_text = "nominated", f"Nominated for {len(detail)} Oscar{'s' if len(detail) != 1 else ''}."
    return award, award_text, detail


def _apply_oscarbase_award_fields(movie: dict, nominations: list) -> None:
    """Write award/award_text/oscar_detail from a nominations list — or write nothing at all
    when there are none, so a film OscarBase has never heard of is left exactly as it was."""
    award, award_text, detail = _oscarbase_award_state(nominations)
    if award is not None:
        movie["award"] = award
        movie["award_text"] = award_text
        movie["oscar_detail"] = detail


def _oscarbase_lookup_nominations(tmdb_id) -> list:
    """Two-step OscarBase lookup, joined on tmdb_id only: find the film's internal id, then its
    nominations. The list-by-tmdb_id call already filters exactly, but a row is still checked
    against the requested tmdb_id before use — never trust a match by title. `[]` when OscarBase
    carries no film for this id at all — a real, cacheable 'no Oscar history' answer, not a
    fetch failure."""
    listing = get_json(f"{OSCARBASE_BASE}/api/movies?tmdb_id={tmdb_id}")
    rows = [r for r in (listing.get("data") or []) if r.get("tmdb_id") == tmdb_id]
    if not rows:
        return []
    if OSCARBASE_PACING:
        time.sleep(OSCARBASE_PACING)
    detail = get_json(f"{OSCARBASE_BASE}/api/movies/{rows[0]['id']}")
    return (detail.get("data") or {}).get("nominations") or []


def enrich_oscarbase(movie: dict, cache: dict) -> dict:
    """One guarded OscarBase enrich. `cache` (OSCARBASE_CACHE_FILE's loaded contents, keyed by
    `str(tmdb_id)`) is mutated in place on every real fetch — a win/nomination list AND a
    confirmed empty one both count as 'checked' — so the refresh policy
    (`_oscarbase_needs_fetch`) sees this title as already resolved on a later run."""
    tmdb_id = movie["tmdb_id"]
    nominations = _oscarbase_lookup_nominations(tmdb_id)
    cache[str(tmdb_id)] = {"nominations": nominations, "fetched_at": _RUN_DATE}
    _apply_oscarbase_award_fields(movie, nominations)
    return movie


def _oscarbase_needs_fetch(movie: dict, cache: dict, today: datetime.date) -> bool:
    """A title with no cached row yet always needs one. A cached title is only re-fetched while
    its release falls within the last two ceremony years (still-live awards races) — an older
    title's Oscar history is settled and costs nothing on later runs."""
    if str(movie.get("tmdb_id")) not in cache:
        return True
    release = movie.get("cinema_date") or movie.get("release_date") or ""
    try:
        year = int(str(release)[:4])
    except ValueError:
        return False
    return year >= today.year - (OSCARBASE_RECENT_CEREMONY_YEARS - 1)


def enrich_oscarbase_awards_nightly(movies: list, today: datetime.date, cache: dict,
                                    budget: int | None = None) -> dict:
    """CAS-937: the nightly OscarBase awards pass. Runs unconditionally, live or sample data — the
    same tolerance `enrich_watchmode_fields_nightly` gives a missing Watchmode key — since
    OscarBase needs no credential of its own to be live, only a network path. Best-effort per
    `_api_call`: a failed fetch prints its own `[warn]` line and this then falls back to that
    title's cached row (if any) rather than leaving the record silently stale. `cache` is mutated
    in place; the caller persists it to OSCARBASE_CACHE_FILE. Returns an
    `{'ok','cache_fallback','skip','stop'}` outcome-count dict."""
    if budget is None:
        budget = OSCARBASE_BACKFILL_BUDGET
    outcomes = {"ok": 0, "cache_fallback": 0, "skip": 0, "stop": 0}
    open_ = True
    remaining = budget
    candidates = [m for m in movies if _oscarbase_needs_fetch(m, cache, today)]
    for m in candidates:
        if not open_ or remaining <= 0:
            break
        _, outcome = _api_call("OscarBase", enrich_oscarbase, m, cache)
        remaining -= 1
        if outcome == "ok":
            outcomes["ok"] += 1
        else:
            outcomes["stop" if outcome == "stop" else "skip"] += 1
            if outcome == "stop":
                open_ = False
            cached = cache.get(str(m.get("tmdb_id")))
            if cached is not None:
                _apply_oscarbase_award_fields(m, cached.get("nominations") or [])
                outcomes["cache_fallback"] += 1
        if OSCARBASE_PACING:
            time.sleep(OSCARBASE_PACING)
    return outcomes


# ---------------------------------------------------------------------------
# 3a. AVAILABILITY (PRIMARY) — AU watch providers via TMDB (free, data by JustWatch)
# ---------------------------------------------------------------------------
def tmdb_providers(tmdb_id, region=REGION, api_key=None) -> dict:
    """AU watch-provider rows for one title from TMDB (data sourced from JustWatch).
    FREE and unquota'd — this is the primary availability signal (CAS-127), replacing the
    daily Watchmode poll. TMDB gives provider NAMES per category but no price or format;
    Watchmode enrichment fills those on-demand for engaged titles."""
    api_key = api_key or TMDB_KEY
    data = get_json(f"{TMDB_BASE}/movie/{tmdb_id}/watch/providers?api_key={api_key}")
    r = (data.get("results") or {}).get(region) or {}
    return {
        "flatrate": [p["provider_name"] for p in r.get("flatrate", [])],  # subscription/streaming
        "rent":     [p["provider_name"] for p in r.get("rent", [])],
        "buy":      [p["provider_name"] for p in r.get("buy", [])],
        "ads":      [p["provider_name"] for p in r.get("ads", [])],       # ad-supported (free to watch)
        "free":     [p["provider_name"] for p in r.get("free", [])],
        "jw_link":  r.get("link"),        # JustWatch page for AU (attribution / deep-out)
    }


def provider_offers(prov: dict) -> list[dict]:
    """Every AU provider row as a normalised offer (service/type/price/format).
    TMDB carries no price or format, so those are None until Watchmode enriches an
    engaged title. ads/free both map to a free-to-watch 'free' offer."""
    rows  = [(s, "sub")  for s in prov.get("flatrate", [])]
    rows += [(s, "free") for s in (prov.get("free", []) + prov.get("ads", []))]
    rows += [(s, "rent") for s in prov.get("rent", [])]
    rows += [(s, "buy")  for s in prov.get("buy", [])]
    return [{"service": s, "type": t, "price": None, "format": None} for s, t in rows]


def _offerless_window(cinema_date: str | None, today: datetime.date,
                       year: int | None = None, release_dates: list | None = None) -> str:
    """CAS-608: the date-only classification for a title with no usable offer to read a window
    from — judged by the release date, never by whether an offer exists, so a film Cascade can't
    place an AU offer against is never confused with one that genuinely hasn't come out yet.
      not yet opened               -> upcoming (buzz is the whole of its score; 7-day ladder)
      opened, still within its run -> in_cinema (cinemas publish no offers; this is CAS-395's window)
      opened, past its run         -> released (a real, offer-less RELEASED film — 30-day ladder,
                                       still held in the catalogue, judged by qScore like any other
                                       released title. This is the split that used to fall to
                                       "upcoming" and never left it.)
    Mirrored exactly by app_template.html's own offerlessWindow — CAS-608 AC5 asserts they agree
    (that mirror never passes `year`/`release_dates`: see the CAS-1078 note below).

    CAS-1078: `cinema_date` alone used to mean "not yet opened" even for a title with NO AU
    cinema_date at all and a release year already behind us — 82 old back-catalogue titles with
    no AU theatrical release on record stayed `upcoming` forever, because nothing here could tell
    "genuinely still to come" apart from "old title Cascade never got an AU date for". `year`/
    `release_dates` are optional so every existing caller (and the fixture-equality test against
    app_template.html's copy, which only ever exercises the cinema_date-only cases) is unaffected;
    when `cinema_date` is None and the caller supplies a `year` already behind `today` with no AU
    release_dates entry (any type) still ahead of `today`, that title is `released`, not `upcoming`."""
    if not cinema_date:
        if (year is not None and year < today.year
                and not any((rd.get("date") or "") > today.isoformat() for rd in (release_dates or []))):
            return "released"
        return "upcoming"
    opened = cinema_date <= today.isoformat()
    if not opened:
        return "upcoming"
    still_running = cinema_date >= (today - datetime.timedelta(days=CINEMA_RUN_DAYS)).isoformat()
    return "in_cinema" if still_running else "released"


def _record_year(movie: dict) -> int | None:
    y = movie.get("year")
    try:
        return int(y)
    except (TypeError, ValueError):
        return None


def derive_from_providers(movie: dict, prov: dict, today: datetime.date) -> list[str]:
    """Headline Cascade window from TMDB/JustWatch AU providers (CAS-127 cascade):
      flatrate|free|ads  -> included_streaming
      else rent|buy      -> rental (a rent offer exists) or pvod (buy-only, pre-rental).
                            TMDB gives no price, so premium vs standard can't use
                            PVOD_MIN_PRICE — a rentable title is the standard window,
                            a buy-only title is the earlier premium/PVOD window.
      else               -> _offerless_window: upcoming / in_cinema / released, by date alone.
    CAS-395: a title still inside its AU theatrical run (cinema_date within CINEMA_RUN_DAYS) carries
    in_cinema ALONGSIDE whatever home window its offers resolve to — a film that has just opened often
    already has a pre-order/rent row, and the old code let that one row erase in_cinema entirely, which
    is why the shipped catalogue's In Cinema list had collapsed to a couple of titles."""
    windows = []
    if prov.get("flatrate") or prov.get("free") or prov.get("ads"):
        windows.append("included_streaming")
    elif prov.get("rent") or prov.get("buy"):
        windows.append("rental" if prov.get("rent") else "pvod")
    # CAS-418 (walk back CAS-395): in_cinema is EXCLUSIVE with home offers — a film with a rent/stream/
    # buy offer is never filed under the big screen (engine invariant #55). So the offer-less fallback
    # only ever runs when NO home window resolved.
    if not windows:
        windows.append(_offerless_window(movie.get("cinema_date"), today,
                                          _record_year(movie), movie.get("release_dates")))
    return windows


def has_provider_rows(prov: dict) -> bool:
    """True if TMDB/JustWatch has ANY AU availability row for the title."""
    return any(prov.get(k) for k in ("flatrate", "free", "ads", "rent", "buy"))


# ---------------------------------------------------------------------------
# 3b. ENRICHMENT (ON-DEMAND ONLY) — exact AU prices / deep-links via Watchmode
#     Called for titles a user opens or saves, within a small bounded budget —
#     NOT the daily sweep (CAS-127). Prices/formats/deep-links TMDB can't give.
# ---------------------------------------------------------------------------
def poll_watchmode(movie: dict, wm_cache: dict) -> list[dict]:
    """Return normalised offers: [{service, type, price, format}].
    The IMDb->Watchmode id mapping never changes, so cache it: after the first
    sighting each title costs only ONE call/day (sources), ~halving API usage."""
    imdb = movie["imdb_id"]
    wm_id = wm_cache.get(imdb)
    if wm_id is None:                                    # first time we've seen this title
        lookup = get_json(
            "https://api.watchmode.com/v1/search/"
            f"?apiKey={WATCHMODE_KEY}&search_field=imdb_id&search_value={imdb}"
        )
        results = lookup.get("title_results", [])
        if not results:
            return []
        wm_id = results[0]["id"]
        wm_cache[imdb] = wm_id
    sources = get_json(
        f"https://api.watchmode.com/v1/title/{wm_id}/sources/"
        f"?apiKey={WATCHMODE_KEY}&regions={REGION}"
    )
    offers = []
    for s in sources:
        if s.get("region") != REGION:
            continue
        offers.append({
            "service": s.get("name"),
            "type": s.get("type"),          # sub | rent | buy | free
            "price": _num(s.get("price")),
            "format": s.get("format"),      # SD | HD | 4K
        })
    return offers


# ---------------------------------------------------------------------------
# 4. DERIVE — turn raw offers + cinema date into a SET of active windows
# ---------------------------------------------------------------------------
def derive_status(movie: dict, offers: list[dict], today: datetime.date) -> list[str]:
    status = set()

    has_sub  = any(o["type"] in ("sub", "free") for o in offers)
    buys     = [o for o in offers if o["type"] == "buy" and o.get("price")]
    rents    = [o for o in offers if o["type"] == "rent" and o.get("price")]
    cheapest_rent = min((o["price"] for o in rents), default=None)
    dearest_buy   = max((o["price"] for o in buys),  default=None)

    # In cinema: theatrical date has passed and is still inside its AU run (CAS-395: no longer gated on
    # having zero home offers — a film can be in cinemas and on premium/rental/streaming at once).
    cd = movie.get("cinema_date")
    # CAS-418 (walk back CAS-395): in_cinema is EXCLUSIVE with home offers — only assigned in the
    # offer-less fallback below, never alongside a rent/stream/buy window.

    # Premium (PVOD): a dear buy/rent exists and it's not yet on subscription
    if not has_sub and ((dearest_buy and dearest_buy >= PVOD_MIN_PRICE) or
                        (cheapest_rent and cheapest_rent >= PVOD_MIN_PRICE)):
        status.add("pvod")

    # Standard rental: a rent at/under the everyday-rental price
    if cheapest_rent is not None and cheapest_rent <= RENTAL_MAX_PRICE:
        status.add("rental")

    # Included streaming: on a subscription or free/ad-supported service
    if has_sub:
        status.add("included_streaming")

    # CAS-608: date-only, same as derive_from_providers' offer-less fallback — a title past its
    # cinema run with no priced offer is released-and-unavailable, not upcoming.
    if not status:
        status.add(_offerless_window(cd, today, _record_year(movie), movie.get("release_dates")))
    return sorted(status)


# ---------------------------------------------------------------------------
# 4b. MONOTONIC GUARD (CAS-355) — the single source of truth for "how far a title
#     has travelled" toward more availability, and the gate that stops a transient
#     JustWatch AU sync gap from writing a backward status. Both poc_pipeline (below)
#     and monitor/transitions.py (which imports AVAILABILITY_TIERS/tier_rank from here)
#     use it, so "forward" means the same thing to the writer and the alert reader.
# ---------------------------------------------------------------------------
AVAILABILITY_TIERS = ["upcoming", "in_cinema", "pvod", "rental", "included_streaming"]
DOWNGRADE_CONFIRM_RUNS = 2   # consecutive runs a lower reading must repeat before it is trusted
# CAS-578: the tiers that must be BACKED BY A REAL OFFER before window_dates may stamp them.
# in_cinema/upcoming are the two legitimate offer-less windows (CAS-395/CAS-412) — never these three.
HOME_WINDOWS = {"pvod", "rental", "included_streaming"}

def tier_rank(status) -> int:
    """Highest AVAILABILITY_TIERS rank held anywhere in `status` (a status list/set), or
    -1 if it holds none of the named tiers."""
    ranks = [AVAILABILITY_TIERS.index(w) for w in status if w in AVAILABILITY_TIERS]
    return max(ranks) if ranks else -1

def apply_monotonic_status(m: dict, candidate: list[str], confidence: str, today: datetime.date) -> None:
    """Commit `candidate` as m['status'] — unless it is a BACKWARD move (a lower tier than
    the status m already holds), in which case the existing status is kept and the
    regression is only committed once the SAME candidate has been read on
    DOWNGRADE_CONFIRM_RUNS consecutive runs. That is the difference between a real
    de-listing and a one-day gap in the AU provider feed (CAS-334/CAS-355): the feed can
    drop a title's rows for a day and pick it back up the next, and a single such gap must
    never write a status a user could be alerted on losing.

    CAS-418: that protection is only earned by a tier a real offer once backed. A tier
    stamped "estimated" was never confirmed by an offer in the first place (or already lost
    the one it had), so holding it back just freezes a phantom listing for longer — commit
    the offer-honest candidate immediately instead of waiting on DOWNGRADE_CONFIRM_RUNS."""
    prev = m.get("status") or []
    prev_confidence = m.get("availability_confidence")
    if not prev or tier_rank(candidate) >= tier_rank(prev) or prev_confidence == "estimated":
        m["status"] = candidate
        m["availability_confidence"] = confidence
        m.pop("pending_downgrade", None)
        return
    pending = m.get("pending_downgrade")
    if pending and pending.get("to") == candidate:
        pending["runs"] = pending.get("runs", 1) + 1
    else:
        pending = {"to": candidate, "runs": 1, "since": today.isoformat()}
    if pending["runs"] >= DOWNGRADE_CONFIRM_RUNS:
        m["status"] = candidate
        m["availability_confidence"] = confidence
        m.pop("pending_downgrade", None)
    else:
        m["pending_downgrade"] = pending   # held back — m["status"] stays at `prev`


# ---------------------------------------------------------------------------
# 5. DIFF — compare today's status set to the stored one, emit change events
# ---------------------------------------------------------------------------
STATUS_LABEL = {
    "upcoming": "Upcoming",
    "in_cinema": "In Cinema",
    "released": "Released (no AU offer)",
    "pvod": "Premium Buy/Rent (~$30)",
    "rental": "Standard Rental (~$7)",
    "included_streaming": "Included Streaming",
}

def _load_prev_snapshot() -> dict:
    """tmdb_id -> yesterday's committed record, or {} on the very first run. Shared by
    update_window_dates (CAS-578: drops a departed home window's stamp) and diff_and_alert
    (arrival/departure events) — both need the SAME prior status, read before either one
    overwrites SNAPSHOT_FILE for today."""
    if not os.path.exists(SNAPSHOT_FILE):
        return {}
    return {m["tmdb_id"]: m for m in json.load(open(SNAPSHOT_FILE, encoding="utf-8"))}


def diff_and_alert(today_records: list[dict]) -> list[dict]:
    prev = _load_prev_snapshot()

    events = []
    for m in today_records:
        before = set(prev.get(m["tmdb_id"], {}).get("status", []))
        after  = set(m["status"])
        opened = after - before
        before_rank = tier_rank(before)
        for w in opened:
            # CAS-355: a newly-present window only alerts when it is FORWARD progress —
            # strictly further along AVAILABILITY_TIERS than anything the title already
            # held. Without this, a title that lost a high tier and landed on a lower one
            # (included_streaming -> rental, via a transient AU provider gap) read as
            # "gained rental" and fired a false alert; a real backward move never should.
            if before and tier_rank([w]) > before_rank:
                events.append({
                    "tmdb_id": m["tmdb_id"],
                    "title": m["title"],
                    "kind": "arrived",
                    "new_window": w,
                    "label": STATUS_LABEL.get(w, w),
                    "services": [o["service"] for o in m.get("offers", [])
                                 if _window_of(o) == w][:3],
                    "detected": today_records_date(),
                })
        # CAS-578 R4: a film LEAVING a window is exactly as interesting as one entering it — "it's
        # leaving Netflix on Sunday" is arguably the more valuable alert. `before`/`after` are
        # already the monotonic-guard-resolved statuses (apply_monotonic_status only ever commits a
        # backward move once it is CONFIRMED — CAS-355), so a window missing here is a real, settled
        # departure, never a one-day provider-feed gap.
        for w in before - after:
            events.append({
                "tmdb_id": m["tmdb_id"],
                "title": m["title"],
                "kind": "left",
                "lost_window": w,
                "label": STATUS_LABEL.get(w, w),
                "detected": today_records_date(),
            })
    # persist
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(today_records, open(SNAPSHOT_FILE, "w", encoding="utf-8"), indent=2)
    existing = json.load(open(ALERTS_FILE, encoding="utf-8")) if os.path.exists(ALERTS_FILE) else []
    json.dump(existing + events, open(ALERTS_FILE, "w", encoding="utf-8"), indent=2)
    return events


# ---------------------------------------------------------------------------
# CAS-1046 — per-run refresh log for the admin site (cascade-admin.pages.dev, a separate repo),
# served from state/refresh_log.json. daily.yml already commits everything under state/, so this
# needs no workflow change.
# ---------------------------------------------------------------------------
REFRESH_LOG_BOOKKEEPING_FIELDS = {
    "last_polled", "last_probed", "probe_count", "cache_stamped_at",
    "wm_fields_fetched_at", "poll_tier", "tmdb_not_found_streak",
}
REFRESH_LOG_WATCHMODE_FIELDS = {"wm_user_rating", "wm_critic_score", "wm_popularity_percentile"}
REFRESH_LOG_OSCARBASE_FIELDS = {"award", "award_text"}
REFRESH_LOG_STATUSES = ("upcoming", "in_cinema", "pvod", "rental", "included_streaming", "released")
REFRESH_LOG_AGE_BUCKETS = ("unreleased", "under_1y", "1_to_5y", "5_to_20y", "over_20y", "unknown")


def _refresh_log_changed_fields(prev_m: dict, today_m: dict) -> set:
    """Field names that differ between the same title's yesterday/today record, ignoring the
    bookkeeping fields a poll can touch with no real content change (CAS-1046 spec)."""
    keys = (set(prev_m) | set(today_m)) - REFRESH_LOG_BOOKKEEPING_FIELDS
    return {k for k in keys if prev_m.get(k) != today_m.get(k)}


def _refresh_log_sources_for_update(changed: set, availability_source) -> set:
    """Which provider(s) a title's `changed` field set counts against. A title can count for more
    than one source. offers/status changes are TMDB's (the daily availability poll) UNLESS this
    title's current availability_source is watchmode_enriched, in which case they are Watchmode's."""
    sources = set()
    if changed & REFRESH_LOG_WATCHMODE_FIELDS:
        sources.add("watchmode")
    if changed & REFRESH_LOG_OSCARBASE_FIELDS:
        sources.add("oscarbase")
    rest = changed - REFRESH_LOG_WATCHMODE_FIELDS - REFRESH_LOG_OSCARBASE_FIELDS
    if availability_source == "watchmode_enriched" and (rest & {"offers", "status"}):
        sources.add("watchmode")
        rest -= {"offers", "status"}
    if rest:
        sources.add("tmdb")
    return sources


def _refresh_log_age_bucket(m: dict, run_date: datetime.date) -> str:
    """Age is measured from run_date to cinema_date (falling back to 1 July of `year`).
    unreleased = that date is in the future, or the title's status is upcoming;
    unknown = no usable date at all (CAS-1046 spec)."""
    d = None
    cinema_date = m.get("cinema_date")
    if cinema_date:
        try:
            d = datetime.date.fromisoformat(cinema_date)
        except ValueError:
            d = None
    if d is None:
        try:
            d = datetime.date(int(m.get("year")), 7, 1)
        except (TypeError, ValueError):
            d = None
    if d is None:
        return "unknown"
    status0 = (m.get("status") or [None])[0]
    if d > run_date or status0 == "upcoming":
        return "unreleased"
    age_days = (run_date - d).days
    if age_days < 365:
        return "under_1y"
    if age_days < 5 * 365:
        return "1_to_5y"
    if age_days < 20 * 365:
        return "5_to_20y"
    return "over_20y"


def build_refresh_log_entry(prev_records: list[dict], today_records: list[dict], run_stats: dict,
                             run_at: datetime.datetime, github_run_id: str | None = None) -> dict:
    """CAS-1046: the pure counting function behind state/refresh_log.json — previous records,
    today's records, today's run_stats.json contents and the run's own timestamp go in; one
    refresh_log.json entry comes out. No file I/O, no network, so it is unit-testable in isolation.

    new/removed/updated/unchanged and the per-title source attribution are exactly the definitions
    in the ticket: see REFRESH_LOG_BOOKKEEPING_FIELDS (never counts as an update on its own) and
    _refresh_log_sources_for_update (a title may count for more than one source)."""
    prev = {m["tmdb_id"]: m for m in prev_records}
    today = {m["tmdb_id"]: m for m in today_records}
    prev_ids, today_ids = set(prev), set(today)
    new_ids = today_ids - prev_ids
    removed_ids = prev_ids - today_ids
    common_ids = prev_ids & today_ids

    updated_ids, unchanged_ids = set(), set()
    status_changes: dict = {}
    source_updated = {"tmdb": 0, "watchmode": 0, "oscarbase": 0}
    for tid in common_ids:
        p, t = prev[tid], today[tid]
        changed = _refresh_log_changed_fields(p, t)
        if changed:
            updated_ids.add(tid)
            for src in _refresh_log_sources_for_update(changed, t.get("availability_source")):
                source_updated[src] += 1
        else:
            unchanged_ids.add(tid)
        old_status = (p.get("status") or [None])[0]
        new_status = (t.get("status") or [None])[0]
        if old_status != new_status:
            key = f"{old_status}->{new_status}"
            status_changes[key] = status_changes.get(key, 0) + 1

    new_by_status = {s: 0 for s in REFRESH_LOG_STATUSES}
    new_by_status["other"] = 0
    new_by_age = {b: 0 for b in REFRESH_LOG_AGE_BUCKETS}
    source_new = {"tmdb": 0, "watchmode": 0}
    notes = []
    if new_ids:
        # Hypothesis (CAS-1046): discovery path isn't recorded separately from the fields that
        # already land on the record, so a new title's own availability_source is the reliable
        # attribution — tmdb_date/tmdb_providers/estimated_unpolled -> tmdb, watchmode_enriched
        # -> watchmode. Disproving this (and picking a more accurate method) is left as a TODO.
        notes.append("films_new attributed by each new title's availability_source "
                     "(discovery path is not separately recorded on the record).")
    for tid in new_ids:
        m = today[tid]
        status0 = (m.get("status") or [None])[0]
        new_by_status[status0 if status0 in new_by_status else "other"] += 1
        new_by_age[_refresh_log_age_bucket(m, run_at.date())] += 1
        if m.get("availability_source") == "watchmode_enriched":
            source_new["watchmode"] += 1
        else:
            source_new["tmdb"] += 1

    tmdb_stats = run_stats.get("tmdb", {}) or {}
    wm_stats = run_stats.get("watchmode", {}) or {}
    ob_stats = run_stats.get("oscarbase", {}) or {}

    return {
        "run_at": run_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "run_date": run_at.date().isoformat(),
        "github_run_id": github_run_id,
        "catalogue": {
            "before": len(prev_ids), "after": len(today_ids),
            "new": len(new_ids), "removed": len(removed_ids),
            "updated": len(updated_ids), "unchanged": len(unchanged_ids),
        },
        "new_by_status": new_by_status,
        "new_by_age": new_by_age,
        "status_changes": status_changes,
        "sources": {
            "tmdb": {"calls": tmdb_stats.get("calls", 0), "errors": tmdb_stats.get("errors", 0),
                     "not_found": tmdb_stats.get("not_found", 0),
                     "films_new": source_new["tmdb"], "films_updated": source_updated["tmdb"]},
            "watchmode": {"calls": wm_stats.get("calls", 0), "errors": wm_stats.get("errors", 0),
                          "films_new": source_new["watchmode"], "films_updated": source_updated["watchmode"]},
            "oscarbase": {"calls": ob_stats.get("calls", 0), "errors": ob_stats.get("errors", 0),
                          "films_updated": source_updated["oscarbase"]},
        },
        "notes": notes,
    }


def _load_refresh_log() -> dict:
    """{"runs": [...]} — or a fresh, empty one if the file is missing OR corrupt (CAS-1046:
    a bad file must never fail the run; it just loses its own history and starts over)."""
    if os.path.exists(REFRESH_LOG_FILE):
        try:
            data = json.load(open(REFRESH_LOG_FILE, encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("runs"), list):
                return data
        except Exception:
            pass
    return {"runs": []}


def append_refresh_log(entry: dict) -> None:
    """Prepend `entry` to state/refresh_log.json, newest first, capped at the REFRESH_LOG_CAP
    most recent runs."""
    data = _load_refresh_log()
    data["runs"] = [entry] + data["runs"]
    data["runs"] = data["runs"][:REFRESH_LOG_CAP]
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(data, open(REFRESH_LOG_FILE, "w", encoding="utf-8"), indent=2)


# ---------------------------------------------------------------------------
# CAS-578 R6 — the guard that would have caught D1. A real release schedule staggers arrivals
# across the year; three bad runs (2026-07-22/07-23/08-02) each mass-stamped the SAME window onto
# ~2% of the whole catalogue in one day. 5% is comfortably above any legitimate single-day
# reclassification this catalogue has ever shown.
# ---------------------------------------------------------------------------
MASS_STAMP_GUARD_PCT = 0.05


class MassStampGuardTripped(RuntimeError):
    """Raised by check_mass_stamp_guard when one run would move too much of the catalogue into a
    single window at once — refuse the write rather than persist what is probably a mass-stamp bug
    like CAS-578's D1, rather than a real release day."""


MASS_STAMP_ACK_FILE = os.path.join(STATE_DIR, "mass_stamp_ack.json")


def _load_mass_stamp_ack() -> dict | None:
    """CAS-992: the committed one-off acknowledgement that lets ONE deliberate reclassification
    (CAS-608's ~951-title released/upcoming correction) through the CAS-578 guard once, without
    weakening it for any other run or window. Returns None when the file is absent or unreadable —
    the guard then applies exactly as it did before this ticket."""
    if not os.path.exists(MASS_STAMP_ACK_FILE):
        return None
    try:
        return json.load(open(MASS_STAMP_ACK_FILE, encoding="utf-8"))
    except (OSError, ValueError):
        return None


def check_mass_stamp_guard(records: list[dict], prev_by_id: dict, pct: float = MASS_STAMP_GUARD_PCT,
                           today: datetime.date | None = None, ack: dict | None = None) -> None:
    """Raise MassStampGuardTripped if this run would move more than `pct` of the WHOLE catalogue
    into one window it did not hold yesterday. A title's very first sighting is excluded — that is
    catalogue GROWTH (e.g. CAS-128's cap lift, which moved thousands of titles from "doesn't exist
    yet" into some window in one run), not a reclassification of an existing record, and diff_and_alert's
    own arrival events already draw the same "first sighting doesn't count" line.

    CAS-992: `ack` (defaulting to `_load_mass_stamp_ack()`, i.e. state/mass_stamp_ack.json) can
    cover exactly ONE tripped window — only when it is the ack's own named window, only at or
    below the ack's own `max_titles`, and only on a run date (`today`, defaulting to `_RUN_DATE`)
    at or before the ack's own `valid_through`. Any other tripped window, a larger count, a later
    date, or no ack at all still raises. `pct`/threshold are never affected by an ack."""
    total = len(records)
    if not total:
        return
    threshold = max(1, int(total * pct))
    gained: dict[str, int] = {}
    for m in records:
        tid = m.get("tmdb_id")
        if tid not in prev_by_id:
            continue
        before = set(prev_by_id[tid].get("status", []))
        after = set(m.get("status", []))
        for w in after - before:
            gained[w] = gained.get(w, 0) + 1
    tripped = {w: n for w, n in gained.items() if n > threshold}
    if not tripped:
        return

    if ack is None:
        ack = _load_mass_stamp_ack()
    if ack:
        window = ack.get("window")
        max_titles = ack.get("max_titles")
        valid_through = ack.get("valid_through")
        run_date = today if today is not None else datetime.date.fromisoformat(_RUN_DATE)
        if (window in tripped and tripped[window] <= max_titles and valid_through
                and run_date <= datetime.date.fromisoformat(valid_through)):
            print(f"[info] CAS-992: mass-stamp guard acknowledgement used for window '{window}' "
                  f"({tripped[window]} title(s) <= {max_titles}, valid through {valid_through}, "
                  f"reason: {ack.get('reason')})")
            tripped = {w: n for w, n in tripped.items() if w != window}
            if not tripped:
                return

    raise MassStampGuardTripped(
        f"refusing to write this run: {tripped} title(s) would newly enter one window out of "
        f"{total} ( > {pct:.0%}, threshold {threshold} ) — looks like a mass-stamp bug (CAS-578), "
        f"not a real release day")


# ---------------------------------------------------------------------------
# CAS-578 R2/R3 — window_dates becomes CORRECTABLE, not append-only. A home window (pvod/rental/
# included_streaming) is only ever stamped when a real offer corroborates it THIS run — the
# window_dates-layer half of CAS-412's belt-and-suspenders, since CAS-412 alone only stopped the ONE
# path that used to invent a paid tier with zero offers (D1's actual trigger — see the CAS-578 fix
# comment). in_cinema/upcoming stay offer-less by design (CAS-395/CAS-418) and are untouched here.
# And once a window genuinely LEAVES status — a monotonic-guard-CONFIRMED departure, the same
# before/after this run's diff_and_alert uses for its mirror-image "left" event, never a one-day
# provider gap — its stamp is removed: a first-seen date for a window the film no longer holds is
# not history worth keeping stamped as current.
# ---------------------------------------------------------------------------
def update_window_dates(records: list[dict], wd: dict, prev_by_id: dict, tstamp: str) -> dict:
    """Merge today's records into the persistent window_dates store `wd` (str(tmdb_id) -> {window:
    first_seen_date}), also setting each record's own m["window_dates"] to the SAME dict. Pure (no
    file IO) so tests can drive it directly — run() owns the load/persist around it."""
    for m in records:
        key = str(m["tmdb_id"]); rec = wd.get(key, {})
        offer_windows = {w for w in (_window_of(o) for o in m.get("offers", [])) if w}
        prev_status = set(prev_by_id.get(m["tmdb_id"], {}).get("status", []))
        status = set(m.get("status", []))
        for w in status:
            if w in HOME_WINDOWS and w not in offer_windows:
                continue                              # status claims it, no offer backs it today
            rec.setdefault(w, tstamp)                  # earliest date this window was ever earned
        for w in (prev_status - status) & HOME_WINDOWS:
            rec.pop(w, None)                           # confirmed departure — the stamp isn't current history
        # CAS-1043: TMDB occasionally corrects a title's cinema_date to a later date after a window
        # was already stamped against the old (earlier) one, leaving a stamp that now predates the
        # film's own opening — an impossible date (test_no_window_is_stamped_before_the_film_opened).
        # "upcoming" is exempt: it is deliberately the pre-release stamp. A window `status` still
        # holds today is re-stamped as first seen today (re-stamping to a still-future opening date
        # would only trade one impossible date for another); a window `status` no longer holds is a
        # stale leftover the correction has invalidated outright, so it is dropped, the same as a
        # confirmed departure above.
        opened = m.get("cinema_date")
        if opened:
            for w in list(rec):
                if w != "upcoming" and rec[w] < opened:
                    if w in status:
                        rec[w] = tstamp
                    else:
                        rec.pop(w, None)
        wd[key] = rec
        m["window_dates"] = rec
    return wd


def _window_of(offer: dict) -> str:
    # CAS-578 AC8 (the free-offer decision, stated rather than folded in silently): `free` (Tubi,
    # Plex, Hoopla, SBS On Demand — watchable with no payment, but not a subscription) maps onto
    # included_streaming, the same window a subscription earns. Both let a viewer watch the film
    # right now for $0 extra, which is the distinction Cascade's windows exist to draw; a separate
    # "free" window would only split one no-cost answer into two. derive_status/derive_from_providers
    # already made this same call independently — this is the one place it is written down.
    if offer["type"] in ("sub", "free"): return "included_streaming"
    if offer["type"] == "buy":  return "pvod"
    if offer["type"] == "rent":
        # A priced rent splits premium(pvod)/standard(rental) on PVOD_MIN_PRICE; a
        # price-less rent (TMDB providers give no price) is the standard rental window,
        # matching derive_from_providers so alert `services` line up with the window.
        return "rental" if (offer.get("price") or 0) <= RENTAL_MAX_PRICE else "pvod"
    return ""


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _num(v):
    try: return round(float(str(v).replace("$", "").replace(",", "")), 2)
    except (TypeError, ValueError): return None

def _int(v):
    try: return int(str(v).replace(",", "").replace("$", ""))
    except (TypeError, ValueError): return None

_RUN_DATE = datetime.date.today().isoformat()
def today_records_date(): return _RUN_DATE


def _dedupe_by_tmdb_id(movies: list[dict]) -> list[dict]:
    """CAS-383: a title must never appear twice in the catalogue. The ingest passes already
    thread a shared `seen` set so this shouldn't happen from a single run, but a corrupted
    base snapshot (e.g. a git merge of two divergent histories touching the same generated
    file) can still hand this function a list with repeats — so collapse defensively rather
    than trust the caller. When a tmdb_id repeats, keep the record with the most recent
    `last_polled` (freshest availability data); fall back to the first occurrence."""
    best: dict[int, dict] = {}
    for m in movies:
        tid = m["tmdb_id"]
        prior = best.get(tid)
        if prior is None or (m.get("last_polled") or "") > (prior.get("last_polled") or ""):
            best[tid] = m
    return list(best.values())


# ---------------------------------------------------------------------------
# CAS-987: the Watchmode billing cycle. state/api_budget.json now tracks the whole cycle, not one
# fixed daily number — {cycle_start, cycle_end, quota, spent, updated_at, days}, `days` a per-date
# map. CAS-384's original job (a second run the same UTC day sees what an earlier run already
# spent, since Watchmode's quota is counted per key per day, not per run — CAS-161's "how a second
# run happened the same day" 401 on 2026-07-24, recurred 2026-08-05) still lives here, as
# `days[today]`, instead of its own separate {date, wm_spent} file.
# ---------------------------------------------------------------------------
def _wm_cycle_bounds(today: datetime.date, reset_day: int = WM_QUOTA_RESET_DAY) -> tuple:
    """The half-open [cycle_start, cycle_end) billing cycle containing `today`. A reset_day past
    the end of a short month (e.g. day 31 in April) clamps to that month's last day."""
    def _reset_date(year, month):
        day = min(reset_day, calendar.monthrange(year, month)[1])
        return datetime.date(year, month, day)
    this_reset = _reset_date(today.year, today.month)
    if today >= this_reset:
        ny, nm = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
        return this_reset, _reset_date(ny, nm)
    py, pm = (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
    return _reset_date(py, pm), this_reset


def _load_wm_cycle_budget(today: datetime.date) -> dict:
    """Loads state/api_budget.json as the current cycle's {cycle_start, cycle_end, quota, spent,
    updated_at, days} shape. A pre-CAS-987 {date, wm_spent} file, a file from a cycle that has
    since rolled over (today has crossed WM_QUOTA_RESET_DAY), or a missing/unparseable file all
    read the same honest way: a fresh cycle starting now, spent back to 0 — never a raised error."""
    cycle_start, cycle_end = _wm_cycle_bounds(today)
    fresh = {"cycle_start": cycle_start.isoformat(), "cycle_end": cycle_end.isoformat(),
             "quota": WM_MONTHLY_QUOTA, "spent": 0, "updated_at": today.isoformat(), "days": {}}
    if not os.path.exists(API_BUDGET_FILE):
        return fresh
    try:
        data = json.load(open(API_BUDGET_FILE, encoding="utf-8"))
    except Exception:
        return fresh
    if "days" not in data or data.get("cycle_end") != cycle_end.isoformat():
        return fresh
    days = data.get("days") or {}
    return {"cycle_start": data.get("cycle_start", fresh["cycle_start"]), "cycle_end": data["cycle_end"],
            "quota": data.get("quota", WM_MONTHLY_QUOTA), "spent": sum(days.values()),
            "updated_at": data.get("updated_at", fresh["updated_at"]), "days": days}


def _save_wm_cycle_budget(cycle: dict, today: datetime.date) -> None:
    os.makedirs(STATE_DIR, exist_ok=True)
    out = dict(cycle)
    out["spent"] = sum(out.get("days", {}).values())
    out["updated_at"] = today.isoformat()
    json.dump(out, open(API_BUDGET_FILE, "w", encoding="utf-8"), indent=2, sort_keys=True)


def compute_wm_today_allowance(quota: int, reserve_pct: float, spent_this_cycle: int,
                               days_remaining_including_today: int) -> int:
    """CAS-987: today's Watchmode spend ceiling, paced against the real billing cycle rather than
    a fixed daily number. Holds back `reserve_pct` of the quota for on-demand/manual runs, then
    spreads what's left evenly across the days remaining in the cycle (today included) — so a
    quiet start to the cycle doesn't get spent all at once, and the last day of a cycle still
    hands over its whole remaining pot rather than a sliver of it."""
    if days_remaining_including_today <= 0:
        return 0
    spendable = quota * (1 - reserve_pct / 100) - spent_this_cycle
    return max(0, int(spendable // days_remaining_including_today))


def split_wm_pot(pot: int, nightly_weight: int, ondemand_weight: int,
                 scoreability_weight: int) -> tuple:
    """CAS-987: split one Watchmode credit pot into the nightly-fields/on-demand/scoreability-
    probe shares run() hands to each pass, in the ratio of the three (formerly independent, fixed)
    weights. The weights decide proportion only; their SUM together can never exceed `pot`, so a
    run that reaches the allowance (`pot` == 0) hands every pass a cap of 0 and none of them makes
    another Watchmode call. Returns (ondemand_cap, nightly_cap, scoreability_cap); scoreability
    takes the rounding remainder so the three always sum to exactly `pot`."""
    weight_total = nightly_weight + ondemand_weight + scoreability_weight
    if weight_total <= 0 or pot <= 0:
        return 0, 0, max(0, pot)
    ondemand_cap = round(pot * ondemand_weight / weight_total)
    nightly_cap = round(pot * nightly_weight / weight_total)
    scoreability_cap = max(0, pot - ondemand_cap - nightly_cap)
    return ondemand_cap, nightly_cap, scoreability_cap


def wm_run_allowance(today: datetime.date, run_max_credits: int | None = None) -> int:
    """CAS-994: this run's whole Watchmode credit pot — the single gate every credit-costing call
    path (the nightly fields pass, on-demand enrichment, the CAS-986 scoreability probe) is capped
    against, via split_wm_pot.

    `run_max_credits` (the WM_RUN_MAX_CREDITS repo variable, default 0) is a hard ceiling. 0 means
    the run spends nothing: GET /status is skipped too (it's a live figure, not a credit cost, but
    not worth the round-trip when the ceiling has already decided the answer), and this prints the
    paused line the ticket's `[watchmode] paused: WM_RUN_MAX_CREDITS=0` names.

    Non-zero: GET /status (0 credits) for Watchmode's own live {quota, quotaUsed}, then pace that
    against the real billing cycle with the same CAS-987 formula (compute_wm_today_allowance) the
    old state/api_budget.json-driven allowance used — except fed by the account's live figures
    instead of the local ledger, which had drifted from what Watchmode's own dashboard showed
    (this ticket's own Why). state/api_budget.json stays as a spend record (run() still writes to
    it) but no longer drives the allowance itself. A failed /status call spends nothing this run
    rather than falling back to any locally-tracked number — the honest answer when the one source
    of truth this now relies on is unavailable."""
    if run_max_credits is None:
        run_max_credits = WM_RUN_MAX_CREDITS
    if run_max_credits <= 0:
        print("[watchmode] paused: WM_RUN_MAX_CREDITS=0")
        return 0
    status, outcome = _api_call("Watchmode status", _fetch_watchmode_status)
    if outcome != "ok" or not status:
        print("[watchmode] /status failed — spending nothing on Watchmode this run.")
        return 0
    quota = status.get("quota", 0)
    quota_used = status.get("quotaUsed", 0)
    cycle_start, cycle_end = _wm_cycle_bounds(today)
    days_remaining = (cycle_end - today).days
    paced = compute_wm_today_allowance(quota, WM_CYCLE_RESERVE_PCT, quota_used, days_remaining)
    pot = max(0, min(run_max_credits, paced))
    print(f"[watchmode] run allowance {pot} (ceiling {run_max_credits}, live quota {quota} used "
          f"{quota_used}, {days_remaining} day(s) left this cycle)")
    return pot


def _load_monthly_wm_spend(today):
    """CAS-974: same stale-date-means-fresh-allowance rule as _load_wm_cycle_budget, keyed by
    month instead of billing cycle — health.py's remaining-credits check needs the month's running
    total, not the cycle figure api_budget.json tracks for a different purpose (CAS-987's pacing)."""
    month = today.strftime("%Y-%m")
    if not os.path.exists(WM_MONTHLY_FILE):
        return {}
    try:
        data = json.load(open(WM_MONTHLY_FILE, encoding="utf-8"))
    except Exception:
        return {}
    return data if data.get("month") == month else {}


def _save_monthly_wm_spend(today, wm_spent):
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump({"month": today.strftime("%Y-%m"), "wm_spent": wm_spent},
               open(WM_MONTHLY_FILE, "w", encoding="utf-8"), indent=2)


# ---------------------------------------------------------------------------
# CAS-109 — build the persistent catalogue, poll only the daily set, carry the rest
# ---------------------------------------------------------------------------
def build_live_catalogue(today, base_records, wm_cache, offsets=None, ondemand_ids=None,
                         wm_spent_today=0, wm_budget_cap=None, poll_set_kwargs=None):
    """Merge new TMDB ingest into the persistent base, then derive availability for the
    WHOLE released catalogue from TMDB Watch Providers (free, one call/title/day — CAS-127).
    Watchmode is spent only to ENRICH the on-demand set (titles a user opened/saved) with
    exact prices + deep-links, within a small bounded budget.

    `wm_spent_today` (CAS-384) is what an earlier run already spent against TODAY's free-tier
    allowance — this run's pot shrinks by that much so two runs stay under one real
    per-key-per-day cap. No file IO here — run() loads/persists spend, same pattern as
    wm_cache below.

    `wm_budget_cap` (CAS-987) overrides ONDEMAND_WM_CAP as the on-demand ceiling before
    `wm_spent_today` is subtracted — the caller's share of the one cycle-paced Watchmode pot,
    rather than a fixed number. `None` (the default) keeps the pre-CAS-987 fixed-cap behaviour.
    `poll_set_kwargs` similarly overrides `ps.select_daily_poll_set`'s own daily_budget/
    active_cap/reserve defaults, so the CAS-987 allocator can pace those too.

    Deps (ingest_tmdb / ingest_tmdb_upcoming / ingest_tmdb_streaming / ingest_watchmode /
    poll_watchmode / tmdb_providers / derive_from_providers / derive_status) are module
    functions so tests can monkeypatch them.
    No file IO here — run() persists the result. Returns (catalogue_records, counts)."""
    offsets = offsets or ps.DEFAULT_OFFSETS
    base = {m["tmdb_id"]: m for m in base_records}
    seen = set(base)

    # grow the catalogue with new titles the spine surfaces that we don't already hold.
    # CAS-773: CASCADE_SPINE picks the vendor; "tmdb" (the default) is byte-identical to
    # pre-v2 behaviour, and the watchmode path is never entered unless it's explicitly set.
    # CAS-981: this must run every refresh, not only while len(base) < CATALOGUE_TARGET — the
    # sort+slice below already enforces the cap on its own, and a size guard here just freezes
    # the catalogue solid the first run it reaches CATALOGUE_TARGET.
    if CASCADE_SPINE == "watchmode":
        # CAS-994: wm_budget_cap == 0 is this run's paused/exhausted signal (never None — see the
        # docstring above) — the watchmode-spine ingest costs credits too, so it is gated the
        # same as every other Watchmode call path, not just the on-demand poll below. No new
        # titles from this spine this run, rather than silently falling back to the TMDB spine.
        new = ingest_watchmode(seen) if wm_budget_cap != 0 else []
    else:
        new = ingest_tmdb(seen) + ingest_tmdb_upcoming(seen) + ingest_tmdb_streaming(seen)
    new_unique = [m for m in new if m["tmdb_id"] not in base]
    catalogue = list(base.values()) + new_unique
    catalogue = _dedupe_by_tmdb_id(catalogue)
    catalogue.sort(key=lambda m: m.get("popularity") or 0, reverse=True)
    pre_slice_count = len(catalogue)
    # CAS-986: the full merged, popularity-sorted pool BEFORE the CATALOGUE_TARGET slice below —
    # candidates.json accumulates from this, not from the sliced `catalogue` return value, so a
    # title dropped by the slice this run is still retained as a candidate rather than forgotten.
    full_discovery_pool = list(catalogue)
    catalogue = catalogue[:CATALOGUE_TARGET]
    dropped = pre_slice_count - len(catalogue)
    print(f"[discovery] discovered={len(new)} new={len(new_unique)} dropped={dropped}")

    # Watchmode is on-demand only now: the poll-set matters just for the engaged titles.
    sched = ps.select_daily_poll_set(catalogue, today, ondemand_ids=ondemand_ids,
                                     **(poll_set_kwargs or {}))
    ondemand_set = {m["tmdb_id"] for m in sched["ondemand"]}
    provider_calls = wm_calls = cinema_calls = 0
    provider_not_found = cinema_not_found = 0   # CAS-997 Defect 2: 404s, tallied apart from real errors
    # CAS-1011: real per-status-code tally for the two TMDB call sites that feed provider_calls/
    # cinema_calls below (not revalidate_record — that pass never counts toward calls/errors at
    # all) — see _api_call's docstring for why this, not *_fails, is the true error tally.
    tmdb_status_counts: Counter = Counter()
    # CAS-384: shrink today's pot by whatever an earlier run already spent against the SAME free-tier
    # day, so two runs sharing one real cap can't each claim a full allowance.
    ondemand_cap = ONDEMAND_WM_CAP if wm_budget_cap is None else wm_budget_cap
    wm_budget = max(0, ondemand_cap - wm_spent_today)
    cinema_backfill = CINEMA_RELEASE_BACKFILL_BUDGET   # CAS-379: its own pot, same reasoning
    # CAS-161: per-API health for this run. `*_open` goes False the first time an API says something that is
    # true of the whole run (cap hit, key rejected) rather than of one title; the `*_fails` tallies are the
    # honest count of titles that kept yesterday's data, printed at the end so a degraded run is visible.
    wm_open = prov_open = cinema_open = True
    wm_fails = prov_fails = cinema_fails = 0

    for m in catalogue:
        # CAS-997 Defect 2: whether ANY TMDB call for this title this run confirmed it still exists
        # or reported it not-found — decides the persistent tmdb_not_found_streak update below, once
        # per title rather than once per call, so a title hit by both the cinema backfill and the
        # providers call in the same run is never double-counted.
        title_tmdb_ok = title_tmdb_not_found = False

        # CAS-379: back-fill pre-CAS-360 records regardless of poll tier — an upcoming title carried
        # forward from before the field existed is just as stuck as a released one.
        if "cinema_release" not in m and cinema_open and cinema_backfill > 0:
            _, cinema_outcome = _api_call("TMDB release_dates", enrich_cinema_release, m,
                                          status_counts=tmdb_status_counts)
            cinema_calls += 1; cinema_backfill -= 1
            if cinema_outcome == "stop":
                cinema_open = False
            if cinema_outcome == "not_found":
                cinema_not_found += 1
                title_tmdb_not_found = True
            elif cinema_outcome != "ok":
                cinema_fails += 1
            else:
                title_tmdb_ok = True

        tier = ps.classify_tier(m, today)
        m["poll_tier"] = tier
        if tier == "none":                                   # upcoming — known from TMDB date
            m["offers"] = []
            m["status"] = ["upcoming"]
            m["availability_confidence"] = "confirmed"
            m["availability_source"] = "tmdb_date"
        else:
            # PRIMARY availability: free TMDB Watch Providers (AU), every released title, daily.
            prov, prov_outcome = (_api_call("TMDB providers", tmdb_providers, m["tmdb_id"],
                                            status_counts=tmdb_status_counts)
                                  if prov_open else (None, "skip"))
            if prov_open:
                provider_calls += 1
            if prov_outcome == "stop":
                prov_open = False
            if prov_outcome == "not_found":
                provider_not_found += 1
                title_tmdb_not_found = True
            if prov_outcome == "ok":
                title_tmdb_ok = True
                m["jw_link"] = prov.get("jw_link")           # JustWatch deep-out + attribution
                prev_offers = m.get("offers", [])
                if has_provider_rows(prov):
                    new_offers = provider_offers(prov)
                    apply_monotonic_status(m, derive_from_providers(m, prov, today), "confirmed", today)
                else:
                    # CAS-412: JustWatch has no AU row at all, so there is no real offer to back a home
                    # window (pvod/rental/included_streaming). estimate_status's age ladder used to be
                    # used here, but it can invent a paid tier (e.g. "pvod", once a title outlives the
                    # in-cinema estimate cap) with zero offers behind it and no route back to in_cinema,
                    # since the ladder never re-computes a lower answer as the same title ages further.
                    # derive_from_providers' own cinema-date-only fallback (empty `prov` in every window
                    # check) is offer-honest: in_cinema while the title is still opened, upcoming before.
                    new_offers = []
                    apply_monotonic_status(m, derive_from_providers(m, prov, today), "estimated", today)
                # CAS-1008 (D1/D2): apply_monotonic_status can HOLD a backward move back rather than
                # commit it (pending_downgrade set) — m["status"] then still reads yesterday's tier.
                # The old code overwrote m["offers"] with today's real read regardless, so a held
                # confirmed home window (or included_streaming) could sit next to zero offers, or
                # offers of a type that no longer backs it (rent-only under a held included_streaming).
                # Offers must move in lockstep with status: only once the candidate is actually
                # committed does today's real offer list apply.
                m["offers"] = prev_offers if m.get("pending_downgrade") else new_offers
                m["last_polled"] = today.isoformat()
                m["availability_source"] = "tmdb_providers"
            else:
                # CAS-161: the call failed, so we know nothing new. Yesterday's confirmed window is worth far
                # more than an estimate invented from a failed read, so keep it — and deliberately do NOT
                # stamp last_polled, because the app's confirmed/estimated badge must never claim a read that
                # did not happen. A title we have never successfully polled has nothing to keep, so it falls
                # back to the honest date-based estimate rather than being left window-less.
                # CAS-997: a 404 (title not found) is tallied separately above (provider_not_found),
                # not here — it is not a fetch outage, so it must not count toward prov_fails/errors.
                if prov_outcome != "not_found":
                    prov_fails += 1
                if not m.get("status"):
                    w, conf = ps.estimate_status(m, today, offsets)
                    m["offers"] = []
                    m["status"] = [w]
                    m["availability_confidence"] = conf
                    m["availability_source"] = "estimated_unpolled"
                elif m.get("availability_confidence") == "estimated":
                    # CAS-418: the held tier was already offer-less, so a failed poll must not
                    # freeze it either — fall back to the same offer-honest, date-based window
                    # the "no AU rows" branch above uses, not the age ladder (CAS-412), which
                    # can reinvent a paid tier with nothing backing it.
                    apply_monotonic_status(m, derive_from_providers(m, {}, today), "estimated", today)
                    m["offers"] = []
                    m["availability_source"] = "estimated_unpolled"

            # ON-DEMAND Watchmode enrichment: exact prices + deep-links for engaged titles only.
            if m["tmdb_id"] in ondemand_set and wm_budget > 0 and m.get("imdb_id") and wm_open:
                wm_offers, wm_outcome = _api_call("Watchmode", poll_watchmode, m, wm_cache)
                wm_calls += 1; wm_budget -= 1
                if wm_outcome == "stop":
                    wm_open = False
                if wm_outcome != "ok":
                    # Keep the TMDB-provider answer already set above: less precise (no real prices), but
                    # true. Watchmode only ever SHARPENS availability, so losing it is a downgrade, not a gap.
                    wm_fails += 1
                elif wm_offers:                              # richer than providers: real prices/formats
                    m["offers"] = wm_offers
                    apply_monotonic_status(m, derive_status(m, wm_offers, today), "confirmed", today)
                    m["availability_source"] = "watchmode_enriched"
                time.sleep(TMDB_PACING)
            if TMDB_PACING:
                time.sleep(TMDB_PACING)                      # polite pacing between provider calls

        # CAS-997 Defect 2: a positive "still exists" answer from TMDB always wins and resets the
        # streak; only a not-found with no confirming call this run advances it. Neither happening
        # (skip/stop only, e.g. the daily cap already hit) leaves the streak exactly as it was —
        # silence is not evidence the title is gone.
        if title_tmdb_ok:
            m["tmdb_not_found_streak"] = 0
        elif title_tmdb_not_found:
            m["tmdb_not_found_streak"] = (m.get("tmdb_not_found_streak") or 0) + 1

        st = set(m.get("status", []))
        if "included_streaming" in st and not (st & ps.ACTIVE_WINDOW):
            m.setdefault("settled_since", today.isoformat())
        else:
            m.pop("settled_since", None)

    # CAS-937: Oscar awards/detail now come from OscarBase, via enrich_oscarbase_awards_nightly —
    # a separate pass in run(), not this LIVE-only build, since OscarBase needs no credential of
    # its own and must run for sample data too (see that function's docstring).

    # CAS-772: revalidation sweep — keep every cached record inside the shorter applicable TTL,
    # spread across the window (select_revalidation_candidates caps this run's share) rather than
    # one giant sweep.
    revalidation_open = True
    revalidated = 0
    for m in select_revalidation_candidates(catalogue, today, budget=REVALIDATION_DAILY_BUDGET):
        if not revalidation_open:
            break
        _, outcome = _api_call("TMDB revalidate", revalidate_record, m, today)
        if outcome == "stop":
            revalidation_open = False
        if outcome == "ok":
            revalidated += 1
        if TMDB_PACING:
            time.sleep(TMDB_PACING)

    counts = dict(sched["counts"])
    # CAS-986: handed to candidates.json's merge step in run() — see full_discovery_pool above.
    counts["candidate_pool"] = full_discovery_pool
    counts.update(provider_calls=provider_calls, wm_calls=wm_calls,
                  cinema_calls=cinema_calls, revalidated=revalidated,
                  ondemand=len(ondemand_set), ondemand_cap=ondemand_cap, catalogue=len(catalogue),
                  # CAS-161: a degraded run must SAY it was degraded. Silence here would let the catalogue
                  # quietly go stale for days while every run still reported success.
                  wm_fails=wm_fails, provider_fails=prov_fails, cinema_fails=cinema_fails,
                  # CAS-997 Defect 2: 404s, kept apart from *_fails above — not a fetch outage.
                  provider_not_found=provider_not_found, cinema_not_found=cinema_not_found,
                  wm_stopped=not wm_open, providers_stopped=not prov_open,
                  cinema_stopped=not cinema_open,
                  revalidation_stopped=not revalidation_open,
                  # CAS-1011: real per-status-code tally, JSON-safe (string keys).
                  tmdb_status_counts={str(k): v for k, v in tmdb_status_counts.items()})
    if wm_fails or prov_fails or cinema_fails:
        print(f"[warn] degraded enrichment: {prov_fails} TMDB-provider, {wm_fails} "
              f"Watchmode, {cinema_fails} TMDB-release_dates title(s) kept "
              f"their previous data"
              + (" — Watchmode stopped early" if not wm_open else "")
              + (" — TMDB providers stopped early" if not prov_open else "")
              + (" — TMDB release_dates stopped early" if not cinema_open else ""))
    return catalogue, counts


# ---------------------------------------------------------------------------
# CAS-772: cache age / revalidation / purge — the data-licensing precondition for paying for
# Watchmode. A record's core vendor content (title/synopsis/cast/etc — as opposed to
# `last_polled`, which only ever tracks the daily availability poll) is only as fresh as its own
# `cache_stamped_at`; once that ages past CACHE_TTL_DAYS it is due for revalidation. Provider-
# agnostic by design: age-tracking and selection below never reference a vendor by name, so they
# stay correct whatever CASCADE_SPINE ends up being — only revalidate_record's own fetch is
# spine-specific, since something has to actually go ask a vendor for fresh data.
# ---------------------------------------------------------------------------
def cache_age_days(m: dict, today: datetime.date) -> int | None:
    """Days since `m`'s vendor content was last confirmed fresh, or None if it has never been
    stamped (a base record from before this field existed) — unknown age, not zero age."""
    stamp = m.get("cache_stamped_at")
    if not stamp:
        return None
    try:
        stamped = datetime.date.fromisoformat(stamp)
    except ValueError:
        return None
    return (today - stamped).days


def needs_revalidation(m: dict, today: datetime.date, ttl_days: int = CACHE_TTL_DAYS) -> bool:
    """True once `m` is at or past the TTL. An unstamped record (age unknown) is always due —
    unknown is never treated as fresh."""
    age = cache_age_days(m, today)
    return age is None or age >= ttl_days


def select_revalidation_candidates(catalogue: list[dict], today: datetime.date,
                                    budget: int = REVALIDATION_DAILY_BUDGET,
                                    ttl_days: int = CACHE_TTL_DAYS) -> list[dict]:
    """Every record at/past the TTL, least-recently-confirmed first (never-stamped records
    first of all, since their real age is unknown and so at least as old as anything measured),
    capped to `budget` so a big catalogue's revalidation is spread across the TTL window
    (~200/day for 6,000 titles) rather than swept in one run. Pure — no file/network IO, so a
    stubbed clock is enough to test it."""
    aged = [(cache_age_days(m, today), m) for m in catalogue]
    stale = [(age, m) for age, m in aged if age is None or age >= ttl_days]
    stale.sort(key=lambda am: (am[0] is not None, -(am[0] or 0)))
    return [m for _, m in stale[:budget]]


def cache_health_stats(catalogue: list[dict], today: datetime.date,
                        ttl_days: int = CACHE_TTL_DAYS) -> tuple[int | None, int]:
    """(oldest_known_age_days, count_over_ttl) for the daily cache-health report (change item 4:
    "a limit nobody can see is a limit nobody keeps"). A record with no stamp yet counts toward
    `count_over_ttl` (unknown is never fresh) but is excluded from `oldest_known_age_days`, since
    there is no date to measure its age from."""
    known_ages = [a for a in (cache_age_days(m, today) for m in catalogue) if a is not None]
    over_ttl = sum(1 for m in catalogue if needs_revalidation(m, today, ttl_days))
    return (max(known_ages) if known_ages else None), over_ttl


def revalidate_record(m: dict, today: datetime.date) -> dict:
    """Re-fetch `m`'s vendor content fresh from today's live spine and re-stamp
    `cache_stamped_at`. TMDB is the only live spine today (Watchmode ingest is CAS-773); when
    that lands, swap what this fetches, not the age-tracking/selection above, which stay
    provider-agnostic. Only touches the fields `_tmdb_record` maps — offers/status/last_polled
    (availability, a separate daily poll) are left untouched, so this can never regress one."""
    detail = get_json(
        f"{TMDB_BASE}/movie/{m['tmdb_id']}?api_key={TMDB_KEY}&append_to_response=release_dates,videos,credits"
    )
    fresh = _tmdb_record(detail)
    fresh["cache_stamped_at"] = today.isoformat()
    m.update(fresh)
    return m


# CAS-772: every file that holds vendor-derived (TMDB/Watchmode) content — what both licences'
# cancellation/termination clauses require deleting. `api_budget.json` (our own daily spend
# counters) and `ondemand.json` (which titles USERS have engaged with — user data, not vendor
# content) are deliberately excluded.
VENDOR_CACHE_FILES = [OUTPUT_FILE, APP_FILE, SNAPSHOT_FILE, WM_CACHE_FILE, WINDOW_DATES_FILE,
                      ALERTS_FILE, os.path.join(STATE_DIR, "last_run_events.json")]


def purge_vendor_cache(files: list[str] | None = None) -> list[str]:
    """CAS-772: delete every vendor-derived cached file — the purge path Watchmode's "must
    delete stored data if they cancel" clause and TMDB's termination clause both require.
    Explicit and irreversible-by-intent: reachable only via `--purge-vendor-cache` on the
    command line, never from `run()` or any scheduled entry point. Returns the paths actually
    removed."""
    removed = []
    for path in (VENDOR_CACHE_FILES if files is None else files):
        if os.path.exists(path):
            os.remove(path)
            removed.append(path)
    return removed


# ---------------------------------------------------------------------------
# CAS-832: provider credential probe. The observed failure was silent and indefinite: TMDB
# rejected our key with a plain 401 "Invalid API key", and CAS-161's per-call defensive bail
# (correct for one bad call) then quietly kept whatever every enriched record already had —
# forever, since a rejected key never fixes itself the way a quota does. One cheap probe per
# provider, made up front, tells "wrong key" (rejected) apart from "over quota / rate limited"
# (throttled — expected on a free tier, self-healing) before any real work happens.
# ---------------------------------------------------------------------------
PROVIDERS = ("TMDB", "Watchmode")

# Named in the hard-failure message so it is obvious what is about to go missing from the
# catalogue if the key is not rotated (Lee's step — never this pipeline's).
PROVIDER_FIELDS = {
    "TMDB":      "cinema_date / age_rating (release_dates)",
    "Watchmode": "wm_user_rating / wm_critic_score / wm_popularity_percentile",
}

# Wording that marks a QUOTA/rate-limit answer rather than a bad key. Deliberately separate from
# `_LIMIT_MARKERS` above, which folds "invalid api key" in too — correctly, for that guard's own
# job of "stop calling this API for the rest of the run" either way.
_QUOTA_MARKERS = ("limit reached", "request limit", "too many requests", "rate limit", "limited", "quota")


def _classify_probe_error(e: urllib.error.HTTPError, has_credential: bool) -> str:
    """'throttled' or 'rejected'. A provider with no credential of its own can never be
    'rejected' — there is no key to be wrong, so any 401/403 there is that endpoint's own rate
    limiting, not something rotating a key could fix."""
    if not has_credential or e.code == 429:
        return "throttled"
    if e.code in (401, 403):
        body = ""
        try:
            body = (e.read() or b"").decode("utf-8", "replace")[:200].lower()
        except Exception:
            pass
        return "throttled" if any(k in body for k in _QUOTA_MARKERS) else "rejected"
    return "throttled"   # a transient 5xx etc. during the probe — not a credential fault either


def probe_tmdb() -> str:
    try:
        get_json(f"{TMDB_BASE}/configuration?api_key={TMDB_KEY}", retries=0)
        return "ok"
    except urllib.error.HTTPError as e:
        return _classify_probe_error(e, has_credential=True)
    except Exception:
        return "throttled"


def probe_watchmode() -> str:
    try:
        get_json(f"{WATCHMODE_BASE}/regions/?apiKey={WATCHMODE_KEY}", retries=0)
        return "ok"
    except urllib.error.HTTPError as e:
        return _classify_probe_error(e, has_credential=True)
    except Exception:
        return "throttled"


def probe_providers() -> dict:
    """One cheap authenticated call per provider — but only when the pipeline would actually use
    them this run. Without both keys (`LIVE`), nothing below ever calls either of them today, so
    a dev machine or a CI job with no keys set must not gain a brand-new real network call just
    because this exists. OscarBase is not probed here: it needs no credential of its own (nothing
    to reject) and tolerates its own failures every run — see `enrich_oscarbase_awards_nightly`,
    which runs unconditionally, live or sample, the same way Watchmode's nightly fields pass does.
    Returns {provider: outcome}, outcome in {'ok', 'throttled', 'rejected', 'unconfigured'}."""
    if not LIVE:
        return {name: "unconfigured" for name in PROVIDERS}
    return {"TMDB": probe_tmdb(), "Watchmode": probe_watchmode()}


def check_provider_health(outcomes: dict) -> int:
    """A rejected provider is a hard failure (CAS-832): the credential is wrong, revoked or
    expired, and — unlike a quota — will not fix itself. Returns 1 so the caller can refuse to
    build rather than commit a catalogue that would keep silently degrading. A throttled
    provider only warns and returns 0; the run continues exactly as it did before this ticket."""
    for name, outcome in outcomes.items():
        if outcome == "throttled":
            print(f"[warn] {name}: throttled (quota or rate limit) — expected on a free tier, "
                  f"continuing.")
    rejected = sorted(name for name, outcome in outcomes.items() if outcome == "rejected")
    if not rejected:
        return 0
    for name in rejected:
        print(f"[error] {name}: credential rejected (401/403, not a quota) — feeds "
              f"{PROVIDER_FIELDS[name]}. Refusing to build a degraded catalogue; rotate the key "
              f"(Lee's step) and re-run.")
    return 1


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------
def run(simulate_day: bool = False):
    today = datetime.date.today()
    # CAS-987: today's Watchmode allowance, paced against the real billing cycle — replaces the
    # fixed WM_NIGHTLY_MAX_CREDITS/ONDEMAND_WM_CAP/SCOREABILITY_PROBE_BUDGET numbers below with
    # weighted shares of the one cycle-paced pot. `nightly_budget` has to exist even off the LIVE
    # branch (enrich_watchmode_fields_nightly runs unconditionally, live or sample), so it starts
    # at the old fixed default and is only overridden once real cycle state is available.
    nightly_budget = {"remaining": WM_NIGHTLY_MAX_CREDITS, "skipped": 0}
    scoreability_cap = SCOREABILITY_PROBE_BUDGET

    if LIVE:
        print(f"[live] CAS-109 tiered poll — persistent catalogue, daily-active capped ...")
        wm_cache = json.load(open(WM_CACHE_FILE, encoding="utf-8")) if os.path.exists(WM_CACHE_FILE) else {}
        base_records = json.load(open(SNAPSHOT_FILE, encoding="utf-8")) if os.path.exists(SNAPSHOT_FILE) else []
        wd_seed = json.load(open(WINDOW_DATES_FILE, encoding="utf-8")) if os.path.exists(WINDOW_DATES_FILE) else {}
        offsets = ps.compute_median_offsets(wd_seed)
        ondemand_file = os.path.join(STATE_DIR, "ondemand.json")
        ondemand_ids = json.load(open(ondemand_file, encoding="utf-8")) if os.path.exists(ondemand_file) else []

        # CAS-994: this run's whole Watchmode pot — WM_RUN_MAX_CREDITS is a hard ceiling (0 by
        # default: no credit-costing Watchmode call at all), paced against Watchmode's own live
        # /status figures when non-zero. state/api_budget.json stays as a spend record below
        # (cycle["days"]) but no longer drives the allowance itself — see wm_run_allowance.
        cycle = _load_wm_cycle_budget(today)
        today_iso = today.isoformat()
        wm_pot = wm_run_allowance(today)

        # WM_NIGHTLY_MAX_CREDITS/ONDEMAND_WM_CAP/SCOREABILITY_PROBE_BUDGET stop being independent
        # fixed pots and become weighted shares of `wm_pot` — their old fixed values are reused
        # only as the RATIO between the three uses, never as a ceiling of their own again.
        ondemand_cap, nightly_cap, scoreability_cap = split_wm_pot(
            wm_pot, WM_NIGHTLY_MAX_CREDITS, ONDEMAND_WM_CAP, SCOREABILITY_PROBE_BUDGET)
        nightly_budget = {"remaining": nightly_cap, "skipped": 0}

        # poll_scheduler's own DAILY_BUDGET/ACTIVE_CAP/ONDEMAND_RESERVE stop being fixed free-tier
        # caps too: the scheduler still decides which titles are worth polling, but the allocator
        # above now decides how many are affordable today — scaled by the same ratio ondemand_cap
        # was, so the DAILY_BUDGET = ACTIVE_CAP + ONDEMAND_RESERVE relationship the constants were
        # built on still holds.
        poll_scale = (ondemand_cap / ps.ONDEMAND_RESERVE) if ps.ONDEMAND_RESERVE else 0
        scaled_reserve = ondemand_cap
        scaled_active_cap = round(ps.ACTIVE_CAP * poll_scale)
        poll_set_kwargs = {"active_cap": scaled_active_cap, "reserve": scaled_reserve,
                           "daily_budget": scaled_active_cap + scaled_reserve}

        records, counts = build_live_catalogue(today, base_records, wm_cache,
                                               offsets=offsets, ondemand_ids=ondemand_ids,
                                               wm_budget_cap=ondemand_cap,
                                               poll_set_kwargs=poll_set_kwargs)
        print(f"[live] catalogue {len(records)} | TMDB provider calls {counts['provider_calls']} (free, no quota) "
              f"| Watchmode on-demand {counts['wm_calls']}/{counts['ondemand_cap']} "
              f"| cinema_release backfill {counts['cinema_calls']}/{CINEMA_RELEASE_BACKFILL_BUDGET}")
        os.makedirs(STATE_DIR, exist_ok=True)
        json.dump(wm_cache, open(WM_CACHE_FILE, "w", encoding="utf-8"), indent=2)

        # CAS-974: this run's TMDB/Watchmode call+error tallies, for monitor.health's tmdb_fetch/
        # watchmode_fetch checks — a run with 0 keys never reaches this branch, so an "unknown"
        # (no run_stats.json entry) there is the honest answer, not a fabricated 0.
        # CAS-1011: "errors" is now derived from the real per-status breakdown (every status other
        # than 404), not provider_fails/cinema_fails — those also count titles skipped untried
        # after an earlier call already tripped `stop`, which is not a per-call error.
        tmdb_status_counts = counts["tmdb_status_counts"]
        tmdb_errors = sum(v for status, v in tmdb_status_counts.items() if status != "404")
        runstats.bump("tmdb", calls=counts["provider_calls"] + counts["cinema_calls"],
                      errors=tmdb_errors,
                      not_found=counts["provider_not_found"] + counts["cinema_not_found"])
        runstats.bump_counts("tmdb", "status_counts", tmdb_status_counts)
        # CAS-1033: run_stats.watchmode.calls is bumped once every credit-costing Watchmode path
        # for this run is known (see the CAS-986 two-tier publication block below), not here —
        # on-demand enrichment alone is routinely 0 on a run that still spent its whole nightly/
        # scoreability-probe allowance, and bumping only counts["wm_calls"] here made monitor.
        # health's watchmode_fetch report "0 calls made this run" on a run that did real work.
        prior_monthly = _load_monthly_wm_spend(today)
        monthly_spent = prior_monthly.get("wm_spent", 0) + counts["wm_calls"]
        _save_monthly_wm_spend(today, monthly_spent)
        runstats.set_value("watchmode",
                           remaining_monthly_credits=max(0, WATCHMODE_MONTHLY_CREDITS - monthly_spent))
    else:
        print("[sample] no API keys set — using bundled illustrative data.")
        records = json.load(open(SAMPLE_FILE, encoding="utf-8"))["movies"]
        if simulate_day:
            _apply_scripted_change(records)
        for m in records:
            m["status"] = derive_status(m, m.get("offers", []), today)
            m.setdefault("cache_stamped_at", today.isoformat())   # CAS-772: no real vendor stamp on sample data

    # CAS-938: OMDb is retired — drop its fields from every record so a base catalogue carried
    # forward from before this ticket (or the bundled sample data) doesn't leak them into
    # movies.json / state/last_snapshot.json.
    for m in records:
        for f in ("imdb_rating", "imdb_votes", "rt_critic", "metacritic"):
            m.pop(f, None)

    # CAS-921: the nightly run's own Watchmode fields pass — see enrich_watchmode_fields_nightly's
    # docstring. Runs every night, live or sample; a missing/rejected key is tolerated so this
    # never fails the build. `nightly_budget` is CAS-987's cycle-paced share when LIVE, the old
    # fixed WM_NIGHTLY_MAX_CREDITS otherwise.
    wm_outcomes = enrich_watchmode_fields_nightly(records, budget=nightly_budget)
    print(f"[watchmode] nightly fields: {wm_outcomes['ok']} enriched, {wm_outcomes['cached']} "
          f"cached, {wm_outcomes['no-id']} no-id, {wm_outcomes['skip']} skipped, "
          f"{wm_outcomes['stop']} stopped")

    # CAS-937: the nightly OscarBase awards pass — see enrich_oscarbase_awards_nightly's
    # docstring. Runs every night, live or sample; a failed fetch falls back to the committed
    # cache rather than ever failing the build.
    oscarbase_cache = (json.load(open(OSCARBASE_CACHE_FILE, encoding="utf-8"))
                       if os.path.exists(OSCARBASE_CACHE_FILE) else {})
    oscarbase_outcomes = enrich_oscarbase_awards_nightly(records, today, oscarbase_cache)
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(oscarbase_cache, open(OSCARBASE_CACHE_FILE, "w", encoding="utf-8"), indent=2)
    print(f"[oscarbase] awards: {oscarbase_outcomes['ok']} fetched, "
          f"{oscarbase_outcomes['cache_fallback']} from cache, "
          f"{oscarbase_outcomes['skip']} skipped, {oscarbase_outcomes['stop']} stopped")
    # CAS-974: 'skip'/'stop' are both genuine per-title fetch failures here (unlike Watchmode's
    # nightly-fields 'skip', which also covers a benign budget-exhausted title) — see
    # enrich_oscarbase_awards_nightly's own outcome contract — so both fold straight into errors.
    runstats.bump("oscarbase",
                  calls=oscarbase_outcomes["ok"] + oscarbase_outcomes["skip"] + oscarbase_outcomes["stop"],
                  errors=oscarbase_outcomes["skip"] + oscarbase_outcomes["stop"])

    # CAS-986: the two-tier catalogue — publish only what candidates.json's own scoreability probe
    # (via the shipped engine) says can carry a score today. LIVE only: the bundled sample data
    # carries no Watchmode fields at all (it predates Watchmode), so gating the offline/no-key demo
    # catalogue the same way would wipe it to zero rather than illustrate anything.
    if LIVE:
        candidates = load_candidates()
        previously_published_ids = {m["tmdb_id"] for m in base_records}
        records, cas986_report = apply_two_tier_publication(
            candidates, today, counts["candidate_pool"], records, previously_published_ids,
            probe_budget=scoreability_cap)
        save_candidates(candidates)
        print(f"[candidates] candidates={cas986_report['candidates']} "
              f"unprobed={cas986_report['unprobed']} probed_today={cas986_report['probed_today']} "
              f"published={cas986_report['published']} promoted={cas986_report['promoted']} "
              f"demoted={cas986_report['demoted']} exempt={cas986_report['exempt']} "
              f"not_found_dropped={cas986_report['not_found_dropped']}")

        # CAS-994: state/api_budget.json is now a spend RECORD only (wm_run_allowance drives the
        # actual allowance from Watchmode's own live /status figures, not this file) — accumulate
        # today's total draw across every credit-costing pass (on-demand, nightly fields,
        # scoreability probe) rather than overwrite it, in case a second run happens the same day.
        nightly_spent = nightly_cap - nightly_budget["remaining"]
        run_spent = counts["wm_calls"] + nightly_spent + cas986_report["wm_spent"]
        # CAS-1033: the deferred watchmode run_stats bump — run_spent is this run's REAL total
        # Watchmode activity (on-demand + nightly fields + the CAS-986 scoreability probe), so
        # monitor.health's watchmode_fetch check (which reads run_stats.watchmode.calls) is
        # measuring what it claims to measure instead of only the on-demand slice.
        runstats.bump("watchmode", calls=run_spent, errors=counts["wm_fails"])
        today_total_spent = cycle["days"].get(today_iso, 0) + run_spent
        cycle["days"][today_iso] = today_total_spent
        _save_wm_cycle_budget(cycle, today)
        print(f"watchmode cycle {cycle['cycle_start']}..{cycle['cycle_end']} quota={cycle['quota']} "
              f"spent={sum(cycle['days'].values())} run_pot={wm_pot} "
              f"today_spent={today_total_spent}")

    # CAS-608: how much of the published catalogue is genuinely upcoming vs. released-with-no-AU-
    # offer vs. on the short 7-day Watchmode ladder — the counts this ticket exists to shrink.
    upcoming_n = sum(1 for m in records if "upcoming" in (m.get("status") or []))
    released_unavailable_n = sum(1 for m in records if "released" in (m.get("status") or []))
    ladder_cohort_n = sum(1 for m in records if _is_ladder_cohort(m))
    print(f"[status] upcoming={upcoming_n} released_unavailable={released_unavailable_n} "
          f"ladder_cohort={ladder_cohort_n}")

    # CAS-772: cache-health report (change item 4) — a limit nobody can see is a limit nobody
    # keeps. Printed every run, live or sample, since the sample branch never touches build_live_
    # catalogue's own revalidation sweep.
    oldest_age, over_ttl = cache_health_stats(records, today)
    revalidated_today = counts.get("revalidated", 0) if LIVE else 0
    print(f"[cache] oldest record age: {oldest_age if oldest_age is not None else 'n/a'} day(s) | "
          f"{over_ttl} over the {CACHE_TTL_DAYS}-day TTL | {revalidated_today} revalidated today")

    # CAS-578 R6: refuse to persist a run that would mass-stamp one window across the catalogue —
    # the guard that would have caught D1. Raises and keeps every existing state/*.json file
    # untouched (nothing below has written yet) rather than silently corrupting them further.
    prev_snapshot = _load_prev_snapshot()
    check_mass_stamp_guard(records, prev_snapshot)

    # Record the first date each title was seen in each window, so transition
    # dates become EXACT over time (no backfill — accrues from the first run).
    # The app uses these when present and falls back to estimates otherwise.
    wd = json.load(open(WINDOW_DATES_FILE, encoding="utf-8")) if os.path.exists(WINDOW_DATES_FILE) else {}
    update_window_dates(records, wd, prev_snapshot, today.isoformat())
    for m in records:
        m.setdefault("availability_confidence", "confirmed")   # CAS-109 (sample/legacy default)
        m.setdefault("poll_tier", ps.classify_tier(m, today))
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(wd, open(WINDOW_DATES_FILE, "w", encoding="utf-8"), indent=2)

    events = diff_and_alert(records)

    payload = {
        "generated": today.isoformat(),
        "region": REGION,
        "currency": CURRENCY,
        "live": LIVE,
        "movies": records,
    }
    json.dump(payload, open(OUTPUT_FILE, "w", encoding="utf-8"), indent=2)
    os.makedirs(STATE_DIR, exist_ok=True)     # this run's changes, for the email step / CI
    json.dump(events, open(os.path.join(STATE_DIR, "last_run_events.json"), "w", encoding="utf-8"), indent=2)
    build_html(records)                       # regenerate the double-clickable app

    # CAS-1046: movies.json is final as of the writes above — log this run's counts for the
    # admin site. prev_snapshot is the same pre-overwrite "yesterday" set diff_and_alert used.
    refresh_entry = build_refresh_log_entry(
        list(prev_snapshot.values()), records, runstats.load(today),
        datetime.datetime.now(datetime.timezone.utc), github_run_id=os.getenv("GITHUB_RUN_ID"))
    append_refresh_log(refresh_entry)

    n_up = sum(1 for m in records if "upcoming" in m.get("status", []))
    print(f"\n{len(records)} titles written to movies.json  ({'LIVE' if LIVE else 'sample'} data)"
          + (f" — {n_up} of them upcoming (not yet in cinemas)" if n_up else ""))
    print(f"index.html rebuilt — open it in any browser.")
    arrivals   = [e for e in events if e.get("kind") == "arrived"]
    departures = [e for e in events if e.get("kind") == "left"]
    print(f"{len(arrivals)} arrival(s), {len(departures)} departure(s) this run:")
    for e in arrivals:
        svc = f" on {', '.join(e['services'])}" if e["services"] else ""
        print(f"   • {e['title']}  ->  {e['label']}{svc}")
    for e in departures:                                        # CAS-578 R4
        print(f"   • {e['title']}  left {e['label']}")
    if not events:
        print("   (none — run again with --simulate-day to see the alert path fire)")


def _git(*args) -> str:
    """Best-effort git call from the repo dir; '' on any failure (no git, detached, etc.)."""
    try:
        r = subprocess.run(["git", *args], cwd=os.path.dirname(__file__),
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def build_version_info(provider_status: dict | None = None) -> dict:
    """Assemble the release + build stamp (CAS-124).
    version              — hand-bumped SemVer from the committed VERSION file (the only manual step).
    major/minor/patch    — parsed from version.
    build/commit/builtAt — derived automatically from git at build time; never hand-edited.
    providers            — CAS-832: this build's provider probe outcomes, when one was made
                            (omitted, not a placeholder dict, when none was — e.g. `run()`'s own
                            internal rebuild, which already made real enrichment calls this run).

    No "env" field here (CAS-324): version.json is mirrored byte-for-byte from staging to main by
    promote.yml's pure merge, so a value baked in at build time (necessarily on staging) would still
    read "staging" once mirrored to prod — there is no build-time value that is correct in both places.
    env is instead resolved at RUNTIME from the hostname, by whoever is reading the stamp (see
    RUNTIME_ENV in app_template.html for the in-app badge)."""
    version = "0.0.0"
    try:
        version = (open(VERSION_FILE, encoding="utf-8").read().strip() or version)
    except Exception:
        pass
    def _int(x):
        try:    return int(x)
        except Exception: return 0
    major, minor, patch = ([_int(p) for p in version.split(".")] + [0, 0, 0])[:3]
    info = {
        "version": version, "major": major, "minor": minor, "patch": patch,
        "build":   _int(_git("rev-list", "--count", "HEAD")),
        "commit":  _git("rev-parse", "--short", "HEAD") or "unknown",
        "builtAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if provider_status is not None:
        info["providers"] = provider_status
    return info


def build_html(records: list[dict] | None = None, provider_status: dict | None = None):
    """Inject the latest movies + date into app_template.html -> index.html.
    Keeps the app a single double-clickable file (no server, no CORS).
    Also stamps the release/build version (CAS-124) into the app and /version.json."""
    catalogue_date = datetime.date.today().isoformat()
    if records is None:  # --build-html on its own: rebuild from the last movies.json
        catalogue = json.load(open(OUTPUT_FILE, encoding="utf-8"))
        records = catalogue["movies"]
        catalogue_date = catalogue.get("generated", catalogue_date)
    if not os.path.exists(TEMPLATE_FILE):
        print("! app_template.html not found — cannot build index.html"); return
    info = build_version_info(provider_status)
    html = open(TEMPLATE_FILE, encoding="utf-8").read()
    html = html.replace("__MOVIES_JSON__", json.dumps(records))
    # CAS-503 follow-up: __TODAY__ only feeds the baked BUILD_DATE stamp now (the app's live
    # "today" is computed at runtime). Stamp it from the catalogue's own `generated` date, not
    # the build machine's wall clock — the wall clock varies with whoever/wherever rebuilds
    # (e.g. CI's UTC runner vs a contributor's local timezone), which produced a spurious
    # single-day drift that qa.yml's build-check flagged as a real diff.
    html = html.replace("__TODAY__", catalogue_date)
    open(APP_FILE, "w", encoding="utf-8").write(html)
    # Machine-readable stamp served at /version.json (same origin as the app).
    with open(VERSION_JSON, "w", encoding="utf-8") as f:
        json.dump(info, f, separators=(",", ":")); f.write("\n")
    # CAS-947: window.BUILD_INFO's own generated file — kept OUT of the main inline <script> precisely
    # because `builtAt` changes on every build; see the comment on the <script src="build-info.js">
    # tag in app_template.html.
    with open(BUILD_INFO_JS, "w", encoding="utf-8") as f:
        f.write("window.BUILD_INFO = " + json.dumps(info) + ";\n")
    print(f"stamped v{info['version']} · build {info['build']} · {info['commit']}")
    write_csp_headers()
    _sync_ios_www()


def build_csp() -> str:
    """CAS-947 hashed every inline <script>/<style> block instead of allowing 'unsafe-inline'. CAS-1057
    (Decision 27 Sep 2026, option b) reverted script-src/style-src to 'unsafe-inline' and dropped the
    hashes: app_template.html drives most of its UI through onclick/style attributes generated per
    record at runtime (movie/video-specific values from movies.json), which a build-time hash list can
    never cover, and a stale hash on the pinned inline <script> was blocking the whole app on the
    Cloudflare preview host — browsers ignore 'unsafe-inline' outright whenever any hash is present.
    Strict, hash-only CSP is deferred to post-launch hardening. Do not add 'unsafe-eval'.

    Origins below were verified against what app_template.html actually loads/fetches/embeds, not
    guessed: fonts.googleapis.com (stylesheet + preconnect), fonts.gstatic.com (the fonts it serves),
    image.tmdb.org (posters) and img.youtube.com (trailer thumbnails) for img-src, the Supabase project
    and cascademovies.com (the native-app catalogue fetch, CATALOGUE_URL) for connect-src, and
    youtube-nocookie.com (the trailer <iframe>) for frame-src. Plain <a target="_blank"> links (TMDB,
    Watchmode, JustWatch, wa.me, YouTube watch pages) are navigations, not fetches, so they need no
    directive."""
    directives = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://image.tmdb.org https://img.youtube.com",
        "connect-src 'self' https://ypccfyatejejslzlfrbf.supabase.co https://cascademovies.com",
        "frame-src https://www.youtube-nocookie.com",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'none'",
    ]
    return "; ".join(directives)


_CSP_BEGIN = "  # BEGIN GENERATED CSP — poc_pipeline.py --build-html; do not hand-edit"
_CSP_END   = "  # END GENERATED CSP"


def write_csp_headers() -> None:
    """Write the CSP into _headers under its existing /* rule, replacing any previously generated
    block between the marker comments so the hand-written headers above it are never touched."""
    csp = build_csp()
    generated = f"{_CSP_BEGIN}\n  Content-Security-Policy: {csp}\n{_CSP_END}"
    current = open(HEADERS_FILE, encoding="utf-8").read() if os.path.exists(HEADERS_FILE) else "/*\n"
    if _CSP_BEGIN in current and _CSP_END in current:
        pattern = re.escape(_CSP_BEGIN) + r".*?" + re.escape(_CSP_END)
        updated = re.sub(pattern, lambda _m: generated, current, count=1, flags=re.DOTALL)
    else:
        updated = current.rstrip("\n") + "\n" + generated + "\n"
    with open(HEADERS_FILE, "w", encoding="utf-8", newline="\n") as f:
        f.write(updated)


def _sync_ios_www():
    """Mirror index.html + its local static assets into www/ (CAS-453).
    Capacitor's webDir can't be the repo root itself, so the iOS shell reads from this
    mobile-only mirror instead; the web app still ships from the repo root unchanged."""
    os.makedirs(IOS_WWW_DIR, exist_ok=True)
    for name in IOS_WWW_ASSETS:
        src = os.path.join(os.path.dirname(__file__), name)
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(IOS_WWW_DIR, name))


def run_build_html() -> int:
    """`python poc_pipeline.py --build-html` (CAS-832): probe every provider's credential
    before touching any file. This is the exact command CI's build-check/engine jobs and the
    daily-refresh commit-retry loop all run (see daily.yml), so catching a rejected key here —
    before `build_html` ever writes index.html/version.json — is what stops a degraded
    catalogue from reaching a commit. Returns the process exit code."""
    outcomes = probe_providers()
    exit_code = check_provider_health(outcomes)
    if exit_code:
        return exit_code
    build_html(provider_status=outcomes)
    print("index.html rebuilt from movies.json — open it in any browser.")
    return 0


def _apply_scripted_change(records: list[dict]):
    """Demo only: nudge a couple of titles into their next window so the diff fires."""
    for m in records:
        if m["title"].startswith("The Long Walk Home"):
            m["offers"] = [o for o in m["offers"] if o["type"] != "buy"] + [
                {"service": "Netflix", "type": "sub", "price": None, "format": "4K"}]
        if m["title"].startswith("Harbour Lights"):
            m["offers"] += [{"service": "Apple TV", "type": "rent", "price": 6.99, "format": "HD"}]


if __name__ == "__main__":
    if "--purge-vendor-cache" in sys.argv:
        # CAS-772: explicit, human-triggered only — the cancellation-path purge. Never call this
        # from run() or wire it into a scheduled job.
        removed = purge_vendor_cache()
        if removed:
            print("purged vendor-derived cache:")
            for p in removed:
                print(f"   • {p}")
        else:
            print("nothing to purge — no vendor-cache files present.")
    elif "--build-html" in sys.argv:
        sys.exit(run_build_html())
    else:
        run(simulate_day="--simulate-day" in sys.argv)
