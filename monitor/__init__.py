"""Cascade Web — daily monitoring package (spec 26771457 §5).

Build order 4 of 7 (CAS-84): the *diff* engine. After ``poc_pipeline.py`` builds
today's ``movies.json``, this package loads yesterday's catalogue and computes the
per-movie *transitions* (the "moments" a user's Cascade can alert on):

    newly available to rent        -> hits_rent
    newly on a streaming service   -> hits_stream
    theatrical opening date reached -> hits_cinema
    today == opening_date + N (=4)  -> past_opening_weekend   (honest, computed)
    today == opening_date - N (=7)  -> opens_soon             (honest, computed)
    a title we have never held, unreleased -> announced

Matching those transitions to users' Cascades, de-duping, and emailing land in the
later stories (CAS-85 / CAS-86); this package does no network I/O and no writes.
"""
import os
import sys

# The window thresholds and offer-classification live in poc_pipeline (the single source
# of truth for the app's business logic). Make the repo root importable so `import
# poc_pipeline` works whether this package is run as `python -m monitor` from the repo
# root, imported by the tests, or invoked from the daily Action.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from .transitions import (  # noqa: E402  (import after sys.path shim, by design)
    Transition,
    compute_transitions,
    DEFAULT_WEEKEND_N,
    MOMENTS,
)
from .matching import (  # noqa: E402
    Hit,
    match,
    matches_criteria,
    compute_admission,
    compute_auto_placements,
    synthesize_auto_watch_rows,
    service_ok,
    notification_rows,
    suppressed_pairs,
    pick_overrides,
    excluded_moments,
    prefs_for,
    excludes_from_prefs,
    delivery_plan,
    PREFS_DEFAULT,
    match_film_watches,
    WINDOW_TO_MOMENT,
    match_newly_qualified,
    match_new_to_agent,
)
from .store import InMemoryStore, SupabaseStore, store_from_env  # noqa: E402
from .emailer import (  # noqa: E402
    render_digest,
    moment_phrase,
    digest_subject,
    send_via_resend,
    format_invite_reply,
)
from .pusher import (  # noqa: E402
    send_via_apns,
    push_copy,
)

__all__ = [
    "Transition", "compute_transitions", "DEFAULT_WEEKEND_N", "MOMENTS",
    "Hit", "match", "matches_criteria", "compute_admission", "compute_auto_placements",
    "synthesize_auto_watch_rows", "service_ok", "notification_rows",
    "suppressed_pairs", "pick_overrides", "excluded_moments", "prefs_for", "excludes_from_prefs", "delivery_plan",
    "PREFS_DEFAULT", "match_film_watches", "WINDOW_TO_MOMENT", "match_newly_qualified",
    "match_new_to_agent",
    "InMemoryStore", "SupabaseStore", "store_from_env",
    "render_digest", "moment_phrase", "digest_subject", "send_via_resend", "format_invite_reply",
    "send_via_apns", "push_copy",
]
