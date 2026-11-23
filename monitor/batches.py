"""CAS-1535: alert batches - one member's alerts for one Sydney night.

Every ledger row the 03:00 find run records for a member on a Sydney date carries the same `batch_id`
(a re-dispatched find the same night joins the same batch). The 07:30 push and the 17:00 email both link
to that batch: `<site_url>?dl=alerts:batch:<batch_id>` (plus `&film=<movie_id>` per film), and the push
payload carries `"batch": "<batch_id>"`. `<batch_id>` is the uuid; nothing else is accepted.

Stores are optional collaborators here, the same convention monitor.phases uses: a store without the batch
methods (an old fixture) simply yields no batch and the callers fall back to the pre-batch behaviour.
"""
from __future__ import annotations

import datetime as _dt
from zoneinfo import ZoneInfo

SYDNEY = ZoneInfo("Australia/Sydney")
FALLBACK_AGENT_NAME = "Cascade"


def sydney_date(ts) -> str:
    """The Sydney calendar date (ISO) of `ts` - a datetime (naive = UTC) or an ISO string."""
    if isinstance(ts, str):
        ts = _dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=_dt.timezone.utc)
    return ts.astimezone(SYDNEY).date().isoformat()


def agent_name_for(cascades, user_id) -> str:
    """The member's own agent's name - the v2 (one-agent) agent, or the only agent - else "Cascade"."""
    mine = [c for c in (cascades or []) if str(c.get("user_id")) == str(user_id)
            and c.get("active", True) and not c.get("deleted_at")]
    v2 = [c for c in mine if (c.get("criteria") or {}).get("v") == 2 or c.get("v") == 2]
    pick = v2[0] if v2 else (mine[0] if len(mine) == 1 else None)
    return ((pick or {}).get("name") or "").strip() or FALLBACK_AGENT_NAME


def headline_for(agent_name: str, n: int) -> str:
    return f"{agent_name} found {n} film{'' if n == 1 else 's'} for you"


def batch_id_of(rows):
    """The batch id the newest of `rows` carries, or None when none does."""
    for r in reversed(list(rows)):
        if r.get("batch_id"):
            return str(r["batch_id"])
    return None


def ensure_batch(store, user_id, date_str: str, kind: str = "daily", headline: str = None):
    """Get-or-create the member's batch for `date_str`. An existing batch is reused (a catch-up joins and
    upgrades a `daily` batch the same night). Returns the batch dict, or None for a store with no batches.
    Raises if the store itself fails - callers decide what a failed batch write means."""
    fetch = getattr(store, "fetch_alert_batch", None)
    if not callable(fetch):
        return None
    existing = fetch(user_id, date_str)
    if existing:
        fields = {}
        if kind == "catchup" and existing.get("kind") != "catchup":
            fields["kind"] = "catchup"
        if headline and existing.get("headline") != headline:
            fields["headline"] = headline
        if fields:
            store.update_alert_batch(existing["id"], fields)
            existing = {**existing, **fields}
        return existing
    return store.insert_alert_batch({"user_id": user_id, "sydney_date": date_str, "kind": kind,
                                     "headline": headline})


def batch_url(site_url: str, batch_id, movie_id=None) -> str:
    """The deep link into one batch's own view in Alerts (before track_url adds src/cmp/cta)."""
    url = f"{site_url}?dl=alerts:batch:{batch_id}"
    return f"{url}&film={movie_id}" if movie_id is not None else url
