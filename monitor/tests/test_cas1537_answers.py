"""CAS-1537: the alert email carries the app's own Watch On / Watched buttons, each a signed one-tap link."""
import datetime as dt
import html as _html
import json
import re
import unittest
from unittest import mock

from monitor import answer_links as al
from monitor import render_digest
from monitor.answer_links import AnswerContext, sign_token, verify_token
from monitor.matching import Hit
from monitor.transitions import Transition

SECRET = "test-secret"
SITE = "https://x.test/"
TODAY = dt.date(2026, 11, 24)
NOW = 1_800_000_000.0


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _hit(title, movie_id, status, moment="hits_stream", stage=None):
    t = Transition(movie_id=str(movie_id), title=title, moment=moment, services=["Netflix"], price=None,
                   movie={"status": [status]}, stage=stage)
    return Hit(user_id="u1", cascade_id="c1", cascade_name="Max", transition=t)


def _columns(html):
    """[(column heading, [(label, href-or-None)])] per card, in document order."""
    out = []
    for m in re.finditer(r'<td width="50%" valign="top"[^>]*>(.*?)</td>', html, re.S):
        cell = m.group(1)
        heading = re.search(r">([A-Z ]+)</div>", cell).group(1)
        items = []
        for a in re.finditer(r'<a href="([^"]+)"[^>]*>([^<]+)</a>|<span title="Already reached"[^>]*>([^<]+)</span>', cell):
            if a.group(1):
                items.append((_html.unescape(a.group(2)), _html.unescape(a.group(1))))
            else:
                items.append((_html.unescape(a.group(3)), None))
        out.append((heading, items))
    return out


class AppLabels(unittest.TestCase):
    """AC2: the email's labels and order are the app's, read from app_template.html."""

    @classmethod
    def setUpClass(cls):
        cls.app = _read("app_template.html")

    def test_watch_on_labels_match_the_app(self):
        short = re.search(r"const WATCH_LEVEL_SHORT_LABEL = \{([^}]*)\}", self.app).group(1)
        app_pairs = re.findall(r'(\w+):"([^"]+)"', short) + [("never", "Never")]
        self.assertEqual([(d["key"], d["label"]) for d in al.WATCH_ON], app_pairs)
        keys = re.search(r"const WATCH_LEVEL_KEYS = \[([^\]]*)\]", self.app).group(1)
        self.assertEqual([d["key"] for d in al.WATCH_ON][:-1], re.findall(r'"(\w+)"', keys))
        self.assertIn('willNeverSegHTML(id,"Never")', self.app)

    def test_watched_labels_match_the_app(self):
        block = re.search(r"const WATCH_STEPS = \[(.*?)\n\];", self.app, re.S).group(1)
        app_pairs = re.findall(r'key:"(\w+)".*?lbl:"([^"]+)"', block)
        self.assertEqual([(d["key"], d["label"]) for d in al.WATCHED], app_pairs)

    def test_answer_keys_are_the_apps_batch_answer_keys(self):
        keys = re.search(r"const BATCH_ANSWER_KEYS = \[([^\]]*)\]", self.app).group(1)
        self.assertEqual(al.ANSWER_KEYS, re.findall(r'"(\w+)"', keys))

    def test_parity_fails_if_a_label_drifts(self):
        with mock.patch.object(al, "WATCH_ON", [dict(d, label="Home") if d["key"] == "rent" else d for d in al.WATCH_ON]):
            with self.assertRaises(AssertionError):
                self.test_watch_on_labels_match_the_app()


class EmailButtons(unittest.TestCase):
    """AC1: every film card in every alert email kind has both columns with the app's exact labels."""

    WATCHED = ["Wow!", "Watch Again", "Enjoyed", "So-so", "Disliked"]

    def _ctx(self, films):
        return AnswerContext(SECRET, "u1", {str(f): f"row-{f}" for f in films}, now=NOW)

    def _check(self, d, n_cards, tracked):
        cols = _columns(d["html"])
        self.assertEqual(len(cols), 2 * n_cards)
        for i in range(n_cards):
            on, watched = cols[2 * i], cols[2 * i + 1]
            self.assertEqual(on[0], "WATCH ON")
            self.assertEqual([lbl for lbl, _ in on[1]], tracked)
            self.assertEqual(watched[0], "WATCHED")
            self.assertEqual([lbl for lbl, _ in watched[1]], self.WATCHED)
            self.assertTrue(all(href for _, href in watched[1]))
        for text in ("Wait for home", "Not for me"):
            self.assertNotIn(text, d["html"])
            self.assertNotIn(text, d["text"])

    def test_daily_digest(self):
        hits = [_hit("A", 1, "upcoming", "opens_soon"), _hit("B", 2, "upcoming", "opens_soon")]
        d = render_digest(hits, site_url=SITE, today=TODAY, answers=self._ctx([1, 2]),
                          watch_windows={"premium": {"list": True}})
        self._check(d, 2, ["Cinema", "Premium", "Rent", "Stream", "Never"])

    def test_unseen_alert_digest(self):
        d = render_digest([_hit("A", 1, "rental", "hits_rent")], site_url=SITE, today=TODAY, kind="unseen_alert",
                          answers=self._ctx([1]))
        self._check(d, 1, ["Cinema", "Rent", "Stream", "Never"])

    def test_catchup_email(self):
        hits = [_hit("A", 1, "in_cinema", "catchup", "cinema"), _hit("B", 2, "included_streaming", "catchup", "streaming")]
        d = render_digest(hits, site_url=SITE, today=TODAY, kind="catchup_alert", batch_id="b" * 8, answers=self._ctx([1, 2]))
        self._check(d, 2, ["Cinema", "Rent", "Stream", "Never"])

    def test_passed_windows_are_greyed_and_not_linked(self):
        d = render_digest([_hit("A", 1, "rental", "hits_rent")], site_url=SITE, today=TODAY, answers=self._ctx([1]))
        on = dict(_columns(d["html"])[0][1])
        self.assertIsNone(on["Cinema"])
        for label in ("Rent", "Stream", "Never"):
            self.assertTrue(on[label])
        stream = render_digest([_hit("A", 1, "included_streaming")], site_url=SITE, today=TODAY, answers=self._ctx([1]))
        on = dict(_columns(stream["html"])[0][1])
        self.assertIsNone(on["Cinema"])
        self.assertIsNone(on["Rent"])
        self.assertTrue(on["Stream"])

    def test_each_button_is_a_signed_link_for_exactly_its_own_key(self):
        d = render_digest([_hit("A", 7, "upcoming", "opens_soon")], site_url=SITE, today=TODAY, answers=self._ctx([7]))
        seen = {}
        for _, items in _columns(d["html"]):
            for label, href in items:
                if not href:
                    continue
                self.assertTrue(href.startswith(f"{SITE}a/?t="), href)
                token = re.search(r"[?&]t=([^&]+)", href).group(1)
                p = verify_token(SECRET, token, now=NOW + 60)
                self.assertEqual((p["u"], p["r"], p["f"]), ("u1", "row-7", "7"))
                self.assertEqual(al.LABELS[p["k"]], label)
                self.assertIn(f"cta=answer_{p['k']}", href)
                seen[p["k"]] = token
        self.assertEqual(set(seen), {"in_cinema", "rent", "stream", "never", "wow", "liked", "enjoyed", "soso", "disliked"})
        self.assertEqual(len(set(seen.values())), len(seen))

    def test_without_a_secret_buttons_open_the_film_in_cascade(self):
        ctx = AnswerContext(None, "u1", {"1": "row-1"})
        d = render_digest([_hit("A", 1, "upcoming", "opens_soon")], site_url=SITE, today=TODAY, answers=ctx)
        self.assertNotIn("/a/?t=", d["html"])
        self.assertIn("#/film/1", d["html"])


class Tokens(unittest.TestCase):
    """AC3."""

    def test_verifies_for_its_own_fields(self):
        t = sign_token(SECRET, "u1", "r1", "42", "rent", now=NOW)
        self.assertEqual(verify_token(SECRET, t, now=NOW + 1),
                         {"u": "u1", "r": "r1", "f": "42", "k": "rent", "e": int(NOW + 30 * 86400)})

    def test_any_changed_field_fails(self):
        t = sign_token(SECRET, "u1", "r1", "42", "rent", now=NOW)
        head, body, sig = t.split(".")
        payload = json.loads(al._unb64(body))
        for field, value in (("u", "u2"), ("r", "r2"), ("f", "43"), ("k", "never"), ("e", payload["e"] + 1)):
            forged = al._b64(json.dumps({**payload, field: value}, separators=(",", ":"), sort_keys=True).encode())
            self.assertIsNone(verify_token(SECRET, f"{head}.{forged}.{sig}", now=NOW + 1), field)

    def test_wrong_secret_and_garbage_fail(self):
        t = sign_token(SECRET, "u1", "r1", "42", "rent", now=NOW)
        self.assertIsNone(verify_token("other", t, now=NOW + 1))
        for bad in ("", "x", "v1..", "v2." + t[3:], t + "x", None):
            self.assertIsNone(verify_token(SECRET, bad, now=NOW + 1))

    def test_expires_after_thirty_days(self):
        t = sign_token(SECRET, "u1", "r1", "42", "rent", now=NOW)
        self.assertIsNotNone(verify_token(SECRET, t, now=NOW + 30 * 86400 - 1))
        self.assertIsNone(verify_token(SECRET, t, now=NOW + 30 * 86400))

    def test_unknown_key_is_never_signed(self):
        with self.assertRaises(ValueError):
            sign_token(SECRET, "u1", "r1", "42", "cinema", now=NOW)


class AppleAppSiteAssociation(unittest.TestCase):
    """AC7."""

    def test_answer_path_is_excluded_and_everything_else_claimed(self):
        comps = json.loads(_read(".well-known/apple-app-site-association"))["applinks"]["details"][0]["components"]
        excluded = [c for c in comps if c.get("exclude")]
        self.assertEqual([c["/"] for c in excluded], ["/a/*"])
        self.assertEqual(al.ANSWER_PATH, "a/")
        claims = [c for c in comps if not c.get("exclude")]
        self.assertEqual([c["/"] for c in claims], ["/*"])
        self.assertLess(comps.index(excluded[0]), comps.index(claims[0]))   # exclusions are matched first

    def test_the_static_page_exists_at_the_excluded_path(self):
        page = _read("a/index.html")
        self.assertIn("alert-answer", page)
        self.assertIn("Saved: ", page)


if __name__ == "__main__":
    unittest.main()
