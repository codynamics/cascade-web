"""CAS-1557: collect the nightly staging run's failures and raise one Jira ticket per new one.

Each nightly-qa.yml suite job uploads its console log as `<suite>.log` into one directory. This module reads
those logs, builds one list of failing items (suite, test name, error first line), and for each item with no open
`Nightly QA: <suite> - <name>` ticket creates a Bug (labels needs-cc-web, Prod-QA) and moves it to Ready for Dev.
No JIRA_EMAIL / JIRA_API_TOKEN: it creates nothing and says so. Nothing failing: it says so and does nothing else.

    python -m qa.nightly_tickets --logs DIR [--run-url URL] [--commit SHA] [--failed SUITE,SUITE]
"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

SITE = "https://codynamics.atlassian.net"
PROJECT = "CAS"
PREFIX = "Nightly QA:"
LABELS = ["needs-cc-web", "Prod-QA"]
TARGET_STATUS = "Ready for Dev"
GUIDANCE = ("Decide whether the test or the app is wrong. Fix the test if the app is right; otherwise fix the app. "
            "Add needs-lee only if the expected behaviour itself is in question.")

# agents / journeys / first-days print `FAIL <id> - <msg>` or `FAIL journey=... step=...`; a setup problem is
# `SETUP FAIL ...`. Playwright's failure summary prints `  1) [webkit] > file:12:5 > title ------`.
_LINE_FAIL = re.compile(r"^(?P<setup>SETUP )?FAIL[ :]\s*(?P<rest>.+)$")
_PW_FAIL = re.compile(r"^\s*\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?(?P<name>.+?)\s*─*\s*$")
_ERR = re.compile(r"^\s*(?:Error|AssertionError|TimeoutError|expect\(|Test timeout)[^\n]*")


@dataclass(frozen=True)
class Failure:
    suite: str
    name: str
    error: str
    first_failing_commit: str = "unknown"

    @property
    def summary(self):
        return f"{PREFIX} {self.suite} — {self.name}"[:250]


def _one_line(s, n=300):
    return " ".join(str(s).split())[:n]


def parse_log(suite, text):
    """Failing items in one suite's console log, de-duplicated by name, in order."""
    lines = text.splitlines()
    out, seen = [], set()

    def add(name, error):
        name = _one_line(name, 150)
        if name and name not in seen:
            seen.add(name)
            out.append(Failure(suite, name, _one_line(error) or "(no error line)"))

    for i, line in enumerate(lines):
        m = _LINE_FAIL.match(line.strip())
        if m:
            rest = m.group("rest")
            name, _, err = rest.partition(" - ")
            if m.group("setup"):
                name = "SETUP FAIL " + name
            add(name, err or rest)
            continue
        m = _PW_FAIL.match(line)
        if m and "›" in line:
            err = ""
            for nxt in lines[i + 1:i + 25]:
                em = _ERR.match(nxt)
                if em:
                    err = em.group(0)
                    break
            add(m.group("name"), err)
    return out


def collect(log_dir, failed_suites=()):
    """One list across every `<suite>.log`. A suite that failed but yielded no parsed item gets one whole-suite item."""
    items = []
    log_dir = Path(log_dir)
    logs = sorted(log_dir.glob("*.log")) if log_dir.is_dir() else []
    for p in logs:
        text = p.read_text(encoding="utf-8", errors="replace")
        found = parse_log(p.stem, text)
        if not found and p.stem in failed_suites:
            tail = [ln for ln in text.splitlines() if ln.strip()][-1:] or ["(empty log)"]
            found = [Failure(p.stem, "suite failed", _one_line(tail[0]))]
        items += found
    have = {p.stem for p in logs}
    for s in failed_suites:
        if s not in have:
            items.append(Failure(s, "suite failed", "no log was uploaded"))
    return items


class Jira:
    """Thin Jira REST client; `request(method, path, body) -> dict` is injectable so tests use a fake."""

    def __init__(self, request):
        self.request = request

    def open_summaries(self):
        jql = f'project = {PROJECT} AND statusCategory != Done AND summary ~ "Nightly QA" ORDER BY created DESC'
        res = self.request("POST", "/rest/api/3/search/jql", {"jql": jql, "fields": ["summary"], "maxResults": 100})
        return {i["fields"]["summary"] for i in res.get("issues", [])}

    def create(self, failure, run_url, commit):
        desc = [
            f"Suite: {failure.suite}", f"Test: {failure.name}", f"Error: {failure.error}",
            f"Run: {run_url or '(no run link)'}", f"Seen at commit: {commit or 'unknown'}",
            f"First failing commit: {failure.first_failing_commit}", GUIDANCE,
        ]
        body = {"fields": {
            "project": {"key": PROJECT}, "issuetype": {"name": "Bug"}, "summary": failure.summary, "labels": LABELS,
            "description": {"type": "doc", "version": 1, "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": t}]} for t in desc]},
        }}
        key = self.request("POST", "/rest/api/3/issue", body)["key"]
        trs = self.request("GET", f"/rest/api/3/issue/{key}/transitions", None).get("transitions", [])
        tid = next((t["id"] for t in trs if t["name"].lower() == TARGET_STATUS.lower()
                    or t.get("to", {}).get("name", "").lower() == TARGET_STATUS.lower()), None)
        if tid:
            self.request("POST", f"/rest/api/3/issue/{key}/transitions", {"transition": {"id": tid}})
        return key, bool(tid)


def raise_tickets(failures, jira, run_url="", commit=""):
    """Returns (summary_lines, created_keys). `jira` None = secrets missing: create nothing."""
    if not failures:
        return ["Nightly QA: everything passed."], []
    lines = [f"Nightly QA: {len(failures)} failing item(s)."] + \
            [f"- {f.suite}: {f.name} — {f.error}" for f in failures]
    if jira is None:
        return lines + ["JIRA_EMAIL / JIRA_API_TOKEN missing: ticket creation skipped."], []
    existing, created = jira.open_summaries(), []
    for f in failures:
        if f.summary in existing:
            lines.append(f"Already open, skipped: {f.summary}")
            continue
        key, moved = jira.create(f, run_url, commit)
        existing.add(f.summary)
        created.append(key)
        lines.append(f"Created {key}: {f.summary}" + ("" if moved else f" (could not move to {TARGET_STATUS})"))
    return lines, created


def http_request(email, token, site=SITE):
    auth = base64.b64encode(f"{email}:{token}".encode()).decode()

    def request(method, path, body):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(site + path, method=method, data=data,
                                     headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json",
                                              "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
        return json.loads(raw) if raw else {}
    return request


def main(argv=None, env=None, jira_factory=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", required=True)
    ap.add_argument("--run-url", default="")
    ap.add_argument("--commit", default="")
    ap.add_argument("--failed", default="", help="comma-separated suites whose job failed")
    a = ap.parse_args(argv)
    env = os.environ if env is None else env
    failures = collect(a.logs, [s for s in a.failed.split(",") if s])
    email, token = env.get("JIRA_EMAIL", ""), env.get("JIRA_API_TOKEN", "")
    jira = None
    if failures and email and token:
        jira = (jira_factory or (lambda: Jira(http_request(email, token))))()
    lines, _ = raise_tickets(failures, jira, a.run_url, a.commit)
    print("\n".join(lines))
    summary = env.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
