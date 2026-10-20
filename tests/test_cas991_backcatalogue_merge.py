"""CAS-991 — folding CAS-989's state/wm_backcatalogue_candidates.json (keyed on Watchmode id) into
CANDIDATES_FILE / candidates.json (keyed on tmdb_id). Before this, an enumerate run wrote a file
nothing consumed.
"""
import json
import os
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp


def _backcat_row(tmdb_id, wm_id=1, title="T", year=2020, popularity_percentile=50):
    return {"id": wm_id, "tmdb_id": tmdb_id, "title": title, "year": year,
            "popularity_percentile": popularity_percentile}


class MergeBackcatalogueCandidatesTestCase(unittest.TestCase):
    def _write(self, tmp, rows):
        path = os.path.join(tmp, "wm_backcatalogue_candidates.json")
        json.dump(rows, open(path, "w", encoding="utf-8"))
        return path

    def test_new_titles_enter_as_unprobed_and_known_ones_are_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [
                _backcat_row(1, wm_id=101), _backcat_row(2, wm_id=102),
                _backcat_row(3, wm_id=103), _backcat_row(4, wm_id=104),
                _backcat_row(5, wm_id=105),
            ]
            path = self._write(tmp, rows)
            already_1 = {"tmdb_id": 1, "title": "Already", "year": 1999,
                         "first_seen": "2026-01-01", "last_probed": "2026-06-01",
                         "probe_count": 3, "outcome": "scored", "wm_user_rating": 80}
            already_2 = {"tmdb_id": 2, "title": "Already Two", "year": 2001,
                         "first_seen": "2026-02-02", "last_probed": None,
                         "probe_count": 0, "outcome": "unprobed"}
            candidates = {"1": dict(already_1), "2": dict(already_2)}

            stats = pp.merge_backcatalogue_candidates(candidates, "2026-09-15", path=path)

            self.assertEqual(stats, {"merged": 3, "already_known": 2, "no_tmdb_id": 0})
            self.assertEqual(candidates["1"], already_1)
            self.assertEqual(candidates["2"], already_2)
            for tid in (3, 4, 5):
                rec = candidates[str(tid)]
                self.assertEqual(rec["outcome"], "unprobed")
                self.assertEqual(rec["tmdb_id"], tid)
                self.assertEqual(rec["first_seen"], "2026-09-15")
                self.assertIsNone(rec["last_probed"])
                self.assertEqual(rec["probe_count"], 0)
                self.assertEqual(rec["popularity_percentile"], 50)

    def test_year_is_written_as_a_string_not_the_raw_watchmode_int(self):
        # CAS-1026: this merge path wrote row.get("year") verbatim — a raw int from Watchmode's
        # /list-titles — while the other two ingestion paths both normalise to a string. An int
        # year with no cinema_date crashes index.html#engine's yearOf() at .slice().
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, [_backcat_row(1, year=2018)])
            candidates = {}
            pp.merge_backcatalogue_candidates(candidates, "2026-09-15", path=path)
            self.assertEqual(candidates["1"]["year"], "2018")
            self.assertIsInstance(candidates["1"]["year"], str)

    def test_a_missing_year_falls_back_to_the_placeholder_string(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._write(tmp, [_backcat_row(1, year=None)])
            candidates = {}
            pp.merge_backcatalogue_candidates(candidates, "2026-09-15", path=path)
            self.assertEqual(candidates["1"]["year"], "----")

    def test_an_entry_with_no_tmdb_id_is_skipped_and_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [_backcat_row(10), {"id": 999, "title": "No tmdb id", "year": 2020,
                                        "popularity_percentile": 5}]
            path = self._write(tmp, rows)
            candidates = {}
            stats = pp.merge_backcatalogue_candidates(candidates, "2026-09-15", path=path)
            self.assertEqual(stats, {"merged": 1, "already_known": 0, "no_tmdb_id": 1})
            self.assertEqual(set(candidates), {"10"})

    def test_running_twice_in_succession_adds_nothing_the_second_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [_backcat_row(1), _backcat_row(2)]
            path = self._write(tmp, rows)
            candidates = {}
            pp.merge_backcatalogue_candidates(candidates, "2026-09-15", path=path)
            stats = pp.merge_backcatalogue_candidates(candidates, "2026-09-16", path=path)
            self.assertEqual(stats, {"merged": 0, "already_known": 2, "no_tmdb_id": 0})

    def test_absent_file_completes_normally_and_says_so(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "does-not-exist.json")
            candidates = {}
            stats = pp.merge_backcatalogue_candidates(candidates, "2026-09-15", path=path)
            self.assertEqual(stats, {"merged": 0, "already_known": 0, "no_tmdb_id": 0})
            self.assertEqual(candidates, {})

    def test_makes_no_network_calls(self):
        def _never_call(*args, **kwargs):
            raise AssertionError("merge_backcatalogue_candidates must not call the network")

        with tempfile.TemporaryDirectory() as tmp:
            rows = [_backcat_row(1), _backcat_row(2)]
            path = self._write(tmp, rows)
            with mock.patch.object(pp, "get_json", _never_call):
                pp.merge_backcatalogue_candidates({}, "2026-09-15", path=path)

    def test_prints_all_three_figures(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [_backcat_row(1), {"id": 2, "title": "no id", "year": 2020,
                                       "popularity_percentile": 1}]
            path = self._write(tmp, rows)
            candidates = {"1": {"tmdb_id": 1, "outcome": "scored", "first_seen": "2026-01-01",
                                 "last_probed": None, "probe_count": 0}}
            with mock.patch("builtins.print") as mock_print:
                pp.merge_backcatalogue_candidates(candidates, "2026-09-15", path=path)
            printed = " ".join(str(c.args[0]) for c in mock_print.call_args_list)
            self.assertIn("backcat_merged=0", printed)
            self.assertIn("already_known=1", printed)
            self.assertIn("no_tmdb_id=1", printed)

    def test_absent_file_prints_the_reason(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "does-not-exist.json")
            with mock.patch("builtins.print") as mock_print:
                pp.merge_backcatalogue_candidates({}, "2026-09-15", path=path)
            printed = " ".join(str(c.args[0]) for c in mock_print.call_args_list)
            self.assertIn("absent", printed)


class ApplyTwoTierPublicationCallsBackcatalogueMergeTestCase(unittest.TestCase):
    """The merge step runs as part of CAS-986's own top-level nightly step, before the probe
    tiers, per CAS-991's build requirement."""

    def test_merge_backcatalogue_candidates_is_called_before_the_probe(self):
        order = []

        def fake_merge_backcat(candidates, today_iso, path=None):
            order.append("merge_backcatalogue")
            return {"merged": 0, "already_known": 0, "no_tmdb_id": 0}

        def fake_run_probe(candidates, today, budget, published_ids, **_kwargs):
            order.append("probe")
            return {"ok": 0, "cached": 0, "no-id": 0, "skip": 0, "stop": 0, "probed": 0, "spent": 0}

        with mock.patch.object(pp, "merge_backcatalogue_candidates", fake_merge_backcat), \
             mock.patch.object(pp, "run_scoreability_probe", fake_run_probe), \
             mock.patch.object(pp, "scoreable_ids", return_value=set()), \
             mock.patch.object(pp, "load_user_held_ids", return_value=set()):
            import datetime
            pp.apply_two_tier_publication({}, datetime.date(2026, 9, 15), [], [], set())

        self.assertEqual(order, ["merge_backcatalogue", "probe"])


if __name__ == "__main__":
    unittest.main()
