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
    def test_the_union_covers_all_five_tables(self):
        store = InMemoryStore(
            user_films=[{"user_id": "u1", "movie_id": 111, "status": "liked"}],
            watches=[{"user_id": "u1", "movie_id": 222, "windows": ["rental"]}],
            agent_films=[{"user_id": "u1", "cascade_id": "c1", "movie_id": 333}],
            picks=[{"user_id": "u1", "movie_id": 555, "pinned_to": ["c1"]}],
            notifications=[{"user_id": "u1", "cascade_id": "c1", "movie_id": 444, "moment": "arrived"}],
        )
        self.assertEqual(store.fetch_user_held_ids(), {"111", "222", "333", "444", "555"})

    def test_an_admitted_a_pinned_and_a_verdict_film_are_all_held(self):
        """CAS-1097: agent_films stays append-only history now — user_held_ids must still carry an
        agent's own admitted film, a hand-pinned film (film_picks), and a watched/disliked verdict
        (user_films), the three cases this ticket's own AC names explicitly."""
        store = InMemoryStore(
            user_films=[{"user_id": "u1", "movie_id": 111, "status": "disliked"}],
            agent_films=[{"user_id": "u1", "cascade_id": "c1", "movie_id": 222,
                          "admission_score": 80, "admission_status": "stream"}],
            picks=[{"user_id": "u1", "movie_id": 333, "pinned_to": ["c1"], "not_in": []}],
        )
        held = store.fetch_user_held_ids()
        self.assertIn("111", held, "a verdict film must be held")
        self.assertIn("222", held, "an admitted film must be held")
        self.assertIn("333", held, "a pinned film must be held")

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


class FetchNotificationKeysPaging(unittest.TestCase):
    """CAS-1294 AC3: fetch_notification_keys() must page through the whole ledger, not just the
    first server-capped page, or an old key beyond the first 1,000 rows reads as absent and a
    repeat slips past the de-dupe."""

    def test_returns_every_key_when_the_ledger_holds_more_than_1000_rows(self):
        total_rows = 1137
        rows = [{"cascade_id": f"c{i}", "movie_id": i, "moment": "hits_rent"}
                for i in range(total_rows)]

        def fake_urlopen(req, timeout=None):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(req.full_url).query)
            offset = int(qs.get("offset", ["0"])[0])
            page = rows[offset: offset + 1000]
            end = offset + len(page) - 1 if page else offset - 1
            return _FakeResponse(page, content_range=f"{offset}-{end}/{total_rows}")

        store = SupabaseStore("https://example.test.invalid", "fake-key")
        with unittest.mock.patch("monitor.store.urllib.request.urlopen", side_effect=fake_urlopen):
            keys = store.fetch_notification_keys()
        self.assertEqual(len(keys), total_rows)
        self.assertIn((f"c{total_rows - 1}", str(total_rows - 1), "hits_rent"), keys)


class InsertNotificationsIsIdempotent(unittest.TestCase):
    """CAS-1294 AC1: a batch write must never let one row's unique-key conflict take the rest of
    the batch down with it — PostgREST's own `on_conflict` + `resolution=ignore-duplicates` makes
    a duplicate row a silent no-op instead of a 409 for the whole POST."""

    def test_on_conflict_and_ignore_duplicates_are_sent_and_the_call_does_not_raise(self):
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["prefer"] = req.get_header("Prefer")
            return _FakeResponse([])

        store = SupabaseStore("https://example.test.invalid", "fake-key")
        rows = [
            {"user_id": "u1", "cascade_id": "c0", "movie_id": "1255833", "moment": "newly_qualifies",
             "cascade_name": "Cinema movies", "title": "Whalefall"},
            {"user_id": "u1", "cascade_id": "c0", "movie_id": "2", "moment": "hits_rent",
             "cascade_name": "Cinema movies", "title": "B"},
        ]
        with unittest.mock.patch("monitor.store.urllib.request.urlopen", side_effect=fake_urlopen):
            written = store.insert_notifications(rows)
        self.assertEqual(written, 2)
        self.assertIn("on_conflict=cascade_id,movie_id,moment", captured["url"])
        self.assertIn("resolution=ignore-duplicates", captured["prefer"])


if __name__ == "__main__":
    unittest.main()
