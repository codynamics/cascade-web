#!/usr/bin/env python3
"""ci/mark_on_staging.py — called by qa.yml once all 5 QA jobs pass on staging.

For every CAS-NN key in the commits that just pushed (RANGE_FROM..RANGE_TO), transition the
ticket to On Staging. No label here — ci/close_shipped.py (promote.yml, on main) owns the
v<VERSION> label once the release actually ships to main.

Stdlib only (urllib) — matches the repo convention; no pip install in CI.
Fails soft per ticket (logs and continues) so one odd ticket can't fail a green QA push,
but exits non-zero if nothing could be processed at all.
"""
import json, os, sys, urllib.request
from jira_common import shipped_keys, transition_by_name

# CAS-1562: a push whose own qa run was cancelled/failed is never marked by github.event.before..sha
# of a later green run. So the range starts at the head of the most recent EARLIER qa run on staging
# that concluded success; github.event.before is only the fallback.


def resolve_range_from(runs, current_run_id, event_before):
    """runs: workflow-run dicts (newest first, as the API returns them) with id, head_sha, conclusion.
    Returns head_sha of the newest earlier successful run, else event_before."""
    for r in runs:
        if r.get("id") == current_run_id or (current_run_id is not None and r.get("id", 0) > current_run_id):
            continue
        if r.get("conclusion") == "success":
            return r["head_sha"]
    return event_before


def fetch_success_runs(repo, token):
    url = (f"https://api.github.com/repos/{repo}/actions/workflows/qa.yml/runs"
           "?branch=staging&status=success&per_page=30")
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp).get("workflow_runs", [])


def compute_range_from(event_before, fetch=fetch_success_runs):
    repo, token = os.environ.get("GITHUB_REPOSITORY"), os.environ.get("GH_TOKEN")
    run_id = int(os.environ["GITHUB_RUN_ID"]) if os.environ.get("GITHUB_RUN_ID") else None
    if not (repo and token):
        return event_before
    try:
        return resolve_range_from(fetch(repo, token), run_id, event_before)
    except Exception as e:  # API trouble must not break marking; fall back to old behaviour
        print(f"Could not read earlier qa runs ({e}); falling back to event.before")
        return event_before


def main():
    range_to = os.environ.get("RANGE_TO", "HEAD")
    range_from = compute_range_from(os.environ["RANGE_FROM"])
    print(f"Range: {range_from[:10] or '(none)'}..{range_to[:10]}")
    keys = shipped_keys(range_from, range_to)
    if not keys:
        print("No CAS-NN keys in the pushed range; nothing to mark On Staging.")
        return
    print(f"Marking {len(keys)} ticket(s) On Staging: {', '.join(keys)}")
    ok = sum(transition_by_name(k, "On Staging") for k in keys)
    print(f"Done: {ok}/{len(keys)} transitioned.")
    if ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
