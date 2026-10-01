"""Unit tests for Recommend Cascade (CAS-884).

Run:  python -m unittest monitor.tests.test_recommend
"""
import datetime as _dt
import unittest
from unittest import mock

from monitor.recommend import email_subject, main, render_email
from monitor.store import InMemoryStore


def _row(id=1, sender_id="u1", sender_name="lee", to_name="Priya", to_email="priya@example.test",
         message="Hi Priya — thought you'd like this. — lee",
         created_at="2026-09-08T09:00:00+00:00", sent_at=None):
    return {"id": id, "sender_id": sender_id, "sender_name": sender_name, "to_name": to_name,
            "to_email": to_email, "message": message, "created_at": created_at, "sent_at": sent_at}


class RenderTests(unittest.TestCase):
    def test_subject_names_the_sender(self):
        self.assertEqual(email_subject(_row(sender_name="lee")), "lee thinks you'd like Cascade")

    def test_subject_falls_back_when_sender_name_missing(self):
        self.assertEqual(email_subject(_row(sender_name=None)), "A friend thinks you'd like Cascade")

    def test_email_contains_recipient_name_and_sender_name(self):
        email = render_email(_row(sender_name="lee", to_name="Priya"))
        self.assertIn("Priya", email["html"])
        self.assertIn("lee", email["html"])
        self.assertIn("lee", email["subject"])

    def test_email_contains_the_message_and_signup_link(self):
        email = render_email(_row(message="A very specific message body."))
        self.assertIn("A very specific message body.", email["html"])
        self.assertIn("A very specific message body.", email["text"])
        self.assertIn("https://cascademovies.com", email["html"])
        self.assertIn("https://cascademovies.com", email["text"])

    def test_html_escapes_message_content(self):
        email = render_email(_row(message="<script>alert(1)</script>"))
        self.assertNotIn("<script>alert(1)</script>", email["html"])
        self.assertIn("&lt;script&gt;", email["html"])


class MainDryRunTests(unittest.TestCase):
    def test_dry_run_sends_nothing_and_stamps_nothing(self):
        store = InMemoryStore(recommendations=[_row(1), _row(2)])
        with mock.patch("monitor.recommend.store_from_env", return_value=store), \
             mock.patch("monitor.recommend.send_via_resend") as send:
            exit_code = main(["--dry-run"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()
        self.assertEqual(len(store.fetch_unsent_recommendations()), 2)

    def test_empty_fixture_renders_nothing_and_exits_zero(self):
        store = InMemoryStore(recommendations=[])
        with mock.patch("monitor.recommend.store_from_env", return_value=store), \
             mock.patch("monitor.recommend.send_via_resend") as send:
            exit_code = main(["--dry-run"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()

    def test_no_store_and_no_fixture_flag_exits_zero(self):
        with mock.patch("monitor.recommend.store_from_env", return_value=None):
            self.assertEqual(main([]), 0)


class MainLiveSendTests(unittest.TestCase):
    def test_successful_send_stamps_sent_at_on_every_row(self):
        store = InMemoryStore(recommendations=[_row(1), _row(2, to_email="other@example.test")])
        with mock.patch("monitor.recommend.store_from_env", return_value=store), \
             mock.patch("monitor.recommend.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(store.fetch_unsent_recommendations(), [])

    def test_send_failure_leaves_that_rows_sent_at_unstamped(self):
        store = InMemoryStore(recommendations=[_row(1), _row(2, to_email="other@example.test")])
        with mock.patch("monitor.recommend.store_from_env", return_value=store), \
             mock.patch("monitor.recommend.send_via_resend", side_effect=RuntimeError("resend down")):
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        unsent = store.fetch_unsent_recommendations()
        self.assertEqual(len(unsent), 2)
        self.assertTrue(all(r["sent_at"] is None for r in unsent))

    def test_one_failure_does_not_block_the_other_row_from_sending(self):
        store = InMemoryStore(recommendations=[_row(1), _row(2, to_email="other@example.test")])
        with mock.patch("monitor.recommend.store_from_env", return_value=store), \
             mock.patch("monitor.recommend.send_via_resend",
                         side_effect=[RuntimeError("resend down"), None]):
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        unsent = store.fetch_unsent_recommendations()
        self.assertEqual(len(unsent), 1)
        self.assertEqual(unsent[0]["id"], 1)


class DuplicateAddressTests(unittest.TestCase):
    """CAS-1131: never email the same (sender, address) pair twice."""

    def test_two_unsent_rows_same_sender_and_address_different_case_fold_into_one_send(self):
        store = InMemoryStore(recommendations=[
            _row(1, to_email="Priya@Example.test"),
            _row(2, to_email="priya@example.test"),
        ])
        with mock.patch("monitor.recommend.store_from_env", return_value=store), \
             mock.patch("monitor.recommend.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(store.fetch_unsent_recommendations(), [])

    def test_row_already_sent_within_7_days_is_stamped_without_a_second_send(self):
        two_days_ago = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=2)).isoformat()
        store = InMemoryStore(recommendations=[
            _row(1, sent_at=two_days_ago),
            _row(2),
        ])
        with mock.patch("monitor.recommend.store_from_env", return_value=store), \
             mock.patch("monitor.recommend.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()
        self.assertEqual(store.fetch_unsent_recommendations(), [])


class RecommendationsFixtureFlagTests(unittest.TestCase):
    def test_recommendations_flag_loads_from_file(self):
        with mock.patch("monitor.recommend.send_via_resend") as send:
            exit_code = main(["--dry-run", "--recommendations",
                               "monitor/fixtures/recommendations.json"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()

    def test_recommendations_flag_empty_fixture_exits_zero(self):
        with mock.patch("monitor.recommend.send_via_resend") as send:
            exit_code = main(["--dry-run", "--recommendations",
                               "monitor/fixtures/recommendations_empty.json"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
