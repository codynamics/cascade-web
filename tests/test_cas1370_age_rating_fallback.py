"""CAS-1370 — most titles have no AU classification at all (TMDB only carries one for a title that
had an AU theatrical/digital release), so _tmdb_record now falls back to the US (MPAA) certification,
then GB (BBFC), mapped onto the AU scale the rest of the app filters on. age_rating_src records which
region actually supplied it.

Run: python -m unittest tests.test_cas1370_age_rating_fallback
"""
import unittest

import poc_pipeline as pp


def _detail(au=None, us=None, gb=None):
    """A minimal TMDB /movie/{id} detail payload carrying release_dates for whichever of
    AU/US/GB are passed a certification string."""
    results = []
    if au is not None:
        results.append({"iso_3166_1": "AU", "release_dates": [
            {"type": 3, "release_date": "2026-03-01T00:00:00.000Z", "certification": au}]})
    if us is not None:
        results.append({"iso_3166_1": "US", "release_dates": [
            {"type": 3, "release_date": "2026-02-01T00:00:00.000Z", "certification": us}]})
    if gb is not None:
        results.append({"iso_3166_1": "GB", "release_dates": [
            {"type": 3, "release_date": "2026-02-01T00:00:00.000Z", "certification": gb}]})
    return {"id": 1, "imdb_id": "tt0000001", "title": "Test Film", "release_date": "2026-01-01",
            "genres": [], "production_countries": [], "original_language": "en",
            "release_dates": {"results": results},
            "videos": {"results": []}, "credits": {"cast": [], "crew": []}}


class AgeRatingFallsBackWhenAuHasNone(unittest.TestCase):
    def test_au_certification_wins_and_is_sourced_au(self):
        m = pp._tmdb_record(_detail(au="M", us="R"))
        self.assertEqual(m["age_rating"], "M")
        self.assertEqual(m["age_rating_src"], "AU")

    def test_no_au_falls_back_to_us_mapped_onto_the_au_scale(self):
        m = pp._tmdb_record(_detail(us="R"))
        self.assertEqual(m["age_rating"], "MA 15+")
        self.assertEqual(m["age_rating_src"], "US")

    def test_no_au_or_us_falls_back_to_gb_mapped_onto_the_au_scale(self):
        m = pp._tmdb_record(_detail(gb="15"))
        self.assertEqual(m["age_rating"], "MA 15+")
        self.assertEqual(m["age_rating_src"], "GB")

    def test_us_is_tried_before_gb(self):
        m = pp._tmdb_record(_detail(us="PG-13", gb="18"))
        self.assertEqual(m["age_rating"], "M")
        self.assertEqual(m["age_rating_src"], "US")

    def test_no_certification_anywhere_leaves_both_fields_none(self):
        m = pp._tmdb_record(_detail())
        self.assertIsNone(m["age_rating"])
        self.assertIsNone(m["age_rating_src"])

    def test_every_us_mapping(self):
        expected = {"G": "G", "PG": "PG", "PG-13": "M", "R": "MA 15+", "NC-17": "R 18+"}
        for us, want in expected.items():
            with self.subTest(us=us):
                self.assertEqual(pp._tmdb_record(_detail(us=us))["age_rating"], want)

    def test_every_gb_mapping(self):
        expected = {"U": "G", "PG": "PG", "12": "M", "12A": "M", "15": "MA 15+", "18": "R 18+"}
        for gb, want in expected.items():
            with self.subTest(gb=gb):
                self.assertEqual(pp._tmdb_record(_detail(gb=gb))["age_rating"], want)


if __name__ == "__main__":
    unittest.main()
