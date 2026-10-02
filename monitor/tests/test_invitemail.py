"""Unit tests for Invite emails (CAS-930).

Run:  python -m unittest monitor.tests.test_invitemail
"""
import unittest
from unittest import mock

from monitor.invitemail import email_subject, invite_url, main, render_email
from monitor.store import InMemoryStore


def _row(id=1, token="abc1234567", to_email="priya@example.test", to_name="Priya",
         created_at="2026-09-08T09:00:00+00:00", sent_at=None, sender_name="lee",
         film_title="Test Film", tmdb_id=12345, suggested_date=None, note=None):
    return {"id": id, "token": token, "to_email": to_email, "to_name": to_name,
            "created_at": created_at, "sent_at": sent_at, "sender_name": sender_name,
            "film_title": film_title, "tmdb_id": tmdb_id,
            "suggested_date": suggested_date, "note": note}


def _movie(tmdb_id=12345, poster="/poster.jpg"):
    return {"tmdb_id": tmdb_id, "poster": poster}


class RenderTests(unittest.TestCase):
    def test_subject_names_the_sender_and_film(self):
        self.assertEqual(email_subject(_row(sender_name="lee", film_title="Test Film")),
                          "lee invited you to watch Test Film")

    def test_subject_falls_back_when_sender_name_and_film_missing(self):
        self.assertEqual(email_subject(_row(sender_name=None, film_title=None)),
                          "A friend invited you to watch a film")

    def test_email_contains_recipient_sender_and_film(self):
        email = render_email(_row(sender_name="lee", to_name="Priya", film_title="Test Film"))
        self.assertIn("Priya", email["html"])
        self.assertIn("lee", email["html"])
        self.assertIn("Test Film", email["html"])
        self.assertIn("lee", email["subject"])

    def test_email_contains_the_token_s_own_invite_link(self):
        email = render_email(_row(token="abc1234567", tmdb_id=12345))
        url = invite_url(_row(token="abc1234567", tmdb_id=12345))
        self.assertIn(url, email["html"])
        self.assertIn(url, email["text"])
        self.assertIn("inv=abc1234567", url)
        self.assertIn("#/film/12345", url)

    def test_html_escapes_film_title(self):
        email = render_email(_row(film_title="<script>alert(1)</script>"))
        self.assertNotIn("<script>alert(1)</script>", email["html"])
        self.assertIn("&lt;script&gt;", email["html"])


class LeadLineButtonAndFooterTests(unittest.TestCase):
    def test_lead_line_names_the_sender_and_film(self):
        email = render_email(_row(sender_name="lee", film_title="Test Film"))
        self.assertIn("lee has invited you to watch <b>Test Film</b>.", email["html"])
        self.assertIn("lee has invited you to watch Test Film.", email["text"])

    def test_button_label_is_view_invite(self):
        email = render_email(_row())
        self.assertIn(">View invite<", email["html"])
        self.assertIn("View invite:", email["text"])
        self.assertNotIn("Say yes or no", email["html"])
        self.assertNotIn("Say yes or no", email["text"])

    def test_footer_names_the_sender(self):
        email = render_email(_row(sender_name="lee", to_name="Priya"))
        self.assertIn("Priya, you got this because lee invited you to watch with them.",
                       email["html"])

    def test_footer_falls_back_when_sender_name_missing(self):
        email = render_email(_row(sender_name=None, to_name="Priya"))
        self.assertIn("Priya, you got this because A friend invited you to watch with them.",
                       email["html"])


class PosterTests(unittest.TestCase):
    def test_poster_renders_an_image_above_the_lead_line(self):
        email = render_email(_row(tmdb_id=12345), movie=_movie(tmdb_id=12345, poster="/poster.jpg"))
        self.assertIn('<img src="https://image.tmdb.org/t/p/w342/poster.jpg"', email["html"])
        self.assertIn('alt="Test Film"', email["html"])
        self.assertLess(email["html"].index("<img"), email["html"].index("has invited you to watch"))

    def test_no_poster_on_the_movie_renders_no_image(self):
        email = render_email(_row(tmdb_id=12345), movie=_movie(tmdb_id=12345, poster=None))
        self.assertNotIn("<img", email["html"])

    def test_no_matching_movie_renders_no_image(self):
        email = render_email(_row(tmdb_id=12345), movie=None)
        self.assertNotIn("<img", email["html"])


class SuggestedDateAndNoteTests(unittest.TestCase):
    """CAS-1121 AC2: a row with a date and note renders both lines; a row without either renders
    neither."""

    def test_both_set_render_both_lines_in_html_and_text(self):
        email = render_email(_row(suggested_date="2026-10-20", note="Bring popcorn"))
        self.assertIn("Suggested: 20 Oct 26", email["html"])
        self.assertIn("Suggested: 20 Oct 26", email["text"])
        self.assertIn("“Bring popcorn”", email["html"])
        self.assertIn("“Bring popcorn”", email["text"])

    def test_neither_set_renders_neither_line(self):
        email = render_email(_row(suggested_date=None, note=None))
        self.assertNotIn("Suggested:", email["html"])
        self.assertNotIn("Suggested:", email["text"])
        self.assertNotIn("“", email["html"])
        self.assertNotIn("“", email["text"])

    def test_date_only_renders_only_the_date_line(self):
        email = render_email(_row(suggested_date="2026-10-20", note=None))
        self.assertIn("Suggested: 20 Oct 26", email["html"])
        self.assertNotIn("“", email["html"])

    def test_note_only_renders_only_the_note_line(self):
        email = render_email(_row(suggested_date=None, note="Bring popcorn"))
        self.assertNotIn("Suggested:", email["html"])
        self.assertIn("“Bring popcorn”", email["html"])

    def test_note_html_escapes_content_and_keeps_line_breaks(self):
        email = render_email(_row(note="Line one\n<script>alert(1)</script>"))
        self.assertIn("Line one<br>&lt;script&gt;alert(1)&lt;/script&gt;", email["html"])
        self.assertNotIn("<script>alert(1)</script>", email["html"])


class MainDryRunTests(unittest.TestCase):
    def test_dry_run_sends_nothing_and_stamps_nothing(self):
        store = InMemoryStore(invite_emails=[_row(1), _row(2)])
        with mock.patch("monitor.invitemail.store_from_env", return_value=store), \
             mock.patch("monitor.invitemail.send_via_resend") as send:
            exit_code = main(["--dry-run"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()
        self.assertEqual(len(store.fetch_unsent_invite_emails()), 2)

    def test_empty_fixture_renders_nothing_and_exits_zero(self):
        store = InMemoryStore(invite_emails=[])
        with mock.patch("monitor.invitemail.store_from_env", return_value=store), \
             mock.patch("monitor.invitemail.send_via_resend") as send:
            exit_code = main(["--dry-run"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()

    def test_no_store_and_no_fixture_flag_exits_zero(self):
        with mock.patch("monitor.invitemail.store_from_env", return_value=None):
            self.assertEqual(main([]), 0)


class MainLiveSendTests(unittest.TestCase):
    def test_successful_send_stamps_sent_at_on_every_row(self):
        store = InMemoryStore(invite_emails=[_row(1), _row(2)])
        with mock.patch("monitor.invitemail.store_from_env", return_value=store), \
             mock.patch("monitor.invitemail.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(store.fetch_unsent_invite_emails(), [])

    def test_send_failure_leaves_that_rows_sent_at_unstamped(self):
        store = InMemoryStore(invite_emails=[_row(1), _row(2)])
        with mock.patch("monitor.invitemail.store_from_env", return_value=store), \
             mock.patch("monitor.invitemail.send_via_resend", side_effect=RuntimeError("resend down")):
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        unsent = store.fetch_unsent_invite_emails()
        self.assertEqual(len(unsent), 2)
        self.assertTrue(all(r["sent_at"] is None for r in unsent))

    def test_one_failure_does_not_block_the_other_row_from_sending(self):
        store = InMemoryStore(invite_emails=[_row(1), _row(2)])
        with mock.patch("monitor.invitemail.store_from_env", return_value=store), \
             mock.patch("monitor.invitemail.send_via_resend",
                         side_effect=[RuntimeError("resend down"), None]):
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        unsent = store.fetch_unsent_invite_emails()
        self.assertEqual(len(unsent), 1)
        self.assertEqual(unsent[0]["id"], 1)

    def test_row_with_no_matching_invite_is_skipped_not_crashed(self):
        orphan = _row(1, tmdb_id=None, film_title=None, sender_name=None)
        store = InMemoryStore(invite_emails=[orphan, _row(2)])
        with mock.patch("monitor.invitemail.store_from_env", return_value=store), \
             mock.patch("monitor.invitemail.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        send.assert_called_once()
        unsent = store.fetch_unsent_invite_emails()
        self.assertEqual(len(unsent), 1)
        self.assertEqual(unsent[0]["id"], 1)


class InviteEmailsFixtureFlagTests(unittest.TestCase):
    def test_invite_emails_flag_loads_from_file(self):
        with mock.patch("monitor.invitemail.send_via_resend") as send:
            exit_code = main(["--dry-run", "--invite-emails",
                               "monitor/fixtures/invite_emails.json"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()

    def test_invite_emails_flag_empty_fixture_exits_zero(self):
        with mock.patch("monitor.invitemail.send_via_resend") as send:
            exit_code = main(["--dry-run", "--invite-emails",
                               "monitor/fixtures/invite_emails_empty.json"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
