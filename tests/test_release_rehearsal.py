import importlib.util, json, os, subprocess, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("rehearsal", os.path.join(ROOT, "ci", "rehearsal.py"))
rh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rh)


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


class Split(unittest.TestCase):
    def test_extra_is_candidate_minus_main(self):
        main_list, extra = rh.split(["0002_b.sql", "0001_a.sql", "README.md"],
                                    ["0001_a.sql", "0002_b.sql", "0004_d.sql", "0003_c.sql", "notes.txt"])
        self.assertEqual(main_list, ["0001_a.sql", "0002_b.sql"])
        self.assertEqual(extra, ["0003_c.sql", "0004_d.sql"])

    def test_identical_lists_have_no_extra(self):
        self.assertEqual(rh.split(["0001_a.sql"], ["0001_a.sql"])[1], [])

    def test_split_is_computed_from_two_commits_file_lists(self):
        with tempfile.TemporaryDirectory() as d:
            git(d, "init", "-q")
            mig = os.path.join(d, "supabase", "migrations")
            os.makedirs(mig)
            for n in ("0001_a.sql", "0002_b.sql"):
                open(os.path.join(mig, n), "w").write("select 1;")
            git(d, "add", "-A"); git(d, "commit", "-qm", "main")
            git(d, "tag", "m")
            open(os.path.join(mig, "0003_c.sql"), "w").write("select 1;")
            git(d, "add", "-A"); git(d, "commit", "-qm", "cand")
            cwd = os.getcwd()
            os.chdir(d)
            try:
                main_files, cand_files = rh.migration_files("m"), rh.migration_files("HEAD")
            finally:
                os.chdir(cwd)
            self.assertEqual(rh.split(main_files, cand_files), (["0001_a.sql", "0002_b.sql"], ["0003_c.sql"]))


class Counts(unittest.TestCase):
    def test_diff(self):
        self.assertEqual(rh.diff({"a": 1, "b": 2}, {"a": 1, "b": 3}), {"b": (2, 3)})
        self.assertEqual(rh.diff({"a": 1}, {"a": 1}), {})

    def test_production_refused(self):
        with self.assertRaises(SystemExit):
            rh.counts("postgresql://x@db.ypccfyatejejslzlfrbf.supabase.co/postgres")


try:
    import yaml
except ImportError:
    yaml = None


@unittest.skipIf(yaml is None, 'pyyaml not installed')
class Workflow(unittest.TestCase):
    def test_only_workflow_dispatch(self):
        wf = yaml.safe_load(open(os.path.join(ROOT, ".github", "workflows", "release-rehearsal.yml"), encoding="utf-8"))
        on = wf.get("on", wf.get(True))
        self.assertEqual(list(on), ["workflow_dispatch"])
        self.assertIn("candidate", on["workflow_dispatch"]["inputs"])


if __name__ == "__main__":
    unittest.main()
