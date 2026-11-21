"""CAS-993 / CAS-1503: wait until 03:00 Australia/Sydney before alerts.yml runs the monitor.

A fixed UTC cron minute drifts against Sydney's local clock every time daylight saving flips, so
this converts the actual moment the job started with `zoneinfo` (stdlib, backed by the runner's
system tzdata — no extra install) instead of hard-coding an offset.

    python scripts/wait_until_sydney.py     # real sleep until ~03:00 Sydney, then exits 0

`compute_wait(now)` is the pure, testable piece — it takes an explicit aware datetime and returns
a decision, never sleeping itself, so the CLI is the only thing that ever calls `time.sleep`.
"""
from __future__ import annotations

import datetime as _dt
import time
from dataclasses import dataclass
from zoneinfo import ZoneInfo

SYDNEY = ZoneInfo("Australia/Sydney")
TARGET_HOUR = 3      # alerts go out at 03:00 Sydney.
LATE_WARNING_HOUR = 7   # a run starting this late or after still proceeds, but warns.


@dataclass
class WaitDecision:
    wait_seconds: float   # 0 means "proceed now".
    warn: bool            # True when proceeding late (>= LATE_WARNING_HOUR) rather than waiting.


def compute_wait(now: _dt.datetime) -> WaitDecision:
    """`now` must be an aware datetime (any timezone — it is converted to Sydney here)."""
    now_syd = now.astimezone(SYDNEY)
    target = now_syd.replace(hour=TARGET_HOUR, minute=0, second=0, microsecond=0)
    if now_syd >= target:
        warn_at = now_syd.replace(hour=LATE_WARNING_HOUR, minute=0, second=0, microsecond=0)
        return WaitDecision(0.0, now_syd >= warn_at)
    return WaitDecision((target - now_syd).total_seconds(), False)


def main() -> int:
    decision = compute_wait(_dt.datetime.now(_dt.timezone.utc))
    if decision.wait_seconds > 0:
        wake = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=decision.wait_seconds)
        print(f"[wait_until_sydney] sleeping {decision.wait_seconds:.0f}s until 03:00 Sydney "
              f"(~{wake.isoformat()} UTC).")
        time.sleep(decision.wait_seconds)
    elif decision.warn:
        print("[wait_until_sydney] WARNING: run started after 07:00 Sydney — proceeding "
              "immediately with a late alert rather than skipping it.")
    else:
        print("[wait_until_sydney] already at/after 03:00 Sydney — proceeding immediately.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
