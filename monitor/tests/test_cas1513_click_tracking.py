"""CAS-1513: every link in every email Cascade sends carries src=email, cmp=<email kind>, cta=<button key>."""
import html
import re
import unittest
from urllib.parse import urlparse, parse_qs

from monitor import render_digest
from monitor.emailer import track_url
from monitor.invitemail import render_email as render_invite
from monitor.recommend import render_email as render_recommend
from monitor.tests.test_emailer import _hit, TODAY


def _links(doc):
    """(html hrefs, text-part urls) that point at Cascade — mailto/image links aren't app links."""
    hrefs = [html.unescape(h) for h in re.findall(r'<a href="([^"]+)"', doc["html"])]
    texts = re.findall(r"https?://\S+", doc["text"])
    return [u for u in hrefs if u.startswith("http")], texts


class ClickTrackingTests(unittest.TestCase):
    def _assert_tracked(self, doc, cmp):
        hrefs, texts = _links(doc)
        self.assertTrue(hrefs, "email has no links")
        self.assertTrue(texts, "email text part has no links")
        for url in hrefs + texts:
            q = parse_qs(urlparse(url).query)
            self.assertEqual(q.get("src"), ["email"], url)
            self.assertEqual(q.get("cmp"), [cmp], url)
            self.assertTrue(q.get("cta") and q["cta"][0], url)
        return hrefs

    def test_track_url_keeps_query_and_fragment(self):
        self.assertEqual(track_url("https://x.test/?answer=seen#/film/9", "daily_alert", "answer_seen"),
                         "https://x.test/?answer=seen&src=email&cmp=daily_alert&cta=answer_seen#/film/9")
        self.assertEqual(track_url("https://x.test/", "recommend", "sign_up"),
                         "https://x.test/?src=email&cmp=recommend&cta=sign_up")

    def test_daily_alert_links(self):
        hits = [_hit(f"Film {i}", "hits_cinema", movie_id=str(i)) for i in range(1, 13)]
        hrefs = self._assert_tracked(render_digest(hits, site_url="https://x.test/", today=TODAY), "daily_alert")
        ctas = {parse_qs(urlparse(u).query)["cta"][0] for u in hrefs}
        self.assertTrue({"view_film", "more_in_cascade", "change_alerts"} <= ctas)
        self.assertTrue(any(c.startswith("answer_") for c in ctas))

    def test_every_button_has_its_own_cta(self):
        hits = [_hit("Film", "hits_cinema", movie_id="9")]
        hrefs = self._assert_tracked(render_digest(hits, site_url="https://x.test/", today=TODAY), "daily_alert")
        answers = [parse_qs(urlparse(u).query)["cta"][0] for u in hrefs if "cta=answer_" in u]
        self.assertEqual(len(answers), len(set(answers)))

    def test_unseen_alert_links(self):
        hits = [_hit("Film", "hits_cinema", movie_id="9")]
        self._assert_tracked(render_digest(hits, site_url="https://x.test/", today=TODAY, kind="unseen_alert"),
                             "unseen_alert")

    def test_recommend_links(self):
        self._assert_tracked(render_recommend({"sender_name": "lee", "to_name": "Priya", "message": "hi"}), "recommend")

    def test_invite_links(self):
        row = {"token": "abc1234567", "tmdb_id": 12345, "sender_name": "lee", "to_name": "Priya",
               "film_title": "Film"}
        hrefs = self._assert_tracked(render_invite(row), "invite")
        self.assertTrue(any("inv=abc1234567" in u for u in hrefs))


if __name__ == "__main__":
    unittest.main()
