"""CAS-1588: write one qa_results row per QA area for a workflow run to the cascade-qa database.

    python ci/qa_report.py --workflow qa --job engine=success --job lint=failure ... [--env local] [--dry-run]

The connection string is the repository secret QA_DATABASE_URL. Reporting must never turn a check red:
a missing secret, a missing driver or any database error prints a warning and exits 0.

Roll-up (cases live in qa/cases/*.yaml, each names one or more `area:` ids from qa/areas.json):
  a case's outcome  = the combined outcome of the jobs that run it in this workflow (PROFILES below):
                      any failed -> Fail, all success -> Pass, otherwise -> Not run (or Blocked with --blocked)
  an area's result  = Fail if any case failed; Pass if every case passed; Partial if some passed and some did
                      not run; Not run / Blocked if none ran. Areas with no case in this run get no row.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "qa"))
from build_checklist import load_cases  # noqa: E402

AUTOMATED = {"unit", "browser", "agent-suite", "journey", "firstdays"}

# workflow -> where it sits in the ten testing points, and which jobs run which kind of case.
# `how` maps a case's `how:` to the jobs that exercise it; `cases` (optional) names cases outright.
PROFILES = {
    "qa": {"point": 2, "env": "local", "kind": "bench", "source": "qa.yml",
           "how": {"unit": ["engine", "lint", "data", "monitor", "scheduler"], "sql": ["data", "integrity"]},
           # a case's own refs say which job runs it; `how` is the fallback when no ref matches
           "refjobs": [("tests/js/", "engine"), ("tests/rls/", "engine"), ("tests/lint/", "lint"),
                       ("tests/test_", "data"), ("tests/run_data", "data"), ("scripts/test-integrity", "integrity"),
                       ("monitor/tests/", "monitor"), ("cloudflare/scheduler/", "scheduler")]},
    "e2e-full": {"point": 4, "env": "local", "kind": "bench", "source": "e2e-full.yml",
                 "how": {"browser": ["e2e-full"]}},
    "nightly-qa": {"point": 4, "env": "local", "kind": "bench", "source": "nightly-qa.yml",
                   "how": {"browser": ["e2e"], "agent-suite": ["agents"], "sql": ["integrity"],
                           "journey": ["simulate"], "firstdays": ["simulate"]}},
    "simulate": {"point": 5, "env": "local", "kind": "bench", "source": "simulate.yml",
                 "how": {"journey": ["simulate"], "firstdays": ["simulate"]}},
    "release-rehearsal": {"point": 5, "env": "local", "kind": "bench", "source": "release-rehearsal.yml",
                          "cases": {"REL-003": ["rehearse"]}},
    # CAS-1574: the real-user check on the deployed staging site (point 3, kind real, env staging).
    "deployed-smoke": {"point": 3, "env": "staging", "kind": "real", "source": "deployed-smoke.yml",
                       "cases": {"REAL-001": ["deployed-smoke"]}},
    "prod-check": {"point": 9, "env": "production", "kind": "production", "source": "prod-check.yml",
                   "cases": {"REL-005": ["prod-check"]}},
}


def case_kind(case):
    """The kind of test a case is: an explicit `kind:`, else derived from part and how."""
    if case.get("kind"):
        return case["kind"]
    how = case.get("how")
    if case.get("part") == "PROD":
        return "production"
    if how in AUTOMATED or (how == "sql" and any(r.startswith(("tests/", "scripts/")) for r in case.get("refs") or [])):
        return "bench"
    if how in ("lee-phone", "device"):
        return "phone"
    if how == "claude":
        return "review"
    return None  # planned, or a manual SQL step


def job_state(status):
    s = (status or "").lower()
    return "pass" if s == "success" else "fail" if s == "failure" else "notrun"


def case_state(jobs, outcomes):
    states = [job_state(outcomes.get(j)) for j in jobs]
    if "fail" in states:
        return "fail"
    return "pass" if states and all(s == "pass" for s in states) else "notrun"


def rollup(cases, profile, outcomes, blocked=False):
    """-> {area_id: (result, detail)} for the areas this workflow run covers."""
    per_area = {}
    for c in cases:
        if "cases" in profile:
            jobs = profile["cases"].get(c["id"])
        else:
            jobs = profile["how"].get(c.get("how")) if case_kind(c) == profile["kind"] else None
            by_ref = sorted({j for r in c.get("refs") or [] for pre, j in profile.get("refjobs", ()) if r.startswith(pre)})
            if jobs and by_ref:
                jobs = by_ref
        if not jobs:
            continue
        st = case_state(jobs, outcomes)
        for a in c.get("area") or []:
            per_area.setdefault(a, []).append((c["id"], st))
    out = {}
    for a, rows in per_area.items():
        states = {s for _, s in rows}
        failed = [i for i, s in rows if s == "fail"]
        if "fail" in states:
            res = "Fail"
        elif states == {"pass"}:
            res = "Pass"
        elif "pass" in states:
            res = "Partial"
        else:
            res = "Blocked" if blocked else "Not run"
        detail = ", ".join(failed)
        if not detail and res != "Pass":
            detail = "not run: " + ", ".join(i for i, s in rows if s == "notrun")
        out[a] = (res, detail[:300])
    return out


def build_info(root=ROOT):
    try:
        with open(os.path.join(root, "version.json"), encoding="utf-8") as fh:
            v = json.load(fh)
        return v.get("build"), v.get("commit")
    except (OSError, ValueError):
        return None, None


def run_url(env=os.environ):
    if env.get("GITHUB_RUN_ID") and env.get("GITHUB_REPOSITORY"):
        server = env.get("GITHUB_SERVER_URL", "https://github.com")
        return f'{server}/{env["GITHUB_REPOSITORY"]}/actions/runs/{env["GITHUB_RUN_ID"]}'
    return None


def make_rows(args, outcomes, cases, round_id, build, commit, url):
    profile = PROFILES[args.workflow]
    rows = []
    for area, (res, detail) in sorted(rollup(cases, profile, outcomes, args.blocked).items()):
        rows.append({"round_id": round_id, "build": build, "commit": commit, "env": args.env or profile["env"],
                     "point": args.point or profile["point"], "kind": profile["kind"], "area_id": area,
                     "result": res, "source": f'{profile["source"]} {args.source_job}'.strip(),
                     "detail": detail, "run_url": url})
    return rows


COLS = ("round_id", "build", "commit", "env", "point", "kind", "area_id", "result", "source", "detail", "run_url")


def parse_dsn(dsn):
    """CAS-1595: split a postgres URL into driver keyword args without a strict URL parser, so a password holding
    reserved characters (@ : / # ?) works whether or not it is percent-encoded. The LAST '@' ends the userinfo."""
    from urllib.parse import unquote
    rest = dsn.split("://", 1)[1] if "://" in dsn else dsn
    userinfo, _, hostpart = rest.rpartition("@")
    user, _, password = userinfo.partition(":")
    hostpart, _, query = hostpart.partition("?")
    hostport, _, dbname = hostpart.partition("/")
    host, _, port = hostport.partition(":")
    kw = {"host": host, "user": unquote(user), "password": unquote(password), "dbname": unquote(dbname) or "postgres"}
    if port:
        kw["port"] = int(port)
    for pair in filter(None, query.split("&")):
        k, _, v = pair.partition("=")
        if k == "sslmode":
            kw["sslmode"] = v
    return kw


NOT_RECORDED = "qa_report: results NOT recorded ({}). Check the QA_DATABASE_URL secret."


def warn_not_recorded(exc):
    """Fixed message only: the error class, never the driver's text (it can echo the connection string)."""
    msg = NOT_RECORDED.format(type(exc).__name__)
    print(msg)
    print("::warning::" + msg)


def write_rows(dsn, rows):
    import psycopg  # installed by the workflow step; imported late so a missing driver only warns
    with psycopg.connect(connect_timeout=15, **parse_dsn(dsn)) as conn:
        cur = conn.cursor()
        cur.execute("select id from qa_rounds where closed_at is null order by started_at desc limit 1")
        r = cur.fetchone()
        rid = r[0] if r else None
        for row in rows:
            row["round_id"] = rid
            cur.execute(f'insert into qa_results ({", ".join(COLS)}) values ({", ".join(["%s"] * len(COLS))})',
                        [row[c] for c in COLS])
        conn.commit()
    return rid


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--workflow", required=True, choices=sorted(PROFILES))
    ap.add_argument("--job", action="append", default=[], help="NAME=success|failure|skipped|cancelled")
    ap.add_argument("--env", choices=("local", "staging", "production"))
    ap.add_argument("--point", type=int)
    ap.add_argument("--source-job", default="")
    ap.add_argument("--blocked", action="store_true", help="cases that did not run are Blocked (prerequisite missing)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    try:
        outcomes = dict(j.split("=", 1) for j in args.job)
        build, commit = build_info()
        rows = make_rows(args, outcomes, load_cases(), None, build, commit, run_url())
        if args.dry_run:
            print(json.dumps(rows, indent=1))
            return 0
        dsn = os.environ.get("QA_DATABASE_URL", "").strip()
        if not dsn:
            print("qa_report: QA_DATABASE_URL is not set - results not recorded (not a failure)")
            return 0
        rid = write_rows(dsn, rows)
        print(f"qa_report: wrote {len(rows)} rows (round {rid}) for {args.workflow}")
    except Exception as e:  # reporting must never turn a check red
        warn_not_recorded(e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
