"""CAS-1557: the nightly ticket step, against a fake Jira."""
import tempfile
import unittest
from pathlib import Path

from qa import nightly_tickets as nt


class FakeJira:
    def __init__(self, open_summaries=()):
        self.open = set(open_summaries)
        self.created = []

    def open_summaries(self):
        return set(self.open)

    def create(self, failure, run_url, commit):
        self.created.append((failure.summary, run_url))
        return f"CAS-{9000 + len(self.created)}", True


F1 = nt.Failure("agents", "K1 build", "boom")
F2 = nt.Failure("journeys", "journey=full-run step=2", "missing push")


class TicketStep(unittest.TestCase):
    def test_one_ticket_per_new_failure(self):
        j = FakeJira()
        _, created = nt.raise_tickets([F1, F2], j, "http://run/1")
        self.assertEqual(len(created), 2)
        self.assertEqual([c[0] for c in j.created], [F1.summary, F2.summary])
        self.assertTrue(F1.summary.startswith("Nightly QA: agents"))

    def test_none_for_already_open(self):
        j = FakeJira([F1.summary])
        _, created = nt.raise_tickets([F1, F2], j)
        self.assertEqual(len(created), 1)
        self.assertEqual(j.created[0][0], F2.summary)

    def test_duplicate_in_one_run_creates_once(self):
        j = FakeJira()
        nt.raise_tickets([F1, F1], j)
        self.assertEqual(len(j.created), 1)

    def test_none_when_secrets_missing(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "agents.log").write_text("FAIL K1 - boom\n")
            made = []
            out = nt.main(["--logs", d], env={}, jira_factory=lambda: made.append(1))
        self.assertEqual(out, 0)
        self.assertEqual(made, [])
        lines, created = nt.raise_tickets([F1], None)
        self.assertEqual(created, [])
        self.assertIn("skipped", lines[-1])

    def test_green_night_says_so_and_does_nothing(self):
        j = FakeJira()
        lines, created = nt.raise_tickets([], j)
        self.assertEqual(created, [])
        self.assertEqual(j.created, [])
        self.assertIn("passed", lines[0])


class Parsing(unittest.TestCase):
    def test_line_and_playwright_failures(self):
        agents = nt.parse_log("agents", "PASS A1\nFAIL K1 - build broke\n  \nSETUP FAIL x: no db\n")
        self.assertEqual([f.name for f in agents], ["K1", "SETUP FAIL x: no db"])
        self.assertEqual(agents[0].error, "build broke")
        pw = nt.parse_log("e2e", "  1) [webkit] › tests/e2e/a.spec.mjs:3:1 › does a thing ───\n\n    Error: expect(received)\n")
        self.assertEqual(len(pw), 1)
        self.assertIn("does a thing", pw[0].name)
        self.assertTrue(pw[0].error.startswith("Error"))

    def test_failed_suite_without_parsed_items_still_listed(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "integrity.log").write_text("starting\ncrashed hard\n")
            items = nt.collect(d, ["integrity", "agents"])
        self.assertEqual({(i.suite, i.name) for i in items}, {("integrity", "suite failed"), ("agents", "suite failed")})


if __name__ == "__main__":
    unittest.main()
