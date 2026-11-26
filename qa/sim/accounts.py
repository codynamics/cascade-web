"""CAS-1549: the four QA accounts on STAGING (create / reset / teardown / list).

    python -m qa.sim.accounts create|reset|teardown|list

Environment (never a file): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (the public key,
only used to sign each new user in so complete_membership runs as that user, as it does in the app).

Staging only. Every command checks SUPABASE_URL first and exits non-zero BEFORE any network call or write if
it names production (ypccfyatejejslzlfrbf).

The agent, moods, prefs and notify payload are built by the app's own engine (qa/sim/build_account.mjs:
oneAgentBuildDraft -> oneAgentCommit -> oneAgentStarterMoods, loaded from the built index.html). Python only
passes the first-run ANSWERS in; it never computes genre bars, alerts or lists.

Fixed choices not in the ticket's table (any reasonable set): see ACCOUNTS below. Favourite (heart) genres,
services and the Date night / Family genre ticks are constants; the top service is the first of the services.
"""
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

PRODUCTION_REF = "ypccfyatejejslzlfrbf"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUILD_SCRIPT = os.path.join(ROOT, "qa", "sim", "build_account.mjs")
DOMAIN = "codynamics.com.au"

# Answers per account. `where` = cinema/rent/stream; partner/children "yes"|"no"; age "18plus"|"under18".
# favs = genres marked as a favourite; together/family = genres ticked on the Date night / Family screens.
ACCOUNTS = {
    "a": dict(where=["cinema", "rent", "stream"], partner="no", children=None, age="18plus",
              favs=["Drama", "Thriller", "Crime"], together=[], family=[],
              services=["Netflix", "Stan"], name="QA A"),
    "b": dict(where=["stream"], partner="yes", children=None, age="18plus",
              favs=["Comedy", "Romance"], together=["Comedy", "Romance", "Drama"], family=[],
              services=["Netflix", "Disney Plus"], name="QA B"),
    "c": dict(where=["cinema", "stream"], partner="yes", children="yes", age="18plus",
              favs=["Adventure", "Science Fiction"], together=["Comedy", "Mystery"], family=["Family", "Animation"],
              services=["Netflix", "Disney Plus", "Stan"], name="QA C"),
    "d": dict(where=["rent", "stream"], partner="no", children=None, age="under18",
              favs=["Animation", "Fantasy"], together=[], family=[],
              services=["Netflix", "Disney Plus"], name="QA D"),
}


def email_for(key):
    return "lee+qa-%s@%s" % (key, DOMAIN)


def guard(url):
    """Exit non-zero, before any write or network call, unless `url` is a non-production Supabase URL."""
    if not url:
        raise SystemExit("qa.sim.accounts: SUPABASE_URL is not set.")
    if PRODUCTION_REF in url:
        raise SystemExit("qa.sim.accounts: REFUSING to run - SUPABASE_URL is PRODUCTION (%s). Staging only." % PRODUCTION_REF)


def build_payload(key):
    """Ask the app's own engine (via node) for the first-run payload for one account."""
    answers = dict(ACCOUNTS[key])
    answers["topSvc"] = answers["services"][0] if answers["services"] and "stream" in answers["where"] else None
    answers["person"] = ""
    proc = subprocess.run(["node", BUILD_SCRIPT], input=json.dumps(answers), capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit("qa.sim.accounts: engine build failed:\n" + proc.stderr)
    return json.loads(proc.stdout)


class Api:
    def __init__(self, url, service_key, anon_key):
        self.url = url.rstrip("/")
        self.service_key = service_key
        self.anon_key = anon_key

    def call(self, method, path, body=None, key=None, bearer=None):
        headers = {"apikey": key or self.service_key, "Authorization": "Bearer " + (bearer or key or self.service_key),
                   "Content-Type": "application/json"}
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode()
        except urllib.error.HTTPError as e:
            raise SystemExit("qa.sim.accounts: %s %s -> HTTP %s %s" % (method, path, e.code, e.read().decode()[:300]))
        return json.loads(raw) if raw else None

    def find_users(self):
        """{email: user_id} for the four QA accounts."""
        wanted = {email_for(k) for k in ACCOUNTS}
        found, page = {}, 1
        while True:
            res = self.call("GET", "/auth/v1/admin/users?page=%d&per_page=200" % page) or {}
            users = res.get("users", [])
            for u in users:
                if (u.get("email") or "").lower() in wanted:
                    found[u["email"].lower()] = u["id"]
            if len(users) < 200:
                return found
            page += 1


def cmd_list(api):
    users = api.find_users()
    for k in sorted(ACCOUNTS):
        print("%s %s" % (email_for(k), users.get(email_for(k), "(missing)")))
    return 0


def cmd_teardown(api):
    users = api.find_users()
    for email, uid in sorted(users.items()):
        # Every account table references auth.users on delete cascade, so this removes every account row too.
        api.call("DELETE", "/auth/v1/admin/users/" + uid)
        print("deleted %s %s" % (email, uid))
    return 0


def cmd_create(api):
    if api.find_users():
        raise SystemExit("qa.sim.accounts: QA accounts already exist - run `reset` (or `teardown` first).")
    if not api.anon_key:
        raise SystemExit("qa.sim.accounts: SUPABASE_ANON_KEY is not set.")
    for k in sorted(ACCOUNTS):
        payload = build_payload(k)
        email, password = email_for(k), secrets.token_urlsafe(24)
        user = api.call("POST", "/auth/v1/admin/users", {"email": email, "password": password, "email_confirm": True})
        sess = api.call("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password}, key=api.anon_key)
        jwt = sess["access_token"]
        notify = dict(payload["notify"], email_on=True, in_app=True, email_address=email)
        out = api.call("POST", "/rest/v1/rpc/complete_membership",
                       {"p": {"agents": payload["agents"], "prefs": payload["prefs"], "notify": notify}},
                       key=api.anon_key, bearer=jwt)
        if out != "created":
            raise SystemExit("qa.sim.accounts: complete_membership for %s returned %r" % (email, out))
        # membStartWork's own follow-up: the first-run lists go into the account's view.
        api.call("POST", "/rest/v1/rpc/merge_user_prefs_view",
                 {"p_patch": {"moods": payload["moods"], "mood": "releases"}}, key=api.anon_key, bearer=jwt)
        print("created %s %s" % (email, user["id"]))
    return 0


def cmd_reset(api):
    cmd_teardown(api)
    return cmd_create(api)


COMMANDS = {"create": cmd_create, "reset": cmd_reset, "teardown": cmd_teardown, "list": cmd_list}


def main(argv=None, env=None):
    argv = sys.argv[1:] if argv is None else argv
    env = os.environ if env is None else env
    if len(argv) != 1 or argv[0] not in COMMANDS:
        raise SystemExit("usage: python -m qa.sim.accounts create|reset|teardown|list")
    url = env.get("SUPABASE_URL", "")
    guard(url)   # before anything else: no network call or write can precede this
    key = env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not key:
        raise SystemExit("qa.sim.accounts: SUPABASE_SERVICE_ROLE_KEY is not set (environment only).")
    return COMMANDS[argv[0]](Api(url, key, env.get("SUPABASE_ANON_KEY", "")))


if __name__ == "__main__":
    sys.exit(main())
