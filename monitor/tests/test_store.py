"""CAS-986: fetch_user_held_ids() — the two-tier catalogue's demotion-safety net. Every tmdb_id a
user holds state on, across four tables, as a set of strings ready to be sorted straight into
state/user_held_ids.json.

CAS-1091: SupabaseStore._get() pages through every result rather than trusting PostgREST's
unpaged default, which silently truncates at the project's max-rows setting.

Run:  python -m unittest monitor.tests.test_store   (from the repo root)
"""
import json
import unittest
import unittest.mock
import urllib.parse

from monitor.store import InMemoryStore, SupabaseStore


class FetchUserHeldIds(unittest.TestCase):
    def test_the_union_covers_all_four_tables(self):
        store = InMemoryStore(
            user_films=[{"user_id": "u1", "movie_id": 111, "status": "liked"}],
            watches=[{"user_id": "u1", "movie_id": 222, "windows": ["rental"]}],
            agent_films=[{"user_id": "u1", "cascade_id": "c1", "movie_id": 333}],
            notifications=[{"user_id": "u1", "cascade_id": "c1", "movie_id": 444, "moment": "arrived"}],
        )
        self.assertEqual(store.fetch_user_held_ids(), {"111", "222", "333", "444"})

    def test_a_shared_id_across_tables_is_not_duplicated(self):
        store = InMemoryStore(
            user_films=[{"user_id": "u1", "movie_id": 111, "status": "liked"}],
            agent_films=[{"user_id": "u2", "cascade_id": "c1", "movie_id": 111}],
        )
        self.assertEqual(store.fetch_user_held_ids(), {"111"})

    def test_ids_are_returned_as_strings_regardless_of_source_type(self):
        store = InMemoryStore(user_films=[{"user_id": "u1", "movie_id": "999", "status": "liked"}],
                              watches=[{"user_id": "u1", "movie_id": 999, "windows": []}])
        self.assertEqual(store.fetch_user_held_ids(), {"999"})

    def test_a_row_with_no_movie_id_is_ignored_not_stringified_to_none(self):
        store = InMemoryStore(notifications=[{"user_id": "u1", "cascade_id": None, "moment": "x"}])
        self.assertEqual(store.fetch_user_held_ids(), set())

    def test_nothing_held_anywhere_is_an_empty_set_not_an_error(self):
        store = InMemoryStore()
        self.assertEqual(store.fetch_user_held_ids(), set())


class _FakeResponse:
    """Minimal stand-in for the object urllib.request.urlopen() hands back as a context manager."""

    def __init__(self, rows, content_range=None):
        self._body = json.dumps(rows).encode("utf-8")
        self.headers = {"Content-Range": content_range} if content_range else {}

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


class SupabaseStoreGetPagesEveryResult(unittest.TestCase):
    """CAS-1091: a fake HTTP layer serving rows in server-capped pages of 1,000 — smaller than
    _get's own requested limit, so a page only ever comes up short because the server capped it,
    the same shape a real max-rows setting produces."""

    def _fake_store(self, total_rows: int, server_page_size: int):
        rows = [{"id": i} for i in range(total_rows)]
        requests = []

        def fake_urlopen(req, timeout=None):
            requests.append(req.full_url)
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(req.full_url).query)
            offset = int(qs.get("offset", ["0"])[0])
            page = rows[offset: offset + server_page_size]
            end = offset + len(page) - 1 if page else offset - 1
            content_range = f"{offset}-{end}/{total_rows}"
            return _FakeResponse(page, content_range=content_range)

        store = SupabaseStore("https://example.test.invalid", "fake-key")
        patcher = unittest.mock.patch("monitor.store.urllib.request.urlopen", side_effect=fake_urlopen)
        return store, requests, patcher

    def test_2037_rows_in_pages_of_1000_come_back_whole_in_3_requests(self):
        store, requests, patcher = self._fake_store(total_rows=2037, server_page_size=1000)
        with patcher:
            result = store._get("/widgets?select=*&order=id.asc")
        self.assertEqual(len(result), 2037)
        self.assertEqual([r["id"] for r in result], list(range(2037)))
        self.assertEqual(len(requests), 3)
        for url in requests:
            self.assertIn("order=", url)

    def test_a_row_count_under_one_page_needs_one_request(self):
        store, requests, patcher = self._fake_store(total_rows=37, server_page_size=1000)
        with patcher:
            result = store._get("/widgets?select=*&order=id.asc")
        self.assertEqual(len(result), 37)
        self.assertEqual(len(requests), 1)

    def test_missing_order_is_refused_rather_than_fetched_unpaged(self):
        store, _requests, patcher = self._fake_store(total_rows=1, server_page_size=1000)
        with patcher:
            with self.assertRaises(ValueError):
                store._get("/widgets?select=*")


if __name__ == "__main__":
    unittest.main()
