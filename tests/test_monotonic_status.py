"""CAS-355 — availability status must move MONOTONICALLY (toward more availability), and the
alert path must never fire for a backward move.

Per the CAS-334 appraisal (docs/appraisals/cas334-data-accuracy.md): 39% of recorded status
transitions were backward, and 80 real downgrade alerts were driven by a title's status flapping
across a transient AU-provider gap (JustWatch briefly drops a title's rows, then picks it back up
the next day) rather than any real change in the film's availability.

Covers the two places a status transition gets decided, which both read/write the SAME status
field and must agree on what counts as "forward":
  - poc_pipeline.apply_monotonic_status / diff_and_alert (the writer + its own alert log)
  - monitor.compute_transitions (the real alert path — CAS-84/CAS-85/CAS-86)
"""
import datetime
import os
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp
from monitor.transitions import compute_transitions


def _title(tmdb_id=1, **kw):
    m = {"tmdb_id": tmdb_id, "imdb_id": f"tt{tmdb_id:07d}", "title": f"Film {tmdb_id}",
         "cinema_date": "2025-01-01", "popularity": 10.0,
         "status": ["included_streaming"], "availability_confidence": "confirmed",
         "offers": []}
    m.update(kw)
    return m


class TierRankIsTheSingleCanonicalOrder(unittest.TestCase):
    def test_order_runs_least_to_most_available(self):
        self.assertEqual(pp.AVAILABILITY_TIERS,
                          ["upcoming", "in_cinema", "pvod", "rental", "included_streaming"])

    def test_rank_picks_the_highest_tier_present(self):
        self.assertEqual(pp.tier_rank(["upcoming"]), 0)
        self.assertEqual(pp.tier_rank(["rental", "pvod"]), 3)
        self.assertEqual(pp.tier_rank(["included_streaming"]), 4)

    def test_rank_of_nothing_recognised_is_minus_one(self):
        self.assertEqual(pp.tier_rank([]), -1)
        self.assertEqual(pp.tier_rank(["past_opening"]), -1)   # a moment, not a tier a film holds


class ApplyMonotonicStatus(unittest.TestCase):
    """Direct unit tests of the guard poc_pipeline writes m['status'] through."""

    def test_first_sighting_commits_whatever_it_is(self):
        m = {}
        pp.apply_monotonic_status(m, ["rental"], "confirmed", datetime.date(2026, 8, 1))
        self.assertEqual(m["status"], ["rental"])
        self.assertEqual(m["availability_confidence"], "confirmed")

    def test_a_forward_move_commits_immediately(self):
        m = {"status": ["rental"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["included_streaming"], "confirmed", datetime.date(2026, 8, 1))
        self.assertEqual(m["status"], ["included_streaming"])
        self.assertNotIn("pending_downgrade", m)

    def test_a_single_backward_read_is_held_back(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 1))
        self.assertEqual(m["status"], ["included_streaming"])              # unchanged
        self.assertEqual(m["availability_confidence"], "confirmed")        # not clobbered either
        self.assertEqual(m["pending_downgrade"], {"to": ["rental"], "runs": 1, "since": "2026-08-01"})

    def test_the_same_backward_read_repeated_confirms_after_N_runs(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 1))
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 2))
        self.assertEqual(m["status"], ["rental"])                          # genuine regression lands
        self.assertEqual(m["availability_confidence"], "estimated")
        self.assertNotIn("pending_downgrade", m)

    def test_a_recovering_read_between_two_gaps_never_confirms(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 1))        # gap
        pp.apply_monotonic_status(m, ["included_streaming"], "confirmed", datetime.date(2026, 8, 2))  # recovers
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 3))        # gap again
        self.assertEqual(m["status"], ["included_streaming"])              # still held — count restarted
        self.assertEqual(m["pending_downgrade"]["runs"], 1)

    def test_a_different_backward_candidate_restarts_the_count(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 1))
        pp.apply_monotonic_status(m, ["pvod"], "estimated", datetime.date(2026, 8, 2))
        self.assertEqual(m["status"], ["included_streaming"])
        self.assertEqual(m["pending_downgrade"], {"to": ["pvod"], "runs": 1, "since": "2026-08-02"})


class ComputeTransitionsOnlyFiresForward(unittest.TestCase):
    """Belt-and-braces at the monitor layer — the ticket names both poc_pipeline.py and the
    monitor module as needing the fix, since a real alert is sent from here (CAS-85/CAS-86),
    not from poc_pipeline's own state/alerts.json log."""

    def test_a_lower_tier_landing_is_never_alerted(self):
        # The exact CAS-334 finding: a title held included_streaming, a provider-feed gap made
        # the next read rental-only, and the old code fired hits_rent as if rental were a gain.
        prev = [{"tmdb_id": 1, "title": "Tilly", "status": ["included_streaming"], "offers": []}]
        today = [{"tmdb_id": 1, "title": "Tilly", "status": ["rental"],
                  "offers": [{"service": "Prime Video", "type": "rent", "price": 6.99}]}]
        transitions = compute_transitions(prev, today, datetime.date(2026, 8, 1))
        self.assertEqual(transitions, [])

    def test_a_genuine_forward_move_still_fires_exactly_once(self):
        prev = [{"tmdb_id": 2, "title": "Real Riser", "status": ["rental"], "offers": []}]
        today = [{"tmdb_id": 2, "title": "Real Riser", "status": ["included_streaming"],
                  "offers": [{"service": "Stan", "type": "sub", "price": None}]}]
        transitions = compute_transitions(prev, today, datetime.date(2026, 8, 1))
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0].moment, "hits_stream")

    def test_a_status_already_held_is_never_refired_by_a_neighbouring_loss(self):
        # Held BOTH rental and streaming, loses rental (streaming untouched) -> nothing to alert:
        # streaming was already there, and rental disappearing is a loss, not a gain.
        prev = [{"tmdb_id": 3, "title": "Dual Window", "status": ["rental", "included_streaming"],
                 "offers": []}]
        today = [{"tmdb_id": 3, "title": "Dual Window", "status": ["included_streaming"],
                  "offers": [{"service": "Stan", "type": "sub", "price": None}]}]
        transitions = compute_transitions(prev, today, datetime.date(2026, 8, 1))
        self.assertEqual(transitions, [])


class TransientProviderDropEndToEnd(unittest.TestCase):
    """The CAS-355 acceptance-criterion #4 sequence, exercised across the real write path
    (poc_pipeline.build_live_catalogue) and the real alert log (poc_pipeline.diff_and_alert)
    together: a transient provider drop must not regress status or fire an alert; a genuine
    forward move must fire exactly one."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        state_dir = self._tmp.name
        patches = [
            mock.patch.object(pp, "STATE_DIR", state_dir),
            mock.patch.object(pp, "SNAPSHOT_FILE", os.path.join(state_dir, "last_snapshot.json")),
            mock.patch.object(pp, "ALERTS_FILE", os.path.join(state_dir, "alerts.json")),
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            # CAS-772: these fixtures predate cache_stamped_at, so every title looks due for
            # revalidation — turn the sweep off; it is orthogonal to this class and must not make
            # a real, unmocked network call in these tests.
            mock.patch.object(pp, "REVALIDATION_DAILY_BUDGET", 0),
            # CAS-379: this fixture's titles predate cinema_release too; a no-op keeps that
            # back-fill path (orthogonal to what this class tests) from hitting the network.
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def _poll_day(self, day, base, has_rows):
        with mock.patch.object(pp, "tmdb_providers", lambda tid: {"jw_link": None}), \
             mock.patch.object(pp, "has_provider_rows", lambda p: has_rows), \
             mock.patch.object(pp, "provider_offers",
                               lambda p: [{"service": "Netflix", "type": "sub",
                                           "price": None, "format": None}]), \
             mock.patch.object(pp, "derive_from_providers", lambda m, p, t: ["included_streaming"]), \
             mock.patch.object(pp.ps, "estimate_status", lambda m, t, offsets: ("rental", "estimated")):
            catalogue, _ = pp.build_live_catalogue(day, base, {}, ondemand_ids=[])
        return catalogue

    def test_a_transient_gap_does_not_regress_status_or_fire_an_alert(self):
        day0 = [_title(1, status=["included_streaming"])]
        pp.diff_and_alert(day0)                                          # seeds "yesterday"

        day1 = self._poll_day(datetime.date(2026, 8, 1), day0, has_rows=False)   # the gap
        events = pp.diff_and_alert(day1)

        self.assertEqual(day1[0]["status"], ["included_streaming"])      # (a) held, not demoted
        self.assertEqual(events, [])                                     # (b) nothing to alert

    def test_a_genuine_forward_move_fires_exactly_one_alert(self):
        day0 = [_title(1, status=["rental"], offers=[])]
        pp.diff_and_alert(day0)

        day1 = self._poll_day(datetime.date(2026, 8, 1), day0, has_rows=True)    # a real gain
        events = pp.diff_and_alert(day1)

        self.assertEqual(day1[0]["status"], ["included_streaming"])
        arrivals = [e for e in events if e["kind"] == "arrived"]
        self.assertEqual(len(arrivals), 1)
        self.assertEqual(arrivals[0]["new_window"], "included_streaming")
        # CAS-578 R4: rental is real news too — the film genuinely left it the same run streaming
        # arrived, so a paired "left" event is expected here, not a bug.
        departures = [e for e in events if e["kind"] == "left"]
        self.assertEqual(len(departures), 1)
        self.assertEqual(departures[0]["lost_window"], "rental")


class ZeroAuRowsNeverInventAPaidTier(unittest.TestCase):
    """CAS-412: when TMDB/JustWatch AU returns literally no provider row, there is no real offer
    to back a home window. The old code fell to estimate_status's age ladder here, which — once
    a title outlived the 14-day in-cinema estimate cap — guessed "pvod" out of thin air and then
    kept re-guessing the SAME "pvod" every subsequent run (the ladder never ages back down), so a
    title that lost its only offer got stranded above the cinema window forever. This exercises
    the real write path (poc_pipeline.build_live_catalogue), mocking only the network call."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        state_dir = self._tmp.name
        empty_prov = {"flatrate": [], "rent": [], "buy": [], "ads": [], "free": [], "jw_link": None}
        patches = [
            mock.patch.object(pp, "STATE_DIR", state_dir),
            mock.patch.object(pp, "SNAPSHOT_FILE", os.path.join(state_dir, "last_snapshot.json")),
            mock.patch.object(pp, "ALERTS_FILE", os.path.join(state_dir, "alerts.json")),
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            # CAS-772: these fixtures predate cache_stamped_at, so every title looks due for
            # revalidation — turn the sweep off; it is orthogonal to this class and must not make
            # a real, unmocked network call in these tests.
            mock.patch.object(pp, "REVALIDATION_DAILY_BUDGET", 0),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "tmdb_providers", lambda tid: empty_prov),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_a_title_with_no_offers_and_a_past_cinema_date_settles_on_in_cinema(self):
        # The Odyssey (CAS-412): a real buy/rent offer once put it at pvod, that offer is gone,
        # AU now returns zero rows outright, and the title opened 21 days ago — past the old
        # ladder's 14-day in-cinema cap, which used to make it read "pvod" with zero offers.
        opened_21_days_ago = (datetime.date(2026, 8, 6) - datetime.timedelta(days=21)).isoformat()
        base = [_title(1, status=["pvod"], cinema_date=opened_21_days_ago, offers=[])]

        day1, _ = pp.build_live_catalogue(datetime.date(2026, 8, 6), base, {}, ondemand_ids=[])
        self.assertEqual(day1[0]["status"], ["pvod"])                # first zero-offer read: held (CAS-355)
        self.assertEqual(day1[0]["offers"], [])
        self.assertEqual(day1[0]["pending_downgrade"]["to"], ["in_cinema"])

        day2, _ = pp.build_live_catalogue(datetime.date(2026, 8, 7), day1, {}, ondemand_ids=[])
        self.assertEqual(day2[0]["status"], ["in_cinema"])           # same candidate again: confirmed
        self.assertNotIn("pending_downgrade", day2[0])


class AHeldDowngradeKeepsItsOffers(unittest.TestCase):
    """CAS-1008 (D1/D2, prod QA-260917-1): apply_monotonic_status can hold a backward move back —
    m["status"] then still reads yesterday's CONFIRMED tier — but the old build_live_catalogue code
    overwrote m["offers"] with today's real (lesser) read regardless of that hold. Two live symptoms:
    a held pvod/rental/included_streaming sitting next to zero offers (AU returned no rows at all),
    and a held included_streaming sitting next to a rent-only offer list (AU still has a row, just
    not a sub/free one). Offers must move in lockstep with status: stay put while held, update only
    once the candidate is actually committed."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        state_dir = self._tmp.name
        patches = [
            mock.patch.object(pp, "STATE_DIR", state_dir),
            mock.patch.object(pp, "SNAPSHOT_FILE", os.path.join(state_dir, "last_snapshot.json")),
            mock.patch.object(pp, "ALERTS_FILE", os.path.join(state_dir, "alerts.json")),
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            mock.patch.object(pp, "REVALIDATION_DAILY_BUDGET", 0),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_a_home_window_held_pending_keeps_its_prior_offers_not_zero(self):
        # NXT Heatwave 2026 (CAS-1008 D1): a real buy offer once put it at pvod; today's AU read
        # comes back with zero provider rows at all, which is a backward move that must be held —
        # so the record must still carry the offer that backs the pvod it's still claiming.
        still_running = (datetime.date(2026, 8, 6) - datetime.timedelta(days=10)).isoformat()
        prior_offer = {"service": "Prime Video", "type": "buy", "price": 24.99, "format": "HD"}
        base = [_title(1, status=["pvod"], cinema_date=still_running, offers=[prior_offer])]
        empty_prov = {"flatrate": [], "rent": [], "buy": [], "ads": [], "free": [], "jw_link": None}

        with mock.patch.object(pp, "tmdb_providers", lambda tid: empty_prov):
            day1, _ = pp.build_live_catalogue(datetime.date(2026, 8, 6), base, {}, ondemand_ids=[])

        self.assertEqual(day1[0]["status"], ["pvod"])                 # held, not demoted to in_cinema
        self.assertIn("pending_downgrade", day1[0])
        self.assertEqual(day1[0]["offers"], [prior_offer])            # NOT wiped to []

    def test_included_streaming_held_pending_keeps_its_sub_offer_not_rent_only(self):
        # Migration (CAS-1008 D2): a real sub offer once put it at included_streaming; today's AU
        # read still has a row, but only a rent one — a backward move that must be held, so the
        # record must still carry a sub/free offer while it still claims included_streaming.
        sub_offer = {"service": "Netflix", "type": "sub", "price": None, "format": None}
        base = [_title(1, status=["included_streaming"], offers=[sub_offer])]
        rent_only_prov = {"flatrate": [], "rent": ["Prime Video"], "buy": [], "ads": [], "free": [],
                           "jw_link": None}

        with mock.patch.object(pp, "tmdb_providers", lambda tid: rent_only_prov):
            day1, _ = pp.build_live_catalogue(datetime.date(2026, 8, 6), base, {}, ondemand_ids=[])

        self.assertEqual(day1[0]["status"], ["included_streaming"])   # held, not demoted to rental
        self.assertIn("pending_downgrade", day1[0])
        self.assertTrue(any(o.get("type") in ("sub", "free") for o in day1[0]["offers"]))

        # A SECOND run repeating the same rent-only read confirms the downgrade — now, and only
        # now, the offers must catch up to reflect the real, current (offer-honest) state.
        with mock.patch.object(pp, "tmdb_providers", lambda tid: rent_only_prov):
            day2, _ = pp.build_live_catalogue(datetime.date(2026, 8, 7), day1, {}, ondemand_ids=[])

        self.assertEqual(day2[0]["status"], ["rental"])
        self.assertNotIn("pending_downgrade", day2[0])
        self.assertEqual([o["type"] for o in day2[0]["offers"]], ["rent"])


class AnEstimatedTierIsNotOwedTheTransientGapHold(unittest.TestCase):
    """CAS-418: apply_monotonic_status's 2-run hold exists to protect a CONFIRMED tier (a real
    offer) from a one-day AU-feed gap (CAS-355, exercised above). A tier stamped "estimated" was
    never backed by a real offer, so — unlike the CAS-412 case above, whose base title carries
    the default "confirmed" confidence — it must not wait for DOWNGRADE_CONFIRM_RUNS either:
    908 titles on live were frozen exactly this way (CAS-418), some indefinitely, because a
    failed poll never advances the counter."""

    def test_a_backward_move_off_an_estimated_tier_commits_on_the_first_read(self):
        m = {"status": ["pvod"], "availability_confidence": "estimated"}
        pp.apply_monotonic_status(m, ["in_cinema"], "estimated", datetime.date(2026, 8, 7))
        self.assertEqual(m["status"], ["in_cinema"])
        self.assertNotIn("pending_downgrade", m)

    def test_a_confirmed_tier_is_unaffected_and_still_held(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 7))
        self.assertEqual(m["status"], ["included_streaming"])
        self.assertIn("pending_downgrade", m)


class DeriveFromProvidersFallbackRespectsTheCinemaRun(unittest.TestCase):
    """CAS-418 item 4: the offer-less fallback used to key off `opened` (cinema_date <= today),
    so a title that left cinemas years ago and lost its only offer read as "in_cinema" right
    now — turning a phantom-streaming title into an equally phantom in-cinema one. It must key
    off `still_running` (the same CINEMA_RUN_DAYS test the branch above it uses) instead."""

    def test_offer_less_and_still_within_its_run_reads_in_cinema(self):
        recent = (datetime.date(2026, 8, 7) - datetime.timedelta(days=10)).isoformat()
        windows = pp.derive_from_providers({"cinema_date": recent}, {}, datetime.date(2026, 8, 7))
        self.assertEqual(windows, ["in_cinema"])

    def test_offer_less_and_long_past_its_run_does_not_read_in_cinema(self):
        long_ago = (datetime.date(2026, 8, 7) - datetime.timedelta(days=400)).isoformat()
        windows = pp.derive_from_providers({"cinema_date": long_ago}, {}, datetime.date(2026, 8, 7))
        self.assertNotIn("in_cinema", windows)


class AFailedPollDoesNotFreezeAPhantomTierEither(unittest.TestCase):
    """CAS-418 item 3: a title already stuck on an offer-less "estimated" tier must heal even
    when TODAY's poll fails outright, not just when it succeeds with zero AU rows — otherwise an
    intermittently-failing provider call is exactly how a title got stranded indefinitely in the
    first place (the counter in test_pipeline_resilience's "failing provider call" case only
    protects a CONFIRMED tier, unaffected by this)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        state_dir = self._tmp.name
        patches = [
            mock.patch.object(pp, "STATE_DIR", state_dir),
            mock.patch.object(pp, "SNAPSHOT_FILE", os.path.join(state_dir, "last_snapshot.json")),
            mock.patch.object(pp, "ALERTS_FILE", os.path.join(state_dir, "alerts.json")),
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            # CAS-772: these fixtures predate cache_stamped_at, so every title looks due for
            # revalidation — turn the sweep off; it is orthogonal to this class and must not make
            # a real, unmocked network call in these tests.
            mock.patch.object(pp, "REVALIDATION_DAILY_BUDGET", 0),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "tmdb_providers",
                               mock.Mock(side_effect=RuntimeError("network down"))),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_a_failed_poll_still_heals_an_offer_less_paid_tier(self):
        long_ago = (datetime.date(2026, 8, 7) - datetime.timedelta(days=400)).isoformat()
        base = [_title(1, status=["included_streaming"], cinema_date=long_ago,
                        availability_confidence="estimated", offers=[])]

        day1, _ = pp.build_live_catalogue(datetime.date(2026, 8, 7), base, {}, ondemand_ids=[])

        self.assertNotIn("included_streaming", day1[0]["status"])    # no offer ever backed it
        self.assertEqual(day1[0]["offers"], [])
        self.assertNotIn("pending_downgrade", day1[0])


class UpcomingLatchNeverTrapsAReleasedTitle(unittest.TestCase):
    """CAS-472: poll_scheduler.classify_tier used to also read `status == {"upcoming"}` alone as
    "none" (never polled again), with no check that the title had actually not opened yet. Once a
    title regressed all the way to upcoming for ANY reason — a real AU delisting past its cinema
    run, or this bug feeding itself — it got permanently stuck: poll_tier "none" is the only thing
    poc_pipeline.build_live_catalogue's `tier == "none"` branch checks before blindly re-stamping
    status=["upcoming"]/availability_confidence="confirmed" every run, with no provider poll to ever
    learn otherwise. 789 live titles were found latched exactly this way (e.g. "Perfect Marble",
    tmdb_id 1680044 — window_dates carried in_cinema/included_streaming stamps from real earlier
    runs, but status stayed frozen at upcoming indefinitely)."""

    def test_classify_tier_is_never_none_once_the_cinema_date_has_passed(self):
        long_ago = (datetime.date(2026, 8, 12) - datetime.timedelta(days=600)).isoformat()
        m = {"status": ["upcoming"], "cinema_date": long_ago}
        self.assertNotEqual(pp.ps.classify_tier(m, datetime.date(2026, 8, 12)), "none")

    def test_classify_tier_still_skips_a_title_that_has_not_opened_yet(self):
        not_yet = (datetime.date(2026, 8, 12) + datetime.timedelta(days=10)).isoformat()
        m = {"status": ["upcoming"], "cinema_date": not_yet}
        self.assertEqual(pp.ps.classify_tier(m, datetime.date(2026, 8, 12)), "none")

    def test_classify_tier_still_skips_a_title_with_no_cinema_date_known_at_all(self):
        m = {"status": ["upcoming"], "cinema_date": None}
        self.assertEqual(pp.ps.classify_tier(m, datetime.date(2026, 8, 12)), "none")

    def test_classify_tier_is_never_none_once_the_titles_own_year_has_passed(self):
        # CAS-1078: a back-catalogue title with no AU cinema_date AT ALL used to read the same as a
        # genuinely-unannounced one — "none" forever — even when its own release year had already
        # passed and no AU release_dates entry (any type) was still ahead of us.
        m = {"status": ["upcoming"], "cinema_date": None, "year": "2018", "release_dates": []}
        self.assertNotEqual(pp.ps.classify_tier(m, datetime.date(2026, 9, 27)), "none")

    def test_classify_tier_still_skips_a_title_with_no_year_known_at_all(self):
        m = {"status": ["upcoming"], "cinema_date": None, "release_dates": []}
        self.assertEqual(pp.ps.classify_tier(m, datetime.date(2026, 9, 27)), "none")

    def test_classify_tier_still_skips_a_title_whose_year_has_not_arrived_yet(self):
        m = {"status": ["upcoming"], "cinema_date": None, "year": "2027", "release_dates": []}
        self.assertEqual(pp.ps.classify_tier(m, datetime.date(2026, 9, 27)), "none")

    def test_classify_tier_still_skips_an_old_year_title_with_a_future_au_release_date(self):
        # A digital-only AU date can be announced with no theatrical cinema_date behind it at all.
        m = {"status": ["upcoming"], "cinema_date": None, "year": "2018",
             "release_dates": [{"region": "AU", "type": 4, "date": "2026-12-01"}]}
        self.assertEqual(pp.ps.classify_tier(m, datetime.date(2026, 9, 27)), "none")


class ALatchedUpcomingTitleSelfCorrectsOnTheNextRun(unittest.TestCase):
    """The end-to-end version of the fix above, exercised through the real write path
    (poc_pipeline.build_live_catalogue): a title shaped exactly like the live "Perfect Marble"
    record must get a real provider poll instead of being silently re-stamped upcoming again."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        state_dir = self._tmp.name
        streaming_prov = {"flatrate": [{"service": "Netflix"}], "rent": [], "buy": [],
                           "ads": [], "free": [], "jw_link": None}
        patches = [
            mock.patch.object(pp, "STATE_DIR", state_dir),
            mock.patch.object(pp, "SNAPSHOT_FILE", os.path.join(state_dir, "last_snapshot.json")),
            mock.patch.object(pp, "ALERTS_FILE", os.path.join(state_dir, "alerts.json")),
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            # CAS-772: these fixtures predate cache_stamped_at, so every title looks due for
            # revalidation — turn the sweep off; it is orthogonal to this class and must not make
            # a real, unmocked network call in these tests.
            mock.patch.object(pp, "REVALIDATION_DAILY_BUDGET", 0),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "tmdb_providers", lambda tid: streaming_prov),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_a_released_title_latched_at_upcoming_gets_polled_and_advances(self):
        long_ago = (datetime.date(2026, 8, 12) - datetime.timedelta(days=600)).isoformat()
        base = [_title(1, status=["upcoming"], cinema_date=long_ago,
                        availability_confidence="confirmed", offers=[])]

        day1, _ = pp.build_live_catalogue(datetime.date(2026, 8, 12), base, {}, ondemand_ids=[])

        self.assertEqual(day1[0]["poll_tier"], "slow")                # no longer latched at "none"
        self.assertEqual(day1[0]["status"], ["included_streaming"])   # the real offer, found and committed
        self.assertTrue(day1[0]["offers"])


class DiffAndAlertEmitsDepartures(unittest.TestCase):
    """CAS-578 R4/AC4: a film LEAVING a window is exactly as interesting as one entering it, and
    diff_and_alert must say so — the flip side of the "arrived" events it has always emitted."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        state_dir = self._tmp.name
        patches = [
            mock.patch.object(pp, "STATE_DIR", state_dir),
            mock.patch.object(pp, "SNAPSHOT_FILE", os.path.join(state_dir, "last_snapshot.json")),
            mock.patch.object(pp, "ALERTS_FILE", os.path.join(state_dir, "alerts.json")),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_a_confirmed_loss_emits_a_left_event(self):
        # The CAS-578 D2 shape: a title held included_streaming, its sub offer is gone, and this run's
        # committed status (post monotonic-guard) genuinely no longer holds the window.
        day0 = [_title(1, status=["included_streaming"])]
        pp.diff_and_alert(day0)

        day1 = [_title(1, status=["in_cinema"], offers=[])]
        events = pp.diff_and_alert(day1)

        left = [e for e in events if e["kind"] == "left"]
        self.assertEqual(len(left), 1)
        self.assertEqual(left[0]["lost_window"], "included_streaming")
        self.assertEqual(left[0]["tmdb_id"], 1)

    def test_a_title_gaining_a_second_window_loses_nothing(self):
        day0 = [_title(1, status=["rental"])]
        pp.diff_and_alert(day0)

        day1 = [_title(1, status=["rental", "included_streaming"])]
        events = pp.diff_and_alert(day1)

        self.assertEqual([e for e in events if e["kind"] == "left"], [])

    def test_a_titles_first_sighting_never_emits_a_departure(self):
        day0 = [_title(1, status=["in_cinema"])]
        events = pp.diff_and_alert(day0)   # nothing "prior" to have left
        self.assertEqual([e for e in events if e["kind"] == "left"], [])


class WindowDatesAreCorrectableNotPermanent(unittest.TestCase):
    """CAS-578 R2/R3: window_dates must only stamp a home window (pvod/rental/included_streaming)
    when a real offer backs it THIS run, and must drop a stamp once the film has genuinely,
    monotonic-guard-confirmed left it — the D1 defect was setdefault() making every stamp
    permanent regardless of what later evidence said."""

    def test_a_home_window_is_never_stamped_without_an_offer(self):
        m = {"tmdb_id": 1, "title": "X", "status": ["rental"], "offers": []}
        wd = pp.update_window_dates([m], {}, {}, "2026-08-18")
        self.assertNotIn("rental", wd["1"])
        self.assertNotIn("rental", m["window_dates"])

    def test_a_home_window_is_stamped_when_a_real_offer_backs_it(self):
        m = {"tmdb_id": 1, "title": "X", "status": ["rental"],
             "offers": [{"service": "Amazon Video", "type": "rent", "price": 6.99}]}
        wd = pp.update_window_dates([m], {}, {}, "2026-08-18")
        self.assertEqual(wd["1"]["rental"], "2026-08-18")

    def test_the_earliest_corroborated_date_is_kept_not_overwritten(self):
        m = {"tmdb_id": 1, "title": "X", "status": ["rental"],
             "offers": [{"service": "Amazon Video", "type": "rent", "price": 6.99}]}
        wd = pp.update_window_dates([m], {"1": {"rental": "2026-07-01"}}, {}, "2026-08-18")
        self.assertEqual(wd["1"]["rental"], "2026-07-01")

    def test_a_confirmed_departure_drops_the_stamp(self):
        # Toy Story 5's exact shape: rental/included_streaming/pvod were stamped by the old bug,
        # status has since self-corrected to in_cinema, and nothing ever removed the old stamps —
        # this proves the writer now does, the moment a real prior/after diff shows the departure.
        prev_by_id = {1: {"status": ["included_streaming"]}}
        m = {"tmdb_id": 1, "title": "Toy Story 5", "status": ["in_cinema"], "offers": []}
        wd = pp.update_window_dates(
            [m], {"1": {"in_cinema": "2026-06-01", "included_streaming": "2026-07-23"}},
            prev_by_id, "2026-08-18")
        self.assertNotIn("included_streaming", wd["1"])
        self.assertEqual(wd["1"]["in_cinema"], "2026-06-01")    # untouched — offer-less by design

    def test_in_cinema_and_upcoming_are_never_gated_on_an_offer(self):
        m = {"tmdb_id": 1, "title": "X", "status": ["in_cinema"], "offers": []}
        wd = pp.update_window_dates([m], {}, {}, "2026-08-18")
        self.assertEqual(wd["1"]["in_cinema"], "2026-08-18")

    def test_a_later_cinema_date_correction_drops_a_stale_window_it_strands(self):
        # CAS-1043: Man of Valor's exact shape — in_cinema was stamped 2026-08-12, TMDB then
        # corrected cinema_date to a FUTURE 2026-11-12, and status reverted to upcoming. Re-stamping
        # to today wouldn't satisfy the invariant either (today is still before a future opening),
        # so a stamp for a window `status` no longer holds is dropped outright.
        m = {"tmdb_id": 1, "title": "Man of Valor", "status": ["upcoming"], "offers": [],
             "cinema_date": "2026-11-12"}
        wd = pp.update_window_dates([m], {"1": {"in_cinema": "2026-08-12"}}, {}, "2026-09-20")
        self.assertNotIn("in_cinema", wd["1"])

    def test_a_later_cinema_date_correction_restamps_a_window_still_held(self):
        # CAS-1043: Mr Adidos/Paroxysm's shape — in_cinema was stamped against an earlier
        # cinema_date, the date was corrected to a later (but already-past) date, and the film is
        # still, correctly, in_cinema today. The stale stamp is re-dated to today rather than left
        # stranded before the corrected opening.
        m = {"tmdb_id": 1, "title": "Mr Adidos", "status": ["in_cinema"], "offers": [],
             "cinema_date": "2026-08-27"}
        wd = pp.update_window_dates([m], {"1": {"in_cinema": "2026-07-22"}}, {}, "2026-09-20")
        self.assertEqual(wd["1"]["in_cinema"], "2026-09-20")

    def test_the_pre_release_upcoming_stamp_is_exempt_from_correction(self):
        m = {"tmdb_id": 1, "title": "X", "status": ["upcoming"], "offers": [],
             "cinema_date": "2026-11-12"}
        wd = pp.update_window_dates([m], {"1": {"upcoming": "2026-07-21"}}, {}, "2026-09-20")
        self.assertEqual(wd["1"]["upcoming"], "2026-07-21")   # legitimately before the film opened

    def test_a_window_stamped_after_cinema_date_is_left_alone(self):
        m = {"tmdb_id": 1, "title": "X", "status": ["in_cinema"], "offers": [],
             "cinema_date": "2026-08-01"}
        wd = pp.update_window_dates([m], {"1": {"in_cinema": "2026-08-05"}}, {}, "2026-09-20")
        self.assertEqual(wd["1"]["in_cinema"], "2026-08-05")   # already consistent — not touched


class MassStampGuardCatchesABadRun(unittest.TestCase):
    """CAS-578 R6/AC7: the guard that would have caught D1 before it ever reached the catalogue."""

    def test_a_run_that_would_move_more_than_the_threshold_share_is_refused(self):
        prev = {i: {"status": ["in_cinema"]} for i in range(100)}
        records = [{"tmdb_id": i, "status": ["rental"]} for i in range(100)]   # 100% -> rental
        with self.assertRaises(pp.MassStampGuardTripped):
            pp.check_mass_stamp_guard(records, prev)

    def test_an_ordinary_run_under_the_threshold_passes(self):
        prev = {i: {"status": ["in_cinema"]} for i in range(100)}
        records = [{"tmdb_id": i, "status": ["rental"] if i < 2 else ["in_cinema"]}
                   for i in range(100)]                                        # 2% -> rental
        pp.check_mass_stamp_guard(records, prev)   # must not raise

    def test_a_titles_first_sighting_never_counts_toward_the_guard(self):
        # CAS-128: lifting the catalogue cap moved thousands of titles from "doesn't exist yet"
        # into some window in one run — real catalogue growth, not a reclassification bug.
        records = [{"tmdb_id": i, "status": ["upcoming"]} for i in range(1000)]
        pp.check_mass_stamp_guard(records, {})   # must not raise


class MassStampGuardAcknowledgement(unittest.TestCase):
    """CAS-992 AC1/AC2 — state/mass_stamp_ack.json lets CAS-608's one-off ~951-title released
    reclassification through the CAS-578 guard exactly once, without weakening it for anything
    else. Reproduces daily.yml run #76's own numbers: 837 titles newly entering `released` out of
    5,999 total, threshold 299."""

    _ACK = {"window": "released", "max_titles": 1000, "valid_through": "2026-09-20",
            "reason": "CAS-608 reclassification"}

    def _run76_records(self, n_released, total=5999):
        prev = {i: {"status": ["upcoming"]} for i in range(total)}
        records = [{"tmdb_id": i, "status": ["released"] if i < n_released else ["upcoming"]}
                   for i in range(total)]
        return records, prev

    def test_the_acknowledged_window_passes_at_or_below_its_cap_and_on_or_before_valid_through(self):
        records, prev = self._run76_records(837)
        pp.check_mass_stamp_guard(records, prev, today=datetime.date(2026, 9, 16),
                                   ack=self._ACK)   # must not raise
        pp.check_mass_stamp_guard(records, prev, today=datetime.date(2026, 9, 20),
                                   ack=self._ACK)   # must not raise — valid_through is inclusive

    def test_a_run_date_after_valid_through_still_trips(self):
        records, prev = self._run76_records(837)
        with self.assertRaises(pp.MassStampGuardTripped):
            pp.check_mass_stamp_guard(records, prev, today=datetime.date(2026, 9, 21),
                                       ack=self._ACK)

    def test_a_count_over_max_titles_still_trips(self):
        records, prev = self._run76_records(1001)
        with self.assertRaises(pp.MassStampGuardTripped):
            pp.check_mass_stamp_guard(records, prev, today=datetime.date(2026, 9, 16),
                                       ack=self._ACK)

    def test_a_window_other_than_the_acknowledged_one_still_trips(self):
        prev = {i: {"status": ["upcoming"]} for i in range(100)}
        records = [{"tmdb_id": i, "status": ["rental"] if i < 50 else ["upcoming"]}
                   for i in range(100)]   # 50% -> rental, not the acknowledged "released" window
        with self.assertRaises(pp.MassStampGuardTripped):
            pp.check_mass_stamp_guard(records, prev, today=datetime.date(2026, 9, 16),
                                       ack=self._ACK)

    def test_no_acknowledgement_at_all_still_trips(self):
        records, prev = self._run76_records(837)
        with mock.patch.object(pp, "_load_mass_stamp_ack", return_value=None):
            with self.assertRaises(pp.MassStampGuardTripped):
                pp.check_mass_stamp_guard(records, prev, today=datetime.date(2026, 9, 16))

    def test_the_committed_acknowledgement_file_has_the_tickets_own_values(self):
        self.assertIsNone(pp._load_mass_stamp_ack())

    def test_with_no_committed_acknowledgement_run_76s_own_numbers_still_trip(self):
        # CAS-1060: the waiver was retired — state/mass_stamp_ack.json no longer exists, so the
        # guard is live again. End-to-end: no injected `ack`/`today` — reads the real (absent)
        # committed file and _RUN_DATE.
        records, prev = self._run76_records(837)
        with self.assertRaises(pp.MassStampGuardTripped):
            pp.check_mass_stamp_guard(records, prev)


if __name__ == "__main__":
    unittest.main()
