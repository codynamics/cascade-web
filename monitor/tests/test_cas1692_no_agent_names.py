"""CAS-1692: agents have no names - the daily alert email and the push say "your agent", never the stored name."""
import unittest

from monitor.batches import agent_name_for, headline_for
from monitor.emailer import render_digest
from monitor.phases import push_copy_for
from monitor.pusher import push_copy
from monitor.tests.test_emailer import _hit

CASCADES = [{"id": "c1", "user_id": "u1", "name": "Nova", "active": True, "criteria": {"v": 2}}]


class NoAgentNames(unittest.TestCase):
    def test_email_subject_and_body_say_your_agent(self):
        hit = _hit("Film", "hits_cinema", cascade="Nova")
        d = render_digest([hit], site_url="https://x.test/")
        for part in (d["subject"], d["html"], d["text"]):
            self.assertNotIn("Nova", part)
        self.assertIn("your agent", d["html"].lower())

    def test_daily_push_says_your_agent(self):
        rows = [{"movie_id": 1, "title": "A"}, {"movie_id": 2, "title": "B"}]
        copy = push_copy_for(rows, agent_name_for(CASCADES, "u1"))
        self.assertNotIn("Nova", copy["title"] + copy["body"])
        self.assertIn("your agent", copy["title"].lower())

    def test_announced_push_says_your_agent(self):
        hit = _hit("Dune Three", "announced", cascade="Nova")
        copy = push_copy(hit)
        self.assertNotIn("Nova", copy["title"] + copy["body"])
        self.assertIn("your agent", (copy["title"] + copy["body"]).lower())

    def test_headline_never_uses_the_stored_name(self):
        self.assertEqual(headline_for(agent_name_for(CASCADES, "u1"), 1), "Your agent found 1 film for you")


if __name__ == "__main__":
    unittest.main()
