"""CAS-1547: helpers for .github/workflows/release-rehearsal.yml.

    python3 -I ci/rehearsal.py split <main-ref> <candidate-ref>   # prints the migrations only the candidate has
    python3 -I ci/rehearsal.py counts <db-url>                    # row counts of the QA accounts' rows, per table
    python3 -I ci/rehearsal.py compare <before.json> <after.json> # exit 1 if any count differs

The migration split is computed from the two commits' own supabase/migrations/ file lists (git ls-tree),
never from a hand-kept list. Local stack only: `counts` refuses a production URL.
"""
import json
import re
import subprocess
import sys

PRODUCTION_REF = "ypccfyatejejslzlfrbf"
MIG_DIR = "supabase/migrations"
NAME_RE = re.compile(r"^\d{4}_.+\.sql$")


def split(main_files, candidate_files):
    """Return (main_list, extra): main's migration files, and the candidate's files that main lacks (both sorted)."""
    main_list = sorted(f for f in main_files if NAME_RE.match(f))
    have = set(main_list)
    extra = sorted(f for f in candidate_files if NAME_RE.match(f) and f not in have)
    return main_list, extra


def migration_files(ref):
    out = subprocess.run(["git", "ls-tree", "--name-only", ref, MIG_DIR + "/"],
                         capture_output=True, text=True, check=True).stdout
    return [line.split("/")[-1] for line in out.splitlines() if line.strip()]


COUNTS_SQL = """
select t.table_name from information_schema.columns t
join information_schema.tables b on b.table_schema = t.table_schema and b.table_name = t.table_name and b.table_type = 'BASE TABLE'
where t.table_schema = 'public' and t.column_name = 'user_id' order by 1
"""


def psql(db_url, sql):
    r = subprocess.run(["psql", db_url, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("rehearsal: psql failed:\n" + r.stderr)
    return r.stdout


def counts(db_url):
    """{table: rows} for every public table with a user_id column, restricted to the lee+qa-* accounts' rows."""
    if PRODUCTION_REF in db_url:
        raise SystemExit("rehearsal: REFUSING - db url is PRODUCTION (%s)." % PRODUCTION_REF)
    out = {}
    for table in psql(db_url, COUNTS_SQL).split():
        n = psql(db_url, 'select count(*) from public."%s" where user_id in '
                         "(select id from auth.users where email like 'lee+qa-%%')" % table)
        out[table] = int(n.strip())
    return out


def diff(before, after):
    return {t: (before.get(t), after.get(t)) for t in sorted(set(before) | set(after)) if before.get(t) != after.get(t)}


def main(argv):
    if len(argv) == 3 and argv[0] == "split":
        main_list, extra = split(migration_files(argv[1]), migration_files(argv[2]))
        print("\n".join(extra))
        return 0
    if len(argv) == 2 and argv[0] == "counts":
        print(json.dumps(counts(argv[1]), sort_keys=True))
        return 0
    if len(argv) == 3 and argv[0] == "compare":
        d = diff(json.load(open(argv[1])), json.load(open(argv[2])))
        for t, (a, b) in d.items():
            print("row count changed: %s %s -> %s" % (t, a, b))
        return 1 if d else 0
    raise SystemExit(__doc__)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
