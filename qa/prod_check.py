"""CAS-1552: post-production check. Read-only except ONE targeted hits_stream test alert to --qa-user.

Never touches lee+c1 or a real member: --qa-user is refused when empty, not a uuid, or the id of
lee+c1@codynamics.com.au. Every check prints one line, PASS or FAIL; exit 1 if any FAIL.
All I/O goes through an `io` object (see LiveIO) so tests drive it with fakes.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://cascademovies.com"
PROD_REF = "ypccfyatejejslzlfrbf"
BLOCKED_EMAIL = "lee+c1@codynamics.com.au"
FUNCTIONS = ("membership-verify", "membership-notifications")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
MAX_CATALOGUE_HOURS = 30
ALERT_WAIT_SECONDS = 600
UPTIME_RUNS = 24


def check_qa_user(qa_user, blocked_id):
    """Fail closed: empty, malformed, or lee+c1's id all refuse."""
    qa_user = (qa_user or "").strip()
    if not qa_user:
        raise SystemExit("prod-check: qa_user is empty - refusing to run.")
    if not UUID_RE.match(qa_user):
        raise SystemExit("prod-check: qa_user %r is not a uuid - refusing to run." % qa_user)
    if blocked_id and qa_user.lower() == str(blocked_id).lower():
        raise SystemExit("prod-check: qa_user is the user id of %s - refusing to run." % BLOCKED_EMAIL)
    return qa_user


def check_version(io, release):
    got = (io.site_version() or {}).get("commit") or ""
    ok = bool(release) and bool(got) and (got.startswith(release) or release.startswith(got))
    return ok, "version.json commit %s vs release %s" % (got or "?", release or "?")


def check_migrations(io, release):
    want = sorted(io.migration_files(release))
    have = sorted(io.recorded_migrations())
    missing = [w for w in want if w not in have]
    extra = [h for h in have if h not in want]
    return (not missing and not extra), "%d file(s), %d recorded, missing %s, extra %s" % (
        len(want), len(have), missing or "none", extra or "none")


def check_catalogue_age(io, now=None):
    stamp = io.catalogue_published_at()
    if not stamp:
        return False, "no catalogue timestamp"
    now = now or dt.datetime.now(dt.timezone.utc)
    t = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    hours = (now - t).total_seconds() / 3600
    return hours < MAX_CATALOGUE_HOURS, "catalogue %.1fh old (limit %dh)" % (hours, MAX_CATALOGUE_HOURS)


def check_functions(io):
    bad = []
    for name in FUNCTIONS:
        try:
            status = io.function_health(name)
        except Exception as e:  # a network error is a FAIL, not a crash
            status = "error %s" % e
        if not (isinstance(status, int) and 200 <= status < 300):
            bad.append("%s=%s" % (name, status))
    return not bad, "edge functions %s" % (", ".join(bad) if bad else "answer OK")


def check_health_and_uptime(io):
    health = io.health_json() or {}
    runs = io.uptime_conclusions(UPTIME_RUNS) or []
    bad_runs = [r for r in runs if r != "success"]
    ok = bool(health.get("ok")) and len(runs) >= UPTIME_RUNS and not bad_runs
    return ok, "health.json ok=%s, %d of last %d uptime run(s) fetched, %d not green" % (
        health.get("ok"), len(runs), UPTIME_RUNS, len(bad_runs))


def check_alert(io, qa_user, wait=ALERT_WAIT_SECONDS, poll=30):
    """One hits_stream test alert to qa_user only; ledger row, push stamp and email stamp within `wait` s."""
    armed = io.send_test_alert(qa_user)
    deadline = io.clock() + wait
    row = None
    while True:
        rows = [r for r in io.alert_rows(qa_user, armed) if r.get("moment") == "hits_stream"]
        row = rows[0] if rows else None
        if row and row.get("pushed_at") and row.get("emailed_at"):
            return True, "ledger row, push and email recorded"
        if io.clock() >= deadline:
            break
        io.sleep(poll)
    if not row:
        return False, "no ledger row within %ds" % wait
    missing = [n for n, c in (("push", "pushed_at"), ("email", "emailed_at")) if not row.get(c)]
    return False, "ledger row present, missing %s within %ds" % (" and ".join(missing), wait)


def run(io, release, qa_user):
    qa_user = check_qa_user(qa_user, io.user_id_for_email(BLOCKED_EMAIL))
    checks = [
        ("version", lambda: check_version(io, release)),
        ("migrations", lambda: check_migrations(io, release)),
        ("catalogue-age", lambda: check_catalogue_age(io)),
        ("edge-functions", lambda: check_functions(io)),
        ("health-and-uptime", lambda: check_health_and_uptime(io)),
        ("test-alert", lambda: check_alert(io, qa_user)),
    ]
    failed = 0
    for name, fn in checks:
        try:
            ok, detail = fn()
        except Exception as e:
            ok, detail = False, "error: %s" % e
        print("%s %s - %s" % ("PASS" if ok else "FAIL", name, detail))
        failed += 0 if ok else 1
    return 1 if failed else 0


class LiveIO:
    def __init__(self, env=os.environ):
        self.url = env["SUPABASE_URL"].rstrip("/")
        if PROD_REF not in self.url:
            raise SystemExit("prod-check: SUPABASE_URL is not the production project (%s)." % PROD_REF)
        self.key = env["SUPABASE_SERVICE_ROLE_KEY"]
        self.gh = env.get("GITHUB_TOKEN", "")
        self.repo = env.get("GITHUB_REPOSITORY", "LCP2/cascade-web")
        self.clock, self.sleep = time.time, time.sleep
        self.out_dir = os.path.join(env.get("RUNNER_TEMP", "/tmp"), "prod-check")

    def _fetch(self, url, headers=None, method="GET", timeout=30):
        req = urllib.request.Request(url, headers=headers or {}, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8")

    def _auth(self):
        return {"apikey": self.key, "Authorization": "Bearer " + self.key}

    def _rest(self, path):
        return json.loads(self._fetch(self.url + path, self._auth())[1])

    def site_version(self):
        return json.loads(self._fetch(SITE + "/version.json")[1])

    def migration_files(self, release):
        out = subprocess.run(["git", "ls-tree", "--name-only", release, "supabase/migrations/"],
                             capture_output=True, text=True, cwd=ROOT, check=True).stdout
        names = [os.path.basename(p) for p in out.split()]
        return [n[:4] for n in names if re.match(r"^\d{4}_.+\.sql$", n)]

    def recorded_migrations(self):
        return [r["version"] for r in self._rest("/rest/v1/schema_migrations?select=version&order=version.asc")]

    def catalogue_published_at(self):
        v = self.site_version() or {}
        if v.get("catalogue_published_at"):
            return v["catalogue_published_at"]
        cat = json.loads(self._fetch(SITE + "/catalogue.json")[1])
        return (cat or {}).get("generated_at") if isinstance(cat, dict) else None

    def function_health(self, name):
        try:
            return self._fetch("%s/functions/v1/%s" % (self.url, name), {"apikey": self.key}, "OPTIONS")[0]
        except urllib.error.HTTPError as e:
            return e.code

    def health_json(self):
        with open(os.path.join(ROOT, "state", "health.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def uptime_conclusions(self, n):
        h = {"Authorization": "Bearer " + self.gh, "Accept": "application/vnd.github+json"}
        u = "https://api.github.com/repos/%s/actions/workflows/uptime.yml/runs?per_page=%d&status=completed" % (self.repo, n)
        return [r.get("conclusion") for r in json.loads(self._fetch(u, h)[1]).get("workflow_runs", [])]

    def user_id_for_email(self, email):
        page = 1
        while True:
            body = json.loads(self._fetch("%s/auth/v1/admin/users?page=%d&per_page=200" % (self.url, page),
                                          self._auth())[1])
            users = body.get("users", []) if isinstance(body, dict) else body
            for u in users:
                if (u.get("email") or "").lower() == email.lower():
                    return u["id"]
            if len(users) < 200:
                return None
            page += 1

    def send_test_alert(self, qa_user):
        armed = dt.datetime.now(dt.timezone.utc).isoformat()
        day = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
        os.makedirs(self.out_dir, exist_ok=True)
        base = ["--target-user", qa_user]
        subprocess.run([sys.executable, "-m", "monitor.notify_test", "--scenario", "hits_stream", *base,
                        "--date", day, "--out-dir", self.out_dir], cwd=ROOT, check=True)
        subprocess.run([sys.executable, "-m", "monitor", "--today", os.path.join(self.out_dir, "today.json"),
                        "--yesterday", os.path.join(self.out_dir, "yesterday.json"), "--date", day, *base],
                       cwd=ROOT, check=True)
        return armed

    def alert_rows(self, qa_user, since):
        return self._rest("/rest/v1/notifications?select=moment,pushed_at,emailed_at,found_at&user_id=eq.%s"
                          "&found_at=gte.%s&order=found_at.asc" % (qa_user, urllib.parse.quote(since)))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--release", required=True, help="commit that was released")
    p.add_argument("--qa-user", default="", help="production QA account user id (uuid)")
    a = p.parse_args(argv)
    return run(LiveIO(), a.release, a.qa_user)


if __name__ == "__main__":
    sys.exit(main())
