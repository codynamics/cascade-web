"""CAS-1588: open and close QA rounds in the cascade-qa database (used by the release chat).

    python ci/qa_round.py open --candidate 1.2.0 [--build N --commit X]   closes any open round first
    python ci/qa_round.py close
Reads QA_DATABASE_URL. Unlike qa_report this is run by a person, so a missing secret is an error (exit 1).
"""
import argparse
import os
import sys


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    o = sub.add_parser("open")
    o.add_argument("--candidate", required=True)
    o.add_argument("--build", type=int)
    o.add_argument("--commit")
    o.add_argument("--note")
    sub.add_parser("close")
    args = ap.parse_args(argv)
    dsn = os.environ.get("QA_DATABASE_URL", "").strip()
    if not dsn:
        print("qa_round: QA_DATABASE_URL is not set", file=sys.stderr)
        return 1
    import psycopg
    with psycopg.connect(dsn, connect_timeout=15) as conn:
        cur = conn.cursor()
        cur.execute("update qa_rounds set closed_at = now() where closed_at is null returning id")
        closed = [r[0] for r in cur.fetchall()]
        if closed:
            print(f"qa_round: closed round(s) {closed}")
        if args.cmd == "open":
            cur.execute("insert into qa_rounds (candidate, build, commit, note) values (%s, %s, %s, %s) returning id",
                        (args.candidate, args.build, args.commit, args.note))
            print(f"qa_round: opened round {cur.fetchone()[0]} for {args.candidate}")
        conn.commit()
    return 0


if __name__ == "__main__":
    sys.exit(main())
