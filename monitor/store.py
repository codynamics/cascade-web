"""Data access for the monitor (CAS-85 / spec 26771457 §5, §7).

Two stores behind one small interface:

  · InMemoryStore  — for --dry-run and unit tests; no network, no keys.
  · SupabaseStore  — the real thing, talking to PostgREST with the **service_role** key
                     (which bypasses RLS: the daily job is the only writer of `notifications`
                     and the only reader of every user's `cascades`). Dependency-free — plain
                     urllib, same as poc_pipeline — so the Action needs nothing extra installed.

Interface:
  fetch_active_cascades() -> list[cascade row]
  fetch_notification_keys() -> set[(cascade_id, movie_id, moment)]   # for de-dupe
  insert_notifications(rows) -> int                                  # ledger write; returns count
  fetch_user_email(user_id) -> str | None
  fetch_notify_prefs() -> {user_id: {in_app, email_on, email_address, excluded_moments}}  # CAS-185
  fetch_picks() -> [{user_id, movie_id, state, pinned_to, not_in}]                # CAS-185/CAS-925
  fetch_push_tokens() -> {user_id: [device_token, ...]}                                   # CAS-465
  fetch_unread_counts() -> {user_id: int}                                                 # CAS-465
  fetch_film_watches() -> [{user_id, movie_id, windows, sources}]                # CAS-484/CAS-918
  fetch_watch_notification_keys() -> set[(user_id, movie_id, moment)]  # de-dupe, null-cascade rows
  delete_notifications_for_movie_ids(ids) -> int          # CAS-486: fixture-range-only, for notify-test
  upsert_film_watch(user_id, movie_id, window) -> None    # CAS-1052: notify-test's guaranteed-match tick
  delete_film_watch_for_movie_ids(ids) -> int             # CAS-1052: fixture-range-only, for notify-test
  fetch_user_prefs() -> {user_id: {sub_services, store_services, taste, services_only}}    # CAS-825/CAS-853
  fetch_user_films() -> [{user_id, movie_id, status}]                                      # CAS-825
  fetch_user_held_ids() -> set[str]  # every tmdb_id a user holds state on                  # CAS-986
  fetch_unsent_contact_messages() -> [contact_messages row, sent_at is null]                # CAS-836
  mark_contact_messages_sent(ids, sent_at) -> int                                           # CAS-836
  sign_attachment_url(path) -> signed URL string | None                                     # CAS-864
  fetch_unsent_recommendations() -> [recommendations row, sent_at is null]                  # CAS-884
  mark_recommendations_sent(ids, sent_at) -> int                                            # CAS-884
  fetch_recent_sent_recommendations(since) -> [{sender_id, to_email, sent_at}, sent_at >= since]  # CAS-1131
  fetch_undigested_invite_replies() -> [{id, token, sender_id, to_name, film_title, tmdb_id,
                                          answer, created_at}, digested_at is null]          # CAS-887
  mark_invite_replies_digested(ids, digested_at) -> int                                      # CAS-887
  fetch_unsent_invite_emails() -> [{id, token, to_email, to_name, created_at, sender_name,
                                     film_title, tmdb_id}, sent_at is null]                   # CAS-930
  mark_invite_emails_sent(ids, sent_at) -> int                                                # CAS-930
  fetch_unnotified_invite_replies() -> [{id, token, sender_id, to_name, film_title, tmdb_id,
                                          answer, created_at}, notified_at is null]           # CAS-967
  mark_invite_replies_notified(ids, notified_at) -> int                                       # CAS-967
  delete_old_usage_events(days=180) -> int              # CAS-942: usage_events retention purge
  fetch_view(view_name) -> list                # every row, select=* (CAS-1021: metrics_report.py)
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request

SUPABASE_URL_ENV = "SUPABASE_URL"
SERVICE_KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY"

# CAS-864: the private bucket contact_messages.attachment_path points into. Fixed, not
# configurable — supabase/schema.sql creates exactly this bucket by hand-applied SQL.
CONTACT_ATTACHMENTS_BUCKET = "contact-attachments"
CONTACT_ATTACHMENT_SIGNED_URL_EXPIRES_IN = 7 * 24 * 3600  # 7 days, per the ticket

# CAS-486: the reserved tmdb_id range for the notify-test harness's fixture films (see
# tests/fixtures/notify-films.json). Hard-coded here, not read from any workflow input, so
# delete_notifications_for_movie_ids below can never be widened to touch a real movie_id no
# matter what a caller passes it.
FIXTURE_ID_MIN = 999000001
FIXTURE_ID_MAX = 999000999


def _fixture_ids_only(movie_ids) -> list:
    out = []
    for i in movie_ids:
        try:
            n = int(i)
        except (TypeError, ValueError):
            continue
        if FIXTURE_ID_MIN <= n <= FIXTURE_ID_MAX:
            out.append(str(n))
    return out


class InMemoryStore:
    """A store backed by plain Python lists — used for dry-run and tests."""

    def __init__(self, cascades=None, notifications=None, emails=None, prefs=None, picks=None,
                 push_tokens=None, watches=None, user_prefs=None, user_films=None,
                 contact_messages=None, recommendations=None, invite_replies=None,
                 invite_emails=None, agent_films=None):
        self._cascades = list(cascades or [])
        self._notifications = list(notifications or [])
        self._emails = dict(emails or {})
        self._prefs = dict(prefs or {})
        self._picks = list(picks or [])
        self._push_tokens = list(push_tokens or [])
        self._watches = list(watches or [])
        self._user_prefs = dict(user_prefs or {})
        self._user_films = list(user_films or [])
        self._contact_messages = [dict(r) for r in (contact_messages or [])]
        self._recommendations = [dict(r) for r in (recommendations or [])]
        self._invite_replies = [dict(r) for r in (invite_replies or [])]
        self._invite_emails = [dict(r) for r in (invite_emails or [])]
        self._agent_films = list(agent_films or [])

    def fetch_active_cascades(self) -> list:
        return [c for c in self._cascades if c.get("active", True)]

    def fetch_notification_keys(self) -> set:
        return {(n.get("cascade_id"), str(n.get("movie_id")), n.get("moment"))
                for n in self._notifications}

    def insert_notifications(self, rows) -> int:
        self._notifications.extend(rows)
        return len(rows)

    def fetch_user_email(self, user_id: str):
        return self._emails.get(user_id)

    def fetch_notify_prefs(self) -> dict:
        return dict(self._prefs)

    def fetch_picks(self) -> list:
        return list(self._picks)

    def fetch_push_tokens(self) -> dict:
        out: dict = {}
        for r in self._push_tokens:
            out.setdefault(str(r.get("user_id")), []).append(r.get("device_token"))
        return out

    def fetch_unread_counts(self) -> dict:
        out: dict = {}
        for n in self._notifications:
            if n.get("read_at"):
                continue
            uid = str(n.get("user_id"))
            out[uid] = out.get(uid, 0) + 1
        return out

    def fetch_film_watches(self) -> list:
        return list(self._watches)

    def fetch_watch_notification_keys(self) -> set:
        return {(str(n.get("user_id")), str(n.get("movie_id")), n.get("moment"))
                for n in self._notifications if n.get("cascade_id") is None}

    def delete_notifications_for_movie_ids(self, movie_ids) -> int:
        """CAS-486: repeatability for the notify-test harness — a fixture scenario must be able
        to run again immediately, which means the previous run's ledger rows for those SAME
        fixture films need to be gone first. `movie_ids` is re-filtered to the reserved fixture
        range here, independently of whatever the caller already checked, so this can never
        delete a real notification even if a future caller forgets its own check."""
        ids = set(_fixture_ids_only(movie_ids))
        if not ids:
            return 0
        before = len(self._notifications)
        self._notifications = [n for n in self._notifications if str(n.get("movie_id")) not in ids]
        return before - len(self._notifications)

    def upsert_film_watch(self, user_id, movie_id, window: str) -> None:
        """CAS-1052: write (or overwrite) ONE film_watch row keyed on (user_id, movie_id), same
        upsert semantics as the real table's primary key — a second arm for the same user/fixture
        film replaces the previous tick rather than duplicating it."""
        key = (str(user_id), str(movie_id))
        for w in self._watches:
            if (str(w.get("user_id")), str(w.get("movie_id"))) == key:
                w["windows"] = [window]
                w["sources"] = {window: "manual"}
                return
        self._watches.append({"user_id": user_id, "movie_id": str(movie_id), "windows": [window],
                              "sources": {window: "manual"}})

    def delete_film_watch_for_movie_ids(self, movie_ids) -> int:
        """CAS-1052: teardown for notify-test's temporary Watch-it tick — same fixture-range guard
        as delete_notifications_for_movie_ids, so this can never remove a real per-film tick."""
        ids = set(_fixture_ids_only(movie_ids))
        if not ids:
            return 0
        before = len(self._watches)
        self._watches = [w for w in self._watches if str(w.get("movie_id")) not in ids]
        return before - len(self._watches)

    def fetch_user_prefs(self) -> dict:
        return dict(self._user_prefs)

    def fetch_user_films(self) -> list:
        return list(self._user_films)

    def fetch_user_held_ids(self) -> set:
        """CAS-986: every tmdb_id a user holds state on — a watched opinion (user_films), a
        per-film Watch-it tick (film_watch), an agent's own admitted film (agent_films), or a
        notification ever sent about it. The two-tier catalogue's demotion-safety net: the monitor
        writes this union to state/user_held_ids.json at the end of every run so the nightly
        pipeline can never orphan a film a user marked watched or pinned."""
        out: set = set()
        for rows in (self._user_films, self._watches, self._agent_films, self._notifications):
            out |= {str(r.get("movie_id")) for r in rows if r.get("movie_id") is not None}
        return out

    def fetch_unsent_contact_messages(self) -> list:
        return [dict(r) for r in self._contact_messages if not r.get("sent_at")]

    def mark_contact_messages_sent(self, ids, sent_at) -> int:
        ids = set(ids)
        n = 0
        for r in self._contact_messages:
            if r.get("id") in ids:
                r["sent_at"] = sent_at
                n += 1
        return n

    def sign_attachment_url(self, path):
        """No network — a deterministic fake URL, good enough for --dry-run and unit tests."""
        if not path:
            return None
        return f"https://fake-signed.example.test/{CONTACT_ATTACHMENTS_BUCKET}/{path}"

    def fetch_unsent_recommendations(self) -> list:
        return [dict(r) for r in self._recommendations if not r.get("sent_at")]

    def mark_recommendations_sent(self, ids, sent_at) -> int:
        ids = set(ids)
        n = 0
        for r in self._recommendations:
            if r.get("id") in ids:
                r["sent_at"] = sent_at
                n += 1
        return n

    def fetch_recent_sent_recommendations(self, since) -> list:
        """Every recommendations row already emailed on/after `since` (CAS-1131) — lets a caller
        fold a newly-queued duplicate (same sender/address) into a no-op stamp instead of a second
        email within the cooldown window."""
        return [dict(r) for r in self._recommendations if r.get("sent_at") and r["sent_at"] >= since]

    def fetch_undigested_invite_replies(self) -> list:
        return [dict(r) for r in self._invite_replies if not r.get("digested_at")]

    def mark_invite_replies_digested(self, ids, digested_at) -> int:
        """Stamps `digested_at`, never `seen_at` — item 5 (CAS-887): that column stays the app's
        alone, so a digest run can never clear a badge the recipient never saw."""
        ids = set(ids)
        n = 0
        for r in self._invite_replies:
            if r.get("id") in ids:
                r["digested_at"] = digested_at
                n += 1
        return n

    def fetch_unsent_invite_emails(self) -> list:
        """CAS-930: unlike SupabaseStore below, no join here — a fixture/test row is trusted to
        already carry the film/sender context flattened in, the same convention __main__.py's
        --replies fixture flag already follows for fetch_undigested_invite_replies."""
        return [dict(r) for r in self._invite_emails if not r.get("sent_at")]

    def mark_invite_emails_sent(self, ids, sent_at) -> int:
        ids = set(ids)
        n = 0
        for r in self._invite_emails:
            if r.get("id") in ids:
                r["sent_at"] = sent_at
                n += 1
        return n

    def fetch_unnotified_invite_replies(self) -> list:
        """CAS-967: like fetch_unsent_invite_emails above, no join here — a fixture/test row is
        trusted to already carry the sender_id/film/to_name context flattened in."""
        return [dict(r) for r in self._invite_replies if not r.get("notified_at")]

    def mark_invite_replies_notified(self, ids, notified_at) -> int:
        """Stamps `notified_at` only, never `seen_at` or `digested_at` — item 4 (CAS-967): the
        same-day email, the app's own read marker, and the next-morning digest are three
        independent things and none of them may set another."""
        ids = set(ids)
        n = 0
        for r in self._invite_replies:
            if r.get("id") in ids:
                r["notified_at"] = notified_at
                n += 1
        return n

    def delete_old_usage_events(self, days: int = 180) -> int:
        """CAS-942: fixtures/tests carry no usage_events data — nothing to purge, always 0."""
        return 0


class SupabaseStore:
    """PostgREST access with the service_role key. Never constructed without a URL + key."""

    def __init__(self, url: str, service_key: str, timeout: int = 30):
        self._base = url.rstrip("/") + "/rest/v1"
        self._key = service_key
        self._timeout = timeout

    def _headers(self, extra=None) -> dict:
        h = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    # Deliberately far above any plausible PostgREST max-rows setting, so a server-side cap is
    # always what actually bounds a page, never this number.
    _PAGE_REQUEST_LIMIT = 10_000

    def _get(self, path: str) -> list:
        """Pages through every row with limit+offset until the response's own row count says
        there's nothing left, so a server-side row cap (PostgREST's max-rows — CAS-1091) can
        never silently truncate a read. A page coming back shorter than requested does NOT by
        itself prove the end — that's exactly what an unlucky max-rows cap looks like too — so
        `_get` asks PostgREST for the true total (`Prefer: count=exact`, read back off the
        `Content-Range` response header) and stops once it has fetched that many rows, rather
        than guessing from page shape.
        `path` must already carry a stable `order` (the table's primary key, or the primary key
        appended as a tie-breaker) — PostgREST does not guarantee row order across paged requests
        otherwise, so paging on an unordered result could skip or repeat rows."""
        if "order=" not in path:
            raise ValueError(f"_get requires an explicit order for stable paging: {path}")
        sep = "&" if "?" in path else "?"
        table = path.lstrip("/").split("?", 1)[0]
        out: list = []
        offset = 0
        total = None
        while True:
            page_path = f"{path}{sep}limit={self._PAGE_REQUEST_LIMIT}&offset={offset}"
            req = urllib.request.Request(
                self._base + page_path,
                headers=self._headers({"Prefer": "count=exact"}),
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                page = json.loads(resp.read().decode("utf-8"))
                content_range = resp.headers.get("Content-Range")
            out.extend(page)
            offset += len(page)
            if content_range:
                total_part = content_range.rsplit("/", 1)[-1]
                if total_part.isdigit():
                    total = int(total_part)
            if len(page) == 0 or (total is not None and offset >= total):
                break
        print(f"[store] {table}: {len(out)} rows")
        return out

    def fetch_active_cascades(self) -> list:
        return self._get("/cascades?active=eq.true&select=*&order=id.asc")

    def fetch_notification_keys(self) -> set:
        rows = self._get("/notifications?select=cascade_id,movie_id,moment&order=id.asc")
        return {(r.get("cascade_id"), str(r.get("movie_id")), r.get("moment")) for r in rows}

    def fetch_notify_prefs(self) -> dict:
        """user_id -> the user's delivery preferences (CAS-185). A user with no row is not an
        error and not a default-off: they simply have not answered, and PREFS_DEFAULT applies."""
        rows = self._get(
            "/notify_prefs?select=user_id,in_app,email_on,email_address,excluded_moments"
            "&order=user_id.asc"
        )
        return {str(r.get("user_id")): r for r in rows if r.get("user_id")}

    def fetch_picks(self) -> list:
        """Every hand-answer on a film, for every user (CAS-100). Only the 'off' rows suppress —
        see matching.suppressed_pairs — but both are fetched so the caller does the deciding.
        `pinned_to`/`not_in` (CAS-279's hand-move IN/OUT lists) ride alongside since CAS-925: they
        decide which cascade owns a film for cross-surface attribution — see matching.pick_overrides
        and matching._resolve_owner. No schema change — both columns already exist and the app
        already writes them (app_template.html's pinFilmToCascadeAndRepaint / film_picks.not_in)."""
        return self._get(
            "/film_picks?select=user_id,movie_id,state,pinned_to,not_in"
            "&order=user_id.asc,movie_id.asc"
        )

    def fetch_push_tokens(self) -> dict:
        """user_id -> the user's live device tokens (CAS-465), read with service_role (bypasses
        RLS, same convention as fetch_active_cascades)."""
        rows = self._get("/push_tokens?select=user_id,device_token&order=id.asc")
        out: dict = {}
        for r in rows:
            out.setdefault(str(r.get("user_id")), []).append(r.get("device_token"))
        return out

    def fetch_unread_counts(self) -> dict:
        """user_id -> count of unread notifications rows — the same number the in-app bell
        badge shows, so a push's badge field can never disagree with it (CAS-465)."""
        rows = self._get("/notifications?read_at=is.null&select=user_id&order=id.asc")
        out: dict = {}
        for r in rows:
            uid = str(r.get("user_id"))
            out[uid] = out.get(uid, 0) + 1
        return out

    def fetch_film_watches(self) -> list:
        """Every user's per-film Watch-it ticks (CAS-484): {user_id, movie_id, windows,
        sources}. `sources` (CAS-918) is read alongside `windows` so matching.match() can tell
        an auto placement from a manual one when deciding whether a window-arrival moment
        forward-matches a film that has moved on but hasn't been re-placed yet."""
        return self._get(
            "/film_watch?select=user_id,movie_id,windows,sources&order=user_id.asc,movie_id.asc"
        )

    def fetch_watch_notification_keys(self) -> set:
        """(user_id, movie_id, moment) already delivered via the per-film-watch path — the rows in
        `notifications` with no owning cascade. Kept apart from fetch_notification_keys() because
        a null cascade_id does not, by itself, de-dupe across users the way a real one does (see
        matching.match_film_watches)."""
        rows = self._get(
            "/notifications?cascade_id=is.null&select=user_id,movie_id,moment&order=id.asc"
        )
        return {(str(r.get("user_id")), str(r.get("movie_id")), r.get("moment")) for r in rows}

    def fetch_user_prefs(self) -> dict:
        """user_id -> {sub_services, store_services, taste, services_only} (CAS-825/CAS-853): the
        account facts the real engine's matchesCriteria reads beyond an agent's own criteria —
        CAS-211's services (the my-services scope's own comparison set), CAS-146's taste baseline
        (only `.langs` survives there today, see app_template.html's passesTasteBase), and CAS-853's
        `services_only` (the "only show films on my services" switch, now authoritative over every
        agent's own myServices). A user with no row here has never opened those screens, and
        compute_admission() reads that as the engine's own permissive default, not as "answered
        empty"."""
        rows = self._get(
            "/user_prefs?select=user_id,sub_services,store_services,taste,services_only"
            "&order=user_id.asc"
        )
        return {str(r.get("user_id")): r for r in rows if r.get("user_id")}

    def fetch_user_films(self) -> list:
        """Every user's watched-film opinions (CAS-183): [{user_id, movie_id, status}]. Fed straight
        into the engine's own applyFilmRows() by admit_shim.mjs (CAS-825) — the same rebuild the app
        runs on sign-in — so a blocked/disliked film is excluded from admission the same way the app
        excludes it, not by a second exclusion rule guessed at in Python."""
        return self._get("/user_films?select=user_id,movie_id,status&order=user_id.asc,movie_id.asc")

    def fetch_user_held_ids(self) -> set:
        """CAS-986: every tmdb_id a user holds state on — a watched opinion (user_films), a
        per-film Watch-it tick (film_watch), an agent's own admitted film (agent_films), or a
        notification ever sent about it. The two-tier catalogue's demotion-safety net: written to
        state/user_held_ids.json at the end of every monitor run so the nightly pipeline can never
        orphan a film a user marked watched or pinned."""
        out: set = set()
        for path in (
            "/user_films?select=movie_id&order=user_id.asc,movie_id.asc",
            "/film_watch?select=movie_id&order=user_id.asc,movie_id.asc",
            "/agent_films?select=movie_id&order=user_id.asc,cascade_id.asc,movie_id.asc",
            "/notifications?select=movie_id&order=id.asc",
        ):
            out |= {str(r.get("movie_id")) for r in self._get(path) if r.get("movie_id") is not None}
        return out

    def fetch_unsent_contact_messages(self) -> list:
        """Every contact_messages row not yet emailed (CAS-836), oldest first — read with
        service_role, since the anon key that wrote these rows has no select grant on them."""
        return self._get(
            "/contact_messages?sent_at=is.null&order=created_at.asc,id.asc"
            "&select=id,user_id,client_key,category,email,message,diagnostics,build,created_at,attachment_path"
        )

    def mark_contact_messages_sent(self, ids, sent_at) -> int:
        """Stamp sent_at on exactly these rows, after the digest has actually been sent
        (send-before-ledger, same ordering as insert_notifications elsewhere in this module)."""
        ids = list(ids)
        if not ids:
            return 0
        quoted = ",".join(str(i) for i in ids)
        data = json.dumps({"sent_at": sent_at}).encode("utf-8")
        req = urllib.request.Request(
            self._base + f"/contact_messages?id=in.({quoted})",
            data=data,
            headers=self._headers({"Prefer": "return=representation"}),
            method="PATCH",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            body = resp.read().decode("utf-8")
        try:
            return len(json.loads(body))
        except (json.JSONDecodeError, TypeError):
            return 0

    def fetch_unsent_recommendations(self) -> list:
        """Every recommendations row not yet emailed (CAS-884), oldest first — read with
        service_role, since the authenticated-only RLS policy scopes a normal client to its own
        sender_id, never every user's."""
        return self._get(
            "/recommendations?sent_at=is.null&order=created_at.asc,id.asc"
            "&select=id,sender_id,sender_name,to_name,to_email,message,created_at"
        )

    def mark_recommendations_sent(self, ids, sent_at) -> int:
        """Stamp sent_at on exactly these rows, after each email has actually been sent
        (send-before-ledger, same ordering as mark_contact_messages_sent above)."""
        ids = list(ids)
        if not ids:
            return 0
        quoted = ",".join(str(i) for i in ids)
        data = json.dumps({"sent_at": sent_at}).encode("utf-8")
        req = urllib.request.Request(
            self._base + f"/recommendations?id=in.({quoted})",
            data=data,
            headers=self._headers({"Prefer": "return=representation"}),
            method="PATCH",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            body = resp.read().decode("utf-8")
        try:
            return len(json.loads(body))
        except (json.JSONDecodeError, TypeError):
            return 0

    def fetch_recent_sent_recommendations(self, since) -> list:
        """Every recommendations row emailed on/after `since` (CAS-1131), read with service_role —
        same cross-user reason as fetch_unsent_recommendations above."""
        return self._get(
            f"/recommendations?sent_at=gte.{urllib.parse.quote(since)}&select=sender_id,to_email,sent_at"
        )

    def fetch_undigested_invite_replies(self) -> list:
        """Every invite_replies row not yet folded into a digest (CAS-887), each flattened with the
        sender/film context it needs from its own invite via the FK resource-embed (invite_replies.
        token -> invites.token) — read with service_role, the same bypass-RLS convention as every
        other digest source here. Never reads or writes `seen_at`; that column belongs to the app."""
        rows = self._get(
            "/invite_replies?digested_at=is.null&order=created_at.asc,id.asc&select="
            "id,token,answer,created_at,invites(sender_id,to_name,film_title,tmdb_id)"
        )
        out = []
        for r in rows:
            inv = r.get("invites") or {}
            out.append({
                "id": r.get("id"), "token": r.get("token"), "answer": r.get("answer"),
                "created_at": r.get("created_at"), "sender_id": inv.get("sender_id"),
                "to_name": inv.get("to_name"), "film_title": inv.get("film_title"),
                "tmdb_id": inv.get("tmdb_id"),
            })
        return out

    def mark_invite_replies_digested(self, ids, digested_at) -> int:
        """Stamps `digested_at`, after the digest carrying these replies has actually sent
        (send-before-ledger, same ordering as mark_contact_messages_sent above). Never touches
        `seen_at` (item 5, CAS-887) — a different column, written only by the app itself."""
        ids = list(ids)
        if not ids:
            return 0
        quoted = ",".join(str(i) for i in ids)
        data = json.dumps({"digested_at": digested_at}).encode("utf-8")
        req = urllib.request.Request(
            self._base + f"/invite_replies?id=in.({quoted})",
            data=data,
            headers=self._headers({"Prefer": "return=representation"}),
            method="PATCH",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            body = resp.read().decode("utf-8")
        try:
            return len(json.loads(body))
        except (json.JSONDecodeError, TypeError):
            return 0

    def fetch_unsent_invite_emails(self) -> list:
        """Every invite_emails row not yet sent (CAS-930), each flattened with the film/sender
        context from its own invite via the FK resource-embed (invite_emails.token ->
        invites.token) — same convention as fetch_undigested_invite_replies above. Read with
        service_role, since the authenticated-only RLS policy scopes a normal client to invites it
        owns, never every user's."""
        rows = self._get(
            "/invite_emails?sent_at=is.null&order=created_at.asc,id.asc&select="
            "id,token,to_email,to_name,created_at,invites(sender_name,film_title,tmdb_id)"
        )
        out = []
        for r in rows:
            inv = r.get("invites") or {}
            out.append({
                "id": r.get("id"), "token": r.get("token"), "to_email": r.get("to_email"),
                "to_name": r.get("to_name"), "created_at": r.get("created_at"),
                "sender_name": inv.get("sender_name"), "film_title": inv.get("film_title"),
                "tmdb_id": inv.get("tmdb_id"),
            })
        return out

    def mark_invite_emails_sent(self, ids, sent_at) -> int:
        """Stamp sent_at on exactly these rows, after each email has actually been sent
        (send-before-ledger, same ordering as mark_recommendations_sent above)."""
        ids = list(ids)
        if not ids:
            return 0
        quoted = ",".join(str(i) for i in ids)
        data = json.dumps({"sent_at": sent_at}).encode("utf-8")
        req = urllib.request.Request(
            self._base + f"/invite_emails?id=in.({quoted})",
            data=data,
            headers=self._headers({"Prefer": "return=representation"}),
            method="PATCH",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            body = resp.read().decode("utf-8")
        try:
            return len(json.loads(body))
        except (json.JSONDecodeError, TypeError):
            return 0

    def fetch_unnotified_invite_replies(self) -> list:
        """Every invite_replies row not yet emailed to its sender the same day (CAS-967), each
        flattened with the sender/film context from its own invite via the FK resource-embed
        (invite_replies.token -> invites.token) — same convention as
        fetch_undigested_invite_replies above. Read with service_role, since the authenticated-only
        RLS policy scopes a normal client to invites it owns, never every user's. Never reads or
        writes `seen_at`/`digested_at`; those columns belong to the app and the next-morning digest
        respectively."""
        rows = self._get(
            "/invite_replies?notified_at=is.null&order=created_at.asc,id.asc&select="
            "id,token,answer,created_at,invites(sender_id,to_name,film_title,tmdb_id)"
        )
        out = []
        for r in rows:
            inv = r.get("invites") or {}
            out.append({
                "id": r.get("id"), "token": r.get("token"), "answer": r.get("answer"),
                "created_at": r.get("created_at"), "sender_id": inv.get("sender_id"),
                "to_name": inv.get("to_name"), "film_title": inv.get("film_title"),
                "tmdb_id": inv.get("tmdb_id"),
            })
        return out

    def mark_invite_replies_notified(self, ids, notified_at) -> int:
        """Stamps `notified_at` on exactly these rows, after the email covering them has actually
        sent (send-before-ledger, same ordering as mark_invite_replies_digested above). Never
        touches `seen_at` or `digested_at` — independent columns, item 4 (CAS-967)."""
        ids = list(ids)
        if not ids:
            return 0
        quoted = ",".join(str(i) for i in ids)
        data = json.dumps({"notified_at": notified_at}).encode("utf-8")
        req = urllib.request.Request(
            self._base + f"/invite_replies?id=in.({quoted})",
            data=data,
            headers=self._headers({"Prefer": "return=representation"}),
            method="PATCH",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            body = resp.read().decode("utf-8")
        try:
            return len(json.loads(body))
        except (json.JSONDecodeError, TypeError):
            return 0

    def sign_attachment_url(self, path):
        """Mint a signed URL for a contact-attachments object with the service_role key
        (CAS-864) — the anon key that uploaded it has no select grant on the private bucket.
        Returns None (rather than raising) on a missing path or a failed sign, so a digest
        with one bad attachment still sends the rest of the messages."""
        if not path:
            return None
        base = self._base[: -len("/rest/v1")]   # strip the PostgREST suffix
        data = json.dumps({"expiresIn": CONTACT_ATTACHMENT_SIGNED_URL_EXPIRES_IN}).encode("utf-8")
        req = urllib.request.Request(
            f"{base}/storage/v1/object/sign/{CONTACT_ATTACHMENTS_BUCKET}/{urllib.parse.quote(path)}",
            data=data,
            headers=self._headers(),
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError):
            return None
        signed = result.get("signedURL")
        return f"{base}/storage/v1{signed}" if signed else None

    def fetch_user_email(self, user_id: str):
        """Resolve a user_id to their email via the Auth admin API (service_role only).
        Returns None if it can't be found."""
        base = self._base[: -len("/rest/v1")]   # strip the PostgREST suffix
        req = urllib.request.Request(
            f"{base}/auth/v1/admin/users/{urllib.parse.quote(user_id)}",
            headers=self._headers(), method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError):
            return None
        return data.get("email") or (data.get("user") or {}).get("email")

    def insert_notifications(self, rows) -> int:
        rows = list(rows)
        if not rows:
            return 0
        data = json.dumps(rows).encode("utf-8")
        req = urllib.request.Request(
            self._base + "/notifications",
            data=data,
            headers=self._headers({"Prefer": "return=minimal"}),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self._timeout):
            return len(rows)

    def delete_notifications_for_movie_ids(self, movie_ids) -> int:
        """CAS-486: DELETE ledger rows for the notify-test harness's fixture films only. `movie_ids`
        is re-filtered to the reserved fixture range (FIXTURE_ID_MIN..FIXTURE_ID_MAX) here, not
        trusted from the caller — the filtered ids are baked into the PostgREST filter itself, never
        a raw workflow input, so a malformed/hostile value passed in can only ever shrink the set to
        nothing, never widen it to a real movie_id."""
        ids = _fixture_ids_only(movie_ids)
        if not ids:
            return 0
        quoted = ",".join(ids)
        req = urllib.request.Request(
            self._base + f"/notifications?movie_id=in.({quoted})",
            headers=self._headers({"Prefer": "return=representation"}),
            method="DELETE",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            body = resp.read().decode("utf-8")
        try:
            return len(json.loads(body))
        except (json.JSONDecodeError, TypeError):
            return 0

    def upsert_film_watch(self, user_id, movie_id, window: str) -> None:
        """CAS-1052: write ONE temporary film_watch row so notify_test.py can guarantee a match for
        --target-user's chosen scenario without touching their real agents — matching.
        match_film_watches() fires on this table independently of any cascade's own criteria.
        Upserts on the table's own (user_id, movie_id) primary key (supabase/schema.sql), so a
        repeat arm for the same user/fixture film overwrites the previous tick rather than
        duplicating or erroring."""
        row = {"user_id": user_id, "movie_id": str(movie_id), "windows": [window],
              "sources": {window: "manual"}}
        data = json.dumps([row]).encode("utf-8")
        req = urllib.request.Request(
            self._base + "/film_watch?on_conflict=user_id,movie_id",
            data=data,
            headers=self._headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self._timeout):
            pass

    def delete_film_watch_for_movie_ids(self, movie_ids) -> int:
        """CAS-1052: DELETE the temporary film_watch row(s) notify_test.py's --verify pass tears
        down after a run. `movie_ids` is re-filtered to the reserved fixture range here, the same
        belt-and-braces guard delete_notifications_for_movie_ids uses, so this can never touch a
        real user's per-film Watch-it tick no matter what a caller passes in."""
        ids = _fixture_ids_only(movie_ids)
        if not ids:
            return 0
        quoted = ",".join(ids)
        req = urllib.request.Request(
            self._base + f"/film_watch?movie_id=in.({quoted})",
            headers=self._headers({"Prefer": "return=representation"}),
            method="DELETE",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            body = resp.read().decode("utf-8")
        try:
            return len(json.loads(body))
        except (json.JSONDecodeError, TypeError):
            return 0

    # CAS-1091: none of these views carries a declared primary key (they're plain `group by`
    # aggregates — supabase/schema.sql), so the paging order is each view's own group-by columns,
    # the set that is already guaranteed unique per output row by the grouping itself.
    _VIEW_ORDER = {
        "analytics_sessions": "client_key.asc,session.asc",
        "analytics_acquisition": "day.asc,source.asc,medium.asc,campaign.asc",
        "analytics_onboarding_funnel": "step.asc",
        "analytics_activation": "day.asc",
        "analytics_retention": "cohort_week.asc,plat.asc",
        "analytics_feature_usage": "feature.asc",
    }

    def fetch_view(self, view_name: str) -> list:
        """CAS-1021: every row of a public view or table, select=* — used by metrics_report.py to
        read the CAS-942 analytics_* views without a bespoke method per view. CAS-1091: a view with
        no known unique key to page on is refused rather than fetched unpaged — add it to
        _VIEW_ORDER (or flag needs-lee if it truly has none) before wiring a new view in here."""
        order = self._VIEW_ORDER.get(view_name)
        if not order:
            raise ValueError(f"fetch_view({view_name!r}): no known unique key to page on (CAS-1091)")
        return self._get(f"/{view_name}?select=*&order={order}")

    def delete_old_usage_events(self, days: int = 180) -> int:
        """CAS-942: purge usage_events rows older than `days`, with the same service_role
        credential this store already uses for every other call — this is the daily retention
        rule for the client's batched usage log, not a fixture/test concern."""
        cutoff = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=days)).isoformat()
        req = urllib.request.Request(
            self._base + f"/usage_events?created_at=lt.{urllib.parse.quote(cutoff)}",
            headers=self._headers({"Prefer": "return=representation"}),
            method="DELETE",
        )
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            body = resp.read().decode("utf-8")
        try:
            return len(json.loads(body))
        except (json.JSONDecodeError, TypeError):
            return 0


def store_from_env(env=None):
    """Return a SupabaseStore if both secrets are present, else None (caller falls back to
    dry-run). The service_role key is read from the environment only — never hardcoded."""
    env = env or os.environ
    url = env.get(SUPABASE_URL_ENV)
    key = env.get(SERVICE_KEY_ENV)
    if url and key:
        return SupabaseStore(url, key)
    return None
