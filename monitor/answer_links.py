"""CAS-1537: signed one-tap answer links for the alert email.

Every Watch On / Watched button in an alert email is a link to the static confirmation page
(`<site>/a/?t=<token>`). The token is single-purpose: it names exactly one (member, batch row, film, button
key) and expires. A plain GET of the page records nothing - the page POSTs the token to the `alert-answer`
edge function (supabase/functions/alert-answer), which verifies it with the SAME secret and records the tap.

  token  = "v1." + b64url(json {u: member uuid, r: notifications row id, f: film id, k: button key, e: expiry
           epoch seconds}) + "." + b64url(HMAC-SHA256(secret, "v1." + b64url(payload)))
  expiry = 30 days from the send (EXPIRY_DAYS) - matches To decide's 30-day window.
  secret = ALERT_ANSWER_SECRET: a server-only secret. It lives in the GitHub environment secrets (passed to the
           monitor step of .github/workflows/alerts.yml) and in the Supabase function secrets (alert-answer).
           Creating it in both places is a Lee-gated step. Never in the repo.

supabase/functions/alert-answer/core.ts implements the same format; tests/js/cas1537-alert-answer.test.mjs
verifies a token minted here with the TypeScript verifier.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

SECRET_ENV = "ALERT_ANSWER_SECRET"
EXPIRY_DAYS = 30
VERSION = "v1"
ANSWER_PATH = "a/"          # the static confirmation page; excluded from the iOS app-link claim (AASA)

_DEFS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "supabase", "functions", "_shared", "answer_keys.json")
with open(_DEFS_PATH, encoding="utf-8") as _fh:
    DEFS = json.load(_fh)

WATCH_ON = DEFS["watch_on"]          # [{key, label, rung}] - Cinema, Premium, Rent, Stream, Never
WATCHED = DEFS["watched"]            # [{key, label, color}] - Wow!, Watch Again, Enjoyed, So-so, Disliked
ANSWER_KEYS = [d["key"] for d in WATCH_ON] + [d["key"] for d in WATCHED]
LABELS = {d["key"]: d["label"] for d in WATCH_ON + WATCHED}


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sig(secret: str, signed: str) -> str:
    return _b64(hmac.new(secret.encode("utf-8"), signed.encode("ascii"), hashlib.sha256).digest())


def secret_from_env():
    return (os.environ.get(SECRET_ENV) or "").strip() or None


def sign_token(secret: str, user_id, row_id, film_id, key: str, now: float = None, days: int = EXPIRY_DAYS) -> str:
    if key not in ANSWER_KEYS:
        raise ValueError(f"unknown answer key {key!r}")
    exp = int((time.time() if now is None else now) + days * 86400)
    payload = {"u": str(user_id), "r": str(row_id), "f": str(film_id), "k": key, "e": exp}
    body = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signed = f"{VERSION}.{body}"
    return f"{signed}.{_sig(secret, signed)}"


def verify_token(secret: str, token: str, now: float = None):
    """The payload dict {u, r, f, k, e} when the signature holds, the key is one of the ten and the token has
    not expired; otherwise None."""
    try:
        version, body, sig = str(token).split(".")
        if version != VERSION or not hmac.compare_digest(sig, _sig(secret, f"{version}.{body}")):
            return None
        p = json.loads(_unb64(body))
        if p.get("k") not in ANSWER_KEYS or not all(isinstance(p.get(x), str) and p[x] for x in "urf"):
            return None
        if (time.time() if now is None else now) >= int(p["e"]):
            return None
        return p
    except (ValueError, TypeError, KeyError, UnicodeError):
        return None


def answer_url(site_url: str, token: str) -> str:
    return f"{site_url}{ANSWER_PATH}?t={token}"


class AnswerContext:
    """What one member's email needs to sign its buttons: the secret, the member, and the ledger row id of
    each film in the email (one token per (member, row, film, key)). `token_for` is None when it cannot sign."""

    def __init__(self, secret, user_id, rows_by_film, now=None):
        self.secret, self.user_id, self.rows_by_film, self.now = secret, user_id, rows_by_film or {}, now

    def token_for(self, film_id, key):
        row = self.rows_by_film.get(str(film_id))
        if not self.secret or not row:
            return None
        return sign_token(self.secret, self.user_id, row, film_id, key, now=self.now)
