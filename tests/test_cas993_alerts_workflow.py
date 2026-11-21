"""CAS-993 AC4 — a static check that alerts.yml's monitor step carries the exact same env and
command daily.yml ran before this ticket moved the step. Frozen here as `DAILY_MONITOR_ENV_BEFORE`
and the two `assertIn` command fragments below, taken verbatim from daily.yml's monitor step as it
stood immediately before CAS-993 deleted it — so a future edit that quietly drops a secret from
alerts.yml's step (or changes its command) fails this test rather than silently under-notifying.

Run:  python -m unittest tests.test_cas993_alerts_workflow
"""
import os
import re
import unittest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALERTS_YML = os.path.join(_REPO_ROOT, ".github", "workflows", "alerts.yml")
DAILY_YML = os.path.join(_REPO_ROOT, ".github", "workflows", "daily.yml")
MONITOR_STEP_NAME = "Run the Cascade monitor (diff → match → de-dupe → email)"   # daily.yml's old name
# CAS-1504 renamed alerts.yml's step when it split the run into find / push / email phases.
ALERTS_STEP_NAME = "Run the Cascade monitor, phase ${{ github.event.inputs.phase || 'find' }} (CAS-1504)"

# Verbatim from daily.yml's monitor step before CAS-993 removed it.
DAILY_MONITOR_ENV_BEFORE = {
    "SUPABASE_URL": "${{ secrets.SUPABASE_URL }}",
    "SUPABASE_SERVICE_ROLE_KEY": "${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}",
    "RESEND_API_KEY": "${{ secrets.RESEND_API_KEY }}",
    "CASCADE_EMAIL_FROM": "${{ secrets.CASCADE_EMAIL_FROM }}",
    "CASCADE_SITE_URL": "${{ secrets.SITE_URL }}",
    "DAYS_BACK": "${{ github.event.inputs.days_back }}",
    "BASELINE_REF": "${{ github.event.inputs.baseline_ref }}",
    "APNS_KEY_ID": "${{ secrets.APNS_KEY_ID }}",
    "APNS_TEAM_ID": "${{ secrets.APNS_TEAM_ID }}",
    "APNS_AUTH_KEY": "${{ secrets.APNS_AUTH_KEY }}",
    "APNS_BUNDLE_ID": "${{ secrets.APNS_BUNDLE_ID }}",
}


def _step_lines(all_lines: list, step_name: str) -> list:
    """The lines of one `- name: <step_name>` step block (exclusive of the name line itself), up
    to the next line at the same or lower indentation."""
    start = next(i for i, l in enumerate(all_lines) if l.strip() == f"- name: {step_name}")
    indent = len(all_lines[start]) - len(all_lines[start].lstrip(" "))
    end = len(all_lines)
    for j in range(start + 1, len(all_lines)):
        l = all_lines[j]
        if l.strip() and (len(l) - len(l.lstrip(" "))) <= indent:
            end = j
            break
    return all_lines[start + 1:end]


def _extract_env(step_lines: list) -> dict:
    env, in_env = {}, False
    for l in step_lines:
        stripped = l.strip()
        if stripped == "env:":
            in_env = True
            continue
        if not in_env:
            continue
        m = re.match(r"^([A-Z0-9_]+):\s*(.+)$", stripped)
        if m:
            env[m.group(1)] = m.group(2).split("  #")[0].strip()
        elif stripped == "run: |" or stripped.startswith("- name:"):
            break
    return env


def _extract_run(step_lines: list) -> str:
    idx = next(i for i, l in enumerate(step_lines) if l.strip() == "run: |")
    return "\n".join(step_lines[idx + 1:])


class AlertsMonitorStepMatchesDaily(unittest.TestCase):
    def setUp(self):
        with open(ALERTS_YML, encoding="utf-8") as f:
            self.alerts_step = _step_lines(f.read().splitlines(), ALERTS_STEP_NAME)

    def test_daily_no_longer_has_the_monitor_step(self):
        with open(DAILY_YML, encoding="utf-8") as f:
            self.assertNotIn(f"- name: {MONITOR_STEP_NAME}", f.read())

    def test_env_matches_daily_before_the_move_no_secret_dropped(self):
        # CAS-1504 added PHASE; every secret and input daily.yml passed must still be there, unchanged.
        env = _extract_env(self.alerts_step)
        for k, v in DAILY_MONITOR_ENV_BEFORE.items():
            self.assertEqual(env.get(k), v, k)
        self.assertEqual(set(env) - set(DAILY_MONITOR_ENV_BEFORE), {"PHASE"})

    def test_command_matches_daily_before_the_move(self):
        run = _extract_run(self.alerts_step)
        self.assertIn(
            'if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_ROLE_KEY" ] && '
            '[ -n "$RESEND_API_KEY" ]; then', run)
        self.assertIn('python -m monitor --phase "$PHASE" $BASELINE_ARGS', run)          # CAS-1504
        self.assertIn('python -m monitor --phase "$PHASE" --dry-run $BASELINE_ARGS', run)


if __name__ == "__main__":
    unittest.main()
