"""CAS-1546: apply unrecorded supabase/migrations/NNNN_*.sql to STAGING only.

Used by .github/workflows/migrate-staging.yml. SUPABASE_DB_URL comes from the `staging`
GitHub Environment. Production (ypccfyatejejslzlfrbf) is migrated only by the gated release,
never here: the production-ref guard below refuses to run against it.
"""
import os
import re
import subprocess
import sys

PRODUCTION_REF = "ypccfyatejejslzlfrbf"
MIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "supabase", "migrations")
NAME_RE = re.compile(r"^(\d{4})_.+\.sql$")


def guard(db_url):
    """Raise if the URL is missing or points at production."""
    if not db_url:
        raise SystemExit("migrate-staging: SUPABASE_DB_URL is not set on the 'staging' environment.")
    if PRODUCTION_REF in db_url:
        raise SystemExit("migrate-staging: REFUSING to run - SUPABASE_DB_URL points at PRODUCTION (%s). "
                         "Production is migrated only by the gated release." % PRODUCTION_REF)


def pending(files, recorded):
    """Return [(version, filename)] for unrecorded migration files, in filename order."""
    out = []
    for f in sorted(files):
        m = NAME_RE.match(f)
        if m and m.group(1) not in set(recorded):
            out.append((m.group(1), f))
    return out


def psql(db_url, *args):
    return subprocess.run(["psql", db_url, "-X", "-v", "ON_ERROR_STOP=1", *args],
                          capture_output=True, text=True)


def recorded_versions(db_url):
    r = psql(db_url, "-At", "-c", "select version from public.schema_migrations")
    if r.returncode != 0:
        # Fresh database: ledger not created yet; 0001 creates it.
        if "schema_migrations" in r.stderr and "does not exist" in r.stderr:
            return []
        raise SystemExit("migrate-staging: cannot read schema_migrations:\n" + r.stderr)
    return [v.strip() for v in r.stdout.splitlines() if v.strip()]


def main():
    db_url = os.environ.get("SUPABASE_DB_URL", "")
    guard(db_url)
    todo = pending(os.listdir(MIG_DIR), recorded_versions(db_url))
    if not todo:
        print("migrate-staging: staging is up to date.")
        return 0
    for version, fname in todo:
        print("migrate-staging: applying " + fname)
        r = psql(db_url, "--single-transaction", "-f", os.path.join(MIG_DIR, fname))
        sys.stdout.write(r.stdout)
        if r.returncode != 0:
            sys.stderr.write(r.stderr)
            print("::error::migrate-staging FAILED on " + fname, file=sys.stderr)
            return 1
        if version not in recorded_versions(db_url):
            print("::warning::%s did not self-record; inserting version %s" % (fname, version))
            r = psql(db_url, "-c", "insert into public.schema_migrations (version) values ('%s') on conflict do nothing" % version)
            if r.returncode != 0 or version not in recorded_versions(db_url):
                sys.stderr.write(r.stderr)
                print("::error::migrate-staging could not record " + fname, file=sys.stderr)
                return 1
    print("migrate-staging: applied %d migration(s)." % len(todo))
    return 0


if __name__ == "__main__":
    sys.exit(main())
