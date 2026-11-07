#!/usr/bin/env python3
"""CAS-989: size the AU back catalogue by year using Watchmode's own `/list-titles` filters,
rather than paying a credit per title on `/title/{id}/details`.

Confirmed against the Watchmode OpenAPI spec (1.1.10) on 2026-09-15 (see CAS-989's description
for the full readout): `/list-titles` filters server-side on `user_rating_low`/`_high`,
`critic_score_low`/`_high`, `regions`, `types`, `release_date_start`/`_end` and more, and returns
per title `id`, `title`, `year`, `imdb_id`, `tmdb_id`, `tmdb_type`, `type`,
`popularity_percentile`, plus `total_results`/`total_pages` on the response — but never the
`user_rating`/`critic_score` values themselves; those still cost 1 credit each via
`/title/{id}/details`. Cost here is 1 credit per requested region per page, and every call below
asks for a single region (`regions=AU`), so 1 call = 1 credit.

Cascade's WM_SCALE floor is 60, which a film with no critic score clears at a raw `user_rating`
of 6.0 — but the raw figure blends `user_rating` and `critic_score`, so a film with a strong
critic score clears 60 at a lower `user_rating`. Filtering at exactly 6.0 would silently drop
those, so the middle rating gate is 5.5, not 6.0; the real floor is still applied once
`/title/{id}/details` returns the real numbers.

Two modes:
  --mode by-year    One count-only call per (year, rating gate) — regions=AU, types=movie,
                    release_date_start/end bounding the calendar year, limit=1, reading only
                    total_results. Writes docs/appraisals/cas-backcatalogue-by-year.md as one
                    markdown table (one row per year, one column per gate) and prints the total
                    credits spent.
  --mode enumerate  Pages `/list-titles` at limit=250 across the same year range and gates,
                    writing every returned title (id, tmdb_id, year, title,
                    popularity_percentile) into state/wm_backcatalogue_candidates.json. Merged
                    by Watchmode id, so a rerun never duplicates an entry. This is CAS-986's
                    candidate pool — every enumerated title already clears its rating gate, so
                    the pool needs no further screening cost.

Both modes honour --max-credits (default 400): the run stops cleanly the moment the next call
would exceed it, and reports how far it got.

--dry-run runs the exact same code path against a small recorded fixture (_DRY_RUN_COUNTS /
_DRY_RUN_TITLES below) instead of the network — no WATCHMODE_API_KEY needed, and no HTTP call is
made. This is what tests/test_cas989_wm_backcatalogue_sizing.py exercises.

A live run needs WATCHMODE_API_KEY, a GitHub Actions secret only (CAS-579/767) — this script is
meant to run inside .github/workflows/wm_backcatalogue_sizing.yml, dispatch-only, never on a dev
machine.
"""
from __future__ import annotations
import argparse
import datetime
import json
import os
import sys

# Puts this file's own directory (scripts/) at the front of sys.path, not the repo root —
# poc_pipeline.py at the root is otherwise invisible. Resolve from __file__, not the working
# directory, so this also runs correctly when invoked from elsewhere (CAS-859).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import poc_pipeline as pp  # noqa: E402

DOC_PATH = os.path.join(_REPO_ROOT, "docs", "appraisals", "cas-backcatalogue-by-year.md")
CANDIDATES_PATH = os.path.join(_REPO_ROOT, "state", "wm_backcatalogue_candidates.json")

DEFAULT_YEAR_START = 1930
DEFAULT_RATING_GATES = "0,5.5,6.5"
DEFAULT_MAX_CREDITS = 400
ENUMERATE_LIMIT = 250

# A small recorded sample of real /list-titles response shapes (field names and nesting
# confirmed against the OpenAPI spec 1.1.10 — see CAS-989's description) used by --dry-run so
# the whole by-year/enumerate flow can be exercised, including by this file's own unit test,
# without WATCHMODE_API_KEY or a single network call.
_DRY_RUN_COUNTS = {
    (2020, None): 812, (2020, 5.5): 340, (2020, 6.5): 145,
    (2021, None): 790, (2021, 5.5): 322, (2021, 6.5): 138,
}
# "rating" is the fixture's own stand-in for Watchmode's real user_rating, used only to decide
# which gate a dry-run title clears (title["rating"] >= gate) — real /list-titles rows never carry
# this field themselves; the gate is what selected them server-side.
_DRY_RUN_TITLES = [
    {"id": 1001, "title": "Dry Run Feature", "year": 2020, "imdb_id": "tt0000001",
     "tmdb_id": 111, "tmdb_type": "movie", "type": "movie", "popularity_percentile": 62,
     "rating": 7.2},
    {"id": 1002, "title": "Second Fixture Film", "year": 2020, "imdb_id": "tt0000002",
     "tmdb_id": 222, "tmdb_type": "movie", "type": "movie", "popularity_percentile": 41,
     "rating": 6.0},
]


def parse_rating_gates(raw: str) -> list:
    """'0,5.5,6.5' -> [None, 5.5, 6.5] — 0 means "no gate" (the literal bare call the ticket
    describes), not a real user_rating_low=0 filter."""
    gates = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        value = float(token)
        gates.append(None if value == 0 else value)
    return gates


def gate_label(gate) -> str:
    return "no gate" if gate is None else f"user_rating_low={gate}"


def sort_gates_highest_first(gates: list) -> list:
    """CAS-1380: enumerate must probe-order titles by the highest rating gate they clear, so the
    gates themselves are walked highest first — `None` ("no gate") is the weakest selectivity and
    always sorts last."""
    return sorted(gates, key=lambda g: (g is None, -g if g is not None else 0.0))


def _count_url(year: int, gate) -> str:
    params = [
        "regions=AU", "types=movie",
        f"release_date_start={year}0101", f"release_date_end={year}1231",
        "limit=1",
    ]
    if gate is not None:
        params.append(f"user_rating_low={gate}")
    return f"{pp.WATCHMODE_BASE}/list-titles/?apiKey={pp.WATCHMODE_KEY}&" + "&".join(params)


def fetch_year_count(year: int, gate, dry_run: bool = False) -> int:
    if dry_run:
        return _DRY_RUN_COUNTS.get((year, gate), 0)
    data = pp.get_json(_count_url(year, gate))
    return data.get("total_results") or 0


def _titles_url(year_start: int, year_end: int, gate, page: int,
                 limit: int = ENUMERATE_LIMIT) -> str:
    params = [
        "regions=AU", "types=movie",
        f"release_date_start={year_start}0101", f"release_date_end={year_end}1231",
        "sort_by=popularity_desc", f"page={page}", f"limit={limit}",
    ]
    if gate is not None:
        params.append(f"user_rating_low={gate}")
    return f"{pp.WATCHMODE_BASE}/list-titles/?apiKey={pp.WATCHMODE_KEY}&" + "&".join(params)


def fetch_titles_page(year_start: int, year_end: int, gate, page: int,
                       dry_run: bool = False) -> dict:
    if dry_run:
        if page != 1:
            titles = []
        elif gate is None:
            titles = _DRY_RUN_TITLES
        else:
            titles = [t for t in _DRY_RUN_TITLES if t["rating"] >= gate]
        return {"titles": titles, "total_results": len(titles), "total_pages": 1}
    return pp.get_json(_titles_url(year_start, year_end, gate, page))


def _write_by_year_doc(path: str, rows: list, gates: list, credits_spent: int,
                        stopped_at, year_start: int, year_end: int) -> None:
    today = datetime.date.today().isoformat()
    lines = [
        "# Back-catalogue sizing by year — Watchmode list-titles (CAS-989)",
        "",
        f"Measured {today} by `scripts/wm_backcatalogue_sizing.py --mode by-year`, dispatched "
        "via `.github/workflows/wm_backcatalogue_sizing.yml` (WATCHMODE_API_KEY is a GitHub "
        "Actions secret only).",
        "",
        f"Requested range: {year_start}-{year_end}. Credits spent: {credits_spent}.",
    ]
    if stopped_at:
        lines.append(f"Stopped early at year={stopped_at[0]}, gate={gate_label(stopped_at[1])} "
                      "— max_credits reached.")
    lines.append("")
    header = "| Year | " + " | ".join(gate_label(g) for g in gates) + " |"
    sep = "| --- | " + " | ".join("---" for _ in gates) + " |"
    lines.append(header)
    lines.append(sep)
    for row in rows:
        cells = [str(row["counts"][g]) if g in row["counts"] else "—" for g in gates]
        lines.append(f"| {row['year']} | " + " | ".join(cells) + " |")
    lines.append("")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def run_by_year(year_start: int, year_end: int, gates: list, max_credits: int,
                 doc_path: str | None = None, dry_run: bool = False) -> dict:
    doc_path = doc_path or DOC_PATH
    rows = []
    credits_spent = 0
    stopped_at = None
    for year in range(year_start, year_end + 1):
        row = {"year": year, "counts": {}}
        for gate in gates:
            if credits_spent >= max_credits:
                stopped_at = (year, gate)
                break
            row["counts"][gate] = fetch_year_count(year, gate, dry_run=dry_run)
            credits_spent += 1
        rows.append(row)
        if stopped_at:
            break

    _write_by_year_doc(doc_path, rows, gates, credits_spent, stopped_at, year_start, year_end)
    print(f"years written: {len(rows)}")
    print(f"credits spent: {credits_spent}")
    if stopped_at:
        print(f"stopped early at year={stopped_at[0]} gate={gate_label(stopped_at[1])} "
              f"(max_credits={max_credits} reached)")
    return {"rows": rows, "credits_spent": credits_spent, "stopped_at": stopped_at}


def load_candidates(path: str) -> list:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_candidates(path: str, records: list) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(records, fh, indent=2)
        fh.write("\n")


def _candidate_row(title: dict, rating_band=None) -> dict:
    row = {
        "id": title["id"],
        "tmdb_id": title.get("tmdb_id"),
        "year": title.get("year"),
        "title": title.get("title"),
        "popularity_percentile": title.get("popularity_percentile"),
    }
    if rating_band is not None:
        row["rating_band"] = rating_band
    return row


def merge_candidates(existing: list, new_rows: list) -> tuple:
    """Keyed by Watchmode `id` — a rerun over an overlapping range updates the existing entry in
    place rather than duplicating it. CAS-1380: a row's `rating_band` (the highest gate a title
    appeared under across every gate processed, highest first, this run — see run_enumerate) only
    ever raises the merged entry's band, never lowers it, so a rerun under a weaker gate can't
    undo an earlier run's stronger finding. Returns (merged, added, updated)."""
    by_id = {row["id"]: row for row in existing}
    added = updated = 0
    for row in new_rows:
        rid = row["id"]
        if rid in by_id:
            prior = by_id[rid]
            new_row = dict(row)
            prior_band = prior.get("rating_band")
            new_band = new_row.get("rating_band")
            if prior_band is not None or new_band is not None:
                merged_band = (new_band if prior_band is None
                               else prior_band if new_band is None
                               else max(prior_band, new_band))
                new_row["rating_band"] = merged_band
            if new_row != prior:
                updated += 1
            by_id[rid] = new_row
        else:
            by_id[rid] = row
            added += 1
    return list(by_id.values()), added, updated


def run_enumerate(year_start: int, year_end: int, gates: list, max_credits: int,
                   out_path: str | None = None, dry_run: bool = False) -> dict:
    out_path = out_path or CANDIDATES_PATH
    existing = load_candidates(out_path)
    all_new_rows = []
    credits_spent = 0
    stopped = False
    # CAS-1380: highest gate first, so a title that clears a stronger gate is stamped with that
    # band even though every weaker gate's call also returns it.
    for gate in sort_gates_highest_first(gates):
        if stopped:
            break
        page = 1
        while True:
            if credits_spent >= max_credits:
                stopped = True
                break
            data = fetch_titles_page(year_start, year_end, gate, page, dry_run=dry_run)
            credits_spent += 1
            titles = data.get("titles") or []
            all_new_rows.extend(_candidate_row(t, gate) for t in titles)
            total_pages = data.get("total_pages") or 1
            if page >= total_pages or not titles:
                break
            page += 1

    merged, added, updated = merge_candidates(existing, all_new_rows)
    save_candidates(out_path, merged)

    print(f"titles seen this run: {len(all_new_rows)}")
    print(f"candidates added: {added}")
    print(f"candidates updated: {updated}")
    print(f"candidates total: {len(merged)}")
    print(f"credits spent: {credits_spent}")
    if stopped:
        print(f"stopped early (max_credits={max_credits} reached)")
    return {"added": added, "updated": updated, "total": len(merged),
            "credits_spent": credits_spent, "stopped": stopped}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                      formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", required=True, choices=["by-year", "enumerate"])
    parser.add_argument("--year-start", type=int, default=DEFAULT_YEAR_START)
    parser.add_argument("--year-end", type=int, default=None,
                         help="default: the current year")
    parser.add_argument("--rating-gates", default=DEFAULT_RATING_GATES,
                         help="comma-separated user_rating_low values; 0 means no gate")
    parser.add_argument("--max-credits", type=int, default=DEFAULT_MAX_CREDITS)
    parser.add_argument("--dry-run", action="store_true",
                         help="run against a recorded fixture, no network call")
    parser.add_argument("--doc-path", default=None, help="--mode by-year output path (testing)")
    parser.add_argument("--out-path", default=None, help="--mode enumerate output path (testing)")
    args = parser.parse_args(argv)

    year_end = args.year_end if args.year_end is not None else datetime.date.today().year
    gates = parse_rating_gates(args.rating_gates)

    if not args.dry_run and not os.environ.get("WATCHMODE_API_KEY"):
        print("WATCHMODE_API_KEY is not set — nothing to do here (pass --dry-run to exercise "
              "this script without it).")
        return 0

    if args.mode == "by-year":
        run_by_year(args.year_start, year_end, gates, args.max_credits,
                    doc_path=args.doc_path, dry_run=args.dry_run)
    else:
        run_enumerate(args.year_start, year_end, gates, args.max_credits,
                      out_path=args.out_path, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
