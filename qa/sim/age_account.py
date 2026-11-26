"""CAS-1555: move a STAGING QA account's creation time back, so the first ten days can be simulated in minutes.

    python -m qa.sim.age_account --user <uuid> --days <n>

Sets `auth.users.created_at` to now minus `n` days (n may be fractional) through the staging database connection
(`SUPABASE_DB_URL`, the `staging` GitHub environment's secret, as ci/migrate_staging.py uses). No clock in the
product changes: every first-days rule reads the account's creation time, so moving it is the whole method.

Columns a first-days rule reads (keep this list current when a new day +N rule is built):
  * auth.users.created_at - the day +1 catch-up (monitor/catchup.py due_users, via fetch_auth_users) and the
    tutorial banner (app_template.html tutAccountAgeDays(a.user.created_at, now)).
  * the rating reminder card (day +2) and the day +7 first-week recap also read created_at (CAS-1583), so aging
    an account moves them too.
  * CAS-1566 - the watch reminder card (app_template.html rnudgeDecide, tutAccountAgeDays(createdAt, now) < 2 stays
    silent); its Taste card does NOT read created_at (10 ratings and a 5+ point adjustment).
  * CAS-1567 - the day +7 recap (monitor/recap.py due_users: sign-up Sydney date, via fetch_user_created_at).
  * CAS-1592 - the email taste line reads no created_at (10 Watched ratings and a 5+ point adjustment); it only rides
    an email that is going out anyway.

Staging only: the connection string is checked FIRST and the command exits non-zero before any write or
subprocess if it names production (ypccfyatejejslzlfrbf) or is missing.
"""
import argparse
import datetime as _dt
import os
import re
import subprocess
import sys

PRODUCTION_REF = "ypccfyatejejslzlfrbf"
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def guard(db_url):
    """Exit non-zero, before any write, unless `db_url` is a non-production connection string."""
    if not db_url:
        raise SystemExit("qa.sim.age_account: SUPABASE_DB_URL is not set (the staging environment's secret).")
    if PRODUCTION_REF in db_url:
        raise SystemExit("qa.sim.age_account: REFUSING to run - SUPABASE_DB_URL is PRODUCTION (%s). Staging only."
                         % PRODUCTION_REF)


def psql_runner(db_url):
    """The real writer: runs one SQL statement through psql. Tests pass a fake with the same shape."""
    def run(sql):
        r = subprocess.run(["psql", db_url, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit("qa.sim.age_account: psql failed:\n" + r.stderr[:500])
        return r.stdout
    return run


def set_created_at(db_url, user_id, created_at, run=None):
    """Set one account's auth.users.created_at (an ISO string). Guard first, then validate, then write."""
    guard(db_url)
    if not _UUID.match(str(user_id)):
        raise SystemExit("qa.sim.age_account: %r is not a user uuid." % (user_id,))
    ts = _dt.datetime.fromisoformat(str(created_at).replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=_dt.timezone.utc)
    sql = "update auth.users set created_at = '%s' where id = '%s'" % (ts.isoformat(), user_id)
    (run or psql_runner(db_url))(sql)
    return ts.isoformat()


def age(db_url, user_id, days, now=None, run=None):
    """created_at := now - days. Returns the ISO string written."""
    guard(db_url)
    now = now or _dt.datetime.now(_dt.timezone.utc)
    return set_created_at(db_url, user_id, now - _dt.timedelta(days=float(days)), run=run)


def main(argv=None, env=None, run=None):
    env = os.environ if env is None else env
    p = argparse.ArgumentParser(prog="python -m qa.sim.age_account")
    p.add_argument("--user", required=True, help="the staging account's auth user uuid")
    p.add_argument("--days", required=True, type=float, help="age the account to this many days old")
    args = p.parse_args(sys.argv[1:] if argv is None else argv)
    db_url = env.get("SUPABASE_DB_URL", "")
    guard(db_url)   # before anything else
    print("age_account: %s created_at -> %s" % (args.user, age(db_url, args.user, args.days, run=run)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
