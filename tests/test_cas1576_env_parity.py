import importlib.util, os, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("env_parity", os.path.join(ROOT, "ci", "env_parity.py"))
ep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ep)


def settings(**over):
    s = {k: "x" for k in ep.MUST_MATCH}
    s.update(mailer_autoconfirm=True, site_url="https://stg", uri_allow_list="stg/*", smtp_sender_name="Cascade Staging")
    s.update(over)
    return s


def prod(**over):
    d = dict(site_url="https://prod", uri_allow_list="prod/*", smtp_sender_name="Cascade")
    d.update(over)
    return settings(**d)


class Parity(unittest.TestCase):
    def verdicts(self, a, b):
        return {r[0]: r[3] for r in ep.compare_auth(a, b)}

    def test_matching_passes(self):
        v = self.verdicts(settings(), prod())
        self.assertFalse([k for k, x in v.items() if x != "PASS"])

    def test_confirm_email_on_in_one_project_fails(self):
        v = self.verdicts(settings(mailer_autoconfirm=False), prod())
        self.assertTrue(v["mailer_autoconfirm"].startswith("FAIL"))

    def test_same_site_url_fails(self):
        v = self.verdicts(settings(), prod(site_url="https://stg"))
        self.assertTrue(v["site_url"].startswith("FAIL"))

    def test_sender_name_must_be_expected(self):
        v = self.verdicts(settings(smtp_sender_name="Cascade"), prod())
        self.assertTrue(v["smtp_sender_name"].startswith("FAIL"))

    def test_unlisted_difference_warns_and_secrets_ignored(self):
        v = self.verdicts(settings(brand_new=1, smtp_pass="a"), prod(brand_new=2, smtp_pass="b"))
        self.assertTrue(v["brand_new"].startswith("WARN"))
        self.assertNotIn("smtp_pass", v)

    def test_migrations_must_equal_repo(self):
        rows = ep.compare_sets("m", {"0001"}, {"0001", "0002"}, expected={"0001", "0002"})
        self.assertTrue(rows[0][3].startswith("FAIL"))
        self.assertEqual(rows[1][3], "PASS")

    def test_function_slug_drift_fails(self):
        self.assertTrue(ep.compare_sets("f", {"a"}, {"a", "b"})[0][3].startswith("FAIL"))


if __name__ == "__main__":
    unittest.main()
