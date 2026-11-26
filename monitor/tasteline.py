"""CAS-1592: the alert email's one-time "<agent> has learned something" line - the email half of CAS-1566's Taste card.

Who: a member with 10+ Watched ratings whose strongest genre-pair adjustment is 5+ points either way, who has not
been sent the line before. The decision is the APP's (rnudgeDecide / rnudgeBestAdjustment), asked through
monitor/tasteline_shim.mjs with the member's real `user_films` verdicts; Python never re-derives a score.

When: only inside an alert email that is going out anyway (monitor.phases.email_phase) - never an extra email, never
a push. A catch-up email does not carry it (the line waits for the member's next email).

Once per account, durably: a row in `email_lines_sent` (migration 0018), written only AFTER the send landed. A failed
send leaves it unwritten, so the next email carries the line. A store that cannot say whether it was sent (no such
table yet) owes nobody the line.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .recap import RATING_KEYS

LINE_KEY = "taste_line"
CMP = "taste_line"
MIN_RATINGS = 10
_SHIM_PATH = Path(__file__).resolve().parent / "tasteline_shim.mjs"


def compute_lines(users: list) -> dict:
    """ONE call to the engine shim. `users` = [{"userId", "filmStatuses": [{movie_id, status}]}].
    Returns {user_id: {"ratings", "pts", "text"}}."""
    if not users:
        return {}
    proc = subprocess.run(["node", str(_SHIM_PATH)], input=json.dumps({"users": users}),
                          capture_output=True, text=True, encoding="utf-8", timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(f"tasteline_shim.mjs failed (exit {proc.returncode}): {proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"tasteline_shim.mjs produced invalid JSON: {err}\n{proc.stdout[:500]}") from err


def already_sent(store, user_id) -> bool:
    """True when the line went out before - or when the store cannot say (never guesses: owes nobody)."""
    fn = getattr(store, "fetch_email_line_sent", None)
    if not callable(fn):
        return True
    try:
        return bool(fn(user_id, LINE_KEY))
    except Exception as err:   # noqa: BLE001 - e.g. migration 0018 not applied yet
        print(f"[monitor] taste line: cannot tell whether {user_id} has had it: {err} - leaving it out.")
        return True


def line_for(store, user_id, films_by_user: dict, lines_fn=None):
    """The member's taste line (str) or None. `films_by_user` = {user_id: [user_films rows]}."""
    rows = films_by_user.get(str(user_id)) or []
    if sum(1 for r in rows if r.get("status") in RATING_KEYS) < MIN_RATINGS:
        return None   # cheap pre-filter only; the app's own count (rnudgeRatingsCount) decides in the shim
    if already_sent(store, user_id):
        return None
    out = (lines_fn or compute_lines)([{"userId": str(user_id), "filmStatuses": rows}])
    return ((out or {}).get(str(user_id)) or {}).get("text") or None


def record_sent(store, user_id, stamp: str) -> None:
    """Called only after the send landed. A failure is logged: the next email then repeats the line."""
    try:
        store.mark_email_line_sent(user_id, LINE_KEY, stamp)
    except Exception as err:   # noqa: BLE001
        print(f"[monitor] could not record the taste line for {user_id}: {err} - the next email will carry it again.")
