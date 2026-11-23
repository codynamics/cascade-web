"""CAS-1535: the day +1 catch-up - a new member's first morning.

Who: every account, once, at the first 03:00 find run after the account was created
(`auth.users.created_at` within the CATCHUP_WINDOW_H hours before the run). "Once" is durable - the
existence of the member's own `catchup` batch (monitor.batches) - never a run-local flag.

What: films from the member's Me list, in the list's own order, skipping films the member has any verdict
on (watched, or Not for me). Three groups, each its own stage: in cinemas now (top 3), coming to cinemas
(top 5), on the member's OWN streaming services (top 10). The ranking is the SHIPPED app's, asked of the
engine through monitor/catchup_shim.mjs (its header says how); this module never re-derives it.

Never re-announced for the same stage: once a film has a catch-up row for a stage, a later ordinary alert
for the SAME stage is dropped (suppress_caught_up); a later, different stage still alerts normally.
"""
from __future__ import annotations

import datetime as _dt
import json
import subprocess
from pathlib import Path

from .matching import Hit, agent_channels
from .transitions import Transition, _detail_for

CATCHUP_MOMENT = "catchup"
CATCHUP_WINDOW_H = 24
# (stage key, the heading the email shows) - the order every surface uses.
STAGES = (("cinema", "In cinemas now"), ("coming", "Coming to cinemas"),
          ("streaming", "On your streaming services"))
STAGE_ORDER = {k: i for i, (k, _) in enumerate(STAGES)}
STAGE_HEADING = dict(STAGES)
# Which stage an ordinary alert moment belongs to - what a catch-up row for that stage already announced.
MOMENT_STAGE = {"hits_cinema": "cinema", "announced": "coming", "opens_soon": "coming",
                "hits_stream": "streaming"}

_SHIM_PATH = Path(__file__).resolve().parent / "catchup_shim.mjs"


def due_users(store, run_now: _dt.datetime, candidate_ids) -> list:
    """Members owed a catch-up this run: created within CATCHUP_WINDOW_H before `run_now`, and with no
    catch-up batch yet. A store that cannot say when accounts were created owes nobody (never guesses)."""
    fn = getattr(store, "fetch_user_created_at", None)
    if not callable(fn):
        return []
    created = fn() or {}
    out = []
    for uid in sorted({str(u) for u in candidate_ids}):
        raw = created.get(uid)
        if not raw:
            continue
        try:
            at = _dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            continue
        if at.tzinfo is None:
            at = at.replace(tzinfo=_dt.timezone.utc)
        age = run_now - at
        if not (_dt.timedelta(0) <= age <= _dt.timedelta(hours=CATCHUP_WINDOW_H)):
            continue
        if store.has_catchup_batch(uid):
            continue
        out.append(uid)
    return out


def compute_catchup_picks(users: list) -> dict:
    """ONE call to the engine shim for every due member. `users` is the shim's request list (see
    catchup_shim.mjs). Returns {user_id: {"cinema": [ids], "coming": [ids], "streaming": [ids]}}."""
    if not users:
        return {}
    proc = subprocess.run(["node", str(_SHIM_PATH)], input=json.dumps({"users": users}),
                          capture_output=True, text=True, encoding="utf-8", timeout=300)
    if proc.returncode != 0:
        raise RuntimeError(f"catchup_shim.mjs failed (exit {proc.returncode}): {proc.stderr.strip()}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"catchup_shim.mjs produced invalid JSON: {err}\n{proc.stdout[:500]}") from err


def _own_agent(cascades, user_id):
    mine = [c for c in cascades if str(c.get("user_id")) == str(user_id)]
    v2 = [c for c in mine if (c.get("criteria") or {}).get("v") == 2 or c.get("v") == 2]
    return (v2 or mine or [None])[0]


def shim_request(user_ids, cascades, account_prefs: dict, user_prefs_rows: dict) -> list:
    """The shim's per-member request, from the same account facts the admission call already reads."""
    out = []
    for uid in user_ids:
        agent = _own_agent(cascades, uid)
        if not agent:
            continue
        prefs = account_prefs.get(str(uid)) or {}
        view = (user_prefs_rows.get(str(uid)) or {}).get("view")
        moods = view.get("moods") if isinstance(view, dict) else None
        out.append({"userId": str(uid), "langs": prefs.get("langs"),
                    "subServices": prefs.get("subServices") or [],
                    "storeServices": prefs.get("storeServices") or [],
                    "servicesOnly": bool(prefs.get("servicesOnly")),
                    "filmStatuses": prefs.get("filmStatuses") or [],
                    "criteria": agent.get("criteria") or {}, "moods": moods or None})
    return out


def catchup_hits(user_ids, cascades, account_prefs, user_prefs_rows, today_by_id, picks_fn=None) -> dict:
    """{user_id: [Hit, ...]} - one `catchup` Hit per picked film, ordered cinema, coming, streaming (each
    group in the Me list's own order). A film missing from today's catalogue is skipped: the picks come
    from the shipped catalogue, so that can only be a stale build, and nothing is invented to fill it."""
    picks = (picks_fn or compute_catchup_picks)(shim_request(user_ids, cascades, account_prefs, user_prefs_rows))
    out: dict = {}
    for uid in user_ids:
        agent = _own_agent(cascades, uid)
        if not agent:
            continue
        mine = picks.get(str(uid)) or {}
        hits, seen = [], set()
        for stage, _heading in STAGES:
            for mid in mine.get(stage) or []:
                mid = str(mid)
                movie = today_by_id.get(mid)
                if not movie or mid in seen:
                    continue
                seen.add(mid)
                services = _detail_for("hits_stream", movie)[0] if stage == "streaming" else []
                t = Transition(movie_id=mid, title=movie.get("title") or "", moment=CATCHUP_MOMENT,
                               services=list(services), price=None, movie=movie, stage=stage)
                hits.append(Hit(user_id=str(uid), cascade_id=agent.get("id"),
                                cascade_name=agent.get("name") or "My Cascade", transition=t,
                                channels=agent_channels(agent.get("criteria") or {})))
        if hits:
            out[str(uid)] = hits
    return out


def suppress_caught_up(by_user: dict, stage_keys: set) -> int:
    """Drop, in place, every ordinary hit whose film was already caught up for the same stage - in
    cinemas now => no `hits_cinema`; coming => no `announced`/`opens_soon`; streaming => no `hits_stream`.
    `stage_keys` is {(user_id, movie_id, stage)}. Catch-up hits themselves are never dropped. Returns how
    many were dropped."""
    dropped = 0
    for uid, hits in list(by_user.items()):
        kept = []
        for h in hits:
            stage = MOMENT_STAGE.get(h.transition.moment)
            if stage and (str(uid), h.transition.movie_id, stage) in stage_keys:
                dropped += 1
                continue
            kept.append(h)
        by_user[uid] = kept
    return dropped
