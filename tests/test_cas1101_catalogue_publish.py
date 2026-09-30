"""CAS-1101 — pipeline publishes a compact content-hashed catalogue file plus a pointer,
alongside the inlined index.html data (which is unchanged).

BUILD MODE: INDICATIVE, no design image — deliberate, this is a pipeline/data change with no
visual surface. Asserts: the pointer's hash matches the file's own SHA-256 prefix, the file
parses, its film count equals movies.json's, none of the dropped fields survive, every field
app_template.html reads via `m.<field>` that also exists in movies.json is kept, old hashed
files are pruned to just the current + previous, and the real catalogue stays under 8 MB.
"""
import hashlib
import json
import os
import re
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_TEMPLATE = os.path.join(REPO_ROOT, "app_template.html")


def _app_read_fields():
    with open(APP_TEMPLATE, encoding="utf-8") as f:
        src = f.read()
    return {m.group(1) for m in re.finditer(r"\bm\.([a-zA-Z_][a-zA-Z0-9_]*)\b", src)}


class CataloguePublish(unittest.TestCase):
    def setUp(self):
        with open(pp.OUTPUT_FILE, encoding="utf-8") as f:
            self.movies = json.load(f)["movies"]
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        catalogue_dir = os.path.join(self.tmp.name, "catalogue")
        pointer_file = os.path.join(self.tmp.name, "catalogue.json")
        for p in [mock.patch.object(pp, "CATALOGUE_DIR", catalogue_dir),
                  mock.patch.object(pp, "CATALOGUE_POINTER", pointer_file)]:
            p.start(); self.addCleanup(p.stop)

    def _pointer(self):
        with open(pp.CATALOGUE_POINTER, encoding="utf-8") as f:
            return json.load(f)

    def _films(self, pointer):
        with open(os.path.join(self.tmp.name, pointer["file"]), encoding="utf-8") as f:
            return json.load(f)

    def test_pointer_hash_matches_file_and_it_parses(self):
        pp.write_catalogue(self.movies, "2026-09-29")
        pointer = self._pointer()
        with open(os.path.join(self.tmp.name, pointer["file"]), "rb") as f:
            raw = f.read()
        self.assertEqual(pointer["hash"], hashlib.sha256(raw).hexdigest()[:12])
        films = json.loads(raw)
        self.assertEqual(len(films), len(self.movies))
        self.assertEqual(pointer["count"], len(self.movies))
        self.assertEqual(pointer["generated"], "2026-09-29")

    def test_dropped_fields_never_appear(self):
        pp.write_catalogue(self.movies, "2026-09-29")
        films = self._films(self._pointer())
        for film in films:
            for dropped in pp.CATALOGUE_DROPPED_FIELDS:
                self.assertNotIn(dropped, film)

    def test_no_app_read_field_is_among_the_dropped(self):
        # A field the app reads that also exists in movies.json must never collide with the
        # drop list, or it would silently vanish from every record that carries it.
        read_fields = _app_read_fields()
        movies_fields = set()
        for m in self.movies:
            movies_fields.update(m.keys())
        required = read_fields & movies_fields
        self.assertTrue(required, "expected at least one app-read field to exist in movies.json")
        collision = required & set(pp.CATALOGUE_DROPPED_FIELDS)
        self.assertEqual(collision, set(), f"app_template.html reads dropped field(s): {collision}")

    def test_trim_keeps_every_field_except_the_dropped_ones(self):
        # Fields are sparse (e.g. award_text only exists on award-winning titles) — the real
        # invariant is that trimming removes nothing but CATALOGUE_DROPPED_FIELDS per record.
        pp.write_catalogue(self.movies, "2026-09-29")
        films = self._films(self._pointer())
        for original, trimmed in zip(self.movies, films):
            self.assertEqual(set(trimmed.keys()),
                              set(original.keys()) - set(pp.CATALOGUE_DROPPED_FIELDS))

    def test_old_hashed_files_pruned_to_current_and_previous(self):
        pp.write_catalogue(self.movies[:5], "2026-09-27")
        first = self._pointer()["file"]
        pp.write_catalogue(self.movies[:6], "2026-09-28")
        second = self._pointer()["file"]
        pp.write_catalogue(self.movies[:7], "2026-09-29")
        third = self._pointer()["file"]

        remaining = set(os.listdir(pp.CATALOGUE_DIR))
        self.assertNotIn(os.path.basename(first), remaining)
        self.assertIn(os.path.basename(second), remaining)
        self.assertIn(os.path.basename(third), remaining)
        self.assertEqual(len(remaining), 2)

    def test_real_catalogue_file_is_under_8mb(self):
        pp.write_catalogue(self.movies, "2026-09-29")
        pointer = self._pointer()
        size = os.path.getsize(os.path.join(self.tmp.name, pointer["file"]))
        self.assertLess(size, 8 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
