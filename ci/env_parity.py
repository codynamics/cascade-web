"""CAS-1576: staging vs production sign-in / email settings parity.

    SUPABASE_ACCESS_TOKEN=... python3 -I ci/env_parity.py

Reads each project's auth config through the Supabase Management API (GET /v1/projects/{ref}/config/auth),
the deployed edge function slugs (GET /v1/projects/{ref}/functions) and public.schema_migrations
(POST /v1/projects/{ref}/database/query, read-only select), then prints a table: setting, staging, production,
verdict. Exit 1 if any MUST-MATCH / MUST-DIFFER / migration / function check fails. Unlisted differences are
WARN only, so a newly added setting is noticed without blocking. Read-only: nothing is written to either project.
"""
import json
import os
import re
import sys
import urllib.request

STAGING_REF = "oenvezqluwqdwlzfhisc"
PRODUCTION_REF = "ypccfyatejejslzlfrbf"
API = "https://api.supabase.com"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIG_DIR = os.path.join(ROOT, "supabase", "migrations")

MUST_MATCH = [
    "mailer_autoconfirm",              # "Confirm email" (autoconfirm on = confirmation OFF)
    "external_email_enabled",          # email provider enabled
    "mailer_otp_length",
    "mailer_otp_exp",
    "disable_signup",                  # allow new sign-ups
    "mailer_secure_email_change_enabled",
    "smtp_admin_email",                # SMTP sender address
    "rate_limit_email_sent",
]
# every email template subject and body
TEMPLATES = ["confirmation", "magic_link", "invite", "recovery", "email_change", "reauthentication"]
for _t in TEMPLATES:
    MUST_MATCH += ["mailer_subjects_" + _t, "mailer_templates_%s_content" % _t]
# magic link / OTP enabled has no single flag of its own: it is the email provider plus the OTP settings above.

# key -> expected (staging, production); None = just "must differ"
MUST_DIFFER = {
    "site_url": None,
    "uri_allow_list": None,
    "smtp_sender_name": ("Cascade Staging", "Cascade"),
}
SECRET_RE = re.compile(r"pass|secret|token|key|jwt|hook", re.I)


def _norm(v):
    return json.dumps(v, sort_keys=True) if not isinstance(v, str) else v


def _show(v, width=28):
    s = "<unset>" if v is None else _norm(v)
    s = s.replace("\n", " ")
    return s if len(s) <= width else s[:width - 1] + "…"


def compare_auth(stg, prod):
    """Return [(setting, staging, production, verdict)] with verdict PASS / FAIL / WARN."""
    rows = []
    for k in MUST_MATCH:
        a, b = stg.get(k), prod.get(k)
        rows.append((k, a, b, "PASS" if _norm(a) == _norm(b) else "FAIL (must match)"))
    for k, expect in MUST_DIFFER.items():
        a, b = stg.get(k), prod.get(k)
        if expect is not None:
            ok = (a, b) == expect
            why = "FAIL (expected %r / %r)" % expect
        else:
            ok = a is not None and b is not None and _norm(a) != _norm(b)
            why = "FAIL (must differ)"
        rows.append((k, a, b, "PASS" if ok else why))
    listed = set(MUST_MATCH) | set(MUST_DIFFER)
    for k in sorted(set(stg) | set(prod)):
        if k in listed or SECRET_RE.search(k):
            continue
        a, b = stg.get(k), prod.get(k)
        if _norm(a) != _norm(b):
            rows.append((k, a, b, "WARN (unlisted setting differs)"))
    return rows


def compare_sets(name, stg, prod, expected=None):
    """Compare two sets of names; with `expected`, both must equal it."""
    stg, prod = set(stg), set(prod)
    rows = []
    if expected is None:
        ok = stg == prod
        rows.append((name, ",".join(sorted(stg)), ",".join(sorted(prod)),
                     "PASS" if ok else "FAIL (staging-only: %s; production-only: %s)" % (
                         sorted(stg - prod), sorted(prod - stg))))
    else:
        expected = set(expected)
        for label, got in (("staging", stg), ("production", prod)):
            ok = got == expected
            rows.append((name + " " + label, "%d" % len(got), "repo %d" % len(expected),
                         "PASS" if ok else "FAIL (missing: %s; extra: %s)" % (
                             sorted(expected - got), sorted(got - expected))))
    return rows


def repo_migrations():
    return [f.split("_", 1)[0] for f in os.listdir(MIG_DIR) if re.match(r"^\d{4}_.+\.sql$", f)]


def api(token, method, path, body=None):
    req = urllib.request.Request(API + path, method=method, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "cascade-env-parity"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch(token, ref):
    auth = api(token, "GET", "/v1/projects/%s/config/auth" % ref)
    funcs = {f["slug"] for f in api(token, "GET", "/v1/projects/%s/functions" % ref)}
    rows = api(token, "POST", "/v1/projects/%s/database/query" % ref,
               {"query": "select version from public.schema_migrations"})
    return auth, funcs, {str(r["version"]) for r in rows}


def render(rows):
    w = max(len(r[0]) for r in rows)
    lines = ["%-*s  %-28s  %-28s  %s" % (w, "setting", "staging", "production", "verdict")]
    for k, a, b, v in rows:
        lines.append("%-*s  %-28s  %-28s  %s" % (w, k, _show(a), _show(b), v))
    return "\n".join(lines)


def main():
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not token:
        print("env-parity: SUPABASE_ACCESS_TOKEN is not set.")
        return 2
    sa, sf, sm = fetch(token, STAGING_REF)
    pa, pf, pm = fetch(token, PRODUCTION_REF)
    rows = compare_auth(sa, pa)
    rows += compare_sets("edge functions", sf, pf)
    rows += compare_sets("schema_migrations", sm, pm, expected=repo_migrations())
    print(render(rows))
    bad = [r for r in rows if r[3].startswith("FAIL")]
    warn = [r for r in rows if r[3].startswith("WARN")]
    if bad:
        for r in bad:
            print("env-parity FAIL: %s — staging=%s production=%s %s" % (r[0], _show(r[1]), _show(r[2]), r[3]))
        return 1
    print("env-parity: OK (%d checks, %d warnings)" % (len(rows) - len(warn), len(warn)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
