"""Send one push notification via APNs (CAS-465 / spec 26771457 push chain).

Auth is the APNs **Token-based (HTTP/2) provider API**: every request carries a short-lived
ES256 JWT signed with the account's `.p8` auth key, instead of a per-app TLS client
certificate. Reads its four secrets from the environment only, never hardcoded:

    APNS_KEY_ID    — the .p8 key's Key ID
    APNS_TEAM_ID   — the Apple Developer Team ID
    APNS_AUTH_KEY  — the .p8 file's contents, base64-encoded (so it survives as one env var)
    APNS_BUNDLE_ID — the app's bundle id (au.com.codynamics.cascade), sent as apns-topic

Same degrade-gracefully convention as ``emailer.py`` with no ``RESEND_API_KEY``: with any of
the four unset, ``send_via_apns`` no-ops and returns ``False`` rather than raising, so a run
with no APNs configured yet (true until Lee adds the GitHub Actions secrets) still completes
green.

This repo's monitor package is deliberately dependency-free (no pip install step in any
workflow — see ``store.py``/``emailer.py``), so the ES256 signature itself is computed here
with nothing beyond the standard library: a minimal DER reader pulls the raw private-key
scalar out of the PKCS8 ``.p8`` bytes, and a minimal P-256 point-multiplication signs the JWT.

Apple's provider API requires HTTP/2, which the standard library's ``urllib`` cannot speak
(CAS-1204). Rather than add an HTTP/2 package, the request is sent with the ``curl`` binary
already on the GitHub Actions runner (built with HTTP/2 support), driven from Python via
``subprocess``. The device token and provider token go to curl only through a ``--config``
file piped on standard input, never as a command-line argument or in a log line, so neither
secret can leak into the process list or the Actions log.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import subprocess
import time

APNS_KEY_ID_ENV = "APNS_KEY_ID"
APNS_TEAM_ID_ENV = "APNS_TEAM_ID"
APNS_AUTH_KEY_ENV = "APNS_AUTH_KEY"      # base64-encoded .p8 contents
APNS_BUNDLE_ID_ENV = "APNS_BUNDLE_ID"

APNS_HOST = "api.push.apple.com"

# CAS-483: the four-secrets-unset no-op used to return False with no output at all, which is
# exactly how a missing daily.yml env-block hid for three tickets' worth of work. Warn once per
# run (not once per push) so a real config gap is visible without spamming the log per device.
_warned_missing_config = False

# Reuses the exact phrasing app_template.html's REAL_MOMENT_SAID already puts on the bell for
# the same event, so push copy can never drift from what the in-app alert says (CAS-465 build
# step 2). Ported by hand rather than shared at build time — this dict and the JS one must be
# kept in lock-step by any future moment-copy change.
REAL_MOMENT_SAID = {
    "hits_cinema": "reached a cinema",
    "past_opening_weekend": "is past its opening weekend",
    "hits_pvod": "is available to buy",
    "hits_rent": "dropped to a rental price",
    "hits_stream": "landed on streaming",
    "newly_qualifies": "now matches this agent",
    "new_to_agent": "is new to this agent",
}


def push_copy(hit) -> dict:
    """{'title', 'body'} for one monitor.matching.Hit, moment-appropriate (CAS-465 build step 2)."""
    t = hit.transition
    if t.moment == "announced":
        return {
            "title": f"New match for {hit.cascade_name}",
            "body": f"{t.title} just joined Cascade — matches your {hit.cascade_name} agent.",
        }
    said = REAL_MOMENT_SAID.get(t.moment, t.moment)
    return {"title": t.title, "body": f"{t.title} {said}."}


# --------------------------------------------------------------------------- #
# minimal DER reader — just enough to pull the private scalar out of a PKCS8
# EC private key (RFC 5958 / RFC 5915), no external ASN.1 library
# --------------------------------------------------------------------------- #
def _der_read_tlv(data: bytes, offset: int):
    tag = data[offset]
    offset += 1
    length = data[offset]
    offset += 1
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(data[offset:offset + n], "big")
        offset += n
    value = data[offset:offset + length]
    return tag, value, offset + length


def _der_children(data: bytes) -> list:
    """Every top-level TLV inside a DER SEQUENCE's content, in order."""
    offset, out = 0, []
    while offset < len(data):
        tag, value, offset = _der_read_tlv(data, offset)
        out.append((tag, value))
    return out


def _ec_scalar_from_pkcs8(der: bytes) -> int:
    """The raw private-key integer `d` from an unencrypted PKCS8-wrapped EC key (a `.p8` file's
    decoded bytes). PrivateKeyInfo = SEQUENCE{version, algorithm, privateKey OCTET STRING}, and
    that OCTET STRING holds an ECPrivateKey = SEQUENCE{version, privateKey OCTET STRING, ...} —
    RFC 5915's second field is `d` itself, always present regardless of the optional trailing
    parameters/publicKey fields."""
    if b"-----BEGIN" in der:
        # The secret is documented as "the .p8 file's contents, base64-encoded", which
        # decodes to PEM text, not DER — strip the armour lines and decode the body.
        der = base64.b64decode(b"".join(
            line.strip() for line in der.strip().splitlines()
            if line.strip() and not line.strip().startswith(b"-----")))
    _, pki_content, _ = _der_read_tlv(der, 0)
    pki_children = _der_children(pki_content)
    ec_der = pki_children[2][1]
    # ec_der is the whole ECPrivateKey SEQUENCE (tag + length + content). Its fields
    # are inside the content, so unwrap it first — reading children of the wrapped bytes
    # returned one element and [1] raised IndexError on every key ever supplied.
    _, ec_content, _ = _der_read_tlv(ec_der, 0)
    ec_children = _der_children(ec_content)
    d_bytes = ec_children[1][1]
    return int.from_bytes(d_bytes, "big")


# --------------------------------------------------------------------------- #
# minimal P-256 (secp256r1) point math — just enough for ECDSA signing
# --------------------------------------------------------------------------- #
_P  = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_A  = _P - 3
_GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
_GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
_N  = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_G  = (_GX, _GY)


def _point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % _P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + _A) * pow(2 * y1 % _P, _P - 2, _P) % _P
    else:
        lam = (y2 - y1) * pow((x2 - x1) % _P, _P - 2, _P) % _P
    x3 = (lam * lam - x1 - x2) % _P
    y3 = (lam * (x1 - x3) - y1) % _P
    return (x3, y3)


def _scalar_mult(k: int, point):
    result = None
    addend = point
    while k:
        if k & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        k >>= 1
    return result


def _ecdsa_sign_p256(d: int, digest: bytes) -> bytes:
    """Raw (not DER) r||s signature bytes — the concatenated fixed-width format JWS ES256
    requires, each half 32 bytes big-endian (RFC 7518 §3.4)."""
    z = int.from_bytes(digest, "big")
    while True:
        k = secrets.randbelow(_N - 1) + 1   # cryptographically secure nonce (stdlib `secrets`)
        point = _scalar_mult(k, _G)
        r = point[0] % _N
        if r == 0:
            continue
        s = (pow(k, _N - 2, _N) * (z + r * d)) % _N
        if s == 0:
            continue
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_provider_jwt(key_id: str, team_id: str, auth_key_b64: str) -> str:
    """A fresh APNs provider token, per Apple's token-based auth spec: an ES256 JWT over
    {iss: team_id, iat: now}, signed with the .p8 key, `kid` in the header."""
    d = _ec_scalar_from_pkcs8(base64.b64decode(auth_key_b64))
    header = {"alg": "ES256", "kid": key_id}
    payload = {"iss": team_id, "iat": int(time.time())}
    signing_input = (
        _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
        + "." + _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    )
    digest = hashlib.sha256(signing_input.encode("ascii")).digest()
    sig = _ecdsa_sign_p256(d, digest)
    return f"{signing_input}.{_b64url(sig)}"


# Apple accepts a provider token for up to ~60 minutes and rate-limits how often a new one may
# be requested; this batch job runs once a day and can safely mint (and reuse) one token for
# the whole run rather than one per push.
_TOKEN_TTL_SECONDS = 55 * 60
_token_cache: dict = {}   # (key_id, team_id) -> (token, minted_at)


def _provider_token(key_id: str, team_id: str, auth_key_b64: str) -> str:
    cache_key = (key_id, team_id)
    cached = _token_cache.get(cache_key)
    now = time.time()
    if cached and now - cached[1] < _TOKEN_TTL_SECONDS:
        return cached[0]
    token = _mint_provider_jwt(key_id, team_id, auth_key_b64)
    _token_cache[cache_key] = (token, now)
    return token


def _invalid_token_reason(status: int, body_text: str = "") -> str | None:
    """CAS-1194: APNs' two ways of saying 'this device token will never work again' — HTTP 410
    Gone, or HTTP 400 with a JSON body `{"reason": "BadDeviceToken"}` (or `"Unregistered"`).
    Returns the reason to log and act on, or None for every other status (those are transient/
    config errors — the token must be retried, not deleted)."""
    if status == 410:
        return "Unregistered"
    if status == 400:
        try:
            reason = json.loads(body_text or "{}").get("reason")
        except (json.JSONDecodeError, TypeError, AttributeError):
            return None
        if reason in ("BadDeviceToken", "Unregistered"):
            return reason
    return None


# --------------------------------------------------------------------------- #
# curl transport (CAS-1204) — Apple's push service refuses anything but HTTP/2,
# which stdlib urllib cannot speak. The runner's curl can, so we shell out to it.
# --------------------------------------------------------------------------- #
_CURL_META_MARKER = "\x1eMETA:"   # \x1e: won't occur in a JSON response body


def _curl_config_escape(value: str) -> str:
    """Escape a value for curl's --config quoted-string syntax: backslash and the closing
    quote are the only characters that need it."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _build_curl_config(url: str, headers: dict, body: str) -> str:
    """The URL, headers and JSON body for one APNs POST, as a curl --config file read from
    standard input — so neither the provider token nor the device token is ever passed as a
    command-line argument (visible in the process list) or appears in a log line."""
    lines = [f'url = "{_curl_config_escape(url)}"', 'request = "POST"']
    for name, value in headers.items():
        lines.append(f'header = "{_curl_config_escape(f"{name}: {value}")}"')
    lines.append(f'data = "{_curl_config_escape(body)}"')
    return "\n".join(lines) + "\n"


def _redact_secrets(text: str, *secrets_to_strip: str) -> str:
    """`text` with any of `secrets_to_strip` removed and whitespace/newlines collapsed to one
    line, for safe logging of curl's own stderr."""
    redacted = text
    for secret in secrets_to_strip:
        if secret:
            redacted = redacted.replace(secret, "[redacted]")
    return " ".join(redacted.split())


def _parse_curl_output(stdout: str):
    """(status, http_version, response_body) parsed from the --write-out marker curl appends
    after the response body, or None when the marker is missing or malformed."""
    idx = stdout.rfind(_CURL_META_MARKER)
    if idx == -1:
        return None
    response_body = stdout[:idx]
    meta = stdout[idx + len(_CURL_META_MARKER):].strip()
    try:
        status_str, http_version = meta.split(":", 1)
        return int(status_str), http_version.strip(), response_body
    except ValueError:
        return None


def send_via_apns(device_token: str, title: str, body: str, badge: int = None,
                   thread_id: str = None, payload: dict = None, timeout: int = 10,
                   on_invalid_token=None) -> bool:
    """POST one alert push to APNs. Returns True on a 2xx response, False otherwise — including
    when APNS_* is unset (no-op, mirrors emailer.py with no RESEND_API_KEY) or the request
    itself fails. Never raises: a bad push must not take the rest of the run down with it.

    CAS-1194: when APNs rejects `device_token` as permanently invalid (410, or 400
    BadDeviceToken/Unregistered), `on_invalid_token(device_token)` is called (if given) so the
    caller can delete that row — this function has no store of its own to do it with."""
    global _warned_missing_config
    key_id = os.environ.get(APNS_KEY_ID_ENV)
    team_id = os.environ.get(APNS_TEAM_ID_ENV)
    auth_key_b64 = os.environ.get(APNS_AUTH_KEY_ENV)
    bundle_id = os.environ.get(APNS_BUNDLE_ID_ENV)
    if not (key_id and team_id and auth_key_b64 and bundle_id):
        if not _warned_missing_config:
            missing = [name for name, val in (
                (APNS_KEY_ID_ENV, key_id), (APNS_TEAM_ID_ENV, team_id),
                (APNS_AUTH_KEY_ENV, auth_key_b64), (APNS_BUNDLE_ID_ENV, bundle_id),
            ) if not val]
            print(f"[monitor] push not configured — {', '.join(missing)} unset; "
                  "no push notifications will be sent this run.")
            _warned_missing_config = True
        return False

    aps = {"alert": {"title": title, "body": body}}
    if badge is not None:
        aps["badge"] = int(badge)
    if thread_id:
        aps["thread-id"] = thread_id
    body_obj = {"aps": aps}
    if payload:
        body_obj.update(payload)

    try:
        token = _provider_token(key_id, team_id, auth_key_b64)
    except Exception as err:   # noqa: BLE001 - a malformed .p8 must not crash the run
        # CAS-1194: this used to be the one silent failure mode among the four below — nothing
        # printed, so a broken APNS_AUTH_KEY read as "0 push notification(s)" with no clue why.
        # Exception class + message only, never auth_key_b64 itself (never interpolated below).
        print(f"[monitor] APNs provider token could not be minted ({type(err).__name__}: {err}) "
              "— push not sent this run.")
        return False

    headers = {
        "authorization": f"bearer {token}",
        "apns-topic": bundle_id,
        "apns-push-type": "alert",
        "content-type": "application/json",
    }
    url = f"https://{APNS_HOST}/3/device/{device_token}"
    config_text = _build_curl_config(url, headers, json.dumps(body_obj))
    cmd = [
        "curl",
        "--http2",
        "--silent",
        "--show-error",
        "--max-time", str(timeout),
        "--write-out", f"{_CURL_META_MARKER}%{{http_code}}:%{{http_version}}",
        "--config", "-",
    ]

    try:
        proc = subprocess.run(
            cmd, input=config_text, capture_output=True, text=True, timeout=timeout + 5)
    except FileNotFoundError:
        print("[monitor] APNs push failed for a registered device: curl is not installed.")
        return False
    except subprocess.TimeoutExpired:
        print(f"[monitor] APNs push failed for a registered device: timed out after {timeout}s.")
        return False

    if proc.returncode != 0:
        stderr_text = _redact_secrets(proc.stderr.strip(), token, device_token)
        cause = f"curl exited {proc.returncode}" + (f": {stderr_text}" if stderr_text else "")
        print(f"[monitor] APNs push failed for a registered device: {cause}.")
        return False

    parsed = _parse_curl_output(proc.stdout)
    if parsed is None:
        print("[monitor] APNs push failed for a registered device: could not parse curl's response.")
        return False
    status, http_version, response_body = parsed

    if http_version != "2":
        print(f"[monitor] APNs push failed for a registered device: response used HTTP/{http_version}, "
              "not HTTP/2 — this runner's curl build may lack HTTP/2 support.")
        return False

    if 200 <= status < 300:
        return True

    try:
        body_reason = json.loads(response_body or "{}").get("reason", "")
    except (json.JSONDecodeError, TypeError, AttributeError):
        body_reason = ""
    invalid_reason = _invalid_token_reason(status, response_body)
    suffix = " — removing this device token." if invalid_reason else ""
    print(f"[monitor] APNs push rejected for a registered device: HTTP {status} {body_reason}".rstrip() + suffix)
    if invalid_reason and on_invalid_token:
        on_invalid_token(device_token)
    return False
