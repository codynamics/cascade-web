"""CAS-825 AC2 — the real admission path, end to end.

Exercises compute_admission() -> admit_shim.mjs -> the SHIPPED engine (tests/js/engine.mjs's own
loadEngine(), which reads the BUILT index.html — never app_template.html, satisfying AC5) -> for
(a) below, the committed movies.json. No mock, no re-derivation of matchesCriteria's rules here or
in matching.py — this is the whole point of the ticket (the old hand-port is what drifted).

Run:  python -m unittest monitor.tests.test_admission   (from the repo root; needs Node on PATH)
"""
import json
import os
import subprocess
import unittest

from monitor.matching import compute_admission

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_MOVIES_PATH = os.path.join(_REPO_ROOT, "movies.json")

_OPEN = {"in_cinema": 0, "rent": 0, "stream": 0}


def _load_movies():
    with open(_MOVIES_PATH, encoding="utf-8") as fh:
        data = json.load(fh)
    return data["movies"] if isinstance(data, dict) else data


def _cascade_scores(movies, tmdb_ids):
    """cascadeScore(), off the same shipped engine admit_shim.mjs uses, computed on the EXACT
    movie objects `movies` (the same ones passed to compute_admission()) — not a second, separate
    lookup into E.MOVIES (the built index.html's own embedded catalogue). E.MOVIES is rederived
    against the real wall-clock date every time the engine loads (deriveStatus(), CAS-227/CAS-237),
    so a film whose cinema_date crosses a window boundary between when `movies` was read and when
    this probe runs can carry a different `status` there than in `movies` — and since cascadeScore()
    branches on status, that alone changes the score. Scoring the very objects admission was asked
    about keeps this check comparing like with like."""
    ids = {str(i) for i in tmdb_ids}
    wanted = [m for m in movies if str(m.get("tmdb_id")) in ids]
    script = (
        "import { loadEngine } from './tests/js/engine.mjs';\n"
        "const E = loadEngine();\n"
        "let raw = '';\n"
        "process.stdin.on('data', c => raw += c);\n"
        "process.stdin.on('end', () => {\n"
        "  const movies = JSON.parse(raw);\n"
        "  const out = {};\n"
        "  for (const m of movies) out[String(m.tmdb_id)] = E.cascadeScore(m);\n"
        "  process.stdout.write(JSON.stringify(out));\n"
        "});\n"
    )
    proc = subprocess.run(["node", "--input-type=module", "-e", script], cwd=_REPO_ROOT,
                          input=json.dumps(wanted), capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"score probe failed: {proc.stderr}")
    return json.loads(proc.stdout)


class ScoreFloorGate(unittest.TestCase):
    """(a) CAS-724/CAS-727: an agent whose watchMarkers produce a floor of 60 must admit nothing
    scoring below it, and nothing unscored (cascadeScore === -1) — the dominant gate the old
    Python matcher was missing entirely (CAS-825 observation)."""

    def test_no_admitted_film_is_below_the_floor_or_unscored(self):
        movies = _load_movies()
        cascade = {"id": "c-floor", "user_id": "u-floor",
                  "criteria": {"watchMarkers": {"in_cinema": 60, "rent": 60, "stream": 60}}}
        admission = compute_admission([cascade], {"today": movies})
        admitted = admission["c-floor"]["today"]
        self.assertTrue(admitted, "setup: the floor must admit at least one real film to be a test")
        scores = _cascade_scores(movies, admitted)
        for mid in admitted:
            self.assertIn(mid, scores, f"movie {mid} was admitted but not found in MOVIES for scoring")
            self.assertNotEqual(scores[mid], -1, f"movie {mid} has no Cascade score but was admitted")
            self.assertGreaterEqual(scores[mid], 60,
                                    f"movie {mid} scored {scores[mid]}, below the 60 floor")


class RetiredLanguageFilter(unittest.TestCase):
    """(b) CAS-560: the agent-level `criteria.lang` filter is retired — only the account taste
    baseline (tasteBase.langs) gates language now. An agent still carrying a stale `lang` value
    must not have it do anything."""

    def test_agent_lang_field_is_ignored_when_account_taste_base_allows_it(self):
        movie = {"tmdb_id": "999900002", "title": "Foreign Film", "genres": ["Drama"],
                 "age_rating": "M", "language": "fr", "status": ["rental"],
                 "imdb_rating": 7.0, "imdb_votes": 5000, "wm_user_rating": 7.5, "wm_critic_score": 70,
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}
        cascade = {"id": "c-lang", "user_id": "u-lang",
                  "criteria": {"lang": ["en"], "watchMarkers": dict(_OPEN)}}
        # [] = every language, filter off (CAS-146) — the account has never narrowed it.
        admission = compute_admission([cascade], {"today": [movie]},
                                      account_prefs={"u-lang": {"langs": []}})
        self.assertIn("999900002", admission["c-lang"]["today"],
                      "criteria.lang narrowed admission, but CAS-560 retired that field")


class AnyGenreMatches(unittest.TestCase):
    """(c) CAS-1147: genre matching is against ANY of the film's genres, not only the first — the app
    now tests `(m.genres||[]).some(g=>c.genre.includes(g))` (Lee's decision, 2026-10-02, replacing the
    old `(m.genres||[])[0]`-only rule this class used to pin). A film carrying the wanted genre only as
    a SECONDARY one must admit; a film not carrying it at all must not."""

    def test_secondary_genre_does_admit(self):
        movie = {"tmdb_id": "999900001", "title": "Secondary Horror", "genres": ["Drama", "Horror"],
                 "age_rating": "M", "language": "en", "status": ["rental"],
                 "imdb_rating": 7.0, "imdb_votes": 5000, "wm_user_rating": 7.5, "wm_critic_score": 70,
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}
        cascade = {"id": "c-genre", "user_id": "u-genre",
                  "criteria": {"genre": ["Horror"], "watchMarkers": dict(_OPEN)}}
        admission = compute_admission([cascade], {"today": [movie]})
        self.assertIn("999900001", admission["c-genre"]["today"])

    def test_primary_genre_still_admits(self):
        # Control: the same shape, Horror moved to primary — proves admission isn't accidentally
        # keyed to genre ORDER in the other direction either.
        movie = {"tmdb_id": "999900003", "title": "Primary Horror", "genres": ["Horror", "Drama"],
                 "age_rating": "M", "language": "en", "status": ["rental"],
                 "imdb_rating": 7.0, "imdb_votes": 5000, "wm_user_rating": 7.5, "wm_critic_score": 70,
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}
        cascade = {"id": "c-genre2", "user_id": "u-genre",
                  "criteria": {"genre": ["Horror"], "watchMarkers": dict(_OPEN)}}
        admission = compute_admission([cascade], {"today": [movie]})
        self.assertIn("999900003", admission["c-genre2"]["today"])

    def test_genre_absent_entirely_does_not_admit(self):
        movie = {"tmdb_id": "999900004", "title": "No Horror Here", "genres": ["Drama", "Comedy"],
                 "age_rating": "M", "language": "en", "status": ["rental"],
                 "imdb_rating": 7.0, "imdb_votes": 5000, "wm_user_rating": 7.5, "wm_critic_score": 70,
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}
        cascade = {"id": "c-genre3", "user_id": "u-genre",
                  "criteria": {"genre": ["Horror"], "watchMarkers": dict(_OPEN)}}
        admission = compute_admission([cascade], {"today": [movie]})
        self.assertNotIn("999900004", admission["c-genre3"]["today"])


class ServiceScopeAuthority(unittest.TestCase):
    """(d) CAS-853 AC4: the account-level "only show films on my services" switch governs admission
    for every agent, not just one that copied it into its own criteria.myServices — an agent with no
    scope of its own must still lose a film that is on none of the user's picked services once the
    account switch is on, and get it back the moment the switch is off."""

    def _stan_only_film(self):
        return {"tmdb_id": "999900853", "title": "Stan-Only Test Film", "genres": ["Drama"],
                "age_rating": "M", "language": "en", "status": ["included_streaming"],
                "imdb_rating": 7.0, "imdb_votes": 5000, "wm_user_rating": 7.5, "wm_critic_score": 70,
                "offers": [{"service": "Stan", "type": "sub", "price": None}]}

    def test_excluded_when_services_only_is_on_and_the_service_is_not_picked(self):
        movie = self._stan_only_film()
        cascade = {"id": "c-svc-on", "user_id": "u-svc",
                  "criteria": {"watchMarkers": dict(_OPEN)}}
        admission = compute_admission([cascade], {"today": [movie]},
                                      account_prefs={"u-svc": {"subServices": [], "servicesOnly": True}})
        self.assertNotIn("999900853", admission["c-svc-on"]["today"],
                         "a Stan-only film was admitted to an unscoped agent with the account "
                         "services-only switch on and Stan not among the user's picked services")

    def test_admitted_when_services_only_is_off(self):
        movie = self._stan_only_film()
        cascade = {"id": "c-svc-off", "user_id": "u-svc",
                  "criteria": {"watchMarkers": dict(_OPEN)}}
        admission = compute_admission([cascade], {"today": [movie]},
                                      account_prefs={"u-svc": {"subServices": [], "servicesOnly": False}})
        self.assertIn("999900853", admission["c-svc-off"]["today"],
                      "a Stan-only film was excluded even though the account services-only switch is off")


class UpcomingCinemaGate(unittest.TestCase):
    """(e) CAS-854: "upcoming" means coming to cinemas, so a pre-release film is only news to an agent
    that actually watches Cinema. An agent whose only usable window is Stream (Cinema marker Never)
    must not admit an upcoming film, however high it scores — so the daily email never fires for it."""

    def _upcoming_film(self):
        return {"tmdb_id": "999900854", "title": "CAS-854 Upcoming Test Film", "genres": ["Drama"],
                "age_rating": "M", "language": "en", "status": ["upcoming"],
                "popularity": 50, "wm_popularity_percentile": 70, "award": None}

    def test_stream_only_agent_does_not_admit_an_upcoming_film(self):
        movie = self._upcoming_film()
        cascade = {"id": "c-854-never", "user_id": "u-854",
                  "criteria": {"watchMarkers": {"in_cinema": None, "rent": None, "stream": 0}}}
        admission = compute_admission([cascade], {"today": [movie]})
        self.assertNotIn("999900854", admission["c-854-never"]["today"],
                         "an upcoming film was admitted to an agent whose only usable window is Stream — "
                         "its Cinema marker is Never, so this agent is not waiting for a cinema arrival")

    def test_admitted_once_the_agent_watches_cinema(self):
        movie = self._upcoming_film()
        cascade = {"id": "c-854-usable", "user_id": "u-854",
                  "criteria": {"watchMarkers": {"in_cinema": 0, "rent": None, "stream": 0}}}
        admission = compute_admission([cascade], {"today": [movie]})
        self.assertIn("999900854", admission["c-854-usable"]["today"],
                      "an upcoming film was excluded even though the agent's Cinema window is usable")


if __name__ == "__main__":
    unittest.main()
