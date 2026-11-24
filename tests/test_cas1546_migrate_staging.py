import importlib.util, os, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("migrate_staging", os.path.join(ROOT, "ci", "migrate_staging.py"))
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)


class MigrateStaging(unittest.TestCase):
    def test_unrecorded_selected_in_order_recorded_skipped(self):
        files = ["0003_c.sql", "0001_a.sql", "0002_b.sql", "README.md", "0004_d.sql"]
        got = ms.pending(files, ["0001", "0003"])
        self.assertEqual(got, [("0002", "0002_b.sql"), ("0004", "0004_d.sql")])

    def test_all_recorded_is_empty(self):
        self.assertEqual(ms.pending(["0001_a.sql"], ["0001"]), [])

    def test_production_guard_trips(self):
        with self.assertRaises(SystemExit):
            ms.guard("postgresql://postgres:x@db.ypccfyatejejslzlfrbf.supabase.co:5432/postgres")

    def test_empty_url_trips_and_staging_passes(self):
        with self.assertRaises(SystemExit):
            ms.guard("")
        ms.guard("postgresql://postgres:x@db.oenvezqluwqdwlzfhisc.supabase.co:5432/postgres")

    def test_workflow_declares_staging_env_and_guard(self):
        wf = open(os.path.join(ROOT, ".github", "workflows", "migrate-staging.yml"), encoding="utf-8").read()
        self.assertIn("environment: staging", wf)
        self.assertIn("ypccfyatejejslzlfrbf", wf)


if __name__ == "__main__":
    unittest.main()
