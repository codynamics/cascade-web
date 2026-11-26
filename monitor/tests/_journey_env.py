"""CAS-1554: an in-memory stand-in for the four staging QA accounts, built by the app's OWN engine
(qa/sim/build_account.mjs via qa.sim.accounts.build_payload) - no network."""
import json
import os

from monitor.store import InMemoryStore
from qa.sim.accounts import ACCOUNTS, build_payload, email_for

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_CACHE = {}


def uid_for(key):
    return "00000000-0000-4000-8000-00000000000%d" % (ord(key) - ord("a") + 1)


def build_store():
    """-> (store, accounts {key: uid}). Four accounts, each with the agent/prefs/notify payload the app builds."""
    cascades, prefs, notify = [], {}, {}
    for k in sorted(ACCOUNTS):
        if k not in _CACHE:
            _CACHE[k] = build_payload(k)
        pl = _CACHE[k]
        uid = uid_for(k)
        for a in pl["agents"]:
            cascades.append({"id": "%s-%s" % (a["id"], k), "user_id": uid, "name": a["name"], "criteria": a["criteria"],
                             "alert_moments": a["alert_moments"], "active": a["active"]})
        prefs[uid] = dict(pl["prefs"])
        notify[uid] = dict(pl["notify"], email_on=True, in_app=True, email_address=email_for(k))
    store = InMemoryStore(cascades=cascades, prefs=notify, user_prefs=prefs,
                          emails={uid_for(k): email_for(k) for k in ACCOUNTS})
    return store, {k: uid_for(k) for k in sorted(ACCOUNTS)}


def real_catalogue():
    with open(os.path.join(ROOT, "movies.json"), encoding="utf-8") as fh:
        return json.load(fh)["movies"]


def fixture_catalogue():
    """The committed 143-film slice of the real catalogue the journey unit tests run against (deterministic)."""
    with open(os.path.join(ROOT, "monitor", "fixtures", "journey_catalogue.json"), encoding="utf-8") as fh:
        return json.load(fh)["movies"]
