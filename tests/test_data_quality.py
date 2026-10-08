"""CAS-233 (part 1): data-quality tests over the catalogue the app ships.

Every assertion here is a claim the UI makes on the strength of this file. The engine invariants (CAS-231) prove
the app reasons correctly about whatever it is given; these prove it is given something worth reasoning about.
The two failure modes they exist for have both happened: CAS-170 shipped 913 titles whose availability rested on
nothing, and CAS-155 filed 257 rental records under "In Cinema".

Deliberately NOT here: anything that pins a number. The catalogue is refreshed daily on main, so an assertion
that today's catalogue holds 1,961 films is a test that fails tomorrow for no reason and gets muted. What is
asserted is that every record is internally coherent and that the shape of the whole is sane.

Run: python -m unittest discover -s tests
"""
import datetime
import json
import os
import unittest

import poc_pipeline as pp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOGUE = os.path.join(ROOT, "movies.json")

# CAS-405: `daily.yml` refreshes this file from live TMDB/OMDb data every morning, and third-party
# data drifts in ways that trip several of the checks below most days for reasons that are not app
# breakage (a rating outside its old percentile band, a window date pattern, an emptier optional
# field). Gating `qa` on all ~30 assertions therefore froze production most mornings. Only the
# checks below still fail `qa` (run via tests/run_data_quality.py, not a flat `unittest discover`);
# every other check in this file still runs on every push, but report-only — see that script.
BLOCKING_TESTS = {
    "CatalogueShape.test_ids_are_unique",
    "CatalogueShape.test_every_film_has_the_fields_the_ui_prints",
    "CatalogueShape.test_no_record_is_a_raw_candidate_pool_stub",
    "DataCompleteness.test_the_showable_catalogue_is_a_real_population",
    "DataCompleteness.test_every_showable_film_carries_what_it_cannot_be_shown_without",
    # CAS-578: D1/D2 were exactly this class of app-breaker (a listing claiming you can watch
    # something with nothing behind it) and both slipped past every existing check for weeks —
    # these two are the assertions AC2/AC4 require, and they block for the same reason the four above do.
    "AvailabilityIsBackedBySomething.test_a_home_window_is_never_claimed_with_zero_offers",
    "AvailabilityIsBackedBySomething.test_included_streaming_is_never_claimed_without_a_current_sub_offer",
    # CAS-1031: production QA expected the publish floor to shrink the catalogue and it barely
    # moved — the floor turned out to be applied correctly (every published title already clears
    # it), but nothing before this proved that in CI, so a real regression would have shipped
    # unnoticed the same way. Blocking for the same reason the checks above are.
    "OnlyFloorQualifyingTitlesPublish.test_every_published_film_clears_the_publish_floor",
    # CAS-1026: a raw int `year` (one back-catalogue merge path skipped the str() every other
    # ingestion path applies) crashes index.html#engine's yearOf() at (m.cinema_date||m.year||"").
    # slice(). Blocking for the same reason test_no_record_is_a_raw_candidate_pool_stub is.
    "CatalogueShape.test_year_is_always_a_string",
    # CAS-1048: TMDB's AU certification field carries both "MA15+"/"MA 15+" and "R18+"/"R 18+" for the
    # same rating — the onboarding age step rendered a chip per spelling and silently dropped whichever
    # one the default selection or an agent's saved criteria didn't happen to name. Blocking so a future
    # ingestion path can't reintroduce the un-canonical spelling the way the back-catalogue merge above did.
    "CatalogueShape.test_age_rating_is_canonical_spelling",
    # CAS-1078: an old back-catalogue title latched at Upcoming forever with no AU release date at
    # all is the same class of app-breaker as the checks above — a listing claiming a cinema future
    # the film doesn't have. Blocking so the classify_tier/_offerless_window gap can't reopen.
    "StatusAgreesWithTheCalendar.test_upcoming_never_holds_an_old_title_with_no_future_au_date",
}

# The windows a film can hold, in journey order — the same list the front end calls CASCADE.
WINDOWS = ["upcoming", "opening_week", "in_cinema", "pvod", "rental", "included_streaming"]
CINEMA_WINDOWS = {"opening_week", "in_cinema"}
HOME_WINDOWS = {"pvod", "rental", "included_streaming"}

# CAS-999: "released" is a deliberate, legitimate terminal status — poc_pipeline.py's own
# _offerless_window() returns it for a title whose cinema run is over with no AU offer behind it
# (STATUS_LABEL there already prints it as "Released (no AU offer)"), mirrored exactly by the front
# end's offerlessWindow(). It never joins WINDOWS: unlike every entry there, nothing plays in it, so
# it carries no journey-order index, and it always arrives alone (derive_from_providers only ever
# appends it as the single-element offerless fallback). The front end's own showable() gate keeps a
# film in this state out of every listing, so it is a known, harmless value here rather than a bug.
NON_WINDOW_STATUSES = {"released"}
# A film released before cinema existed is a data error, and one dated far in the future is a placeholder.
EARLIEST_SANE = datetime.date(1895, 1, 1)


def load():
    with open(CATALOGUE, encoding="utf-8") as fh:
        return json.load(fh)


def parse_date(value):
    """The ISO date, or None. Raises nothing — the caller decides whether None is a failure."""
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.date.fromisoformat(value[:10])
    except ValueError:
        return None


class CatalogueShape(unittest.TestCase):
    """The file itself, before any single record."""

    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.movies = cls.doc["movies"]

    def test_envelope(self):
        self.assertIn("generated", self.doc, "no build stamp on the catalogue")
        self.assertIsNotNone(parse_date(self.doc["generated"]), f"unparseable stamp {self.doc['generated']!r}")
        self.assertEqual(self.doc.get("region"), "AU", "the pipeline is AU-only; a region change needs a look")
        self.assertGreater(len(self.movies), 500, "the catalogue is suspiciously small")

    def test_ids_are_unique(self):
        seen, dupes = set(), []
        for m in self.movies:
            if m["tmdb_id"] in seen:
                dupes.append(m["tmdb_id"])
            seen.add(m["tmdb_id"])
        self.assertEqual(dupes, [], f"duplicate tmdb_ids: {dupes[:5]}")

    def test_every_film_has_the_fields_the_ui_prints(self):
        missing = []
        for m in self.movies:
            for field in ("tmdb_id", "title", "status", "offers", "availability_confidence", "genres"):
                if field not in m:
                    missing.append((m.get("title", m.get("tmdb_id")), field))
        self.assertEqual(missing, [], f"films missing fields the UI prints: {missing[:5]}")

    def test_the_catalogue_is_not_all_one_window(self):
        # Not a threshold on any single window — just that the ladder isn't collapsed, which is what a broken
        # status writer looks like from the outside.
        held = {w for m in self.movies for w in m.get("status", [])}
        self.assertGreaterEqual(len(held), 2, f"every film is in the same window: {held}")

    def test_no_record_is_a_raw_candidate_pool_stub(self):
        # CAS-1027: the back-catalogue dispatch (CAS-1024) once published CAS-991's raw
        # merge_backcatalogue_candidates stubs straight into movies.json — an int `year`, no
        # `cinema_date`/`genres`/`release_dates`/etc — which crashed the app's own
        # `(m.cinema_date || m.year || "").slice` read. is_publishable_record is the one guard
        # every path that writes movies.json must pass a candidate through before publishing it;
        # this proves the file actually shipped only reflects that guard.
        stubs = [m.get("title", m.get("tmdb_id")) for m in self.movies
                if not pp.is_publishable_record(m)]
        self.assertEqual(stubs, [], f"films that are still raw, un-enriched candidate-pool stubs: {stubs[:5]}")

    def test_year_is_always_a_string(self):
        # CAS-1026: engine's yearOf() does (m.cinema_date||m.year||"").slice(...) — an int year
        # with no cinema_date throws. Every ingestion path but one already writes str(year); this
        # proves the file that ships never carries the raw-int exception.
        bad = [(m.get("title", m.get("tmdb_id")), m.get("year")) for m in self.movies
               if "year" in m and not isinstance(m["year"], str)]
        self.assertEqual(bad, [], f"films with a non-string year: {bad[:5]}")

    def test_age_rating_is_canonical_spelling(self):
        # CAS-1048: "MA15+"/"R18+" are TMDB's un-spaced duplicates of "MA 15+"/"R 18+" — the same
        # rating, not a second one. pp.canon_age_rating is the one place that spelling is fixed on
        # ingest; this proves nothing un-canonical reached the file that ships.
        bad = [(m.get("title", m.get("tmdb_id")), m.get("age_rating")) for m in self.movies
               if m.get("age_rating") in pp.AGE_RATING_CANON]
        self.assertEqual(bad, [], f"films with a non-canonical age_rating spelling: {bad[:5]}")


class AvailabilityIsBackedBySomething(unittest.TestCase):
    """CAS-170: a listing is a claim you can go and watch this, so something real has to be behind it."""

    @classmethod
    def setUpClass(cls):
        cls.movies = load()["movies"]

    def test_status_values_are_known_windows(self):
        bad = [(m["title"], m["status"]) for m in self.movies
               if not m["status"] or any(w not in WINDOWS and w not in NON_WINDOW_STATUSES for w in m["status"])]
        self.assertEqual(bad, [], f"films holding an unknown window: {bad[:5]}")

    def test_status_is_in_journey_order(self):
        # primaryStatus() takes the LAST window a film holds, so the order is load-bearing: a list written out
        # of order would make the app read the wrong window as current.
        # CAS-999: a NON_WINDOW_STATUSES film (e.g. "released") is not on the ladder at all and always
        # arrives alone, so there's no journey order to check — WINDOWS.index() would raise for it anyway.
        bad = []
        for m in self.movies:
            if set(m["status"]) & NON_WINDOW_STATUSES:
                continue
            order = [WINDOWS.index(w) for w in m["status"]]
            if order != sorted(order):
                bad.append((m["title"], m["status"]))
        self.assertEqual(bad, [], f"status lists out of journey order: {bad[:5]}")

    def test_confirmed_means_polled(self):
        bad = [m["title"] for m in self.movies
               if m["availability_confidence"] not in ("confirmed", "estimated")]
        self.assertEqual(bad, [], f"films with an unknown availability_confidence: {bad[:5]}")

    def test_a_home_window_is_never_claimed_on_no_offer(self):
        # The CAS-170 fault in one assertion: a CONFIRMED film cannot be sitting at rent or on streaming with
        # nothing to rent or stream it from. (An ESTIMATED film is allowed to have no offers — that is what
        # estimated MEANS — and the front end refuses to list those, which CAS-231 asserts separately.)
        bad = []
        for m in self.movies:
            if m["availability_confidence"] != "confirmed":
                continue
            if set(m["status"]) & HOME_WINDOWS and not m["offers"]:
                bad.append((m["title"], m["status"]))
        self.assertEqual(bad, [], f"confirmed home-window films with no offers: {bad[:5]}")

    def test_a_home_window_is_never_claimed_with_zero_offers(self):
        # CAS-578 AC2/D1: unlike test_a_home_window_is_never_claimed_on_no_offer above (which only
        # checks CONFIRMED films), this is unconditional. The 112-title corruption reached the
        # catalogue entirely through the ESTIMATED path — an offer-less title mass-stamped a paid
        # window by a pre-CAS-412 bug — which the older, confirmed-only check never saw at all.
        bad = [(m["title"], m["status"]) for m in self.movies
               if set(m["status"]) & HOME_WINDOWS and not m["offers"]]
        self.assertEqual(bad, [], f"films holding a home window with zero offers: {bad[:5]}")

    def test_included_streaming_is_never_claimed_without_a_current_sub_offer(self):
        # CAS-578 AC4/AC5/D2: 675 titles kept an included_streaming badge long after their
        # subscription offer disappeared, because nothing ever re-checked a claimed window against
        # today's real offers — there was no departure path in the code at all. Zero is the count.
        bad = []
        for m in self.movies:
            if "included_streaming" not in m["status"]:
                continue
            if not any(o.get("type") in ("sub", "free") for o in m["offers"]):
                bad.append((m["title"], [o.get("type") for o in m["offers"]]))
        self.assertEqual(bad, [],
                          f"included_streaming claimed with no current sub/free offer: {bad[:5]}")

    def test_offers_are_well_formed(self):
        bad = []
        for m in self.movies:
            for o in m["offers"]:
                if not isinstance(o, dict) or "type" not in o or "service" not in o:
                    bad.append((m["title"], o))
                elif o["type"] not in ("sub", "free", "rent", "buy", "ads", "cinema"):
                    bad.append((m["title"], o.get("type")))
                elif o.get("price") is not None and not (0 < float(o["price"]) < 200):
                    bad.append((m["title"], o.get("price")))
        self.assertEqual(bad, [], f"malformed offers: {bad[:5]}")


class StatusAgreesWithTheCalendar(unittest.TestCase):
    """CAS-155: the window a film is filed under has to be consistent with its dates and its offers."""

    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.movies = cls.doc["movies"]
        cls.today = parse_date(cls.doc["generated"]) or datetime.date.today()

    def test_a_cinema_window_stays_inside_its_run(self):
        # CAS-395: a film in a cinema window AND a home window at once is now expected — being on a screen
        # and having already picked up a home (buy/rent/stream) offer are not mutually exclusive, and a
        # film that opened today with a same-day pre-order was exactly what the old "zero offers" gate was
        # wrongly hiding. What still has to hold is the DATE: a cinema window is only honest while the
        # title's own AU opening is recent enough to still be a live theatrical run.
        bad = []
        for m in self.movies:
            if not (set(m["status"]) & CINEMA_WINDOWS):
                continue
            cd = parse_date(m.get("cinema_date"))
            if not cd or cd > self.today or cd < self.today - datetime.timedelta(days=pp.CINEMA_RUN_DAYS):
                bad.append((m["title"], m["status"], m.get("cinema_date")))
        self.assertEqual(bad, [], f"cinema-window films whose opening date is outside the run: {bad[:5]}")

    def test_a_cinema_window_never_holds_a_null_priced_offer(self):
        # This is exactly what CAS-155 found: rent/buy offers with null prices meant every price rule missed,
        # and a date-based fallback declared the film "in cinemas" while the data said rental. CAS-395 lets a
        # cinema window carry REAL priced home offers now, but a null-priced one is still the CAS-155 fault.
        bad = []
        for m in self.movies:
            if not (set(m["status"]) & CINEMA_WINDOWS):
                continue
            nullpriced = [o for o in m["offers"]
                          if o.get("type") in ("rent", "buy") and o.get("price") is None]
            if nullpriced:
                bad.append((m["title"], m["status"], len(nullpriced)))
        self.assertEqual(bad, [], f"cinema-window films carrying null-priced home offers: {bad[:5]}")

    def test_upcoming_films_are_not_already_out(self):
        # A film whose only window is `upcoming` while its opening date has passed is mislabelled — the state
        # CAS-227 had to work around in the front end. Recorded as a KNOWN GAP with a tolerance rather than as a
        # hard failure, because the fix lives in the poll scheduler and is Lee's call (see the CAS-227 comment).
        # The tolerance is deliberately tight: it catches the scheduler getting WORSE, which is what matters.
        late = []
        for m in self.movies:
            cd = parse_date(m.get("cinema_date"))
            if m["status"] == ["upcoming"] and cd and cd < self.today:
                late.append((m["title"], m["cinema_date"]))
        self.assertLessEqual(
            len(late), 40,
            f"{len(late)} films are still labelled Upcoming after their opening date — the poll scheduler's "
            f"upcoming latch (see CAS-227) has got worse: {late[:5]}")

    def test_upcoming_never_holds_an_old_title_with_no_future_au_date(self):
        # CAS-1078: 84 old back-catalogue titles (release year already behind us) with no AU
        # cinema_date at all stayed Upcoming forever — classify_tier's "none" tier (poll_scheduler.py)
        # never re-checked them, and _offerless_window's cinema_date-only read had no way to tell
        # "genuinely still to come" apart from "an old title Cascade never got an AU date for". Unlike
        # test_upcoming_films_are_not_already_out above (cinema_date required, tolerant, a known gap),
        # this is a hard zero: a film whose own release year has passed, with no AU release_dates entry
        # of any type still ahead of us, must never be Upcoming, cinema_date or not.
        bad = []
        for m in self.movies:
            if "upcoming" not in (m.get("status") or []):
                continue
            year = m.get("year")
            year = int(year) if isinstance(year, str) and year.isdigit() else None
            if year is None or year >= self.today.year:
                continue
            if any((rd.get("date") or "") > self.today.isoformat()
                   for rd in (m.get("release_dates") or [])):
                continue
            bad.append((m["title"], m.get("year"), m.get("cinema_date")))
        self.assertEqual(bad, [],
                          f"old titles with no future AU date still marked Upcoming: {bad[:5]}")

    def test_dates_parse_and_are_sane(self):
        horizon = self.today + datetime.timedelta(days=365 * 6)
        bad = []
        for m in self.movies:
            raw = m.get("cinema_date")
            if raw in (None, ""):
                continue
            d = parse_date(raw)
            if d is None:
                bad.append((m["title"], raw, "unparseable"))
            elif d < EARLIEST_SANE:
                bad.append((m["title"], raw, "before cinema existed"))
            elif d > horizon:
                bad.append((m["title"], raw, "further out than the pipeline looks"))
        self.assertEqual(bad, [], f"bad cinema dates: {bad[:5]}")

    def test_window_dates_parse_and_belong_to_real_windows(self):
        # CAS-999: update_window_dates() stamps every status value it sees, including "released" —
        # a NON_WINDOW_STATUSES entry is still a real first-seen date worth keeping, just not one of
        # the journey WINDOWS.
        bad = []
        for m in self.movies:
            for window, raw in (m.get("window_dates") or {}).items():
                if window not in WINDOWS and window not in NON_WINDOW_STATUSES:
                    bad.append((m["title"], window, "unknown window"))
                elif parse_date(raw) is None:
                    bad.append((m["title"], window, raw))
        self.assertEqual(bad, [], f"bad window_dates: {bad[:5]}")

    def test_no_window_is_stamped_before_the_film_opened(self):
        # A film cannot be at home before it came out, so no post-cinema stamp may precede cinema_date.
        #
        # This replaces an assertion I wrote first and had to throw away: that window_dates must run in journey
        # order. It fails on 13 titles (Furiosa is stamped streaming 20 Jul, rental 22 Jul) and the data is
        # right — window_dates records when CASCADE FIRST SAW the film in each window, not when the film moved.
        # A title already on a subscription when we started polling it gets its streaming stamp first, and a
        # rental offer appearing later is a real, later observation. Worth writing down, because "these dates
        # are the journey" is the natural reading and it is wrong.
        bad = []
        for m in self.movies:
            opened = parse_date(m.get("cinema_date"))
            if not opened:
                continue
            for window, raw in (m.get("window_dates") or {}).items():
                if window == "upcoming":
                    continue                      # the pre-release stamp is legitimately before the opening
                stamped = parse_date(raw)
                if stamped and stamped < opened:
                    bad.append((m["title"], window, raw, m["cinema_date"]))
        self.assertEqual(bad, [], f"windows stamped before the film opened: {bad[:5]}")


class ScoresAreCredible(unittest.TestCase):
    """CAS-156: a score printed on a card is a claim about consensus, so it needs a crowd behind it.

    CAS-938: the OMDb-sourced imdb_rating/imdb_votes/rt_critic/metacritic fields this class checked
    are retired from the pipeline — critic/audience scores are Watchmode's now (CAS-919/920)."""

    @classmethod
    def setUpClass(cls):
        cls.movies = load()["movies"]

    def test_popularity_is_a_non_negative_number_where_present(self):
        bad = [(m["title"], m.get("popularity")) for m in self.movies
               if m.get("popularity") is not None
               and (not isinstance(m["popularity"], (int, float)) or m["popularity"] < 0)]
        self.assertEqual(bad, [], f"bad popularity values: {bad[:5]}")

    def test_money_figures_are_not_negative(self):
        bad = []
        for m in self.movies:
            for field in ("budget", "worldwide_gross"):
                v = m.get(field)
                if v is not None and (not isinstance(v, (int, float)) or v < 0):
                    bad.append((m["title"], field, v))
        self.assertEqual(bad, [], f"negative or non-numeric money: {bad[:5]}")

    def test_an_award_claim_carries_its_text(self):
        # The card prints the award line verbatim; a truthy `award` with nothing to print would be an
        # unsupported claim of the exact kind the honesty guardrail forbids.
        bad = [m["title"] for m in self.movies
               if m.get("award") and not (m.get("award_text") or "").strip()]
        self.assertEqual(bad, [], f"award claims with no award text: {bad[:5]}")


class OnlyFloorQualifyingTitlesPublish(unittest.TestCase):
    """CAS-1031: CAS-986/CAS-997's publication floor (WM_PUBLISH_FLOOR) is the promise that
    movies.json holds only titles the shipped engine calls scoreable today (upcoming/cinema buzz
    exempt, everything else needs wmQScore >= the floor). Runs the same real engine call
    apply_two_tier_publication itself makes (poc_pipeline.scoreable_ids -> scripts/
    scoreable_shim.mjs -> isScoreable) against the whole published catalogue, so a regression that
    republishes a below-floor title is caught here rather than assumed from the pipeline's intent.

    CAS-1232: judged as of the catalogue's OWN build date (this file's "generated" stamp), never
    the test runner's wall clock/timezone — a film's score decays with time, so between daily
    refreshes a title can cross below the floor on its own with no code change, which used to turn
    this gate red for a reason that was never a regression (see that ticket's own proof)."""

    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.movies = cls.doc["movies"]

    def test_every_published_film_clears_the_publish_floor(self):
        # CAS-1067: a below-floor title can stay published indefinitely by design when a user
        # holds state on it (select_publishable's own held_ids exemption) — encode that same
        # exemption, from the same source of truth, rather than treating it as an offender.
        today = parse_date(self.doc.get("generated"))
        scoreable = pp.scoreable_ids(self.movies, floor=pp.WM_PUBLISH_FLOOR,
                                     today=today.isoformat() if today else None)
        held_ids = pp.load_user_held_ids()
        offenders = [m.get("title", m.get("tmdb_id")) for m in self.movies
                    if m["tmdb_id"] not in scoreable
                    and not (held_ids is None or str(m["tmdb_id"]) in held_ids)]
        self.assertEqual(offenders, [],
                         f"published films that fail WM_PUBLISH_FLOOR={pp.WM_PUBLISH_FLOOR} and aren't user-held: {offenders[:5]}")


class DataCompleteness(unittest.TestCase):
    """CAS-255: the fields the UI leans on, measured over the films the UI can actually show.

    The classes above ask whether each record is COHERENT. This one asks whether it is COMPLETE enough for the
    screen it lands on — which is the shape of the defects Lee has been finding by hand. "Dr Doom has no budget
    so the scale dial dropped it" is not an incoherent record; it is a missing field the engine had no fallback
    for. A sweep is the only way to see that class coming, because the record that breaks is always the one
    nobody thought to open.

    Two rules keep it useful:

    * The population is the SHOWABLE catalogue, not the whole file. Half of movies.json is titles no screen can
      reach (estimated availability, no offers), and letting those set the denominator would mean the numbers
      moved for reasons the user never sees.
    * Anything not at zero today is a RATCHET, not a target: the ceiling sits above today's measurement, the
      failure message prints what it actually is, and the test's job is to catch the number climbing. A hard
      zero is used only where the field is genuinely universal today, so that it stays that way.
    """

    # Today's measurements, over 1,050 showable titles of 1,961 (2026-07-30). Ceilings are set with headroom
    # for ordinary daily drift and tight enough that a real regression trips them.
    # CAS-938: imdb_rating's ceiling is retired along with the OMDb field itself — the pipeline no
    # longer populates it on any record, so "missing" is now the field's permanent, correct state.
    # CAS-1043: age_rating/cinema_date both come from TMDB's AU release_dates entries, which only
    # ever exist for a title that had (or is booked for) an AU theatrical release. CAS-1024's
    # back-catalogue dispatch has since made VOD-only titles the majority of the showable catalogue
    # (4,104 of 5,578 showable on 2026-09-20, 73.6%), and those titles structurally cannot carry
    # either field — no amount of backfill will find an AU classification for a film that was never
    # classified for an AU cinema release. Split by cohort on that same date: titles that ever had
    # an AU cinema release (or are upcoming toward one) are missing age_rating 12.5% (184/1,474) and
    # cinema_date 5.6% (88/1,571) — in line with the old baseline; back-catalogue-only titles are
    # missing them 84.2% (3,454/4,104) and 97.9% (3,923/4,007). The ceilings below are raised to the
    # new blended baseline (with headroom), not the old cinema-only one, since the failure is a
    # population shift CAS-986/CAS-1024 already intended, not a backfill regression.
    CEILINGS = {
        "age_rating": 70.0,    # 65.2% today (was 16.2% pre-back-catalogue) — see CAS-1043 above
        "genres": 3.0,         # 1.1%  — a film with no genre can never match a genre-led recipe
        "poster": 3.0,         # 1.0%  — the card falls back to a placeholder
        "synopsis": 2.0,       # 0.1%  — the card has nothing to say about the film
        "cinema_date": 77.0,   # 71.9% today (was 0.3% pre-back-catalogue) — see CAS-1043 above;
                               # every estimated window date is derived from this one, but a
                               # back-catalogue title has real (not estimated) window_dates the
                               # moment an offer is observed, so it needs no estimate to fall back to
    }

    @classmethod
    def setUpClass(cls):
        cls.movies = load()["movies"]
        cls.showable = [m for m in cls.movies if cls.is_showable(m)]

    @staticmethod
    def is_showable(m):
        """The front end's showable(): unreleased, or confirmed with something real behind it."""
        held = set(m.get("status") or [])
        if "upcoming" in held:
            return True
        if m.get("availability_confidence") != "confirmed":
            return False
        return bool(m.get("offers")) or bool(held & CINEMA_WINDOWS)

    def missing_share(self, field, present):
        missing = [m.get("title") for m in self.showable if not present(m)]
        pct = 100.0 * len(missing) / len(self.showable)
        return missing, pct

    def test_the_showable_catalogue_is_a_real_population(self):
        # Every share below is a fraction of this, so a collapse here would make them all meaningless.
        self.assertGreater(len(self.showable), 100,
                           f"only {len(self.showable)} of {len(self.movies)} films are showable")

    def test_every_showable_film_carries_what_it_cannot_be_shown_without(self):
        # A title, a window and a language: without any one of these the film cannot be placed on the screen
        # at all — it has no name, no section, or no answer to the language filter. All three are universal
        # today, so they are asserted at zero rather than ratcheted.
        bad = []
        for m in self.showable:
            for field in ("title", "status", "language"):
                if not m.get(field):
                    bad.append((m.get("title") or m.get("tmdb_id"), field))
        self.assertEqual(bad, [], f"showable films missing a field they cannot be shown without: {bad[:5]}")

    def test_every_showable_film_gives_the_scale_dial_something_to_read(self):
        # CAS-238: the scale dial leans on budget, and half the showable catalogue has no budget figure. It
        # must therefore always have a fallback to read — worldwide gross, or failing that popularity — or the
        # dial becomes a filter on our own data gaps. Zero today, and it needs to stay zero for the inference
        # CAS-238 asks for to be possible at all.
        blind = [m["title"] for m in self.showable
                 if not (m.get("budget") or 0) > 0
                 and not (m.get("worldwide_gross") or 0) > 0
                 and not (m.get("popularity") or 0) > 0]
        self.assertEqual(blind, [], f"showable films with no signal of scale whatsoever: {blind[:5]}")

    def test_a_film_the_ui_offers_can_always_be_reached(self):
        # The other half of CAS-170, from the record's side: a showable film is a promise, and the promise is
        # kept by an offer, a cinema date, or being unreleased. Nothing else counts.
        bad = []
        for m in self.showable:
            held = set(m.get("status") or [])
            if "upcoming" in held:
                continue
            if m.get("offers"):
                continue
            if held & CINEMA_WINDOWS and m.get("cinema_date"):
                continue
            bad.append((m["title"], sorted(held)))
        self.assertEqual(bad, [], f"showable films with no way to reach them: {bad[:5]}")

    def test_optional_fields_are_not_getting_emptier(self):
        # One assertion per ratcheted field, reported together so a run says everything that moved rather than
        # only the first thing.
        present = {
            "age_rating": lambda m: bool(m.get("age_rating")),
            "genres": lambda m: bool(m.get("genres")),
            "poster": lambda m: bool(m.get("poster")),
            "synopsis": lambda m: bool(m.get("synopsis")),
            "cinema_date": lambda m: bool(m.get("cinema_date")),
        }
        over = []
        for field, ceiling in sorted(self.CEILINGS.items()):
            missing, pct = self.missing_share(field, present[field])
            if pct > ceiling:
                over.append(f"{field}: {len(missing)} of {len(self.showable)} showable films "
                            f"({pct:.1f}%) have none, over the {ceiling}% ceiling — e.g. {missing[:3]}")
        self.assertEqual(over, [], "the catalogue has got emptier:\n  " + "\n  ".join(over))

    def test_an_offer_names_a_service_a_person_could_pick(self):
        # "Only show films on my services" matches on the service NAME, so a blank or non-string name is a film
        # that can never satisfy the scope no matter what the user picks — it just quietly vanishes.
        bad = []
        for m in self.showable:
            for o in m.get("offers") or []:
                name = o.get("service")
                if not isinstance(name, str) or not name.strip():
                    bad.append((m["title"], repr(name)))
        self.assertEqual(bad, [], f"offers with no service to pick: {bad[:5]}")


if __name__ == "__main__":
    unittest.main()
