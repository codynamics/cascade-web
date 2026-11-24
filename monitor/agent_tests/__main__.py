"""CAS-794: entry point for the python half of `npm run test:agents` (`python -m monitor.agent_tests`,
invoked by tests/js/run-agent-suite.mjs). Discovers every check in this directory exactly as the old
`python -m unittest discover -s monitor/agent_tests` did, and appends one PASS/FAIL/SKIP line per
check to qa-agents-report.txt, so the node half's checks and this half's land in the same file. Never
picked up by `npm run qa` (python -m unittest discover -s monitor/tests only looks at monitor/tests/).
"""
import os
import re
import sys
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REPORT_PATH = os.environ.get("QA_AGENTS_REPORT", os.path.join(REPO_ROOT, "qa-agents-report.txt"))

# The suite names each check by prefixing its TestCase class with a short id, e.g.
# `class K1RebuildMatchesTheCommittedIndexExceptItsOwnStamp`; fall back to a fully qualified test
# id for a class that carries none (CAS-789's own scaffold "Scaffold" class has no such prefix).
CHECK_ID_RE = re.compile(r"^([A-Z]+\d+(?:_CAS\d+)?)")


def check_id(test):
    cls = type(test)
    m = CHECK_ID_RE.match(cls.__name__)
    if m:
        return m.group(1)
    return f"{cls.__module__}.{cls.__name__}.{test._testMethodName}"


def one_line(value):
    text = str(value).strip()
    return text.splitlines()[0] if text else "failed"


class ReportResult(unittest.TestResult):
    def __init__(self, report):
        super().__init__()
        self._report = report

    def addSuccess(self, test):
        super().addSuccess(test)
        self._write(f"PASS {check_id(test)}")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._write(f"FAIL {check_id(test)} - {one_line(err[1])}")

    def addError(self, test, err):
        super().addError(test, err)
        self._write(f"FAIL {check_id(test)} - {one_line(err[1])}")

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._write(f"SKIP {check_id(test)} - {reason}")

    def _write(self, line):
        print(line)
        self._report.write(line + "\n")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    suite = unittest.TestLoader().discover(here)
    with open(REPORT_PATH, "a", encoding="utf-8") as report:
        result = ReportResult(report)
        suite.run(result)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
