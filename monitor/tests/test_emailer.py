"""Unit tests for the digest renderer (CAS-86 / CAS-1196 redesign, spec 26771457 §6).

Run:  python -m unittest monitor.tests.test_emailer
"""
import datetime as _dt
import io
import unittest
import urllib.error
from unittest import mock

from monitor import render_digest, digest_subject
from monitor.emailer import (
    USER_AGENT, send_via_resend, format_invite_reply, _invite_window_text, _invite_age_text,
    _format_short_date, _weekday_date, _event_pill, _event_context,
)
from monitor.matching import Hit, _rank_key
from monitor.transitions import Transition

TODAY = _dt.date(2026, 10, 5)


def _hit(title, moment, cascade="Some Agent", movie_id="1", movie=None, services=None, price=None,
         order=None):
    t = Transition(movie_id=movie_id, title=title, moment=moment, services=services or [], price=price,
                   movie=movie or {})
    rank = _rank_key({"criteria": {"order": order}})
    return Hit(user_id="user-A", cascade_id=f"id-{cascade}", cascade_name=cascade, transition=t, rank=rank)


class EventPillTests(unittest.TestCase):
    """CAS-1196 item 2: every pill states its event with a real date, never a bare relative word."""

    def test_opens_soon(self):
        text, color = _event_pill(_hit("A", "opens_soon").transition, {"cinema_date": "2026-10-08"}, TODAY)
        self.assertEqual(text, "OPENS Thu 8 Oct")
        self.assertEqual(color, "violet")

    def test_announced_with_cinema_date(self):
        text, _ = _event_pill(_hit("A", "announced").transition, {"cinema_date": "2026-12-17"}, TODAY)
        self.assertEqual(text, "COMING Thu 17 Dec")

    def test_announced_without_cinema_date(self):
        text, _ = _event_pill(_hit("A", "announced").transition, {}, TODAY)
        self.assertEqual(text, "NEWLY ANNOUNCED")

    def test_hits_cinema(self):
        text, color = _event_pill(_hit("A", "hits_cinema").transition, {}, TODAY)
        self.assertEqual(text, "IN CINEMAS NOW")
        self.assertEqual(color, "violet")

    def test_past_opening_weekend(self):
        text, _ = _event_pill(_hit("A", "past_opening_weekend").transition, {}, TODAY)
        self.assertEqual(text, "IN CINEMAS · PAST OPENING WEEKEND")

    def test_hits_pvod_with_price(self):
        t = _hit("A", "hits_pvod", services=["Apple TV"], price=29.99).transition
        text, color = _event_pill(t, {}, TODAY)
        self.assertEqual(text, "NOW TO BUY OR RENT · APPLE TV · $29.99")
        self.assertEqual(color, "amber")

    def test_hits_rent_with_price(self):
        t = _hit("A", "hits_rent", services=["Apple TV"], price=6.99).transition
        text, _ = _event_pill(t, {}, TODAY)
        self.assertEqual(text, "NOW TO RENT · APPLE TV · from $6.99")

    def test_hits_rent_without_price_is_honest(self):
        t = _hit("A", "hits_rent").transition
        text, _ = _event_pill(t, {}, TODAY)
        self.assertEqual(text, "NOW TO RENT")
        self.assertNotIn("from $", text)

    def test_hits_stream(self):
        t = _hit("A", "hits_stream", services=["Netflix"]).transition
        text, color = _event_pill(t, {}, TODAY)
        self.assertEqual(text, "NOW STREAMING · NETFLIX")
        self.assertEqual(color, "green")

    def test_new_for_you_colour_follows_current_window(self):
        t = _hit("A", "newly_qualifies").transition
        _, color_stream = _event_pill(t, {"status": ["included_streaming"]}, TODAY)
        _, color_rental = _event_pill(t, {"status": ["rental"]}, TODAY)
        _, color_upcoming = _event_pill(t, {"status": ["upcoming"]}, TODAY)
        self.assertEqual(color_stream, "green")
        self.assertEqual(color_rental, "amber")
        self.assertEqual(color_upcoming, "violet")

    def test_no_fabricated_urgency(self):
        # Honesty guardrail: no banned urgency words anywhere a pill can read.
        for moment in ("opens_soon", "announced", "hits_cinema", "past_opening_weekend",
                       "hits_pvod", "hits_rent", "hits_stream"):
            t = _hit("A", moment).transition
            text, _ = _event_pill(t, {}, TODAY)
            for banned in ("leaving", "last chance", "hurry", "expires", "gone in"):
                self.assertNotIn(banned, text.lower())


class EventContextTests(unittest.TestCase):
    def test_opens_soon_counts_real_days(self):
        t = _hit("A", "opens_soon").transition
        self.assertEqual(_event_context(t, {"cinema_date": "2026-10-08"}, TODAY), "in cinemas in 3 days")

    def test_hits_cinema_since_real_date(self):
        t = _hit("A", "hits_cinema").transition
        self.assertEqual(_event_context(t, {"cinema_date": "2026-10-01"}, TODAY), "since Thu 1 Oct")

    def test_hits_rent_names_other_services(self):
        t = _hit("A", "hits_rent", services=["Apple TV", "Amazon Video"]).transition
        self.assertEqual(_event_context(t, {}, TODAY), "also on Amazon Video")

    def test_hits_rent_alone_has_no_context(self):
        t = _hit("A", "hits_rent", services=["Apple TV"]).transition
        self.assertEqual(_event_context(t, {}, TODAY), "")

    def test_hits_stream_names_service_and_date(self):
        t = _hit("A", "hits_stream", services=["Netflix"]).transition
        movie = {"window_dates": {"included_streaming": "2026-10-02"}}
        self.assertEqual(_event_context(t, movie, TODAY), "on Netflix since Fri 2 Oct")

    def test_newly_qualifies_names_window_and_date(self):
        t = _hit("A", "newly_qualifies").transition
        movie = {"status": ["upcoming"], "window_dates": {"upcoming": "2026-09-24"}}
        self.assertEqual(_event_context(t, movie, TODAY), "Upcoming 24 Sep")


class CardRenderTests(unittest.TestCase):
    """AC1/AC2/AC6: what one card renders."""

    def test_poster_renders_w185_tmdb_src(self):
        movie = {"status": ["upcoming"], "poster": "/abc.jpg"}
        hit = _hit("Other Mommy", "opens_soon", movie=movie)
        d = render_digest([hit], site_url="https://x.test/")
        self.assertIn('src="https://image.tmdb.org/t/p/w185/abc.jpg"', d["html"])
        self.assertIn('width="92" height="138"', d["html"])
        self.assertIn('alt="Other Mommy"', d["html"])

    def test_no_poster_renders_no_broken_image(self):
        hit = _hit("No Poster", "hits_cinema", movie={"status": ["in_cinema"]})
        d = render_digest([hit], site_url="https://x.test/")
        self.assertNotIn("<img", d["html"])

    def test_no_section_headings_survive(self):
        hits = [
            _hit("A", "hits_cinema", movie={"status": ["upcoming"]}, movie_id="1"),
            _hit("B", "hits_stream", services=["Netflix"], movie={"status": ["included_streaming"]},
                movie_id="2"),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertNotIn("UPCOMING (", part)
            self.assertNotIn("Your agents have been watching", part)

    def test_meta_line_only_shows_facts_the_film_has(self):
        movie = {"status": ["included_streaming"], "genres": ["Drama", "History"], "age_rating": "M",
                 "wm_user_rating": 8.2, "wm_critic_score": 95}
        hit = _hit("Spotlight", "hits_stream", services=["Netflix"], movie=movie)
        d = render_digest([hit], site_url="https://x.test/")
        self.assertIn("Drama, History · M · People 8.2 · Critics 95", d["html"])

    def test_meta_line_omits_missing_facts(self):
        movie = {"status": ["upcoming"], "genres": ["Horror"], "age_rating": "MA 15+"}
        hit = _hit("Other Mommy", "opens_soon", movie=movie)
        d = render_digest([hit], site_url="https://x.test/")
        self.assertIn("Horror · MA 15+", d["html"])
        self.assertNotIn("People", d["html"])
        self.assertNotIn("Critics", d["html"])

    def test_score_chip_shows_the_passed_score(self):
        hit = _hit("Scored", "hits_cinema", movie_id="1")
        d = render_digest([hit], site_url="https://x.test/", scores={"1": 87})
        self.assertIn(">87<", d["html"])

    def test_no_score_omits_the_chip(self):
        hit = _hit("Unscored", "hits_cinema", movie_id="1")
        d = render_digest([hit], site_url="https://x.test/", scores={"1": None})
        d2 = render_digest([hit], site_url="https://x.test/")
        for d_ in (d, d2):
            self.assertNotIn('border-radius:8px;border:1px solid', d_["html"])

    def test_context_line_starts_with_agent_name(self):
        hit = _hit("Film", "past_opening_weekend", cascade="Cinema date night")
        d = render_digest([hit], site_url="https://x.test/")
        self.assertIn("Cinema date night", d["html"])

    def test_html_escapes_user_content(self):
        hit = _hit("Bad <script>", "hits_cinema", cascade="My \"quoted\" & <b>Cascade</b>")
        d = render_digest([hit], site_url="https://x.test/")
        self.assertNotIn("<script>", d["html"])
        self.assertIn("&lt;script&gt;", d["html"])

    def test_view_in_cascade_link(self):
        hit = _hit("Film", "hits_cinema", movie_id="42")
        d = render_digest([hit], site_url="https://example.test/app/")
        self.assertIn("https://example.test/app/#/film/42", d["html"])
        self.assertIn("View in Cascade", d["html"])

    def test_site_url_default_is_the_live_site(self):
        hit = _hit("Film", "hits_cinema")
        d = render_digest([hit])
        self.assertIn("cascademovies.com", d["html"])


class ButtonTests(unittest.TestCase):
    """AC4: buttons depend on where the film stands, gated by Service tracking."""

    def test_unreleased_film_has_four_gated_answer_buttons(self):
        hit = _hit("Other Mommy", "opens_soon", movie={"status": ["upcoming"]}, movie_id="9")
        d = render_digest([hit], site_url="https://x.test/")
        for value in ("cinema", "rent", "stream", "never"):
            self.assertIn(f"https://x.test/?answer={value}#/film/9", d["html"])
        self.assertIn("WHEN WILL YOU WATCH IT?", d["html"])

    def test_rent_switched_off_removes_the_rent_button(self):
        hit = _hit("Other Mommy", "opens_soon", movie={"status": ["upcoming"]}, movie_id="9")
        d = render_digest([hit], site_url="https://x.test/",
                          watch_windows={"rent": {"list": False}})
        self.assertNotIn("answer=rent", d["html"])
        self.assertIn("answer=cinema", d["html"])
        self.assertIn("answer=stream", d["html"])
        self.assertIn("answer=never", d["html"])

    def test_streaming_film_has_three_buttons(self):
        hit = _hit("Spotlight", "hits_stream", services=["Netflix"],
                   movie={"status": ["included_streaming"]}, movie_id="9")
        d = render_digest([hit], site_url="https://x.test/")
        for value in ("stream", "seen", "never"):
            self.assertIn(f"https://x.test/?answer={value}#/film/9", d["html"])
        self.assertNotIn("answer=cinema", d["html"])

    def test_home_pay_film_has_three_buttons(self):
        hit = _hit("Ex Machina", "hits_rent", movie={"status": ["rental"]}, movie_id="9")
        d = render_digest([hit], site_url="https://x.test/")
        for value in ("rent", "stream", "never"):
            self.assertIn(f"https://x.test/?answer={value}#/film/9", d["html"])
        self.assertNotIn("answer=cinema", d["html"])
        self.assertNotIn("answer=seen", d["html"])


class OrderingAndOverflowTests(unittest.TestCase):
    """AC3: highest Cascade score first, at most 5 cards, "and N more" beyond that."""

    def _hits(self, n):
        return [_hit(f"Film{i}", "hits_cinema", movie_id=str(i), movie={"status": ["in_cinema"]})
               for i in range(n)]

    def test_highest_score_first(self):
        hits = self._hits(3)
        scores = {"0": 50, "1": 90, "2": 70}
        d = render_digest(hits, site_url="https://x.test/", scores=scores)
        self.assertLess(d["html"].index("Film1"), d["html"].index("Film2"))
        self.assertLess(d["html"].index("Film2"), d["html"].index("Film0"))

    def test_no_score_sorts_last(self):
        hits = self._hits(2)
        scores = {"0": None, "1": 10}
        d = render_digest(hits, site_url="https://x.test/", scores=scores)
        self.assertLess(d["html"].index("Film1"), d["html"].index("Film0"))

    def test_seven_hits_render_five_cards_and_overflow_line(self):
        hits = self._hits(7)
        scores = {str(i): i for i in range(7)}
        d = render_digest(hits, site_url="https://x.test/", scores=scores)
        for part in (d["html"], d["text"]):
            self.assertIn("and 2 more in Cascade", part)
        shown = [f"Film{i}" for i in (6, 5, 4, 3, 2)]
        hidden = ["Film0", "Film1"]
        for title in shown:
            self.assertIn(title, d["html"])
        for title in hidden:
            self.assertNotIn(title, d["html"])


class SubjectTests(unittest.TestCase):
    """AC5: the subject names the top (highest-score) film and its event."""

    def test_single_film_subject(self):
        hit = _hit("Other Mommy", "opens_soon", movie={"cinema_date": "2026-10-08"})
        self.assertEqual(digest_subject([hit], today=TODAY), "Other Mommy opens Thursday")

    def test_multi_film_subject_names_the_top_scored_film(self):
        hits = [
            _hit("Low Score", "hits_cinema", movie_id="1"),
            _hit("Other Mommy", "opens_soon", movie_id="2", movie={"cinema_date": "2026-10-08"}),
            _hit("Mid Score", "hits_stream", movie_id="3"),
        ]
        scores = {"1": 10, "2": 90, "3": 50}
        subject = digest_subject(hits, scores=scores, today=TODAY)
        self.assertEqual(subject, "Other Mommy opens Thursday — and 2 more")

    def test_subject_reflects_reply_count_alone(self):
        reply = {"to_name": "Sam", "answer": "yes", "film_title": "X",
                 "window_text": "", "when_text": ""}
        self.assertEqual(digest_subject([], [reply]), "1 reply to your invites")
        self.assertEqual(digest_subject([], [reply, reply]), "2 replies to your invites")

    def test_subject_reflects_replies_and_updates_together(self):
        reply = {"to_name": "Sam", "answer": "yes", "film_title": "X",
                 "window_text": "", "when_text": ""}
        subject = digest_subject([_hit("A", "hits_cinema")], [reply])
        self.assertIn("1 reply to your invites", subject)
        self.assertIn("1 update", subject)


class InlineStylingTests(unittest.TestCase):
    """AC6: email-client-safe markup only — no <style> block, no class=, no flex/grid."""

    def test_no_style_block_class_attr_or_flex_or_grid(self):
        hits = [
            _hit("Film One", "hits_cinema", movie_id="1"),
            _hit("Film Two", "hits_rent", cascade="Your picks", movie_id="2"),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        self.assertNotIn("<style", d["html"])
        self.assertNotIn("class=", d["html"])
        self.assertNotIn("display:flex", d["html"])
        self.assertNotIn("display:grid", d["html"])


class InviteRepliesRenderTests(unittest.TestCase):
    """CAS-887: the replies block, kept as-is by the CAS-1196 redesign."""

    def _reply(self, to_name="Sam", answer="yes", film_title="Practical Magic 2"):
        return {"to_name": to_name, "answer": answer, "film_title": film_title,
                "window_text": "In cinemas 17 Sep", "when_text": "replied yesterday"}

    def test_subject_unaffected_when_no_replies(self):
        hit = _hit("Other Mommy", "opens_soon", movie={"cinema_date": "2026-10-08"})
        self.assertEqual(digest_subject([hit], today=TODAY), "Other Mommy opens Thursday")

    def test_replies_block_leads_film_entries_html_and_text(self):
        hits = [_hit("Rent Riser", "hits_rent", cascade="Drama rentals", price=6.99)]
        replies = [self._reply(to_name="Sam", film_title="Practical Magic 2")]
        d = render_digest(hits, site_url="https://x.test/", replies=replies)
        for part in (d["html"], d["text"]):
            self.assertIn("Replies to your invites", part)
            self.assertLess(part.index("Replies to your invites"), part.index("Rent Riser"))

    def test_replies_block_contains_recipient_answer_film_and_subline(self):
        replies = [self._reply(to_name="Sam", answer="yes", film_title="Practical Magic 2")]
        d = render_digest([], site_url="https://x.test/", replies=replies)
        for part in (d["html"], d["text"]):
            self.assertIn("Sam", part)
            self.assertIn("Practical Magic 2", part)
            self.assertIn("In cinemas 17 Sep", part)
            self.assertIn("replied yesterday", part)

    def test_replies_only_digest_has_no_film_heading(self):
        # AC2: a replies-only digest must not claim "here's what changed" over an empty list.
        d = render_digest([], site_url="https://x.test/", replies=[self._reply()])
        for part in (d["html"], d["text"]):
            self.assertNotIn("films for you today", part)
            self.assertNotIn("film for you today", part)

    def test_no_replies_leaves_shape_unchanged(self):
        hits = [_hit("Rent Riser", "hits_rent", cascade="Drama rentals", price=6.99)]
        d = render_digest(hits, site_url="https://x.test/")
        self.assertNotIn("Replies to your invites", d["html"])
        self.assertNotIn("Replies to your invites", d["text"])
        self.assertIn("film for you today", d["html"])

    def test_replies_block_html_escapes_user_content(self):
        replies = [self._reply(to_name="<script>", film_title="A & B")]
        d = render_digest([], site_url="https://x.test/", replies=replies)
        self.assertNotIn("<script>", d["html"])
        self.assertIn("&lt;script&gt;", d["html"])
        self.assertIn("A &amp; B", d["html"])

    def test_no_class_or_flex_in_replies_block(self):
        d = render_digest([], site_url="https://x.test/", replies=[self._reply()])
        self.assertNotIn("class=", d["html"])
        self.assertNotIn("display:flex", d["html"])


class InviteReplyFormattingTests(unittest.TestCase):
    """CAS-887: the pure helpers that turn a raw invite_replies row + today's catalogue record
    into the shape render_digest's `replies` wants."""

    def test_format_short_date(self):
        self.assertEqual(_format_short_date("2026-09-17"), "17 Sep")
        self.assertEqual(_format_short_date(None), "")
        self.assertEqual(_format_short_date("not-a-date"), "")

    def test_weekday_date(self):
        self.assertEqual(_weekday_date("2026-10-08"), "Thu 8 Oct")
        self.assertEqual(_weekday_date(None), "")

    def test_window_text_in_cinema_falls_back_to_cinema_date(self):
        movie = {"status": ["in_cinema"], "cinema_date": "2026-09-17"}
        self.assertEqual(_invite_window_text(movie), "In cinemas 17 Sep")

    def test_window_text_upcoming_prefers_window_dates(self):
        movie = {"status": ["upcoming"], "cinema_date": "2026-01-01",
                 "window_dates": {"upcoming": "2026-09-24"}}
        self.assertEqual(_invite_window_text(movie), "Upcoming 24 Sep")

    def test_window_text_home_window_with_no_date_is_label_only(self):
        # Honesty guardrail: never invent a date pvod/rental/streaming don't actually carry.
        self.assertEqual(_invite_window_text({"status": ["rental"]}), "Rent")

    def test_window_text_no_movie_is_empty(self):
        self.assertEqual(_invite_window_text(None), "")
        self.assertEqual(_invite_window_text({}), "")

    def test_window_text_picks_the_furthest_along_tier_held(self):
        movie = {"status": ["rental", "included_streaming"],
                 "window_dates": {"included_streaming": "2026-09-10"}}
        self.assertEqual(_invite_window_text(movie), "Streaming 10 Sep")

    def test_age_text_buckets(self):
        now = _dt.datetime(2026, 9, 10, 12, 0, tzinfo=_dt.timezone.utc)
        self.assertEqual(_invite_age_text("2026-09-10T11:59:30Z", now=now), "just now")
        self.assertEqual(_invite_age_text("2026-09-10T11:30:00Z", now=now), "30 min ago")
        self.assertEqual(_invite_age_text("2026-09-10T02:00:00Z", now=now), "10h ago")
        self.assertEqual(_invite_age_text("2026-09-09T12:00:00Z", now=now), "yesterday")
        self.assertEqual(_invite_age_text("2026-09-05T12:00:00Z", now=now), "5 days ago")

    def test_age_text_missing_is_empty(self):
        self.assertEqual(_invite_age_text(None), "")
        self.assertEqual(_invite_age_text(""), "")

    def test_format_invite_reply_resolves_window_and_age(self):
        row = {"to_name": "Sam", "answer": "yes", "film_title": "Practical Magic 2",
               "created_at": "2026-09-09T12:00:00Z"}
        movie = {"status": ["in_cinema"], "cinema_date": "2026-09-17"}
        now = _dt.datetime(2026, 9, 10, 12, 0, tzinfo=_dt.timezone.utc)
        self.assertEqual(format_invite_reply(row, movie, now=now), {
            "to_name": "Sam", "answer": "yes", "film_title": "Practical Magic 2",
            "window_text": "In cinemas 17 Sep", "when_text": "yesterday",
        })

    def test_format_invite_reply_defaults_missing_name_and_movie(self):
        row = {"answer": "no", "film_title": "X", "created_at": None}
        out = format_invite_reply(row, None)
        self.assertEqual(out["to_name"], "Someone")
        self.assertEqual(out["window_text"], "")
        self.assertEqual(out["when_text"], "")


class RenderingIsDeterministicTests(unittest.TestCase):
    def test_same_input_same_output(self):
        hits = [_hit("Warfare", "hits_cinema", cascade="Cinema date night")]
        d1 = render_digest(hits, site_url="https://example.test/app/", today=TODAY)
        d2 = render_digest(hits, site_url="https://example.test/app/", today=TODAY)
        self.assertEqual(d1, d2)


class SendViaResendTests(unittest.TestCase):
    def test_request_carries_a_real_user_agent(self):
        resp = mock.MagicMock()
        resp.read.return_value = b'{"id": "abc"}'
        resp.__enter__.return_value = resp
        with mock.patch("urllib.request.urlopen", return_value=resp) as urlopen:
            send_via_resend("to@example.test", "Subj", "<p>hi</p>", "hi", api_key="k")
        req = urlopen.call_args[0][0]
        self.assertEqual(req.get_header("User-agent"), USER_AGENT)
        self.assertNotIn("python-urllib", req.get_header("User-agent").lower())

    def test_http_error_reports_status_content_type_body_and_from_no_key(self):
        err = urllib.error.HTTPError(
            url="https://api.resend.com/emails", code=403, msg="Forbidden",
            hdrs={"Content-Type": "text/html"}, fp=io.BytesIO(b"<html>blocked</html>"),
        )
        with mock.patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(RuntimeError) as ctx:
                send_via_resend("to@example.test", "Subj", "<p>hi</p>", "hi",
                                 api_key="super-secret-key", from_addr="Cascade <a@b.test>")
        message = str(ctx.exception)
        self.assertIn("403", message)
        self.assertIn("text/html", message)
        self.assertIn("blocked", message)
        self.assertIn("a@b.test", message)
        self.assertNotIn("super-secret-key", message)


if __name__ == "__main__":
    unittest.main()
