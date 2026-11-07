"""CAS-1381 — _tmdb_record keeps TMDB's belongs_to_collection (franchise/series) id/name, so a
later ticket can list and link the films in a series. Only id/name are kept (never poster/backdrop
path), and the field must survive the same write path that produces movies.json.

Run: python -m unittest tests.test_cas1381_tmdb_collection
"""
import json
import os
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp


def _detail(belongs_to_collection=...):
    """A minimal TMDB /movie/{id} detail payload. `belongs_to_collection` defaults to omitted
    entirely (the ... sentinel); pass None or a dict to set it explicitly."""
    detail = {"id": 1, "imdb_id": "tt0000001", "title": "Test Film", "release_date": "2026-01-01",
              "genres": [], "production_countries": [], "original_language": "en",
              "release_dates": {"results": []},
              "videos": {"results": []}, "credits": {"cast": [], "crew": []}}
    if belongs_to_collection is not ...:
        detail["belongs_to_collection"] = belongs_to_collection
    return detail


class TmdbRecordKeepsCollection(unittest.TestCase):
    def test_collection_dict_keeps_only_id_and_name(self):
        m = pp._tmdb_record(_detail({"id": 10, "name": "Star Wars Collection",
                                      "poster_path": "/x.jpg", "backdrop_path": "/y.jpg"}))
        self.assertEqual(m["collection"], {"id": 10, "name": "Star Wars Collection"})

    def test_null_collection_gives_none(self):
        m = pp._tmdb_record(_detail(None))
        self.assertIsNone(m["collection"])

    def test_missing_key_gives_none(self):
        m = pp._tmdb_record(_detail())
        self.assertIsNone(m["collection"])


class CollectionSurvivesCataloguePublish(unittest.TestCase):
    """Guards against the field being stripped by write_catalogue's CATALOGUE_DROPPED_FIELDS,
    the one allow/strip-list on the path from a record to the built index.html catalogue."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        catalogue_dir = os.path.join(self.tmp.name, "catalogue")
        pointer_file = os.path.join(self.tmp.name, "catalogue.json")
        for p in [mock.patch.object(pp, "CATALOGUE_DIR", catalogue_dir),
                  mock.patch.object(pp, "CATALOGUE_POINTER", pointer_file)]:
            p.start(); self.addCleanup(p.stop)

    def test_collection_value_present_after_write_catalogue(self):
        record = {"tmdb_id": 1, "title": "Test Film", "year": "2026",
                  "collection": {"id": 10, "name": "Star Wars Collection"}}
        pp.write_catalogue([record], "2026-11-07")
        with open(pp.CATALOGUE_POINTER, encoding="utf-8") as f:
            pointer = json.load(f)
        with open(os.path.join(self.tmp.name, pointer["file"]), encoding="utf-8") as f:
            films = json.load(f)
        self.assertEqual(films[0]["collection"], {"id": 10, "name": "Star Wars Collection"})


if __name__ == "__main__":
    unittest.main()
