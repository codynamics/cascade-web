"""CAS-1426 — the public privacy page (privacy.html, served at cascademovies.com/privacy) is generated
from app_template.html's PRIVACY_* source by `poc_pipeline.py --build-html`.

The expected text is read from the template by Node evaluating the JS literals themselves, not by the
generator's own regex parser, so a parser slip cannot certify itself. The page under test is the one the
build just wrote (npm run qa builds first).
"""
import html
import json
import re
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = REPO_ROOT / "app_template.html"
PAGE = REPO_ROOT / "privacy.html"

NODE_EVAL = r"""
const fs = require("fs");
const t = fs.readFileSync(process.argv[1], "utf8");
const a = t.indexOf("const PRIVACY_LEDE");
const b = t.indexOf("function privacyParaHTML");
const src = t.slice(a, b) + "\nconsole.log(JSON.stringify({lede:PRIVACY_LEDE,sections:PRIVACY_SECTIONS,leads:PRIVACY_BOLD_LEADS}));";
new Function(src)();
"""


def _plain(page: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", page))


class PrivacyPage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = subprocess.run(["node", "-e", NODE_EVAL, str(TEMPLATE)], capture_output=True, text=True,
                             encoding="utf-8", check=True).stdout
        cls.src = json.loads(out)
        cls.page = PAGE.read_text(encoding="utf-8")
        cls.text = _plain(cls.page)

    def test_ac2_every_lede_heading_and_paragraph_is_present(self):
        self.assertIn(self.src["lede"], self.text)
        self.assertGreater(len(self.src["sections"]), 0)
        for s in self.src["sections"]:
            self.assertIn(s["heading"], self.text, f"heading missing: {s['heading']}")
            for p in s["paras"]:
                self.assertIn(p, self.text, f"paragraph missing: {p[:60]}")

    def test_bold_leads_are_bold(self):
        for lead in self.src["leads"]:
            self.assertIn(f"<b>{lead}</b>", self.page)

    def test_ac3_no_old_address_or_personal_email_and_has_hello(self):
        self.assertNotIn("Gordon", self.page)
        self.assertNotIn("lee@", self.page)
        self.assertIn("hello@codynamics.com.au", self.page)

    def test_ac4_no_script_tag(self):
        self.assertNotIn("<script", self.page.lower())

    def test_page_shell(self):
        self.assertIn("<title>Cascade — Privacy policy</title>", self.page)
        self.assertIn('name="viewport"', self.page)
        self.assertIn('href="https://cascademovies.com"', self.page)


if __name__ == "__main__":
    unittest.main()
