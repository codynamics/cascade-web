"""Unit tests for the digest renderer + phrasing (CAS-86 / spec 26771457 §6).

Run:  python -m unittest monitor.tests.test_emailer
"""
import datetime as _dt
import io
import unittest
import urllib.error
from unittest import mock

from monitor import render_digest, moment_phrase, digest_subject
from monitor.emailer import (
    USER_AGENT, send_via_resend, format_invite_reply, _invite_window_text, _invite_age_text,
    _format_short_date,
)
from monitor.matching import Hit, _rank_key
from monitor.transitions import Transition

_UNSET = object()


def _hit(title, moment, cascade, order=None, services=None, price=None, prior_window=None,
         movie_id="1", cascade_id=_UNSET, status=("in_cinema",)):
    """cascade_id defaults to one derived from the agent name, so two calls naming different
    agents land in different sections (matching.py's own rank-collapse already guarantees a real
    Hit list never mixes cascade_id with cascade_name this way). Pass cascade_id=None explicitly
    for a Watch-it hit (no cascade — cascade_name "Your picks").

    status defaults to ["in_cinema"] (CAS-924's outer grouping) so every existing call that never
    cared about a film's status still lands in one shared status section, unchanged. Pass
    status=() for a movie record with no resolvable status."""
    t = Transition(movie_id=movie_id, title=title, moment=moment,
                   services=services or [], price=price, movie={"status": list(status)})
    if prior_window is not None:
        t.prior_window = prior_window
    if cascade_id is _UNSET:
        cascade_id = f"id-{cascade}"
    rank = _rank_key({"criteria": {"order": order}}) if cascade_id is not None else None
    return Hit(user_id="user-A", cascade_id=cascade_id, cascade_name=cascade, transition=t, rank=rank)


class PhraseTests(unittest.TestCase):
    def test_stream_names_service(self):
        t = _hit("A", "hits_stream", "x", services=["Netflix"]).transition
        self.assertEqual(moment_phrase(t), "Now on Netflix")

    def test_stream_without_service_is_generic(self):
        t = _hit("A", "hits_stream", "x").transition
        self.assertIn("streaming", moment_phrase(t).lower())

    def test_rent_shows_real_price(self):
        t = _hit("A", "hits_rent", "x", price=4.99).transition
        self.assertEqual(moment_phrase(t), "Dropped to rent — $4.99")

    def test_rent_without_price_is_honest(self):
        t = _hit("A", "hits_rent", "x").transition
        self.assertEqual(moment_phrase(t), "Now available to rent")

    def test_cinema_and_weekend(self):
        self.assertEqual(moment_phrase(_hit("A", "hits_cinema", "x").transition), "In cinemas now")
        self.assertEqual(moment_phrase(_hit("A", "past_opening_weekend", "x").transition),
                         "Past its opening weekend")

    def test_no_fabricated_urgency(self):
        # Honesty guardrail: the weekend line must not invent a "leaving"/countdown claim.
        line = moment_phrase(_hit("A", "past_opening_weekend", "x").transition).lower()
        for banned in ("leaving", "last chance", "hurry", "expires", "gone in"):
            self.assertNotIn(banned, line)


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.hits = [
            _hit("Rent Riser", "hits_rent", "Drama rentals", price=6.99),
            _hit("Stream Arrival", "hits_stream", "Comedy on Stan", services=["Stan"]),
        ]

    def test_subject_counts_updates(self):
        self.assertEqual(digest_subject(self.hits), "Cascade found 2 updates for you")
        self.assertEqual(digest_subject(self.hits[:1]), "Cascade found 1 update for you")

    def test_one_consolidated_digest_lists_every_item(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertIn("Rent Riser", part)
            self.assertIn("Stream Arrival", part)
            self.assertIn("Drama rentals", part)      # which Cascade caught it — named on the film itself
            self.assertIn("Comedy on Stan", part)
        self.assertIn("$6.99", d["html"])             # real price, real service
        self.assertIn("Now on Stan", d["html"])
        self.assertIn("https://example.test/app/", d["html"])   # link back to the site

    def test_html_escapes_user_content(self):
        hit = _hit("Bad <script>", "hits_cinema", "My \"quoted\" & <b>Cascade</b>")
        d = render_digest([hit], site_url="https://x.test/")
        self.assertNotIn("<script>", d["html"])
        self.assertIn("&lt;script&gt;", d["html"])

    def test_site_url_default_is_the_live_site(self):
        d = render_digest(self.hits)
        self.assertIn("cascademovies.com", d["html"])


class SectioningTests(unittest.TestCase):
    """CAS-849: films render inside their agent's own section now (see AgentSectionTests) — these
    check what survives that change."""

    def setUp(self):
        self.hits = [
            _hit("Warfare", "hits_cinema", "Cinema date night", prior_window="upcoming", movie_id="w"),
            _hit("The Long Walk", "past_opening_weekend", "Cinema date night", movie_id="tlw"),
            _hit("Sinners", "hits_stream", "Everyday favourites", services=["Netflix"],
                 prior_window="rental", movie_id="s"),
        ]

    def test_films_appear_in_hit_order(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertLess(part.index("Warfare"), part.index("The Long Walk"))
            self.assertLess(part.index("The Long Walk"), part.index("Sinners"))

    def test_no_per_line_found_by_tag(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertNotIn("Found by your", part)

    def test_move_line_shown_when_prior_window_known(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertIn("Upcoming → In cinema", part)
            self.assertIn("Rent → Stream", part)

    def test_no_move_line_when_prior_window_unknown(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertIn("Past its opening weekend", part)
        # "The Long Walk" has no prior_window set — never invent a move for it.
        self.assertNotIn("→ Past", d["html"])

    def test_rendering_is_deterministic(self):
        d1 = render_digest(self.hits, site_url="https://example.test/app/")
        d2 = render_digest(self.hits, site_url="https://example.test/app/")
        self.assertEqual(d1, d2)


class AgentSectionTests(unittest.TestCase):
    """CAS-849: films render grouped under the agent's own section heading, not named per-row."""

    def test_one_agent_named_on_its_section(self):
        d = render_digest([_hit("Warfare", "hits_cinema", "Cinema date night")],
                           site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertIn("Warfare", part)
            self.assertIn("Cinema date night", part)

    def test_two_agents_catching_the_same_film_each_get_their_own_row(self):
        # matching.py's own _collapse_by_rank already guarantees one (cascade, movie, moment) is
        # never produced by two DIFFERENT cascades within a single match() call — two cascade_ids
        # both naming the same film here are two real, separate events, one per agent's section.
        hits = [
            _hit("Sinners", "hits_stream", "Everyday favourites", services=["Netflix"]),
            _hit("Sinners", "hits_stream", "Weekend picks", services=["Netflix"]),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertEqual(part.count("Sinners"), 2)
            self.assertIn("Everyday favourites", part)
            self.assertIn("Weekend picks", part)

    def test_watch_it_hit_reads_your_picks(self):
        hit = _hit("Warfare", "hits_cinema", "Your picks", cascade_id=None)
        d = render_digest([hit], site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertIn("Your picks", part)

    def test_agent_and_watch_it_on_the_same_film_each_get_their_own_row(self):
        hits = [
            _hit("Warfare", "hits_cinema", "Cinema date night"),
            _hit("Warfare", "hits_cinema", "Your picks", cascade_id=None),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertEqual(part.count("Warfare"), 2)
            self.assertIn("Cinema date night", part)
            self.assertIn("Your picks", part)

    def test_different_moments_for_the_same_film_stay_separate(self):
        # Two real, distinct events for the same film — never collapsed into one line.
        hits = [
            _hit("Warfare", "hits_cinema", "Cinema date night"),
            _hit("Warfare", "hits_stream", "Everyday favourites", services=["Netflix"]),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertEqual(part.count("Warfare"), 2)

    def test_agent_name_appears_once_per_section_not_once_per_row(self):
        # AC3: three films from the same agent still name that agent exactly once (the heading).
        hits = [
            _hit("Film One", "hits_cinema", "Busy Agent", movie_id="1"),
            _hit("Film Two", "hits_stream", "Busy Agent", services=["Netflix"], movie_id="2"),
            _hit("Film Three", "hits_rent", "Busy Agent", movie_id="3"),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        self.assertEqual(d["html"].count("Busy Agent"), 1)
        self.assertEqual(d["text"].count("Busy Agent"), 1)


class SectionOrderTests(unittest.TestCase):
    """AC1 + AC4: section order follows _rank_key() ascending; Your picks always sorts last."""

    def test_rank_one_agent_section_comes_first(self):
        hits = [
            _hit("Second Pick", "hits_cinema", "Rank Two Agent", order=2, movie_id="a"),
            _hit("First Pick", "hits_cinema", "Rank One Agent", order=1, movie_id="b"),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertLess(part.index("Rank One Agent"), part.index("Rank Two Agent"))

    def test_your_picks_sorts_last_after_a_ranked_agent(self):
        hits = [
            _hit("Watched Film", "hits_cinema", "Your picks", cascade_id=None, movie_id="w"),
            _hit("Agent Film", "hits_cinema", "Some Agent", order=5, movie_id="a"),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertLess(part.index("Some Agent"), part.index("Your picks"))

    def test_your_picks_sorts_last_even_against_an_unranked_agent(self):
        hits = [
            _hit("Watched Film", "hits_cinema", "Your picks", cascade_id=None, movie_id="w"),
            _hit("Agent Film", "hits_cinema", "No Order Agent", movie_id="a"),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertLess(part.index("No Order Agent"), part.index("Your picks"))


class TagTests(unittest.TestCase):
    """AC2: New = new_to_agent/newly_qualifies; Changed = every other moment."""

    def test_new_to_agent_tags_new(self):
        d = render_digest([_hit("Fresh Find", "new_to_agent", "Some Agent")], site_url="https://x.test/")
        self.assertIn("New", d["html"])
        self.assertIn("[New]", d["text"])

    def test_newly_qualifies_tags_new(self):
        d = render_digest([_hit("Now Qualifies", "newly_qualifies", "Some Agent")], site_url="https://x.test/")
        self.assertIn("New", d["html"])
        self.assertIn("[New]", d["text"])
        self.assertIn("matches this agent", d["html"])   # CAS-849: newly_qualifies gets its own sub-line

    def test_hits_rent_tags_changed(self):
        d = render_digest([_hit("Price Drop", "hits_rent", "Some Agent")], site_url="https://x.test/")
        self.assertIn("Changed", d["html"])
        self.assertIn("[Changed]", d["text"])


class InlineStylingTests(unittest.TestCase):
    """AC5: email-client-safe markup only — no <style> block, no class=, no display:flex."""

    def test_no_style_block_class_attr_or_flex(self):
        hits = [
            _hit("Film One", "new_to_agent", "Some Agent"),
            _hit("Film Two", "hits_rent", "Your picks", cascade_id=None),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        self.assertNotIn("<style", d["html"])
        self.assertNotIn("class=", d["html"])
        self.assertNotIn("display:flex", d["html"])


class InviteRepliesRenderTests(unittest.TestCase):
    """CAS-887 AC1a/AC3d: the replies block, as render_digest itself renders it. Pipeline-level
    questions (which users get an email at all) live in monitor/tests/test_invite_replies.py."""

    def _reply(self, to_name="Sam", answer="yes", film_title="Practical Magic 2"):
        return {"to_name": to_name, "answer": answer, "film_title": film_title,
                "window_text": "In cinemas 17 Sep", "when_text": "replied yesterday"}

    def test_subject_reflects_reply_count_alone(self):
        self.assertEqual(digest_subject([], [self._reply()]), "1 reply to your invites")
        self.assertEqual(digest_subject([], [self._reply(), self._reply()]),
                         "2 replies to your invites")

    def test_subject_reflects_replies_and_updates_together(self):
        subject = digest_subject([_hit("A", "hits_cinema", "x")], [self._reply()])
        self.assertIn("1 reply to your invites", subject)
        self.assertIn("1 update", subject)

    def test_subject_unaffected_when_no_replies(self):
        self.assertEqual(digest_subject([_hit("A", "hits_cinema", "x")]),
                         "Cascade found 1 update for you")

    def test_replies_block_leads_film_entries_html_and_text(self):
        hits = [_hit("Rent Riser", "hits_rent", "Drama rentals", price=6.99)]
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

    def test_replies_only_digest_has_no_film_transitions_heading(self):
        # AC2: a replies-only digest must not claim "here's what changed" over an empty list.
        d = render_digest([], site_url="https://x.test/", replies=[self._reply()])
        for part in (d["html"], d["text"]):
            self.assertNotIn("Your agents have been watching", part)

    def test_no_replies_leaves_shape_unchanged(self):
        hits = [_hit("Rent Riser", "hits_rent", "Drama rentals", price=6.99)]
        d = render_digest(hits, site_url="https://x.test/")
        self.assertNotIn("Replies to your invites", d["html"])
        self.assertNotIn("Replies to your invites", d["text"])
        self.assertIn("Your agents have been watching", d["html"])

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


class StatusSectionTests(unittest.TestCase):
    """CAS-924: the digest gains the same two levels of grouping Moving has — status outer,
    agent inner."""

    def setUp(self):
        self.hits = [
            _hit("Waiting Room", "hits_cinema", "Cinema date night", status=("upcoming",), movie_id="1"),
            _hit("On Screens", "hits_cinema", "Cinema date night", status=("in_cinema",), movie_id="2"),
            _hit("For Rent", "hits_rent", "Weekend picks", price=6.99, status=("rental",), movie_id="3"),
            _hit("Now Streaming", "hits_stream", "Weekend picks", services=["Stan"],
                 status=("included_streaming",), movie_id="4"),
        ]

    def test_headings_appear_in_listing_order(self):
        d = render_digest(self.hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertLess(part.index("Upcoming"), part.index("In Cinema"))
            self.assertLess(part.index("In Cinema"), part.index("Rent (~$7)"))
            self.assertLess(part.index("Rent (~$7)"), part.index("Stream (included)"))

    def test_text_part_carries_same_headings_same_order(self):
        d = render_digest(self.hits, site_url="https://x.test/")
        text = d["text"]
        self.assertIn("Upcoming", text)
        self.assertIn("In Cinema", text)
        self.assertIn("Rent (~$7)", text)
        self.assertIn("Stream (included)", text)

    def test_both_agents_appear_in_a_shared_status_section_in_rank_order(self):
        hits = [
            _hit("Second Agent's Film", "hits_cinema", "Rank Two Agent", order=2,
                 status=("in_cinema",), movie_id="a"),
            _hit("First Agent's Film", "hits_cinema", "Rank One Agent", order=1,
                 status=("in_cinema",), movie_id="b"),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            in_cinema_idx = part.index("In Cinema")
            self.assertGreater(part.index("Rank One Agent"), in_cinema_idx)
            self.assertGreater(part.index("Rank Two Agent"), in_cinema_idx)
            self.assertLess(part.index("Rank One Agent"), part.index("Rank Two Agent"))

    def test_agent_with_no_film_in_a_status_section_is_absent_from_it(self):
        d = render_digest(self.hits, site_url="https://x.test/")
        # "Weekend picks" only has films in rental/included_streaming — never in the upcoming
        # or in_cinema sections.
        for part in (d["html"], d["text"]):
            upcoming_to_rent = part[part.index("Upcoming"):part.index("Rent (~$7)")]
            self.assertNotIn("Weekend picks", upcoming_to_rent)

    def test_multi_member_status_lands_in_the_furthest_along_section_only(self):
        hit = _hit("Almost Home", "hits_stream", "Weekend picks", services=["Stan"],
                    status=("in_cinema", "rental"), movie_id="5")
        d = render_digest([hit], site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertIn("Rent (~$7)", part)
            self.assertNotIn("In Cinema", part)

    def test_empty_sections_are_omitted(self):
        d = render_digest([_hit("Only Upcoming", "hits_cinema", "Some Agent",
                                 status=("upcoming",))], site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertNotIn("Stream (included)", part)
            self.assertNotIn("Rent (~$7)", part)

    def test_unresolvable_status_is_not_dropped(self):
        hit = _hit("No Known Window", "hits_cinema", "Some Agent", status=())
        d = render_digest([hit], site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertIn("No Known Window", part)


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
