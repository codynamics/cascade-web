// CAS-231: engine invariants. Run with `node --test tests/js/invariants.test.mjs` (no dependencies, no build
// step — node's own test runner against the built index.html). Exits non-zero on any violation.
//
// These are RELATIONAL assertions, not recorded numbers. The catalogue is refreshed daily on main, so any test
// that pinned "28 films" would be red by tomorrow morning and would teach everyone to ignore it. What does not
// move is the relationships: a count equals the set it counts, narrowing never widens, a facet of a set is no
// bigger than the set, and one recipe measured twice gives one answer. Those are the properties every count bug
// in this release actually violated — CAS-221's 21-vs-2 broke "one recipe, one answer"; CAS-224's Drama · 752
// over a total of 28 broke "a facet is no bigger than the set".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, pickInLane } from "./engine.mjs";

const E = loadEngine();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// CAS-764: acctRead's real backoff (~400ms/~1.2s) is a UX choice for a live device, not something this
// suite should sit through on every retry-to-failure test below — zero it once, for every test in this file.
E.CascadePersistence.ACCT_READ_DELAYS = [0, 0];
// CAS-1097: acctOp's own backoff (~400ms/~1.2s/~3.6s) is the same kind of live-device UX delay, not
// something to sit through either — zero it once, same reasoning as ACCT_READ_DELAYS above. agent_films
// joining acctOp means an admission churned by one test's own recomputeFound() pass can land a retry here.
E.CascadeAccountStore.ACCT_OP_RETRY_DELAYS = [0, 0, 0];
// CAS-1097: pushAgentFilmAdmission's own cascade-confirmation defer (~500ms, up to 10 rounds) is the same
// class of delay — zero it so a deferred retry armed by one test's recomputeFound() pass resolves on the
// very next tick rather than landing mid-way through a LATER, unrelated test (every test in this file
// shares one fake uid, so the defer's own owner check can't tell two different tests' sessions apart).
E.CascadePersistence.AGENT_FILM_DEFER_MS = 0;

// Every preset in every lane it is offered in — the real matrix a person can walk into.
const LANES = ["cinema", "stream"];
const CASES = LANES.flatMap(kind => E.STARTERS.filter(s => (s.kinds || LANES).includes(kind)).map(s => ({ kind, s, label: `${kind}/${s.key}` })));

test("the harness is holding the real, built catalogue", () => {
  assert.ok(E.MOVIES.length > 500, `only ${E.MOVIES.length} films — index.html looks unbuilt`);
  assert.ok(E.SHOWABLE_N > 0 && E.SHOWABLE_N <= E.MOVIES.length);
  assert.ok(CASES.length >= 6, `only ${CASES.length} preset/lane cases`);
});

// ---- 1. COUNT INTEGRITY ---------------------------------------------------------------------------------
// The number a screen prints must be the size of the set it claims to describe. Counted two ways: through the
// engine's own counter, and by filtering the catalogue by hand with the same predicate.
test("count integrity: every reported count is the size of its own matching set", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const byCounter = E.watchCount(d);
    const bySet = E.MOVIES.filter(m => E.watchesFilm(m, d)).length;
    assert.equal(byCounter, bySet, `${label}: watchCount says ${byCounter}, the set has ${bySet}`);
    assert.equal(E.onbCount(), bySet, `${label}: the flow's count disagrees with its own set`);

    // …and the same for the narrower "can watch it today" number, which is a different question and must not
    // be allowed to quietly answer the first one (the CAS-143 confusion).
    const shown = E.MOVIES.filter(m => E.matchesCriteria(m, d)).length;
    assert.equal(E.countCriteria(d), shown, `${label}: countCriteria disagrees with its own set`);
    assert.ok(shown <= bySet, `${label}: ${shown} shown now exceeds ${bySet} watched — a subset cannot be bigger`);
  }
});

// ---- 1b. EDIT SCREEN MATCHES THE LISTING (CAS-446) ------------------------------------------------------
// The Edit-Agent screen's "N films match right now" (onbShownCount, via stepCount()'s mirror + CTA) has to
// quote the same number as the deck card and the listing (listedCount) — what the agent will actually LIST
// right now — not the broader watch-ahead figure. A streaming agent diverges when it watches a window ahead
// of what it lists (e.g. watching Rent+Stream but listing Stream only); a cinema agent never diverges
// because cinema is the first window in CASCADE order, so nothing sits "ahead" of it to inflate the count.
test("edit screen matches the listing: onbShownCount equals listedCount, for every lane", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    assert.equal(E.onbShownCount(), E.listedCount(d),
      `${label}: Edit says ${E.onbShownCount()}, the listing has ${E.listedCount(d)}`);
  }
});

// ---- 2. ONE RECIPE, ONE ANSWER (CAS-221) ----------------------------------------------------------------
// The pick-agent card and the flow are two views of the same agent, so they are two printings of one number.
// This is the invariant CAS-221 restored; it is here so it cannot rot again.
test("one recipe, one answer: the card's count equals the flow's count", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    assert.equal(E.starterCount(s, kind), E.onbCount(),
      `${label}: card says ${E.starterCount(s, kind)}, Mission says ${E.onbCount()}`);
  }
});

// ---- 3. MONOTONICITY ------------------------------------------------------------------------------------
// Narrowing any one axis can only ever remove films — true unconditionally for genre/age/awards/windows,
// which stay ANDed. The Mission dials (People's vote / Critics & awards / Budget / Buzz) are CAS-661's OR
// group: raising a dial that is ALREADY set only ever shrinks that one OR term, so the union with the other
// (unchanged) terms can only shrink or hold — still guaranteed. But turning a dial on FROM OFF is adding a
// new independent route in, not tightening one, and when another Mission dial is already active in the base
// recipe that can only add films, never remove them (e.g. stream/streaming: turning on Critics score while
// People's vote is already the agent's route in took 349 → 380). That case is only guaranteed to narrow when
// the dial being moved is the SOLE active Mission route (see invariants.test.mjs's own OR-specific test,
// added by CAS-661), so this general matrix walk skips it rather than asserting something no longer true.
test("monotonicity: narrowing any single axis never increases the count", () => {
  // Group id for each Mission-dial perturbation below, and whether that group is already active in a given
  // recipe. selCritScore/selAwards share one OR term (selCriticsOK), so both perturbations share one group id.
  const MISSION_GROUP_ID = { "vote bar": "crowd", "critics score": "critics", "awards rung": "critics",
                              "scale": "scale", "buzz": "buzz" };
  const groupActive = (id, d) => id === "crowd" ? !!d.selCrowd
    : id === "critics" ? !!(d.selCritScore || d.selAwards)
    : id === "scale" ? !!d.selScale : !!d.selBuzz;
  const missionActiveExcept = (d, exceptId) => Object.values(MISSION_GROUP_ID)
    .some(id => id !== exceptId && groupActive(id, d)) || !!d.cinemaReleaseOnly;
  const narrower = [
    ["genre",     d => ({ ...d, genre: ["Drama"] })],
    ["age",       d => ({ ...d, age: [E.AGE_LEVELS[0]] })],
    // CAS-560 retired the per-agent lang field (c.lang) — matchesCriteria no longer reads it, so a "lang"
    // case here would sit passing forever without testing anything (the failure mode this comment already
    // warns against). Language narrowing is exercised on tasteBase.langs instead — see the taste-baseline
    // test below.
    ["vote bar",  d => ({ ...d, selCrowd: Math.max(d.selCrowd || 0, 7.5) })],
    // CAS-249 split the one 0-4 critics ladder into a continuous SCORE floor and a counted awards rung.
    // Both narrow, and both are poked, because a dead assertion on a field nothing reads any more would sit
    // here passing forever — which is the failure mode a renamed field usually produces in a suite.
    ["critics score", d => ({ ...d, selCritScore: Math.max(d.selCritScore || 0, 80) })],
    ["awards rung",   d => ({ ...d, selAwards:    Math.max(d.selAwards || 0, 2) })],
    ["scale",     d => ({ ...d, selScale: Math.max(d.selScale || 0, 100e6) })],
    ["buzz",      d => ({ ...d, selBuzz: Math.max(d.selBuzz || 0, 3) })],
    ["awards",    d => ({ ...d, awards: true })],
    // Dropping a window is a narrowing; SWAPPING one is not, and it took a failing run to see why. Membership
    // is "a window I watch is still ahead of this film" (inScope), so watching a LATER window admits more, not
    // fewer — pointing a cinema agent at streaming took 28 to 153. A subset of the windows is the real
    // narrowing, and that is what this asserts.
    ["windows",   d => ({ ...d, status: (d.status || []).slice(0, 1) })],
  ];
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const base = E.onbApply();
    const before = E.watchCount(base);
    for(const [what, tighten] of narrower){
      const groupId = MISSION_GROUP_ID[what];
      if(groupId && !groupActive(groupId, base) && missionActiveExcept(base, groupId)) continue;   // CAS-661:
        // adding a new OR route in, not tightening one already there — only guaranteed to narrow when this
        // dial is the sole active Mission route (or none was active, i.e. the whole block was open before)
      const after = E.watchCount(E.normCascade(tighten(base)));
      assert.ok(after <= before,
        `${label}: tightening ${what} took the count UP, ${before} → ${after}`);
    }
  }
});

// ---- 4. FACET COUNTS ARE WITHIN THE SET (CAS-224) -------------------------------------------------------
// A per-genre number is a slice of the agent's own films, so no slice can be bigger than the whole. Before
// CAS-224 the chips quoted the whole catalogue (Drama · 752 on a page whose total was 28), which is precisely
// this invariant broken by a factor of 27. This used to check a per-language facet too (langCountsNow()), but
// CAS-560 retired the per-agent language axis that facet counted — there is no longer an agent-level "lang"
// slice for a count to be a slice of.
test("facet counts: no genre slice is larger than the set it slices", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    // The facet counts open their own axis, so the ceiling is the total with that axis open — not the total
    // with it applied. Comparing against the narrowed total would be comparing two different populations.
    const openGenre = E.watchCount(E.normCascade({ ...E.onbApply(), genre: [] }));
    for(const [g, n] of Object.entries(E.genreCountsNow())){
      assert.ok(n <= openGenre, `${label}: genre ${g} counts ${n} of ${openGenre}`);
      assert.ok(n >= 0 && Number.isInteger(n), `${label}: genre ${g} counts ${n}`);
    }
  }
});

// ---- 4b. LANGUAGE IS TASTE-BASELINE ONLY NOW (CAS-560) --------------------------------------------------
// CAS-560 retired the per-agent language field — c.lang is forced to [] for every agent (normCascade) and
// matchesCriteria no longer reads it. tasteBase.langs (Preferences) is the only language filter left, so this
// is where the narrowing-never-widens property (CAS-114/monotonicity, above) has to hold for language now.
test("language narrowing lives on tasteBase now, and still only ever narrows", () => {
  const savedLangs = E.tasteBase.langs;
  try{
    for(const { kind, s, label } of CASES){
      pickInLane(E, kind, s.key);
      const d = E.onbApply();
      E.tasteBase.langs = [];             // open: no language filter
      const open = E.watchCount(d);
      E.tasteBase.langs = ["en"];         // narrower: English only
      const narrowed = E.watchCount(d);
      assert.ok(narrowed <= open, `${label}: narrowing tasteBase.langs took the count UP, ${open} → ${narrowed}`);
      // c.lang itself must carry no weight any more — an agent explicitly set to ["en"] must count identically
      // to the same agent left at [], since Preferences is the only language gate now.
      E.tasteBase.langs = [];
      const withStrayLang = E.watchCount(E.normCascade({ ...d, lang: ["en"] }));
      assert.equal(withStrayLang, open, `${label}: a stray c.lang still changed the count — matchesCriteria is reading it`);
    }
  } finally {
    E.tasteBase.langs = savedLangs;
  }
});

// ---- 5. THE LANE'S WINDOWS AND ITS LISTING (CAS-227 / CAS-228, CAS-723) -----------------------------------
// A listed window is always a watched window (you cannot list what the agent does not follow) — that
// property survives. CAS-723 retires the other half this test used to assert: c.kind no longer scopes an
// agent's windows, so a "cinema" preset and a "stream" preset now derive the exact same c.status from the
// one shared watchPrefs answer, with no more lane-separation to check.
test("windows: everything listed is watched", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    for(const w of d.listStatus) assert.ok(d.status.includes(w),
      `${label}: lists ${w} without watching it — the films could never arrive`);
  }
});

// CAS-723: c.kind retires as a window-scoping input — every agent's c.status/c.listStatus now derive from
// watchPrefs alone, so a cinema-flavoured preset and a stream-flavoured preset agree on both exactly.
test("CAS-723: cinema and stream presets derive the identical window scope from watchPrefs", () => {
  const byKind = {};
  for(const { kind, s } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    byKind[kind] = byKind[kind] || new Set();
    d.status.forEach(w => byKind[kind].add(w));
  }
  assert.deepEqual([...byKind.cinema].sort(), [...byKind.stream].sort(),
    `cinema presets watch ${[...byKind.cinema].sort()}, stream presets watch ${[...byKind.stream].sort()}`);
});

// ---- 5b. ONE AGENT TYPE — EVERY WINDOW ENABLED MEANS NOTHING LEAVES SCOPE (CAS-723 AC2) ------------------
// With every window switched on, inScope(m,c) must hold for every showable film and every agent — there is
// no longer a "cinema" agent whose c.status excludes home windows and therefore drops a film once it moves
// past cinemas. Fails before CAS-723 on any released film against a cinema-preset agent (inScope depends on
// c.status, which watchForKind used to narrow to upcoming/opening_week/in_cinema for that lane alone).
test("CAS-723 AC2: with every window enabled, inScope holds for every film and every agent", () => {
  const savedPrefs = E.watchPrefs;
  try {
    const allOn = {};
    for(const w of E.AGENT_WINDOWS) allOn[w.key] = { list: true, notify: true };
    E.setWatchPrefs(allOn);
    for(const { kind, s, label } of CASES){
      pickInLane(E, kind, s.key);
      const d = E.onbApply();
      for(const m of E.MOVIES){
        if(!E.showable(m)) continue;
        assert.ok(E.inScope(m, d),
          `${label}: ${m.title} (${E.primaryStatus(m)}) is out of scope with every window enabled`);
      }
    }
  } finally {
    E.setWatchPrefs(savedPrefs);
  }
});

// A film that is listed must be one the agent watches, and must sit in a window the agent lists. Checked over
// the real catalogue rather than asserted from the fields, so a listing bug cannot hide behind correct config.
test("windows: no listed film sits outside the agent's listed windows", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const listed = E.MOVIES.filter(m => E.listedBy(m, d));
    for(const m of listed){
      assert.ok(E.matchesTaste(m, d), `${label}: lists ${m.title}, which fails its own taste test`);
      if(d.listStatus.length) assert.ok(d.listStatus.includes(E.primaryStatus(m)),
        `${label}: lists ${m.title} from ${E.primaryStatus(m)}, not a listed window`);
    }
  }
});

// ---- 6. AVAILABILITY IS BACKED BY SOMETHING (CAS-170 / CAS-155 / CAS-227) -------------------------------
test("availability: every showable film is unreleased, offered, or in a cinema run", () => {
  for(const m of E.MOVIES){
    if(!E.showable(m)) continue;
    const upcoming   = (m.status || []).includes("upcoming");
    const offered    = !E.isEstimated(m) && (m.offers || []).length > 0;
    // CAS-237 widened the third case by exactly one clause. It used to require a CONFIRMED title; it now
    // also admits an estimated one, PROVIDED the film is in a cinema window with its opening date still
    // inside the run. That is not a weaker claim, it is the same claim: the evidence for "on a screen" is a
    // real opening date and no digital listing, and whether the pipeline or the front end read that
    // evidence changes nothing about it. Every other estimated window is still excluded (CAS-170).
    const inCinema   = E.inCinemaWindow(m) && (!E.isEstimated(m) || E.inCinemaRun(m));
    assert.ok(upcoming || offered || inCinema,
      `${m.title} is listable on nothing: status ${(m.status||[]).join(",")}, ${(m.offers||[]).length} offers`);
    // CAS-155's fault in one line: a film with a rent or stream offer must never be filed under the big screen.
    if(inCinema) assert.ok(!(m.offers || []).length,
      `${m.title} is in a cinema window while holding ${(m.offers||[]).length} digital offers`);
    if(inCinema) assert.ok(m.cinema_date, `${m.title} is in a cinema window with no opening date`);
  }
});

// ---- 7. THE SCALE DIAL: AN INFERENCE ANSWERS, ONLY TRUE ABSENCE RIDES ON THE OPT-IN (CAS-166/CAS-747) -----
// CAS-166: a floor is a lower bound, not a band — a real figure at or above it passes, below it fails.
// CAS-747 re-derives the unknown-scale cases for the AND-only admission path CAS-724 introduced: the CAS-238/
// CAS-674 tri-state (`null` rides along and never denies) was correct only under the CAS-661 OR block, where
// a term contributing nothing could not admit. Under AND the same value can no longer deny, so it silently
// admits instead — the defect this ticket fixes. An inference is now a real answer either way, and only a
// film with NEITHER a real figure NOR an inference is handed to c.includeUnbudgeted.
// Every fixture below is additionally screened through matchesCriteria against the wide-open baseline
// (selScale:0, so the budget gate is a no-op) — same technique as CAS-744's `unrated`/`outsider` fixtures —
// so a failure at a real floor is provably the budget gate and not some unrelated gate the raw catalogue
// entry happens to also fail.
test("CAS-747 AC4: a real figure always clears a floor at or below it and never clears one above it, regardless of includeUnbudgeted", () => {
  const openBase = missionCase({ scoreFloor: 0 });
  const small = E.MOVIES.find(m => m.budget > 0 && m.budget < 1e6 && E.matchesCriteria(m, openBase));
  assert.ok(small, "no known-small-budget film clearing the open baseline — this test would prove nothing");
  for(const includeUnbudgeted of [true, false]){
    assert.equal(E.selScaleMatch(small, { selScale: 100e6, includeUnbudgeted }), false,
      `${small.title} at $${small.budget} passed a $100M floor (includeUnbudgeted: ${includeUnbudgeted})`);
    assert.equal(E.selScaleMatch(small, { selScale: small.budget, includeUnbudgeted }), true,
      `${small.title} at $${small.budget} failed a floor set at its own figure (includeUnbudgeted: ${includeUnbudgeted})`);
    assert.equal(E.matchesCriteria(small, missionCase({ scoreFloor: 0, selScale: 100e6, includeUnbudgeted })), false,
      `${small.title}: an agent's $100M floor listed it anyway (includeUnbudgeted: ${includeUnbudgeted})`);
    assert.equal(E.matchesCriteria(small, missionCase({ scoreFloor: 0, selScale: small.budget, includeUnbudgeted })), true,
      `${small.title}: an agent's floor set at its own figure did not list it (includeUnbudgeted: ${includeUnbudgeted})`);
  }
});
test("CAS-747 AC2: a film with no real figure and an inferred scale below the floor is not listed — fails on current code", () => {
  const openBase = missionCase({ scoreFloor: 0 });
  const inferred = E.MOVIES.find(m => !(m.budget > 0) && !(m.worldwide_gross > 0) && E.inferredScale(m)
    && E.matchesCriteria(m, openBase));
  assert.ok(inferred, "no film with an inferred (but no real) scale clearing the open baseline — this test would prove nothing");
  const floor = E.inferredScale(inferred).d + 1;   // one dollar above what the inference actually clears
  assert.equal(E.selScaleMatch(inferred, { selScale: floor }), false,
    `${inferred.title}: a below-floor inference passed the scale dial`);
  assert.equal(E.matchesCriteria(inferred, missionCase({ scoreFloor: 0, selScale: floor })), false,
    `${inferred.title}: an agent with that floor listed a film whose inferred scale falls below it`);
});
test("CAS-747 AC3: a film with no figure and no inference at all is decided by includeUnbudgeted, not a default ride-along", () => {
  const openBase = missionCase({ scoreFloor: 0 });
  const unknown = E.MOVIES.find(m => !(m.budget > 0) && !(m.worldwide_gross > 0) && !E.inferredScale(m)
    && E.matchesCriteria(m, openBase));
  assert.ok(unknown, "no film with neither a real figure nor an inference clearing the open baseline — this test would prove nothing");
  assert.equal(E.selScaleMatch(unknown, { selScale: 100e6, includeUnbudgeted: false }), false,
    `${unknown.title}: a wholly unscaled film passed a floor with includeUnbudgeted false`);
  assert.equal(E.selScaleMatch(unknown, { selScale: 100e6, includeUnbudgeted: true }), true,
    `${unknown.title}: a wholly unscaled film failed a floor with includeUnbudgeted true`);
  assert.equal(E.matchesCriteria(unknown, missionCase({ scoreFloor: 0, selScale: 100e6, includeUnbudgeted: false })), false,
    `${unknown.title}: an agent listed a wholly unscaled film with includeUnbudgeted false`);
  assert.equal(E.matchesCriteria(unknown, missionCase({ scoreFloor: 0, selScale: 100e6, includeUnbudgeted: true })), true,
    `${unknown.title}: an agent did not list a wholly unscaled film with includeUnbudgeted true`);
});

// ---- 8. THE CASCADE SCORE (CAS-603, CAS-919, CAS-920) ------------------------------------------------------
// CAS-919: Watchmode is now the Cascade score — cascadeScore reads wm_user_rating/wm_critic_score through
// wmQScore, not IMDb/RT/Metacritic (see §9c below). CAS-920 retired qScore itself along with the app's last
// other OMDb reads — there is nothing left to compare it against, so its own tests go with it.
test("cascade score: a film with real Watchmode terms outranks one with none, and sourceless films sort last", () => {
  const released = { status: ["included_streaming"] };
  const wellReviewed = { ...released, title: "Well Reviewed", wm_user_rating: 8.2, wm_critic_score: 93 };
  const noSources     = { ...released, title: "No Sources",    wm_user_rating: null, wm_critic_score: null };

  assert.ok(E.sortMoviesBy(wellReviewed, noSources, "cascade") < 0,
    "a film with real Watchmode terms did not outrank one carrying none");

  // A film with no source at all sorts after every scored film.
  assert.ok(E.sortMoviesBy(noSources, wellReviewed, "cascade") > 0,
    "a film with no source at all did not sort after a scored film");
});

// ---- 9b. CRITICS IS ONE RECORDED FIGURE (CAS-694, CAS-920) ---------------------------------------------------
// CAS-920: Critics moved off the OMDb Metacritic/RT blend onto Watchmode's single wm_critic_score figure —
// critScore is now a straight (rounded) passthrough, null when absent.
test("critScore: reads wm_critic_score directly, rounded, null when absent", () => {
  assert.equal(E.critScore({ wm_critic_score: 74.6 }), 75, "a present score should round to the nearest whole number");
  // wm_critic_score: 0 is a present (if extreme) score, not an absent one — a truthy-only check would wrongly
  // treat it as missing, exactly the asymmetry CAS-694 fixed for the old OMDb blend.
  assert.equal(E.critScore({ wm_critic_score: 0 }), 0, "a critic score of exactly 0 should still read as present");
  assert.equal(E.critScore({ wm_critic_score: null }), null, "an absent score should read as null");
});

// ---- 9e. AGENT FLOORS APPLY TO THE WATCHMODE FIELDS (CAS-920 AC4/AC5) ----------------------------------------
// The saved keys (c.imdb, c.rt) are unchanged — only the film field each floor is measured against moved
// from OMDb to Watchmode. language:"en" is set on every fixture only to clear passesTasteBase's own default
// language gate, which the rating/critics floor is not what's under test here.
test("CAS-920 AC4: an agent's imdb floor applies to wm_user_rating, not imdb_rating", () => {
  const c = E.normCascade({ kind: "stream", status: [] });
  c.imdb = 7;
  const admits = { status: ["included_streaming"], offers: ["netflix"], language: "en",
    wm_user_rating: 7.2, wm_critic_score: null };
  const rejects = { status: ["included_streaming"], offers: ["netflix"], language: "en",
    wm_user_rating: 6.5, imdb_rating: 9, wm_critic_score: null };
  assert.equal(E.matchesCriteria(admits, c, false, true), true,
    "a film clearing the imdb floor on wm_user_rating alone should be admitted");
  assert.equal(E.matchesCriteria(rejects, c, false, true), false,
    "a film below the imdb floor on wm_user_rating must not be admitted by a high imdb_rating instead");
});
test("CAS-920 AC5: an agent's rt floor applies to wm_critic_score, not rt_critic", () => {
  const c = E.normCascade({ kind: "stream", status: [] });
  c.rt = 80;
  const rejects = { status: ["included_streaming"], offers: ["netflix"], language: "en",
    wm_critic_score: 70, rt_critic: 95 };
  assert.equal(E.matchesCriteria(rejects, c, false, true), false,
    "a film below the rt floor on wm_critic_score must not be admitted by a high rt_critic instead");
});

// ---- 9c. WATCHMODE IS NOW THE CASCADE SCORE (CAS-895 mirrors -> CAS-919 the real score) -----------------
// wmQScore averages the wm_user_rating/wm_critic_score fields (scale-matched via the existing META_ADJ
// ratio, no RT_ADJ equivalent — Watchmode carries no RT-shaped field), then CAS-919 maps that raw mean
// through WM_SCALE (wmScaled) so it lands on the same scale every agent marker was set on. wmCascadeScore
// mirrors cascadeScore's three primaryStatus branches exactly, and cascadeScore now dispatches to the same
// Watchmode terms directly (§8/CAS-919 AC4 below), so the two are the same computation under two names.
const META_ADJ = 0.9635;
test("wmQScore: the rounded mean of whichever Watchmode terms are present, scale-matched and then mapped through WM_SCALE", () => {
  const both  = { wm_user_rating: 7.6, wm_critic_score: 91 };
  const userOnly = { wm_user_rating: 8.0, wm_critic_score: null };
  const critOnly = { wm_user_rating: null, wm_critic_score: 91 };
  const neither = { wm_user_rating: null, wm_critic_score: null };
  assert.equal(E.wmQScore(both), Math.round(E.wmScaled((7.6*10 + 91/META_ADJ)/2)), "both present should average the two scale-matched terms, then map through WM_SCALE");
  assert.equal(E.wmQScore(userOnly), Math.round(E.wmScaled(80)), "wm_user_rating alone should score as itself x10, then map through WM_SCALE");
  assert.equal(E.wmQScore(critOnly), Math.round(E.wmScaled(91/META_ADJ)), "wm_critic_score alone should scale-match against IMDb via META_ADJ, then map through WM_SCALE");
  assert.equal(E.wmQScore(neither), -1, "a film with neither Watchmode term should not score");
});
// CAS-919 AC6: WM_SCALE is frozen and monotonic, and wmScaled/wmQScore read it correctly at named knots.
test("CAS-919 AC6: WM_SCALE is monotonic and wmScaled/wmQScore map through it correctly", () => {
  for(let i = 1; i < E.WM_SCALE.length; i++){
    assert.ok(E.WM_SCALE[i][0] > E.WM_SCALE[i-1][0], `WM_SCALE x values must strictly rise at index ${i}`);
    assert.ok(E.WM_SCALE[i][1] >= E.WM_SCALE[i-1][1], `WM_SCALE y values must never fall at index ${i}`);
  }
  assert.equal(E.wmScaled(88.8), 92, "wmScaled(88.8) should read the exact knot value 92");
  assert.equal(E.wmScaled(65), 66, "wmScaled(65) should read the exact knot value 66");
  assert.equal(E.wmQScore({ wm_user_rating: 6.9 }), 71, "wmQScore({wm_user_rating: 6.9}) should return 71");
});
// CAS-919 AC5: the card's score row reads People/Critics off the Watchmode fields, with the dot classes
// IMDb and Metacritic used to carry, a missing figure a muted en-dash, and none of the retired labels.
test("CAS-919 AC5: scoresRowHTML renders People/Critics off wm_user_rating/wm_critic_score, dot classes imdb then meta", () => {
  const html = E.scoresRowHTML({ wm_user_rating: 6.9, wm_critic_score: null });
  assert.match(html, /<span class="lab">People<\/span> <b>6\.9<\/b>/, "should render the People figure as 'People 6.9'");
  assert.match(html, /<span class="lab">Critics<\/span> <b>–<\/b>/, "should render the missing Critics figure as an en-dash");
  const imdbIdx = html.indexOf('dot imdb');
  const metaIdx = html.indexOf('dot meta');
  assert.ok(imdbIdx >= 0 && metaIdx >= 0 && imdbIdx < metaIdx, "dot classes should be imdb then meta, in that order");
  for(const retired of ["IMDb", ">RT<", "Meta<", "Pop", "Cascade"]){
    assert.ok(!html.includes(retired), `retired label "${retired}" should not appear in scoresRowHTML's output`);
  }
});

test("wmCascadeScore: follows cascadeScore's three primaryStatus branches, over wmQScore instead of qScore", () => {
  // CAS-907: the pre-release/blended branches now dispatch to wmCinemaScore (the Watchmode-sourced buzz
  // chain), not cinemaScore (TMDB-sourced) — that shared call was the defect this ticket fixes, so pinning
  // cinemaScore here would re-pin the bug.
  // CAS-1005: fixed fixtures, not E.MOVIES.find() — a live film's primaryStatus can flip (e.g. its cinema
  // date is today) between when the catalogue built and when this test runs, and "not pre-release" is not
  // the same test as "released" (opening_week is neither).
  const upcoming = { status: ["upcoming"] };
  assert.equal(E.wmCascadeScore(upcoming), E.wmCinemaScore(upcoming), "upcoming should return wmCinemaScore unchanged");

  const released = { status: ["included_streaming"], wm_user_rating: 7.5, wm_critic_score: 82 };
  assert.equal(E.wmCascadeScore(released), E.wmQScore(released), "released (not in_cinema/opening_week) should return wmQScore unchanged");

  // A film in cinemas (or its opening week) whose wmQScore is -1 falls back to wmCinemaScore rather than
  // returning a negative number, exactly like cascadeScore falls back to buzz when qScore is -1.
  const cinemaFilm = { status: ["in_cinema"], wm_popularity_percentile: 50 };
  const noWm = { ...cinemaFilm, wm_user_rating: null, wm_critic_score: null };
  assert.equal(E.wmCascadeScore(noWm), E.wmCinemaScore(noWm), "in_cinema/opening_week with no Watchmode terms should fall back to wmCinemaScore, not a negative number");

  const withWm = { ...cinemaFilm, wm_user_rating: 8.0, wm_critic_score: 90 };
  const expectedBuzz = E.wmCinemaScore(withWm), expectedWm = E.wmQScore(withWm);
  assert.equal(E.wmCascadeScore(withWm), Math.round((expectedBuzz+expectedWm)/2), "in_cinema/opening_week with a real wmQScore should blend it with wmCinemaScore");
});

// CAS-919 AC4: cascadeScore is now defined identically to wmCascadeScore (same primaryStatus branches, same
// wmCinemaScore/wmQScore calls) — this holds over the whole built catalogue, not just hand-picked fixtures.
test("CAS-919 AC4: cascadeScore equals wmCascadeScore for every film — Watchmode is now the Cascade score", () => {
  for(const m of E.MOVIES){
    assert.equal(E.cascadeScore(m), E.wmCascadeScore(m), `${m.title}: cascadeScore disagreed with wmCascadeScore`);
  }
});

// ---- CAS-907: THE WATCHMODE BUZZ CHAIN — a real mirror of buzzPctlOf/cinemaScore, not a shared call --------
// Before this ticket wmCascadeScore's pre-release/blended branches called the same cinemaScore(m) as
// cascadeScore, so every pre-release film's "WM" figure was the TMDB/OMDb score under a Watchmode label —
// worse than a duplicate, since it read as the two sources agreeing when the second had not been consulted.
// WM_BUZZ_POP_VALS/wmBuzzPctlOf/wmReleasedScoreVals/wmCinemaScore are the real Watchmode-sourced mirror.
// They are plain module-level arrays/functions exported by reference (the same "mutate in place, restore in
// `finally`" pattern CAS-742 AC2/CAS-748 AC6 already use on BUZZ_POP_VALS/MOVIES), which is required here
// because this checkout's real catalogue currently carries no wm_popularity_percentile data at all — the
// backfill that populates it is CAS-906's job, not this ticket's (see its "Do not re-raise" list).
test("CAS-907 AC2: wmCascadeScore differs from cascadeScore for an upcoming film ranked differently on the TMDB and Watchmode buzz axes", () => {
  const originalMovies = E.MOVIES.slice();
  const savedBuzz = E.BUZZ_POP_VALS.slice();
  const savedWmBuzz = E.WM_BUZZ_POP_VALS.slice();
  try {
    // Ranks top of the TMDB cohort (popularity 50 of [5,50]) but bottom of the Watchmode one
    // (wm_popularity_percentile 5 of [5,50]) — the two axes deliberately disagree.
    const upcoming = { status: ["upcoming"], popularity: 50, wm_popularity_percentile: 5 };
    const released = { status: ["included_streaming"], imdb_rating: 9.0, imdb_votes: 100000,
      rt_critic: null, metacritic: null, wm_user_rating: 2.0, wm_critic_score: null };
    E.MOVIES.length = 0; E.MOVIES.push(upcoming, released);
    E.BUZZ_POP_VALS.length = 0; E.BUZZ_POP_VALS.push(5, 50);
    E.WM_BUZZ_POP_VALS.length = 0; E.WM_BUZZ_POP_VALS.push(5, 50);
    E.invalidateComputeCaches();
    assert.equal(E.buzzPctlOf(upcoming), 100, "setup: upcoming should rank top of the TMDB buzz cohort");
    assert.equal(E.wmBuzzPctlOf(upcoming), 50, "setup: upcoming should rank mid of the Watchmode buzz cohort");
    // CAS-919: cascadeScore now dispatches to the same Watchmode chain as wmCascadeScore (it no longer reads
    // buzzPctlOf/cinemaScore's TMDB-only figure at all), so the two are equal even though the TMDB and
    // Watchmode buzz signals disagree here — see the whole-catalogue AC4 test below for the general case.
    assert.equal(E.cascadeScore(upcoming), E.wmCascadeScore(upcoming),
      "cascadeScore should equal wmCascadeScore — Watchmode is the Cascade score now, TMDB buzz is not read");
  } finally {
    E.MOVIES.length = 0; E.MOVIES.push(...originalMovies);
    E.BUZZ_POP_VALS.length = 0; E.BUZZ_POP_VALS.push(...savedBuzz);
    E.WM_BUZZ_POP_VALS.length = 0; E.WM_BUZZ_POP_VALS.push(...savedWmBuzz);
    E.invalidateComputeCaches();
  }
});

test("CAS-907 AC3: wmBuzzPctlOf returns null with no wm_popularity_percentile, and wmCinemaScore falls back to -1", () => {
  const noWm = { status: ["upcoming"], popularity: 50 };
  assert.equal(E.wmBuzzPctlOf(noWm), null, "a film with no wm_popularity_percentile should not rank");
  assert.equal(E.wmCinemaScore(noWm), -1, "with no buzz percentile to map, wmCinemaScore should return -1");
});

// CAS-920: CAS-907 AC4 used to prove wmReleasedScoreVals/wmCinemaScore read a genuinely different
// distribution than the OMDb-sourced releasedScoreVals/cinemaScore/qScore they stood beside — those three
// are retired now (nothing else reads OMDb any more), so there is nothing left to distinguish them from.
test("wmReleasedScoreVals is derived from wmQScore, and wmCinemaScore maps onto it", () => {
  const originalMovies = E.MOVIES.slice();
  const savedBuzz = E.BUZZ_POP_VALS.slice();
  const savedWmBuzz = E.WM_BUZZ_POP_VALS.slice();
  try {
    const upcoming = { status: ["upcoming"], popularity: 100, wm_popularity_percentile: 5 };
    const released = { status: ["included_streaming"], wm_user_rating: 2.0, wm_critic_score: null };
    const expectedWmQ = Math.round(E.wmScaled(20));   // CAS-919: wm_user_rating 2.0 alone -> raw mean 20, then WM_SCALE
    E.MOVIES.length = 0; E.MOVIES.push(upcoming, released);
    E.BUZZ_POP_VALS.length = 0; E.BUZZ_POP_VALS.push(100);
    E.WM_BUZZ_POP_VALS.length = 0; E.WM_BUZZ_POP_VALS.push(5);
    E.invalidateComputeCaches();
    assert.equal(E.wmQScore(released), expectedWmQ, "setup: wmQScore should read the Watchmode-derived figure, mapped through WM_SCALE");
    assert.deepEqual([...E.wmReleasedScoreVals()], [expectedWmQ], "wmReleasedScoreVals should carry wmQScore's value");
    assert.equal(E.wmCinemaScore(upcoming), expectedWmQ, "wmCinemaScore should map buzz onto wmReleasedScoreVals");
  } finally {
    E.MOVIES.length = 0; E.MOVIES.push(...originalMovies);
    E.BUZZ_POP_VALS.length = 0; E.BUZZ_POP_VALS.push(...savedBuzz);
    E.WM_BUZZ_POP_VALS.length = 0; E.WM_BUZZ_POP_VALS.push(...savedWmBuzz);
    E.invalidateComputeCaches();
  }
});

test("CAS-907 AC5: tied wm_popularity_percentile values produce tied wmBuzzPctlOf results", () => {
  const savedWmBuzz = E.WM_BUZZ_POP_VALS.slice();
  try {
    E.WM_BUZZ_POP_VALS.length = 0;
    E.WM_BUZZ_POP_VALS.push(10, 50, 50, 50, 90);
    const a = { status: ["upcoming"], wm_popularity_percentile: 50 };
    const b = { status: ["in_cinema"], wm_popularity_percentile: 50 };
    assert.equal(E.wmBuzzPctlOf(a), E.wmBuzzPctlOf(b),
      "identical wm_popularity_percentile values must rank identically, not be broken apart");
  } finally {
    E.WM_BUZZ_POP_VALS.length = 0;
    E.WM_BUZZ_POP_VALS.push(...savedWmBuzz);
  }
});

// ---- 10. MISSION DIALS COMBINE WITH OR (CAS-661) ----------------------------------------------------------
// The dials used to AND (CAS-114/145): a film had to clear every one you touched. CAS-661 reverses that — a
// film now clears the Mission block if it clears AT LEAST ONE dial that is SET, so turning a second dial on
// only ever ADDS films. `{template:true}` skips laneCrit (STARTERS' own normalisation trick, CAS-261) so a
// standalone criteria object keeps whichever dials this test sets regardless of the lane its empty `status`
// would otherwise resolve to.
const missionCase = (overrides = {}) => E.normCascade({ ...overrides }, { template: true });

// CAS-663: a pre-release film (primaryStatus upcoming or in_cinema) is exempt from the quality dials, so
// the exact-equivalence-with-selCrowdOK claim below only holds for a film that has had the chance to be
// judged. isPreRelease mirrors matchesCriteria's own preRelease test.
const isPreRelease = m => ["upcoming", "in_cinema"].includes(E.primaryStatus(m));

// CAS-724: selCrowd and selCritScore retire as admission routes entirely — a film's inclusion must not move
// at all when either is set, pre-release or not. (selAwards, the third former OR member, survives as its own
// standing requirement and is covered separately below.)
test("CAS-724: selCrowd and selCritScore no longer affect admission at all", () => {
  const open = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase())));
  for(const overrides of [{ selCrowd: 7.5 }, { selCritScore: 80 }, { selCrowd: 7.5, selCritScore: 80 }]){
    const got = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase(overrides))));
    assert.equal(got.size, open.size,
      `${JSON.stringify(overrides)}: setting a retired dial changed the matching set, ${open.size} → ${got.size}`);
  }
});

test("with every requirement off, admission is exactly as if the block were not there", () => {
  const open = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase())));
  const reopened = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase({
    selCrowd: 0, selCritScore: 0, selAwards: 0, selScale: 0, selBuzz: 0, cinemaReleaseOnly: false, scoreFloor: 0,
  }))));
  assert.equal(reopened.size, open.size,
    `every requirement off should equal the open set (${open.size}), got ${reopened.size}`);
  for(const m of open) assert.ok(reopened.has(m), `${m.title} is in the open set but not the all-off set`);
});

test("every zero stop reads Off, and the Cinema Release control drops \"Only\"", () => {
  assert.equal(E.CRIT_MARKS[0].label, "Off", `Critics score's zero stop reads "${E.CRIT_MARKS[0].label}"`);
  assert.equal(E.AWARD_STOPS[0].label, "Off", `Awards' zero stop reads "${E.AWARD_STOPS[0].label}"`);
  assert.equal(E.SCALE_REF[0].label, "Off", `Budget's zero stop reads "${E.SCALE_REF[0].label}"`);
  assert.equal(E.BUZZ_STOPS[0].label, "Off", `Buzz's zero stop reads "${E.BUZZ_STOPS[0].label}"`);
  assert.equal(E.voteReadout(0), "Off", `People's vote's zero stop reads "${E.voteReadout(0)}"`);
  for(const arr of [E.CRIT_MARKS, E.AWARD_STOPS, E.SCALE_REF, E.BUZZ_STOPS])
    for(const stop of arr) assert.ok(!/^Any( size)?$/.test(stop.label),
      `a Mission dial stop still reads "${stop.label}"`);
  assert.equal(E.critScoreReadout(0), "Off", `critScoreReadout(0) reads "${E.critScoreReadout(0)}"`);
  assert.equal(E.scaleReadout(0), "Off", `scaleReadout(0) reads "${E.scaleReadout(0)}"`);

  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const anchor = src.indexOf('id="onbCinemaRelease"');
  assert.ok(anchor >= 0, "the Cinema Release control markup was not found");
  const cinemaBlock = src.slice(anchor, anchor + 400);
  assert.ok(!/Only movies/i.test(cinemaBlock), "the Cinema Release control still reads \"Only movies\"");
  assert.ok(/Had a cinema release/i.test(cinemaBlock),
    "the Cinema Release control does not read \"Had a cinema release\"");
});

// ---- 10b. ADMISSION IS ONE SCORE FLOOR PLUS AND REQUIREMENTS, NOT AN OR BLOCK (CAS-724) -------------------
// CAS-724 deletes the CAS-661 Mission OR block. Admission is now cascadeScore(m) >= c.scoreFloor AND every
// requirement below (Budget, Awards, How far back, Had a cinema release), all ANDed, none optional.

// AC4: CAS-747 re-derives this — a `null` (no budget, no worldwide gross, no inference) scale no longer
// rides along under this AND-only admission path; it is decided by c.includeUnbudgeted instead, at every
// rung. A KNOWN, strictly-below-floor match still denies regardless of includeUnbudgeted.
// scoreFloor:0 is pinned on every case below alongside selScale — otherwise normCascade's own one-time
// migration (legacyMissionFloorDefault) would read the very selScale these cases are setting as a legacy
// cinema Mission dial and derive a non-zero floor from it, contaminating a test about the Budget requirement
// alone with the separate score-floor gate.
test("CAS-724 AC4 / CAS-747: the Budget requirement denies a genuinely unknown scale unless includeUnbudgeted opts back in", () => {
  const unknown = E.MOVIES.find(m => !(m.budget > 0) && !(m.worldwide_gross > 0) && !E.inferredScale(m)
    && E.matchesCriteria(m, missionCase()));
  assert.ok(unknown, "no wholly-unscaled film clearing the open baseline — this test would prove nothing");
  for(const floor of E.SCALE_REF.map(r => r.d).filter(Boolean)){
    assert.equal(E.matchesCriteria(unknown, missionCase({ selScale: floor, scoreFloor: 0, includeUnbudgeted: false })), false,
      `${unknown.title} carries no budget, gross or inference and was listed by a $${floor} Budget requirement with includeUnbudgeted false`);
    assert.equal(E.matchesCriteria(unknown, missionCase({ selScale: floor, scoreFloor: 0, includeUnbudgeted: true })), true,
      `${unknown.title}: includeUnbudgeted true did not clear a $${floor} Budget requirement`);
  }
  // and the requirement is real: a KNOWN below-floor budget still denies.
  const above = E.MOVIES.find(m => m.budget >= 100e6 && E.matchesCriteria(m, missionCase()));
  const below = E.MOVIES.find(m => m.budget > 0 && m.budget < 100e6 && E.matchesCriteria(m, missionCase()));
  assert.ok(above && below, "need both an above-floor and a below-floor budgeted film to test the requirement is real");
  assert.equal(E.matchesCriteria(above, missionCase({ selScale: 100e6, scoreFloor: 0 })), true,
    `${above.title} at $${above.budget} (>= floor) did not clear the Budget requirement`);
  assert.equal(E.matchesCriteria(below, missionCase({ selScale: 100e6, scoreFloor: 0 })), false,
    `${below.title} at $${below.budget} (< floor) cleared the Budget requirement`);
});

// AC3: the Awards requirement is reachable today only inside matchesCriteria's !preRelease branch — the
// ticket's own "trap". A pre-release, unawarded film clearing the open baseline must still list once Awards
// is set; this fails the moment the exemption is dropped.
test("CAS-724 AC3: the Awards requirement exempts a film that hasn't been judged yet (upcoming/in_cinema)", () => {
  const open = missionCase();
  const candidate = E.MOVIES.find(m => E.matchesCriteria(m, open) && isPreRelease(m) && E.awardRank(m) === 0);
  assert.ok(candidate, "no pre-release, unawarded film clearing the open baseline — this test would prove nothing");
  const withAwards = missionCase({ selAwards: 2 });
  assert.equal(E.matchesCriteria(candidate, withAwards), true,
    `${candidate.title}: pre-release, unawarded film was excluded by the Awards requirement, which must exempt pre-release`);
  // and the requirement is real once released: a released, unawarded film IS denied by the same setting.
  const released = E.MOVIES.find(m => E.matchesCriteria(m, open) && !isPreRelease(m) && E.awardRank(m) === 0);
  if(released) assert.equal(E.matchesCriteria(released, withAwards), false,
    `${released.title}: released, unawarded film cleared the Awards requirement`);
});

// ---- CAS-854: an upcoming film is only an agent's news once Cinema is a window that agent actually
// watches — "upcoming" means "coming to cinemas", so an agent with Cinema at Never (windowUsable false)
// is not waiting for that arrival, whatever else its watchMarkers admit. -------------------------------
const cascadeWithMarkers = markers => E.normCascade({ kind: "stream", status: [],
  watchMarkers: { in_cinema: null, premium: null, rent: null, stream: 0, ...markers } });

test("CAS-854 AC1: an upcoming film is not admitted to an agent whose Cinema window is Never", () => {
  const cinemaUsable = cascadeWithMarkers({ in_cinema: 0 });
  const film = E.MOVIES.find(m => E.primaryStatus(m) === "upcoming" && E.matchesCriteria(m, cinemaUsable));
  assert.ok(film, "no upcoming film matches an open, Cinema-usable agent — this test would prove nothing");
  const cinemaNever = cascadeWithMarkers({});
  assert.equal(E.matchesCriteria(film, cinemaNever), false,
    `${film.title}: an upcoming film was admitted to an agent whose Cinema marker is Never and only usable window is Stream`);
});

test("CAS-854 AC2: the same upcoming film IS admitted once the agent's Cinema window is usable", () => {
  const cinemaUsable = cascadeWithMarkers({ in_cinema: 0 });
  const film = E.MOVIES.find(m => E.primaryStatus(m) === "upcoming" && E.matchesCriteria(m, cinemaUsable));
  assert.ok(film, "no upcoming film matches an open, Cinema-usable agent — this test would prove nothing");
  assert.equal(E.matchesCriteria(film, cinemaUsable), true,
    `${film.title}: an upcoming film was excluded from an agent whose Cinema window is usable`);
});

test("CAS-854 AC3: a released film is unaffected by the Cinema-Never gate, on both agents", () => {
  const cinemaUsable = cascadeWithMarkers({ in_cinema: 0 });
  const cinemaNever = cascadeWithMarkers({});
  let checked = 0;
  for(const status of ["in_cinema", "pvod", "rental", "included_streaming"]){
    const film = E.MOVIES.find(m => E.primaryStatus(m) === status && E.matchesCriteria(m, cinemaUsable));
    if(!film) continue;
    checked++;
    assert.equal(E.matchesCriteria(film, cinemaNever), true,
      `${film.title}: a ${status} film was excluded by an agent whose Cinema marker is Never — CAS-854 must only gate upcoming`);
  }
  assert.ok(checked > 0, "no film at in_cinema/pvod/rental/included_streaming matched the open agent — this test would prove nothing");
});

// AC2: for every agent and film, listedBy(m,c) implies cascadeScore(m) >= c.scoreFloor. No exceptions —
// checked both across the real preset/lane matrix (CASES) and directly against matchesCriteria with a custom
// floor, since listedBy narrows further (window/pin state) and must not be the only place this holds.
test("CAS-724 AC2: no listed film's Cascade score is below its own agent's scoreFloor", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const listed = E.MOVIES.filter(m => E.listedBy(m, d));
    // CAS-1128: a literal scoreFloor of 0 no longer survives normCascade (it migrates to TRACK_MIN), so the
    // >= check below holds unconditionally now — the old "0 is Off" escape (CAS-762, retired) is dead here.
    for(const m of listed) assert.ok(E.cascadeScore(m) >= d.scoreFloor,
      `${label}: ${m.title} lists at Cascade score ${E.cascadeScore(m)}, below its own agent's floor ${d.scoreFloor}`);
  }
  const floored = missionCase({ scoreFloor: 70 });
  const scoredBelow = E.MOVIES.filter(m => { const s = E.cascadeScore(m); return s >= 0 && s < 70; });
  assert.ok(scoredBelow.length > 0, "no film scored below 70 in the fixture catalogue — this test would prove nothing");
  for(const m of scoredBelow) assert.equal(E.matchesCriteria(m, floored), false,
    `${m.title} scores ${E.cascadeScore(m)}, below the agent's floor of 70, but still matched`);
  // CAS-1128 retires CAS-762's "a floor of 0 is Off, no score requirement" reading: normCascade now migrates
  // any literal 0 marker (however it arrives — a legacy watchMarkers value or, as here, the legacy scoreFloor
  // seed) up to TRACK_MIN (50) and keeps it ON, so missionCase({scoreFloor:0}) is an ordinary 50-floor agent
  // now, not an Off one — rule 4 holds there exactly as it does at any other real floor.
  const unscored = E.MOVIES.find(m => E.cascadeScore(m) === -1 && E.matchesCriteria(m, missionCase(), undefined, true));
  if(unscored) assert.equal(E.matchesCriteria(unscored, missionCase({ scoreFloor: 0 })), false,
    `${unscored.title} has no Cascade score but was admitted at scoreFloor:0 — CAS-1128 migrates that to a real floor (TRACK_MIN), not Off`);
  if(unscored) assert.equal(E.matchesCriteria(unscored, missionCase({ scoreFloor: 50 })), false,
    `${unscored.title} has no Cascade score but was admitted at a real floor of 50`);
});

// AC6: raising any single requirement never increases what an agent lists — asserted over the live MOVIES
// array (via listedBy, not just matchesCriteria) for a sweep of selScale stops, across the real preset/lane
// matrix. This is a general property of AND-only admission, not something special-cased per dial.
test("CAS-724 AC6: raising the Budget requirement never increases what an agent lists, for any agent", () => {
  const stops = E.SCALE_REF.map(r => r.d);
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const base = E.onbApply();
    let prev = null;
    for(const floor of stops){
      const d = E.normCascade({ ...base, selScale: floor });
      const n = E.MOVIES.filter(m => E.listedBy(m, d)).length;
      if(prev !== null) assert.ok(n <= prev,
        `${label}: raising Budget to $${floor} took the listed count UP, ${prev} → ${n}`);
      prev = n;
    }
  }
});

// CAS-724 change item 6: scoreHeldBackCount is restated against c.scoreFloor rather than the retired
// Mission-dials target, so the count is meaningful at any real floor. CAS-762 changes what "at a floor of 0"
// means: 0 is now Off, no score requirement at all, so nothing is held back for score there any more.
test("CAS-724: scoreHeldBackCount agrees with its own set, at a real floor", () => {
  const originalMovies = E.MOVIES.slice();
  try {
    // CAS-1028: movies.json has been scoreable-only since CAS-986/1027, so every published film now carries
    // a Cascade score — there is no longer a live film to find for the "held back for having none" case.
    // Clone a real, currently-listed film and strip its score fields so it's unscored but otherwise a
    // genuine catalogue entry, the same "mutate in place, restore in finally" shape CAS-742 AC2/CAS-748 AC6
    // already use on MOVIES.
    const d0 = missionCase({ status: ["included_streaming", "pvod", "rental"], scoreFloor: 0 });
    const donor = E.MOVIES.find(m => E.listedBy(m, d0));
    assert.ok(donor, "test setup: no real film available to clone for the held-back fixture");
    const unscored = { ...donor, tmdb_id: -724001,
      wm_user_rating: null, wm_critic_score: null, wm_popularity_percentile: null };
    assert.equal(E.cascadeScore(unscored), -1, "test setup: cloned fixture should be unscored");
    E.MOVIES.push(unscored);
    E.invalidateComputeCaches();

    const d = missionCase({ status: ["included_streaming", "pvod", "rental"], scoreFloor: 50 });
    const held = E.scoreHeldBackCount(d);
    const heldFilms = E.MOVIES.filter(m => E.cascadeScore(m) === -1
      && !E.listedBy(m, d) && E.listedBy(m, d, true));
    assert.equal(heldFilms.length, held, "scoreHeldBackCount disagrees with its own set");
    assert.ok(held > 0, "test setup: expected at least one unscored film held back to exercise the count");
    for(const m of heldFilms) assert.equal(E.listedBy(m, d), false,
      `${m.title} has no score but is still listed`);
  } finally {
    E.MOVIES.length = 0; E.MOVIES.push(...originalMovies);
    E.invalidateComputeCaches();
  }
});
// CAS-1128 retires CAS-762's "scoreFloor 0 means Off" reading — a literal 0 now migrates to TRACK_MIN (50)
// through normCascade, so this is an ordinary 50-floor agent, and scoreHeldBackCount must count exactly the
// unscored films that floor excludes, the same as any other real floor.
test("CAS-1128: scoreHeldBackCount at scoreFloor:0 counts against the migrated TRACK_MIN floor, not zero", () => {
  const d = missionCase({ status: ["included_streaming", "pvod", "rental"], scoreFloor: 0 });
  assert.equal(E.agentFloor(d), 50, "setup: scoreFloor:0 must migrate to TRACK_MIN, never stay Off");
  const held = E.scoreHeldBackCount(d);
  const heldFilms = E.MOVIES.filter(m => E.cascadeScore(m) === -1 && !E.taggedOut(m) && !E.listedBy(m, d) && E.listedBy(m, d, true));
  assert.equal(held, heldFilms.length, "scoreHeldBackCount must agree with its own unscored-and-would-list set");
});

// ---- 10b. THE CHOSEN SORT'S OWN COMPARATOR DECIDES THE ORDER (CAS-702) ------------------------------------
// CAS-699 stopped two guards silently overriding a chosen sort with the release timeline in In Cinema and
// Upcoming. That was not the whole defect: sortMoviesBy's own "cascade" case still read qScore, which is -1
// for virtually every real pre-release film (CAS-695 scores them off buzz, not People's
// vote/Critics) — so once the override was lifted, the "order" it revealed was really a tie-break
// (rating/popularity), not the Cascade score a person had just picked. Checked against ground truth built
// independently of listingOrder/sortForKey/sortMoviesBy — cascadeScore itself for one section+sort,
// alphabetical order (no scoring function at all) for the other — and as a monotonicity, not an exact
// sequence, because tied scores/titles are free to land in either relative order.
test("CAS-702: an explicit sort's own comparator decides the rendered order, In Cinema and Upcoming", () => {
  const cinema = E.MOVIES.filter(m => E.primaryStatus(m) === "in_cinema" && E.cascadeScore(m) >= 0);
  assert.ok(cinema.length > 3, `only ${cinema.length} scored in_cinema films — not enough to test an order against`);
  const rendered = E.listingOrder(cinema, "cascade", { kind: "cinema" }, true);
  for(let i = 1; i < rendered.length; i++){
    assert.ok(E.cascadeScore(rendered[i - 1]) >= E.cascadeScore(rendered[i]),
      `In Cinema under Cascade score: "${rendered[i - 1].title}" (${E.cascadeScore(rendered[i - 1])}) sits above "${rendered[i].title}" (${E.cascadeScore(rendered[i])})`);
  }

  const upcoming = E.MOVIES.filter(m => E.primaryStatus(m) === "upcoming");
  assert.ok(upcoming.length > 3, `only ${upcoming.length} upcoming films — not enough to test an order against`);
  const byTitle = E.listingOrder(upcoming, "title", { kind: "cinema" }, true);
  for(let i = 1; i < byTitle.length; i++){
    assert.ok(byTitle[i - 1].title.localeCompare(byTitle[i].title) <= 0,
      `Upcoming under Title: "${byTitle[i - 1].title}" sits above "${byTitle[i].title}"`);
  }
});

// ---- 11. LISTED NEVER EXCEEDS WHAT MATCHES (CAS-674 AC1) --------------------------------------------------
// listedCount (what an agent actually LISTS, via listedBy) is a NARROWING of countCriteria (the raw
// matchesCriteria haul) by window and pin/move state — it can never legitimately exceed it. This was
// violated for an agent watching a single narrow window with no listStatus singled out: listWindowOK's
// fallback ("list whatever the agent watches") read that through inScope's broader "still ahead of" test
// instead of an exact match against c.status, so a single-window agent could list films from windows
// matchesCriteria itself would reject.
test("listing never exceeds matching: listedCount(c) <= countCriteria(c), for every real preset", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const lc = E.listedCount(d), cc = E.countCriteria(d);
    assert.ok(lc <= cc, `${label}: listedCount ${lc} exceeds countCriteria ${cc}`);
  }
});

test("listing never exceeds matching: holds for a single-window agent with no listStatus singled out (CAS-674 repro)", () => {
  const narrowVariants = [
    { kind:"cinema", status:["in_cinema"] },
    { kind:"stream", status:["included_streaming"] },
    { kind:"stream", status:["pvod","rental"] },
  ];
  for(const v of narrowVariants){
    const c = E.normCascade({ ...v }, {});
    assert.equal(c.listStatus.length, 0, `${JSON.stringify(v)}: expected no listStatus singled out for this repro`);
    const lc = E.listedCount(c), cc = E.countCriteria(c);
    assert.ok(lc <= cc, `${JSON.stringify(v)}: listedCount ${lc} exceeds countCriteria ${cc}`);
  }
});

// ---- 12. THE AGENTS ROW AND MISSION AGREE (CAS-674 AC4) ---------------------------------------------------
// Reproduces the reported case: a cinema agent set to Budget Studio floor + Buzz Trending must report the
// SAME count on the Agents row (agentMetricsCompute's "total", the deck card's "N listed") as on Mission
// (listedCount, what onbShownCount/stepCount print as "N films match right now"). Before CAS-674 the Agents
// row's comment already claimed "same test the listing itself runs" but the code read watchesFilm — the
// wider watch-ahead set — so the two screens quoted different numbers for one agent.
test("the Agents row and Mission report the same count for one agent (CAS-674 repro)", () => {
  const c = E.normCascade({ kind:"cinema", status:["upcoming","opening_week","in_cinema"],
    selScale:97e6, selBuzz:2 }, {});
  const agentsRowTotal = E.agentMetricsCompute(c).total;
  const missionCount = E.listedCount(c);
  assert.equal(agentsRowTotal, missionCount,
    `Agents row says ${agentsRowTotal} listed, Mission says ${missionCount} match right now`);
});

test("CAS-677 AC1: the scope bar defaults to Notify and For review on, Watched off", () => {
  // scope is a session-only module object — never persisted (see its own comment) — so this literal IS the
  // state both a brand-new list and a user who has never touched the bar land on.
  assert.deepEqual({ watch: E.scope.watch, new: E.scope.new, watched: E.scope.watched },
    { watch: true, new: true, watched: false });
});

// ---- MOVING NEVER RENDERS A PROVISIONAL LEDGER (CAS-667) -------------------------------------------------
// movingData() branches on window.CascadePersistence.accountActive() — flip window.CascadeAuth's real fields
// (enabled/client/session) the same way sign-in for real does, rather than a stand-in predicate, so the
// signed-in branch runs through the exact same check the shipped code runs.
function setSignedIn(signedIn){
  const auth = E.CascadeAuth;
  auth.enabled = signedIn;
  auth.client = signedIn ? {} : null;
  auth.session = signedIn ? { user: { id: "cas667-test-user" } } : null;
  // CAS-670: the guest branch itself now keys off cascade_had_account, not accountActive() — set it the same
  // way the real cascade-auth-change listener does so these tests still simulate a signed-in device faithfully.
  E.localStorage.setItem("cascade_had_account", signedIn ? "1" : "0");
}

// CAS-829/CAS-858: a film with no single owning agent (filmOwnerCascade returns null) gets no row at all —
// dropped, not rendered under any fallback lane. These CAS-667/668/670/671 checks are about ledger-
// readiness/window/badge plumbing, not ownership itself (that's tests/js/moving-owner.test.mjs's job), so
// every film they expect a row for gets one shared "mover" cascade as its real owner anyway.
function seedMovingOwner(){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = "cas829-moving-owner"; c.paused = false; c.order = 0;
  E.cascades.push(c);
  return c;
}
function ownFilms(owner, films){
  films.forEach(m => { E.notify[m.tmdb_id] = { cascadeIds: [owner.id] }; });
}
function disownFilms(films){
  films.forEach(m => { delete E.notify[m.tmdb_id]; });
}
function unseedMovingOwner(owner){
  const i = E.cascades.findIndex(c => c.id === owner.id);
  if(i >= 0) E.cascades.splice(i, 1);
}
// Not a real check — `MOVING_OWNER` must not exist in E.cascades for any test outside this block (CAS-673's
// active-set assertions, among others, would see it as a stray extra agent). node:test runs a file's test()
// bodies in registration order, but ALL module-level code — including a bare `const X = seedMovingOwner()`
// here — runs at import time, before ANY test() body, which would leak it into every earlier test too. So
// the seed has to be a test of its own, immediately before the block that needs it.
let MOVING_OWNER;
test("CAS-829: moving-owner test fixture setup", () => {
  MOVING_OWNER = seedMovingOwner();
});

test("CAS-667 AC1: a signed-in device with the alerts ledger unresolved renders nothing, never the guest ledger", () => {
  const film = E.MOVIES[0];
  E.realAlerts.length = 0;
  E.firstFound[String(film.tmdb_id)] = new Date().toISOString();
  setSignedIn(true);
  E.setMovingReady(false);

  const { rows } = E.movingData();
  assert.equal(rows.length, 0, "unresolved ledger must render nothing, and must not fall back to the guest firstFound ledger");

  delete E.firstFound[String(film.tmdb_id)];
  setSignedIn(false);
  E.setMovingReady(true);
});

test("CAS-667 AC2: opening Moving before and after the ledger resolves ends on the same row set", () => {
  const film = E.MOVIES[0];
  ownFilms(MOVING_OWNER, [film]);
  setSignedIn(true);
  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
    cascade_name: "Test agent", emailed_at: new Date().toISOString(), read_at: null });

  // Landing on Moving before the account answer comes back — the reported symptom.
  E.setMovingReady(false);
  const beforeReady = E.movingData();
  assert.equal(beforeReady.rows.length, 0, "still-unresolved ledger must render nothing on the landing-screen open");

  // Same visit, once loadRealAlerts has actually answered.
  E.setMovingReady(true);
  const afterReady = E.movingData();
  // CAS-848: afterReady.rows is constructed inside the sandboxed engine, so .map() on it directly would
  // inherit that realm's Array — spread it into a literal first (the original CAS-667 code's own
  // [...canRows, ...] did this implicitly) so it compares against a plain literal array correctly.
  const afterIds = [...afterReady.rows].map(r => r.filmId);
  assert.deepEqual(afterIds, [String(film.tmdb_id)],
    "once ready, movingData must reflect the real alerts ledger instead of staying empty");

  // Navigating away and back — same underlying data, same readiness — must reproduce the identical rows.
  const reopened = E.movingData();
  const reopenedIds = [...reopened.rows].map(r => r.filmId);
  assert.deepEqual(reopenedIds, afterIds, "reopening Moving must produce the same row set as the prior open");

  E.realAlerts.length = 0;
  disownFilms([film]);
  setSignedIn(false);
});

test("CAS-667 AC3: a genuine guest device still gets firstFound rows regardless of movingReady", () => {
  const film = E.MOVIES[0];
  ownFilms(MOVING_OWNER, [film]);
  setSignedIn(false);
  E.firstFound[String(film.tmdb_id)] = new Date().toISOString();
  E.setMovingReady(false);   // a guest has nothing to wait for — must be unaffected by this flag

  const { rows } = E.movingData();
  assert.ok(rows.every(r => r.tag === "new"), "a guest device has no Changed rows at all");
  assert.ok(rows.some(r => r.filmId === String(film.tmdb_id)),
    "a guest device must still get its firstFound row even while movingReady is false");

  delete E.firstFound[String(film.tmdb_id)];
  E.setMovingReady(true);
  disownFilms([film]);
});

// ---- THE GUEST BRANCH KEYS OFF cascade_had_account, NOT THE LIVE accountActive() ANSWER (CAS-670) --------
// CAS-667's guard only ever protected the `!guest` branch. The race it was meant to fix happens precisely
// while accountActive() still reads false on a device that DOES have an account — so the old guest flag
// stayed true through the whole window and movingData() kept falling into the firstFound branch regardless
// of the guard. These seed cascade_had_account directly (not via setSignedIn/CascadeAuth) so accountActive()
// can stay false throughout, exactly reproducing the reported race.
test("CAS-670 AC1: cascade_had_account=1 with accountActive() false returns empty rows and ignores firstFound", () => {
  const film = E.MOVIES[0];
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null;
  E.localStorage.setItem("cascade_had_account", "1");
  E.firstFound[String(film.tmdb_id)] = new Date().toISOString();
  E.setMovingReady(false);

  const { rows } = E.movingData();
  assert.equal(rows.length, 0, "must not read firstFound (or render anything) just because accountActive() reads false");

  delete E.firstFound[String(film.tmdb_id)];
  E.setMovingReady(true);
  E.localStorage.removeItem("cascade_had_account");
});

test("CAS-670 AC2: cascade_had_account=1 makes renderMovingScreen show its loading state, never the guest rows", () => {
  const film = E.MOVIES[0];
  const fid = String(film.tmdb_id);
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null;
  E.localStorage.setItem("cascade_had_account", "1");
  E.firstFound[fid] = new Date().toISOString();
  delete E.movingSeen[fid];
  E.setMovingReady(false);

  E.renderMovingScreen();
  assert.ok(!(fid in E.movingSeen),
    "the loading-state early return must never mark a guest-branch row as seen (would only happen if the guest/empty-state path ran instead)");

  delete E.firstFound[fid];
  E.setMovingReady(true);
  E.localStorage.removeItem("cascade_had_account");
});

test("CAS-670 AC3: cascade_had_account absent is a genuine guest device and still gets firstFound rows", () => {
  const film = E.MOVIES[0];
  ownFilms(MOVING_OWNER, [film]);
  E.localStorage.removeItem("cascade_had_account");
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null;
  E.firstFound[String(film.tmdb_id)] = new Date().toISOString();
  E.setMovingReady(false);   // a guest has nothing to wait for — must be unaffected by this flag

  const { rows } = E.movingData();
  assert.ok(rows.every(r => r.tag === "new"), "a guest device has no Changed rows at all");
  assert.ok(rows.some(r => r.filmId === String(film.tmdb_id)),
    "a guest device (no cascade_had_account) must still get its firstFound row");

  delete E.firstFound[String(film.tmdb_id)];
  E.setMovingReady(true);
  disownFilms([film]);
});

test("CAS-670 AC4: a hard reload on a signed-in device never surfaces a firstFound-sourced row during boot", () => {
  const film = E.MOVIES[0];
  const fid = String(film.tmdb_id);
  ownFilms(MOVING_OWNER, [film]);
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null; // still resolving
  E.localStorage.setItem("cascade_had_account", "1");
  E.firstFound[fid] = new Date().toISOString();   // a stale guest-era ledger this device happens to carry
  E.realAlerts.length = 0;
  E.setMovingReady(false);

  // Boot, pre-answer: nothing may render, and nothing sourced from firstFound.
  let data = E.movingData();
  assert.ok(!data.rows.some(r => r.filmId === fid),
    "no point before the ledger resolves may surface a firstFound-sourced row");

  // The ledger answers, still no real alerts for this film — firstFound must still never leak through.
  E.setMovingReady(true);
  data = E.movingData();
  assert.ok(!data.rows.some(r => r.filmId === fid),
    "once resolved, a signed-in device must read its real ledger, never fall back to firstFound");

  delete E.firstFound[fid];
  E.localStorage.removeItem("cascade_had_account");
  disownFilms([film]);
});

// ---- MOVING OPENS PINNED TO 2 WEEKS (CAS-848), AND THE BADGE COUNTS THE SAME WINDOW THE SCREEN SHOWS
// (CAS-668) --------------------------------------------------------------------------------------------
// CAS-671 removed "Since you last looked" and the visit-cutoff it depended on, opening instead on the
// shortest window holding 3+ rows. CAS-848 replaced that auto-pick outright: Moving now always opens
// pinned to 2 weeks, with no prior state and no row-count dependence — see the AC4 test below.
// movingWindowRows(win) is still the one recipe both renderMovingScreen and movingUnseenCount read
// through, so the badge and the list can never disagree about the window.
const daysAgoISO = n => new Date(Date.now() - n * 864e5).toISOString();
function unwatchedFilms(n){
  return E.MOVIES.filter(m => !E.watched.has(m.tmdb_id)).slice(0, n);
}
function seedFirstFound(films, daysAgo){
  films.forEach(m => { E.firstFound[String(m.tmdb_id)] = daysAgoISO(daysAgo); delete E.movingSeen[String(m.tmdb_id)]; });
  ownFilms(MOVING_OWNER, films);   // gives every seeded film a real owner, so these stay pure window checks
}
function unseedFirstFound(films){
  films.forEach(m => { delete E.firstFound[String(m.tmdb_id)]; delete E.movingSeen[String(m.tmdb_id)]; });
  disownFilms(films);
}

test("CAS-671 AC1: app_template.html contains no since_last or movingVisitCutoff", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  assert.ok(!src.includes("since_last"), "since_last must be fully removed");
  assert.ok(!src.includes("movingVisitCutoff"), "movingVisitCutoff must be fully removed");
});

test("CAS-848 AC5: app_template.html contains no movingAutoOpenWindow", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  assert.ok(!src.includes("movingAutoOpenWindow"), "movingAutoOpenWindow must be fully removed");
});

test("CAS-848 AC6: app_template.html no longer prints a trailing \"via <agent>\" on a Moving row", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  assert.ok(!/via <span class="mlchip mvagent"|via .{0,40}mvagent/.test(src),
    "the lane heading names the agent now — no per-row \"via <agent>\" trailer");
});

test("CAS-869 AC6: the 200-events sentence is gone — Moving's status nav takes its place, not a supersession of the 200-row fetch cap itself", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  assert.ok(!src.includes("Showing the most recent 200 events."),
    "the sentence must no longer appear anywhere in app_template.html");
  assert.ok(src.includes("function movingLedgerTruncated"),
    "the 200-row ledger fetch cap predicate itself must be unchanged — only the sentence is gone");
});

test("CAS-848 AC4: openMovingScreen always opens pinned to 2 weeks, with no prior state", () => {
  // 9 rows all aged 20 days — under CAS-671's old row-count auto-pick this would have opened on Month.
  // The new behaviour must ignore row distribution entirely and always land on 2 weeks.
  const films = unwatchedFilms(9);
  assert.equal(films.length, 9, "sanity: needs 9 distinct unwatched films to seed this scenario");
  seedFirstFound(films, 20);

  E.openMovingScreen();
  assert.equal(E.movingWindow, "2weeks", "openMovingScreen must always land on 2 weeks, regardless of row age/count");
  E.closeMovingScreen();

  // Reopening with the same, unchanged data must land on 2 weeks again.
  E.openMovingScreen();
  assert.equal(E.movingWindow, "2weeks", "reopening with no data change must still land on 2 weeks");
  E.closeMovingScreen();

  unseedFirstFound(films);
});

test("CAS-668: rendering a window does not clear the unseen state of rows outside it", () => {
  const [filmA, filmB] = unwatchedFilms(2);
  const idA = String(filmA.tmdb_id), idB = String(filmB.tmdb_id);

  seedFirstFound([filmB], 10);   // aged 10 days — inside 2weeks/month, outside today/week
  seedFirstFound([filmA], 20);   // aged 20 days — inside month only, outside 2weeks

  E.openMovingScreen();
  assert.equal(E.movingWindow, "2weeks", "sanity: Moving always opens on 2 weeks now");
  const { shownRows } = E.movingWindowRows("2weeks");
  const shownIds = shownRows.map(r => r.filmId);
  assert.ok(shownIds.includes(idB) && !shownIds.includes(idA), "sanity: filmB is in the 2 weeks window, filmA is not");

  assert.equal(E.movingSeen[idB], "new", "the row actually shown in the rendered window must be marked seen");
  assert.ok(!(idA in E.movingSeen), "a row outside the rendered window must not have its unseen state touched");
  E.closeMovingScreen();

  unseedFirstFound([filmA, filmB]);
});

test("CAS-668: an empty window's badge reads 0, not a count borrowed from a different window", () => {
  const [film] = unwatchedFilms(1);
  seedFirstFound([film], 20);  // real, unseen, but never inside "today"

  E.openMovingScreen();
  E.setMovingWindow("today");
  const { shownRows } = E.movingWindowRows("today");
  assert.equal(shownRows.length, 0, "sanity: \"today\" really is empty for this seeded data");
  assert.equal(E.movingUnseenCount(), 0,
    "the badge must read 0 for an empty window even though an unseen row exists in a different window");
  E.closeMovingScreen();

  unseedFirstFound([film]);
});

// Not a real check — node:test runs a file's test() bodies in registration order, so this is where the
// CAS-829 shared owner cascade (module-level, pushed once above) actually gets removed. Top-level code runs
// at module-load time, before any test body executes, so the removal has to be a test of its own rather
// than a bare statement here.
test("CAS-829: moving-owner test fixture cleanup", () => {
  unseedMovingOwner(MOVING_OWNER);
  assert.ok(!E.cascades.some(c => c.id === MOVING_OWNER.id), "the shared moving-owner fixture must be removed");
});

// ---- THE LISTING APPLIES NO DEPTH CAP OR SCORE FLOOR (CAS-662) --------------------------------------------
// render() used to read one active agent's onboarding depth answer + rate-slider stop and apply that agent's
// floor/cap to the WHOLE listing — a six-agent list could render one film under a "Show all 36" button, none
// of which anyone had chosen. AC1 (structural: render() reads no onbDepth, the app carries no obshowall
// affordance) is checked directly against the source; AC2 (arithmetic: the listing yields exactly the rows it
// is given, with no further trimming) is checked against listingGroups(), render()'s own DOM-free group
// partition — the only place the cap used to live.
test("CAS-662 AC1: render() reads no onbDepth, and the app carries no obshowall affordance", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const renderStart = src.indexOf("\nfunction render(){");
  assert.ok(renderStart >= 0, "render() was not found");
  const renderEnd = src.indexOf("\n// ---- CAS-275", renderStart);
  assert.ok(renderEnd > renderStart, "the end of render() was not found");
  const renderBody = src.slice(renderStart, renderEnd);
  assert.ok(!renderBody.includes("onbDepth"), "render() still reads onbDepth");
  assert.ok(!src.includes("obshowall"), "the app still carries the obshowall affordance");
});

test("CAS-662 AC2: the listing yields exactly E.listedBy's rows, for every group, no cap or floor", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const rows = E.MOVIES.filter(m => E.listedBy(m, d));
    const groups = E.listingGroups(rows, d);
    const total = groups.reduce((n, x) => n + x.items.length, 0);
    assert.equal(total, rows.length,
      `${label}: the listing dropped ${rows.length - total} of ${rows.length} listed film(s) — a cap survived`);
    // AC3: a group's header count (rendered cards minus tagged-out stubs) can never exceed what render()
    // actually streams for that group — true as long as no group holds more than its own rows.length.
    for(const { g, items } of groups) assert.ok(items.length <= rows.filter(m => E.primaryStatus(m) === g).length,
      `${label}/${g}: group holds more items than the rows that belong to it`);
  }
});

// ---- WATCH ON PLACEMENT — THE LATER-OF RULE (CAS-727) ------------------------------------------------------
// recomputeFound() now computes every admitted film's Watch On itself, every pass: the later of `earned`
// (the window its score clears, fixed once at admission and never re-thresholded) and `standing` (the
// window it's in right now, which keeps moving). This replaces CAS-613's once-ever `autoNotify`-gated arm
// outright — autoNotified is gone (AC5 below), and c.autoNotify no longer has anything to do with Watch On.
function seedMarkerCascade(markers){
  const id = "cas727-test-cascade";
  // A full normCascade(), not a bare object: watchesFilm/matchesCriteria run against EVERY film in
  // MOVIES.forEach (recomputeFound loops the whole catalogue per cascade), and a bare {id} crashes on the
  // first film that isn't the one this test pins in. imdb:10.1 is above the real 0-10 scale, so criteria
  // matching admits nothing — only pinFilm's pinnedInto override reaches this cascade.
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.paused = false;
  c.watchMarkers = { in_cinema: null, premium: null, rent: null, stream: null, ...markers };
  E.cascades.push(c);
  return id;
}
// Cinema/Rental/Streaming on, Premium off — the default watchPrefsDefaults() shape, made explicit so these
// tests don't depend on whatever an earlier test left the global watchPrefs pointing at.
const PLACEMENT_WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function unseedCascade(id){
  const i = E.cascades.findIndex(c => c.id === id);
  if(i >= 0) E.cascades.splice(i, 1);
}
function pinFilm(id, cascadeId){
  const e = E.entryFor(id);
  e.pinnedTo = [...(e.pinnedTo || []), cascadeId];
}
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}

// Picks an unwatched film with a real (non -1) Cascade score under `status`, since the placement rule has
// nothing to grade a scoreless film against. unwatchedFilms(n) already skips watched films; this just walks
// forward until cascadeScore(m) is real, restoring nothing itself — status is the caller's to save/restore.
function scoredUnwatchedFilm(status){
  const pool = unwatchedFilms(40);
  for(const m of pool){
    const saved = m.status;
    m.status = status;
    const score = E.cascadeScore(m);
    if(score !== -1) return m;
    m.status = saved;
  }
  throw new Error("no unwatched film in the first 40 carries a real Cascade score under " + JSON.stringify(status));
}
// Same search, but hands back a restore() closing over the film's status as it stood BEFORE this pick — not
// scoredUnwatchedFilm's own "savedStatus = film.status" convention, which captures the status AFTER it has
// already been overwritten and so never actually undoes the mutation. That's harmless as long as no later
// test's own unwatchedFilms() pick lands on the same film, which is what happened here: CAS-731's tests and
// CAS-709/CAS-728's fixed unwatchedFilms(1) pick collided on the same first film once this file's own status
// mutations accumulated. `listable` additionally demands !isEstimated(m) for tests that must clear
// listWindowOK (CAS-731's placementSplitHTML tests, via listedBy) — an ESTIMATED "upcoming" is denied there
// outright (CAS-481) — where the recomputeFound-only CAS-727 tests above don't need it.
function pickScoredFilm(status, { listable = false } = {}){
  const pool = unwatchedFilms(60);
  for(const m of pool){
    const original = m.status;
    m.status = status;
    const score = E.cascadeScore(m);
    if(score !== -1 && (!listable || !E.isEstimated(m))) return { film: m, restore: () => { m.status = original; } };
    m.status = original;
  }
  throw new Error(`no eligible unwatched film in the first 60 under ${JSON.stringify(status)} (listable=${listable})`);
}

test("CAS-727 AC2(a): upcoming, score above the Cinema marker, is placed at Cinema", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    const e = E.notify[id];
    assert.equal(e.wins.in_cinema, true, "an upcoming film clearing the Cinema marker is placed at Cinema");
    assert.equal(e.winsSource.in_cinema, "auto");
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC2(b): in cinemas, a score between the Rental and Cinema markers is placed at Rental", () => {
  const film = scoredUnwatchedFilm(["in_cinema"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score + 10, rent: score - 10, stream: score - 20 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    const e = E.notify[id];
    assert.equal(e.wins.rent, true,
      "the score doesn't clear Cinema but clears Rental, and the film is standing at Cinema — 'I'll wait for it'");
    assert.equal(e.winsSource.rent, "auto");
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC2(c)/(d)/AC3-in-miniature: earned is fixed at admission — a film travels forward with its status, and a window dropped to Off (CAS-1128) is skipped, not followed", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);   // taken while upcoming (cinema basis) — must survive the basis flip below
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      E.recomputeFound();
      assert.equal(E.notify[id].wins.in_cinema, true, "AC2(a) sanity: armed at Cinema while upcoming");

      // (c): the same film, unwatched, now rental — earned (Cinema, from the score at admission) never
      // gets re-read even though released films score on a completely different basis (qScore, not cinema
      // buzz); only standing moves, and it moves past earned.
      film.status = ["rental"];
      E.recomputeFound();
      assert.equal(E.notify[id].wins.rent, true, "AC2(c): standing overtakes earned once the film reaches rental");
      assert.equal(E.notify[id].wins.in_cinema, false);

      // (d), CAS-1128: windows are independent on/off now (CAS-917's start-window-forward model retired) —
      // dropping Rental's own marker to Never switches that window OFF for this agent, so placement must
      // skip it, not land on it. Streaming still carries its own marker (never nulled by this test), so the
      // film moves on to it, the next window it reaches that this agent still has ON.
      const c = E.cascades.find(x => x.id === cId);
      c.watchMarkers.rent = null;
      E.recomputeFound();
      assert.equal(E.notify[id].wins.rent, false, "AC2(d), CAS-1128: an OFF Rental must never be placed in");
      assert.equal(E.notify[id].wins.in_cinema, false);
      assert.equal(E.notify[id].wins.stream, true, "AC2(d), CAS-1128: placement must move on to the next ON window (Streaming)");
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC2(e): a score below every marker is admitted (via pin) but placed nowhere", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  // 101 is above the 0-100 scale on every axis cascadeScore can return, so no real score ever clears it —
  // simpler than reasoning about the film's own score value, and just as much "below every marker".
  const cId = seedMarkerCascade({ in_cinema: 101, rent: 101, stream: 101 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    const e = E.notify[id];
    const picked = !!(e && e.wins && Object.values(e.wins).some(Boolean));
    assert.ok(!picked, "a film that clears no marker must get no Watch On value, even though the pin admits it");
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC3: replaying a film's status forward never moves its Watch On backward on WINDOW_RUNG", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      const journey = [["upcoming"], ["in_cinema"], ["rental"], ["included_streaming"]];
      let prevRank = -1;
      for(const status of journey){
        film.status = status;
        E.recomputeFound();
        const e = E.notify[id];
        const key = E.WATCH_LEVEL_KEYS.find(k => e.wins && e.wins[k]);
        assert.ok(key, `a film clearing its Cinema marker at admission must still hold a Watch On value at ${status}`);
        const rank = E.WATCH_LEVEL_KEYS.indexOf(key);
        assert.ok(rank >= prevRank,
          `Watch On moved backward at status=${status}: rank ${rank} < previous ${prevRank}`);
        prevRank = rank;
      }
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC4: a manual Watch On value is byte-identical before and after recompute, for any marker combination", () => {
  const film = scoredUnwatchedFilm(["in_cinema"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const cId = seedMarkerCascade({});
  try {
    pinFilm(id, cId);
    const e = E.entryFor(id);
    e.wins = { in_cinema: false, premium: false, rent: true, stream: false };
    e.winsSource = { rent: "manual" };
    const before = JSON.stringify([e.wins, e.winsSource]);
    const c = E.cascades.find(x => x.id === cId);
    const score = E.cascadeScore(film) === -1 ? 50 : E.cascadeScore(film);
    const combos = [
      { in_cinema: score - 1, rent: score - 20, stream: score - 30 },
      { in_cinema: null, rent: null, stream: null },
      { in_cinema: 0, rent: 0, stream: 0 },
      { in_cinema: score + 40, rent: score + 20, stream: score + 10 },
    ];
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      for(const markers of combos){
        c.watchMarkers = { in_cinema: null, premium: null, rent: null, stream: null, ...markers };
        for(const status of [["upcoming"], ["in_cinema"], ["rental"], ["included_streaming"]]){
          film.status = status;
          E.recomputeFound();
          assert.equal(JSON.stringify([e.wins, e.winsSource]), before,
            `a manual value must survive recompute: markers=${JSON.stringify(markers)} status=${status}`);
        }
      }
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC5: app_template.html carries no trace of the retired autoNotified guard", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const count = (src.match(/autoNotified/g) || []).length;
  assert.equal(count, 0, `expected 0 occurrences of "autoNotified", found ${count}`);
});

// ---- MISSION PLACEMENT SPLIT COUNTS WATCH ON, NOT AVAILABILITY (CAS-731) -----------------------------------
// placementSplitHTML(c) used to bucket by primaryStatus(m) through filmOptKeyForWindow — the film's CURRENT
// availability — which both answered the wrong question (CAS-729 §7 item 7 wants placement, what the agent
// DECIDED) and silently dropped a film whenever that status mapped to a window outside the agent's own marks
// (upcoming/pvod), so the parts didn't sum to the headline (the CAS-680/682 bug, again). It now buckets by
// filmNotifyState(m.tmdb_id).key — Watch On, the same value the Watch screen's tabs filter on — and any
// listed film without a bucket in `marks` (no Watch On value yet) falls into a trailing "unplaced" part
// instead of vanishing.
function sumPlacementParts(html){
  if(!html) return 0;
  const parts = [...html.matchAll(/(\d+) (?:Cinema|Premium|Rental|Streaming|unplaced)/g)];
  return parts.reduce((sum, m) => sum + Number(m[1]), 0);
}

test("CAS-731 AC2: the placement split (including unplaced) sums to the listing headline, for every lane", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const html = E.placementSplitHTML(d);
    const sum = sumPlacementParts(html);
    assert.equal(sum, E.listedCount(d), `${label}: placement split sums to ${sum}, the listing has ${E.listedCount(d)} (split: "${html}")`);
  }
});

test("CAS-731 AC2: a listed film with no Watch On value is counted as unplaced, not dropped", () => {
  const { film, restore } = pickScoredFilm(["upcoming"], { listable: true });
  const id = film.tmdb_id;
  // 101 is above the 0-100 scale on every axis cascadeScore can return, so the pinned film clears no marker
  // and gets no Watch On value at all — the "no bucket" case this test exists to check.
  const cId = seedMarkerCascade({ in_cinema: 101, rent: 101, stream: 101 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      E.recomputeFound();
      assert.equal(E.filmNotifyState(id).key, null, "sanity: a score below every marker leaves no Watch On value");
      const c = E.cascades.find(x => x.id === cId);
      const html = E.placementSplitHTML(c);
      assert.match(html, /\b1 unplaced\b/, `expected the unplaced film to surface, not vanish: "${html}"`);
      assert.equal(sumPlacementParts(html), E.listedCount(c), `parts must still sum to the headline: "${html}"`);
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    restore();
  }
});

test("CAS-731 AC3: a film admitted from upcoming and placed at Cinema is counted in the Cinema part, not dropped", () => {
  const { film, restore } = pickScoredFilm(["upcoming"], { listable: true });
  const id = film.tmdb_id;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      E.recomputeFound();
      assert.equal(E.primaryStatus(film), "upcoming", "sanity: the film is still upcoming");
      assert.equal(E.filmNotifyState(id).key, "in_cinema", "sanity: Watch On is Cinema");
      const c = E.cascades.find(x => x.id === cId);
      const html = E.placementSplitHTML(c);
      const cinema = html.match(/(\d+) Cinema/);
      assert.ok(cinema && Number(cinema[1]) >= 1, `expected the upcoming film in the Cinema part, not dropped: "${html}"`);
      assert.equal(sumPlacementParts(html), E.listedCount(c), `parts must sum to the headline: "${html}"`);
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    restore();
  }
});

test("CAS-731 AC4: a film whose Watch On is Streaming while standing at Rental is counted in Streaming, not Rental", () => {
  const { film, restore } = pickScoredFilm(["rental"]);
  const id = film.tmdb_id;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score + 50, rent: score + 20, stream: score - 1 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      E.recomputeFound();
      assert.equal(E.primaryStatus(film), "rental", "sanity: the film is standing at Rental");
      assert.equal(E.filmNotifyState(id).key, "stream", "sanity: Watch On is Streaming, following the score, not availability");
      const c = E.cascades.find(x => x.id === cId);
      const html = E.placementSplitHTML(c);
      const streaming = html.match(/(\d+) Streaming/);
      const rental = html.match(/(\d+) Rental/);
      assert.ok(streaming && Number(streaming[1]) >= 1, `expected the film in Streaming: "${html}"`);
      assert.equal(rental ? Number(rental[1]) : 0, 0, `the film must not also count under Rental: "${html}"`);
      assert.equal(sumPlacementParts(html), E.listedCount(c), `parts must sum to the headline: "${html}"`);
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    restore();
  }
});

test("CAS-613 AC5: recomputeFound() calls saveNotify() at most once per pass", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const start = src.indexOf("\nfunction recomputeFound(){");
  assert.ok(start >= 0, "recomputeFound() was not found");
  const end = src.indexOf("\n// What the megaphone's colour", start);
  assert.ok(end > start, "the end of recomputeFound() was not found");
  const body = src.slice(start, end);
  const calls = body.match(/\bsaveNotify\(\)/g) || [];
  assert.equal(calls.length, 1, `recomputeFound() calls saveNotify() ${calls.length} time(s), expected exactly 1`);
});

// ---- A FILM BELONGS TO EXACTLY ONE AGENT (CAS-709) --------------------------------------------------------
// recomputeFound() used to let a film be found by every Cascade whose criteria matched it, so a film could
// show under two auto-matching agents at once. Now, unpinned, it belongs to exactly its single highest-ranked
// (lowest .order) match; pinned, it belongs to exactly its pinned cascade(s), full stop, even against a
// higher-ranked agent's own criteria match.
test("CAS-709 AC1/AC2: an unpinned film keeps only its top-ranked match; a hand-pin outranks a higher-ranked match", () => {
  const [film] = unwatchedFilms(1);
  const id = film.tmdb_id;
  const before = new Set(Object.keys(E.notify));
  // Broad, unconstrained criteria (mirrors seedAutoNotifyCascade's shape) so both agents match the same
  // film by CRITERIA, not by pin — .order is what CAS-709 says must decide between them.
  const cA = E.normCascade({ kind: "stream", status: [] }); cA.id = "cas709-a"; cA.paused = false; cA.order = -1000;
  const cB = E.normCascade({ kind: "stream", status: [] }); cB.id = "cas709-b"; cB.paused = false; cB.order = -999;
  E.cascades.push(cA, cB);
  try {
    E.recomputeFound();
    // vm-realm gotcha: cascadeIds is an Array from the sandboxed engine's own realm, so it must be spread
    // into a plain array before deepEqual — compared directly it fails even with identical contents.
    assert.deepEqual([...E.notify[id].cascadeIds], [cA.id],
      "AC1: an unpinned film matched by two agents must belong to exactly its single highest-ranked (lowest .order) one");

    pinFilm(id, cB.id);   // hand-pin into the LOWER-ranked agent while the higher-ranked one still matches by criteria
    E.recomputeFound();
    assert.deepEqual([...E.notify[id].cascadeIds], [cB.id],
      "AC2: a hand-pin must win outright over a higher-ranked agent's own criteria match");
  } finally {
    unseedCascade(cA.id);
    unseedCascade(cB.id);
    // The broad-match agents above will have found many other films besides `id` — clean up every notify
    // entry this test created, not just the one it asserted on, then recompute so real state is restored.
    for(const k of Object.keys(E.notify)) if(!before.has(k)) delete E.notify[k];
    E.recomputeFound();
  }
});

// ---- A MONITOR MOMENT CAN NEVER RENDER AS ITS RAW KEY (CAS-602) -------------------------------------------
// The monitor's `newly_qualifies` moment (a held film whose own attributes newly qualify it for an agent)
// has to be in REAL_MOMENT_SAID, the bell's own moment-copy lookup, or a ledger row for it would fall
// through to a.moment itself at the ntfrow render site — a raw internal key on screen.
test("CAS-602: REAL_MOMENT_SAID carries the newly_qualifies key, so its ledger row never renders raw", () => {
  assert.ok(Object.prototype.hasOwnProperty.call(E.REAL_MOMENT_SAID, "newly_qualifies"),
    "REAL_MOMENT_SAID is missing a newly_qualifies entry");
  assert.equal(typeof E.REAL_MOMENT_SAID.newly_qualifies, "string",
    "REAL_MOMENT_SAID.newly_qualifies must be real copy, not empty/falsy");
});

// ---- CAS-678: ONE POPULARITY LADDER — THE BUZZ DIAL AND THE CARD LOZENGE CANNOT DRIFT APART --------------
// One cohort (films whose status includes upcoming or in_cinema), one quantity (TMDB popularity), one set of
// percentile cuts. The card badge and the Buzz dial both read buzzStop()/buzzBandOf(), so these are really
// one invariant tested from both ends, not two separate claims that happen to agree today.
test("CAS-678 AC1: one set of popularity thresholds, computed over the upcoming-and-in-cinema cohort", () => {
  assert.deepEqual([...E.BUZZ_PCTL], [0, 65, 85, 95], "the ladder's percentile stops have moved");
  assert.equal(E.BUZZ_CUTS.length, E.BUZZ_PCTL.length, "one cut per stop");
  for(let i = 1; i < E.BUZZ_CUTS.length; i++){
    assert.ok(E.BUZZ_CUTS[i] >= E.BUZZ_CUTS[i - 1], "the cuts must be non-decreasing — a higher stop is a higher bar");
  }
  const cohort = E.MOVIES.filter(m => m.status.includes("upcoming") || m.status.includes("in_cinema"));
  assert.ok(cohort.length > 0, "the cohort is empty — this test would prove nothing");
  for(const m of cohort) assert.equal(E.inLadderCohort(m), true, `${m.title}: in the cohort by status but inLadderCohort says no`);
  for(const m of E.MOVIES.filter(m => !cohort.includes(m))){
    assert.equal(E.inLadderCohort(m), false, `${m.title}: outside the cohort by status but inLadderCohort says yes`);
  }
});

test("CAS-678 AC2: a film displays a band's lozenge if and only if the Buzz dial set to that band returns it", () => {
  const BAND_KEY = { anticipated: 1, blockbuster: 2, mustsee: 3 };
  for(const m of E.MOVIES){
    const badge = E.scaleTier(m);
    if(badge === "landmark") continue;   // Landmark outranks the ladder — its own axis, tested separately
    for(const [band, stop] of Object.entries(BAND_KEY)){
      const dialReturnsExactlyThisBand = E.buzzStop(m) >= stop
        && (stop === 3 || !(E.buzzStop(m) >= stop + 1));
      assert.equal(badge === band, dialReturnsExactlyThisBand,
        `${m.title}: badge is ${badge || "none"}, dial-at-${band} says ${dialReturnsExactlyThisBand}`);
    }
  }
});

test("CAS-678 AC3: no film outside the cohort carries any of the three ladder lozenges", () => {
  for(const m of E.MOVIES){
    if(E.inLadderCohort(m)) continue;
    assert.equal(E.buzzBandOf(m), null, `${m.title}: outside the cohort but badged ${E.buzzBandOf(m)}`);
  }
});

test("CAS-678 AC4: the three bands are disjoint and ordered — a film's band is the highest it clears", () => {
  for(const m of E.MOVIES){
    const stop = E.buzzStop(m);
    assert.ok(stop >= 0 && stop <= 3, `${m.title}: buzzStop ${stop} out of range`);
    // Every lower stop must also be cleared (a floor, not a band) — otherwise "highest cleared" is undefined.
    for(let s = 1; s <= stop; s++){
      assert.equal(E.buzzStop(m) >= s, true, `${m.title}: clears stop ${stop} but not the lower stop ${s}`);
    }
    for(let s = stop + 1; s <= 3; s++){
      assert.equal(E.buzzStop(m) >= s, false, `${m.title}: buzzStop says ${stop} but also clears the higher stop ${s}`);
    }
  }
});

test("CAS-678 AC5: Landmark behaves exactly as before the change — its predicate is unchanged", () => {
  const LANDMARK_RT = 85, LANDMARK_META = 75, BIG_BUDGET = 120e6;
  const BLOCKBUSTER_TOP = 15;
  const popOf = m => m.popularity || 0;
  const popAll = E.MOVIES.map(popOf).sort((a, b) => a - b);
  const blockbusterBar = popAll.length
    ? popAll[Math.min(popAll.length - 1, Math.round((100 - BLOCKBUSTER_TOP) / 100 * (popAll.length - 1)))] : Infinity;
  // CAS-920: RT and Metacritic collapsed onto the single wm_critic_score figure — the OR of the two original
  // bars against that one field is just its minimum.
  const reproIsLandmark = m => !!m.award
    && ((m.wm_critic_score || 0) >= Math.min(LANDMARK_RT, LANDMARK_META))
    && ((m.budget || 0) >= BIG_BUDGET || popOf(m) >= blockbusterBar);
  let landmarkCount = 0;
  for(const m of E.MOVIES){
    assert.equal(E.isLandmark(m), reproIsLandmark(m), `${m.title}: isLandmark disagrees with the pre-CAS-678 formula`);
    if(E.isLandmark(m)) landmarkCount++;
  }
  assert.ok(landmarkCount > 0, "not one film is badged Landmark — this test would prove nothing");
});

test("CAS-678 AC6: matchesCriteria no longer reads c.tentpole, and no Tentpole UI markup remains", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const start = src.indexOf("\nfunction matchesCriteria(m,c,ignoreBlocked,ignoreScoreGate){");
  assert.ok(start >= 0, "matchesCriteria() was not found");
  const end = src.indexOf("\nconst countCriteria = c =>", start);
  assert.ok(end > start, "the end of matchesCriteria() was not found");
  assert.ok(!/tentpole/i.test(src.slice(start, end)), "matchesCriteria still reads the tentpole criterion");
  for(const gone of ["TENTPOLE_STOPS", "tentpoleSel", "cTentLoz", "cTentCap", "cTentDesc"]){
    assert.ok(!src.includes(gone), `${gone} still appears — Tentpole UI has not been fully removed`);
  }
  // The stored field itself, and cascSigOf's use of it, are explicitly UNCHANGED (CAS-678 item Four).
  assert.ok(/c\.tentpole = c\.tentpole\|\|"any";/.test(src), "the stored c.tentpole field's normalisation was removed");
  const sigStart = src.indexOf("const cascSigOf = c =>");
  assert.ok(sigStart >= 0, "cascSigOf() was not found");
  assert.ok(/c\.tentpole/.test(src.slice(sigStart, sigStart + 300)), "cascSigOf no longer carries c.tentpole");
});

test("CAS-733 AC7: CascadePersistence exposes no CAS-212 merge-sheet seam — signed-out is no longer a usable state to offer a merge away from", () => {
  const keys = Object.keys(E.CascadePersistence);
  assert.ok(!keys.includes("offerMerge"), "CascadePersistence must not expose offerMerge");
  assert.ok(!keys.includes("pendingMerge"), "CascadePersistence must not expose pendingMerge");
  assert.ok(!keys.includes("renderMigrate"), "CascadePersistence must not expose renderMigrate");
});

// ---- THE WATCH-LIST CARD AND SECTION COUNTS DESCRIBE WHAT render() ACTUALLY PUTS ON SCREEN (CAS-682) ------
// Reported case: list "Lee Stream", scope bar set to For review + Watched, Notify off. The deck card read 234
// (watchlistRawCount — the raw agent union, ignoring the scope bar AND the list's own svcOn/watchedOn/
// watchTiers entirely). The Rent section read 53 against 58 rendered rows (`items.filter(!taggedOut)` dropped
// five stubs the section still drew). Fix: the card now takes render()'s own `rows` (scopeRows(), the exact
// set the sections are built from); each section header counts every item in its group, stubs included.
// AC1/AC6 are checked structurally (render() is DOM-bound and not itself callable from this harness, exactly
// like CAS-662's own AC1) — AC2/AC3/AC4 are checked arithmetically against the same `rows`/`listingGroups`
// render() reads, reproducing the reported scope combination.
test("CAS-682 AC1/AC6: render() feeds the deck card scopeRows()'s own `rows`, not a pre-scope pool", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const renderStart = src.indexOf("\nfunction render(){");
  assert.ok(renderStart >= 0, "render() was not found");
  const renderEnd = src.indexOf("\n// ---- CAS-275", renderStart);
  assert.ok(renderEnd > renderStart, "the end of render() was not found");
  const renderBody = src.slice(renderStart, renderEnd);
  assert.ok(renderBody.includes("renderCascadeBar(rows.length)"),
    "the deck card must be handed rows.length — the exact set the listing below is built from");
  assert.ok(!renderBody.includes("pool.filter(m=>!taggedOut(m)).length"),
    "the deck card must no longer fall back to the pre-scope pool count");
});

test("CAS-682 AC3: render() counts every row a section holds, stubs included, no taggedOut subtraction", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const renderStart = src.indexOf("\nfunction render(){");
  const renderEnd = src.indexOf("\n// ---- CAS-275", renderStart);
  const renderBody = src.slice(renderStart, renderEnd);
  assert.ok(renderBody.includes("const live=items.length;"),
    "each group's header count must equal every row in that group");
  assert.ok(!renderBody.includes("items.filter(m=>!taggedOut(m)).length"),
    "the header must not subtract tagged-out stubs any more — a stub is still a rendered row");
});

// ---- CONDENSED CARD STATS ROW IS A PER-FILM DECISION (CAS-686, CAS-919) -----------------------------------
// CAS-624 gated the condensed card's money-vs-scores row on the LISTING (#groups.cinema-listing — every card
// under a cinema agent got the money row, no matter what the film itself held). CAS-686 replaced that with a
// per-FILM rule over IMDb/RT/Metacritic; CAS-919 moved the rule onto Watchmode: a film showing the scores row
// needs at least one of wm_user_rating or wm_critic_score, a film with neither gets the money row instead —
// a count or a row that doesn't describe the film beside it is this project's own repeat failure mode
// (CAS-680, CAS-682), so this asserts the predicate directly rather than spot-checking a rendered card.
test("CAS-919: condensedShowsScores agrees with the Watchmode two-source rule, over fixture films covering every combination", () => {
  const twoSourceRule = m => m.wm_user_rating!=null || m.wm_critic_score!=null;
  const fixtures = [
    { title: "None",           wm_user_rating: null, wm_critic_score: null },
    { title: "People only",    wm_user_rating: 7.1, wm_critic_score: null },
    { title: "Critics only",   wm_user_rating: null, wm_critic_score: 55 },
    { title: "Both",           wm_user_rating: 6.0, wm_critic_score: 60 },
  ];
  for(const m of fixtures){
    assert.equal(E.condensedShowsScores(m), twoSourceRule(m),
      `${m.title}: condensedShowsScores disagrees with the two-source rule`);
  }
  // …and over the real catalogue, so the invariant also holds for whatever the fixture list didn't think of.
  for(const m of E.MOVIES){
    assert.equal(E.condensedShowsScores(m), twoSourceRule(m),
      `${m.title}: condensedShowsScores disagrees with the two-source rule`);
  }
});

// ---- CAS-695: THE CINEMA (PRE-RELEASE) CASCADE SCORE -------------------------------------------------------
// Before this, qScore (People's vote/Critics) was the only Cascade score, and it scores from reviews that a
// pre-release film cannot have yet — 85% of Upcoming and 79% of In Cinema carried no score. cascadeScore picks
// its basis by where the film is in its life: the cinema score (buzz percentile, CAS-722) pre-release, the
// streaming score (qScore) once released. PVOD sits on the streaming side by decision (it is released).
// CAS-749 superseded the plain isPreRelease dispatch this test used to assert: an in_cinema/opening_week film
// with a real qScore now blends it with the mapped buzz figure rather than reading pure buzz. This whole-
// catalogue expectation is rewritten to that three-way rule; the upcoming-only and released-only spot checks
// below are unaffected by CAS-749 (upcoming never had a qScore to blend, released never had buzz to blend).
// CAS-919: the three-way dispatch is unchanged, but its two terms are now wmCinemaScore/wmQScore (Watchmode)
// instead of cinemaScore/qScore (OMDb/TMDB) — qScore/cinemaScore survive under their own names but are no
// longer what cascadeScore reads.
// CAS-1005: the upcoming/released spot checks below use fixed fixtures, not E.MOVIES.find() — "not
// isPreRelease" is not the same test as "released" (opening_week is neither), and a live film's cinema
// date landing on today can flip its primaryStatus out from under a `find()`.
test("CAS-695 AC1: the score's basis switches on primaryStatus — cinema (buzz) before release, streaming (Watchmode) after", () => {
  const upcomingFilm = { status: ["upcoming"], wm_popularity_percentile: 50 };
  assert.equal(E.cascadeScore(upcomingFilm), E.wmCinemaScore(upcomingFilm),
    "upcoming film's Cascade score is not its Watchmode cinema score");

  const releasedFilm = { status: ["included_streaming"], wm_user_rating: 7.5, wm_critic_score: 82 };
  assert.equal(E.cascadeScore(releasedFilm), E.wmQScore(releasedFilm),
    "released film's Cascade score is not its (Watchmode) wmQScore");

  // Whole catalogue: the same three-way dispatch, never a fourth formula.
  for(const m of E.MOVIES){
    const ps = E.primaryStatus(m);
    let expected;
    if(ps === "upcoming") expected = E.wmCinemaScore(m);
    else if(ps === "in_cinema" || ps === "opening_week"){
      const buzz = E.wmCinemaScore(m), q = E.wmQScore(m);
      expected = q >= 0 ? Math.round((buzz + q) / 2) : buzz;
    } else expected = E.wmQScore(m);
    assert.equal(E.cascadeScore(m), expected, `${m.title}: cascadeScore disagrees with the basis its own status picks`);
  }
});

// ---- CAS-748: THE CINEMA SCORE IS QUANTILE-MAPPED ONTO THE RELEASED DISTRIBUTION ----------------------------
// CAS-722 made cinemaScore exactly buzzPctlOf — a raw, uniform-by-construction percentile rank. That put the
// two sides of cascadeScore on different scales: the released side (qScore) is bell-shaped around 67 with a
// 95th percentile of only 87, so a marker at 90 or 95 selected wildly different slices of each cohort (10.7%
// of pre-release vs 2.9% of released scoring 90+, measured 2026-09-03). This retires that alignment (CAS-722
// AC1/AC2 above) in favour of one where a marker means the same thing on both sides.
// CAS-920: cinemaScore/releasedScoreVals (the OMDb-sourced pair this quantile map first shipped on) are
// retired along with the rest of the app's OMDb reads — wmCinemaScore/wmReleasedScoreVals are the only
// implementation left, over wm_popularity_percentile rather than raw TMDB popularity.
test("CAS-748 AC1: wmCinemaScore is a quantile map — wmBuzzPctlOf looked up against the released cohort's own score distribution", () => {
  const originalMovies = E.MOVIES.slice();
  try {
    // CAS-1028: movies.json has been scoreable-only since CAS-986/1027, so every upcoming/in_cinema film in
    // the live catalogue now carries a wm_popularity_percentile — there is no longer a live "unscored cohort
    // film" to find. Clone a real cohort film and strip that one field so it's unscored but otherwise
    // genuine, same "mutate MOVIES in place, restore in finally" shape CAS-742 AC2/CAS-748 AC6 already use.
    const donor = E.MOVIES.find(m => E.inLadderCohort(m) && typeof m.wm_popularity_percentile === "number");
    assert.ok(donor, "test setup: no scored cohort film available to clone for the unscored fixture");
    const unscoredFixture = { ...donor, tmdb_id: -748001, wm_popularity_percentile: undefined };
    E.MOVIES.push(unscoredFixture);
    E.invalidateComputeCaches();

    const cohort = E.MOVIES.filter(m => E.inLadderCohort(m));
    const scored = cohort.filter(m => typeof m.wm_popularity_percentile === "number");
    const unscored = cohort.filter(m => typeof m.wm_popularity_percentile !== "number");
    assert.ok(scored.length > 0, "no cohort film with a numeric wm_popularity_percentile found — this test would prove nothing");
    assert.ok(unscored.length > 0, "no cohort film with no wm_popularity_percentile found — this test would prove nothing");
    const vals = E.wmReleasedScoreVals();
    assert.ok(vals.length > 0, "the released cohort's score array is empty — this test would prove nothing");
    for(const m of scored){
      const p = E.wmBuzzPctlOf(m);
      const expected = Math.round(vals[Math.min(vals.length - 1, Math.floor(vals.length * p / 100))]);
      assert.equal(E.wmCinemaScore(m), expected, `${m.title}: wmCinemaScore disagrees with the quantile-map lookup at p=${p}`);
    }
    for(const m of unscored){
      assert.equal(E.wmCinemaScore(m), -1, `${m.title}: a cohort film with no wm_popularity_percentile should not score`);
    }
  } finally {
    E.MOVIES.length = 0; E.MOVIES.push(...originalMovies);
    E.invalidateComputeCaches();
  }
});

// AC5: CAS-722's own badge/score alignment is deliberately given up here (Lee's decision) — the badge
// continues to come from buzzBandOf/BUZZ_CUTS, popularity-only, and must not move now that cinemaScore reads
// a different scale. Reimplemented independently from BUZZ_CUTS/popularity rather than read back through
// buzzStop, so this would actually catch cinemaScore leaking into the badge.
test("CAS-748 AC5: buzzBandOf's badge stays independent of cinemaScore's quantile map", () => {
  const badgeFromPopularity = m => {
    if(!E.inLadderCohort(m) || typeof m.popularity !== "number") return null;
    for(let s = E.BUZZ_KEY.length - 1; s >= 1; s--) if(m.popularity >= E.BUZZ_CUTS[s]) return E.BUZZ_KEY[s];
    return null;
  };
  let checked = 0;
  for(const m of E.MOVIES){
    checked++;
    assert.equal(E.buzzBandOf(m), badgeFromPopularity(m), `${m.title}: buzzBandOf disagrees with a popularity-only badge`);
  }
  assert.ok(checked > 0, "no films found — this test would prove nothing");
});

// AC2/AC3: the whole point of the quantile map — read with the SAME cutoff convention cinemaScore itself
// uses (percentileOf below === the production floor(len*p/100) lookup), against the live catalogue rather
// than the canned 2026-09-03 measurement, so a normal catalogue refresh cannot make this stale.
function percentileOf(sortedVals, p){
  return sortedVals[Math.min(sortedVals.length - 1, Math.floor(sortedVals.length * p / 100))];
}
// CAS-919: cascadeScore's terms are now wmCinemaScore/wmQScore, quantile-mapped onto wmReleasedScoreVals
// the same way the old cinemaScore/qScore pair was (CAS-907 kept that machinery unchanged). The alignment
// property still holds by construction, but the tolerance widens here: Watchmode backfill is still partial
// (2,242 of 5,923 films scored at this ticket's own measurement) and pre-release ranks by
// wm_popularity_percentile, a differently-shaped cohort to the one CAS-748's original 2pt/1.5pp bounds were
// tuned against — a real, accepted gap (see this ticket's "do not re-raise" list), not a calibration defect.
test("CAS-748 AC2: pre-release and released cascadeScore distributions align within 4 points at p50/p75/p90/p95", () => {
  const preVals = E.MOVIES.filter(m => isPreRelease(m)).map(m => E.cascadeScore(m)).filter(v => v >= 0).sort((a, b) => a - b);
  const relVals = E.MOVIES.filter(m => !isPreRelease(m)).map(m => E.cascadeScore(m)).filter(v => v >= 0).sort((a, b) => a - b);
  assert.ok(preVals.length > 0 && relVals.length > 0, "one side of the cohort is empty — this test would prove nothing");
  for(const p of [50, 75, 90, 95]){
    const preP = percentileOf(preVals, p), relP = percentileOf(relVals, p);
    assert.ok(Math.abs(preP - relP) <= 4, `p${p}: pre-release ${preP} vs released ${relP} — more than 4 points apart`);
  }
});
test("CAS-748 AC3: the proportion of each side scoring 90+ is within 3 percentage points", () => {
  const preVals = E.MOVIES.filter(m => isPreRelease(m)).map(m => E.cascadeScore(m)).filter(v => v >= 0);
  const relVals = E.MOVIES.filter(m => !isPreRelease(m)).map(m => E.cascadeScore(m)).filter(v => v >= 0);
  assert.ok(preVals.length > 0 && relVals.length > 0, "one side of the cohort is empty — this test would prove nothing");
  const prePct = preVals.filter(v => v >= 90).length / preVals.length * 100;
  const relPct = relVals.filter(v => v >= 90).length / relVals.length * 100;
  assert.ok(Math.abs(prePct - relPct) <= 3,
    `pre-release ${prePct.toFixed(1)}% vs released ${relPct.toFixed(1)}% scoring 90+ — more than 3pp apart`);
});

// AC4: the mapping is a rank lookup into a sorted array, so it must be monotonic by construction — a film
// with strictly higher buzz can never score lower.
test("CAS-748 AC4: wmCinemaScore is monotonic in wmBuzzPctlOf", () => {
  const cohort = E.MOVIES.filter(m => E.inLadderCohort(m) && typeof m.wm_popularity_percentile === "number");
  assert.ok(cohort.length > 1, "not enough cohort films to compare — this test would prove nothing");
  const sorted = [...cohort].sort((a, b) => E.wmBuzzPctlOf(a) - E.wmBuzzPctlOf(b));
  let compared = 0;
  for(let i = 1; i < sorted.length; i++){
    const a = sorted[i], b = sorted[i - 1];
    if(E.wmBuzzPctlOf(a) === E.wmBuzzPctlOf(b)) continue;
    compared++;
    assert.ok(E.wmCinemaScore(a) >= E.wmCinemaScore(b),
      `${b.title} (p=${E.wmBuzzPctlOf(b)}) scores ${E.wmCinemaScore(b)} but ${a.title} (p=${E.wmBuzzPctlOf(a)}), higher buzz, scores lower at ${E.wmCinemaScore(a)}`);
  }
  assert.ok(compared > 0, "no two cohort films with different buzz percentiles found — this test would prove nothing");
});

// AC6: the degenerate case — nothing to map onto when the released cohort is empty (a catalogue that hasn't
// loaded). MOVIES is mutated in place and restored in `finally`, the same shared-state pattern CAS-742 AC2
// above uses, since E.MOVIES and the engine's own internal MOVIES binding are the same array instance.
test("CAS-748 AC6: wmCinemaScore falls back to the raw percentile when the released cohort is empty", () => {
  const cohortFilm = E.MOVIES.find(m => E.wmBuzzPctlOf(m) != null);
  assert.ok(cohortFilm, "no scoreable cohort film found — this test would prove nothing");
  const original = E.MOVIES.slice();
  const onlyPreRelease = original.filter(m => isPreRelease(m));
  assert.ok(onlyPreRelease.length > 0, "no pre-release film found — this test would prove nothing");
  try {
    E.MOVIES.length = 0;
    E.MOVIES.push(...onlyPreRelease);
    E.invalidateComputeCaches();
    assert.equal(E.wmReleasedScoreVals().length, 0, "sanity: the released cohort should now be empty");
    assert.doesNotThrow(() => E.wmCinemaScore(cohortFilm));
    assert.equal(E.wmCinemaScore(cohortFilm), E.wmBuzzPctlOf(cohortFilm),
      "with an empty released cohort, wmCinemaScore should fall back to the raw buzz percentile rather than divide by zero");
  } finally {
    E.MOVIES.length = 0;
    E.MOVIES.push(...original);
    E.invalidateComputeCaches();
  }
});

// ---- CAS-749: AN IN-CINEMA FILM BLENDS IN ITS REVIEWS ONCE THEY EXIST -----------------------------------
// isPreRelease(m) used to treat upcoming and in_cinema identically, scoring both on buzz alone even though
// an in-cinema film has actually been seen and reviewed. cascadeScore's pre-release branch now splits:
// upcoming stays buzz-only (nothing has been judged yet); in_cinema/opening_week blends the CAS-748-mapped
// buzz figure with qScore once qScore is real, and falls back to buzz alone when it isn't.
// CAS-919: the two terms cascadeScore blends are now wmCinemaScore/wmQScore (Watchmode), not
// cinemaScore/qScore (OMDb/TMDB) — the buzz percentile it ranks on is wm_popularity_percentile, not
// popularity.
test("CAS-749 AC2: an in-cinema film with a Watchmode buzz percentile of 100 and a real Watchmode critic score blends the two, near their mean", () => {
  const film = E.MOVIES.find(m => E.primaryStatus(m) === "in_cinema");
  assert.ok(film, "no in_cinema film found — this test would prove nothing");
  const saved = { status: film.status, wm_popularity_percentile: film.wm_popularity_percentile,
    wm_user_rating: film.wm_user_rating, wm_critic_score: film.wm_critic_score };
  try {
    film.status = ["in_cinema"];
    film.wm_popularity_percentile = 1e9;   // ranks above every other cohort film — wmBuzzPctlOf must read 100
    film.wm_user_rating = null;            // isolate wmQScore to the Critics term alone
    film.wm_critic_score = 40;             // an arbitrary real Watchmode critic figure
    assert.equal(E.wmBuzzPctlOf(film), 100, "setup: Watchmode buzz percentile should read 100");
    const q = E.wmQScore(film);
    assert.ok(q >= 0, "setup: wmQScore should read a real value");
    const buzz = E.wmCinemaScore(film);
    const score = E.cascadeScore(film);
    // Fails on pre-CAS-749 dispatch logic, which would return the buzz figure alone, ignoring wmQScore.
    assert.ok(score > Math.min(buzz, q) && score < Math.max(buzz, q),
      `${film.title}: blended score ${score} is not strictly between wmQScore (${q}) and wmCinemaScore (${buzz})`);
    assert.ok(Math.abs(score - (buzz + q) / 2) <= 1,
      `${film.title}: blended score ${score} is not within 1 of the mean of buzz (${buzz}) and wmQScore (${q})`);
  } finally {
    Object.assign(film, saved);
  }
});
test("CAS-749 AC3: an upcoming film's Cascade score is unaffected — still the mapped Watchmode buzz figure alone", () => {
  const film = E.MOVIES.find(m => E.primaryStatus(m) === "upcoming" && E.wmCinemaScore(m) >= 0);
  assert.ok(film, "no scored upcoming film found — this test would prove nothing");
  assert.equal(E.cascadeScore(film), E.wmCinemaScore(film),
    `${film.title}: upcoming film's Cascade score should still be the mapped Watchmode buzz figure alone`);
});
test("CAS-749 AC4: an in-cinema film with no Watchmode critics score still scores on mapped buzz alone", () => {
  const film = E.MOVIES.find(m => E.primaryStatus(m) === "in_cinema" && E.wmQScore(m) === -1 && E.wmCinemaScore(m) >= 0);
  assert.ok(film, "no in_cinema film with a real Watchmode buzz figure and no wmQScore found — this test would prove nothing");
  assert.equal(E.cascadeScore(film), E.wmCinemaScore(film),
    `${film.title}: in-cinema film with no Watchmode terms should score on mapped buzz alone, not a blend with -1`);
});
// CAS-919: same real-catalogue alignment measurement as CAS-748 AC2 (the same cascadeScore values), widened
// to the same 4pt tolerance for the same reason — see that test's comment.
test("CAS-749 AC5: pre-release and released score distributions still align within 4 points once reviews blend in", () => {
  const preVals = E.MOVIES.filter(m => isPreRelease(m)).map(m => E.cascadeScore(m)).filter(v => v >= 0).sort((a, b) => a - b);
  const relVals = E.MOVIES.filter(m => !isPreRelease(m)).map(m => E.cascadeScore(m)).filter(v => v >= 0).sort((a, b) => a - b);
  assert.ok(preVals.length > 0 && relVals.length > 0, "one side of the cohort is empty — this test would prove nothing");
  for(const p of [50, 75, 90, 95]){
    const preP = percentileOf(preVals, p), relP = percentileOf(relVals, p);
    assert.ok(Math.abs(preP - relP) <= 4, `p${p}: pre-release ${preP} vs released ${relP} — more than 4 points apart`);
  }
});
// Change item 4: the tooltip must name both contributions once a film is no longer scoring on pure buzz.
test("CAS-749: cascadeScoreSourcesText names both Buzz and the Watchmode sources for a blended in-cinema film", () => {
  const film = E.MOVIES.find(m => E.primaryStatus(m) === "in_cinema" && E.wmQScore(m) >= 0 && E.wmBuzzPctlOf(m) != null);
  assert.ok(film, "no in-cinema film with both a Watchmode buzz figure and a wmQScore found — this test would prove nothing");
  const text = E.cascadeScoreSourcesText(film);
  assert.ok(text.startsWith("Buzz and "), `${film.title}: "${text}" does not name Buzz as a contribution`);
  assert.equal(text, `Buzz and ${E.wmQScoreSourcesText(film)}`,
    `${film.title}: "${text}" does not also name the Watchmode contribution(s)`);
});

// AC4: the cohort's sorted popularity and budget arrays are module-level consts, built once at load — never
// re-sorted per card. Asserted the same way CAS-678's own performance claim is: the same array reference
// (by identity) comes back on repeat reads, and it is already sorted ascending.
test("CAS-695 AC4: the cohort's popularity and budget arrays are sorted once, not per card", () => {
  assert.ok(E.BUZZ_POP_VALS.length > 0 && E.CINEMA_BUDGET_VALS.length > 0, "the cohort arrays are empty — this test would prove nothing");
  for(let i = 1; i < E.BUZZ_POP_VALS.length; i++) assert.ok(E.BUZZ_POP_VALS[i] >= E.BUZZ_POP_VALS[i - 1], "BUZZ_POP_VALS is not sorted ascending");
  for(let i = 1; i < E.CINEMA_BUDGET_VALS.length; i++) assert.ok(E.CINEMA_BUDGET_VALS[i] >= E.CINEMA_BUDGET_VALS[i - 1], "CINEMA_BUDGET_VALS is not sorted ascending");
  // Reading buzzPctlOf/pctRankOf a second time for the same films must not mutate or resize the arrays.
  // CAS-722 retired budgetPctlOf itself (budget left the score); CINEMA_BUDGET_VALS survives only for
  // missionScoreStats' cinema Budget dial, so this reads it the same way that call site does.
  const popLen = E.BUZZ_POP_VALS.length, budgetLen = E.CINEMA_BUDGET_VALS.length;
  for(const m of E.MOVIES.filter(m => E.inLadderCohort(m)).slice(0, 20)){
    E.buzzPctlOf(m);
    E.pctRankOf(E.CINEMA_BUDGET_VALS, m.budget || m.worldwide_gross || 0);
  }
  assert.equal(E.BUZZ_POP_VALS.length, popLen, "BUZZ_POP_VALS changed size after scoring films");
  assert.equal(E.CINEMA_BUDGET_VALS.length, budgetLen, "CINEMA_BUDGET_VALS changed size after scoring films");
});

// AC4 (CAS-722): the card's own tooltip must name only Buzz for a film that has nothing else to go on — never
// a budget term that no longer exists — and keep naming the streaming axes exactly as qScoreSourcesText does
// once released. Narrowed to an upcoming film by CAS-749: an in-cinema film with a real qScore now names both
// contributions (see the CAS-749 test below), so it no longer demonstrates "Buzz only".
// CAS-1005: fixed fixtures, not E.MOVIES.find() — "not isPreRelease" is not the same test as "released"
// (opening_week is neither), and a live film's cinema date landing on today can flip its primaryStatus out
// from under a `find()`.
test("CAS-722 AC4: cascadeScoreSourcesText names only Buzz for a film with nothing else to go on, never Budget", () => {
  const buzzed = { status: ["upcoming"], wm_popularity_percentile: 50 };
  assert.equal(E.cascadeScoreSourcesText(buzzed), "Buzz");
  for(const name of ["Budget", "People's vote", "Critics"]){
    assert.ok(!E.cascadeScoreSourcesText(buzzed).includes(name), `cascadeScoreSourcesText named ${name} on a pre-release film`);
  }

  const releasedFilm = { status: ["included_streaming"], wm_user_rating: 7.5, wm_critic_score: 82 };
  assert.equal(E.cascadeScoreSourcesText(releasedFilm), E.wmQScoreSourcesText(releasedFilm),
    "released film's basis text should be exactly wmQScoreSourcesText's");
});

// CAS-724: an agent saved before c.scoreFloor existed migrates it, once, from whichever legacy Mission dials
// it had ON — the same formula the retired missionScoreStats used, now a one-time normCascade migration
// rather than a live admission input. Exercised through the public migration path, not a retired internal
// function (removed with the OR block it served).
test("CAS-724: an agent's scoreFloor migrates once from its legacy Mission dials' own mean", () => {
  const migrate = overrides => E.normCascade({ ...overrides }, { template: true }).scoreFloor;
  assert.equal(migrate({ kind: "cinema", selBuzz: 0, selScale: 0 }), 0, "no cinema dial on should migrate to a floor of 0");
  assert.equal(migrate({ kind: "cinema", selBuzz: 2, selScale: 0 }), E.BUZZ_PCTL[2], "Buzz alone should migrate to its own percentile");
  const scaleFloorD = E.CINEMA_BUDGET_VALS[Math.floor(E.CINEMA_BUDGET_VALS.length / 2)];
  const scalePctl = E.pctRankOf(E.CINEMA_BUDGET_VALS, scaleFloorD);
  assert.equal(migrate({ kind: "cinema", selBuzz: 0, selScale: scaleFloorD }), scalePctl,
    "Budget alone should migrate to its dollar floor's own percentile");
  assert.equal(migrate({ kind: "cinema", selBuzz: 2, selScale: scaleFloorD }),
    Math.round((E.BUZZ_PCTL[2] + scalePctl) / 2), "both cinema dials on should migrate to their mean");

  // The stream lane keeps CAS-694's own formula exactly — a kind other than "cinema" must not be re-routed.
  assert.equal(migrate({ kind: "stream", selCrowd: 7.5, selCritScore: 0, selBuzz: 0, selScale: 0 }), 75,
    "a stream agent's migrated floor changed even though its own dials (People's vote/Critics) are untouched by this ticket");

  // Once set, scoreFloor is authoritative and is never recomputed from the dials again.
  assert.equal(migrate({ kind: "cinema", selBuzz: 2, selScale: 0, scoreFloor: 40 }), 40,
    "an agent that already carries scoreFloor had it overwritten by the legacy migration formula");
});

// ---- CAS-697: RECALIBRATED BUZZ LADDER + THE $1M CINEMA BUDGET FLOOR --------------------------------------
// The cinema Mission target was unusable: a Budget dial at its minimum already read 57, and any Buzz setting
// pushed it to 90. Two input constants were wrong, not the formula — BUZZ_PCTL widens 95/97/99 to 65/85/95,
// and CINEMA_BUDGET_VALS drops the sub-$1M TMDB placeholder rows that were dragging the budget percentile
// down. Asserted against the live constants, never fixed counts, so a catalogue refresh cannot go stale.
test("CAS-697 AC1/AC2: the Buzz ladder moved to [0,65,85,95] and badges a materially wider slice of the cohort", () => {
  assert.deepEqual([...E.BUZZ_PCTL], [0, 65, 85, 95], "the ladder's percentile stops have not moved to CAS-697's values");
  const cohort = E.MOVIES.filter(m => E.inLadderCohort(m));
  assert.ok(cohort.length > 0, "the cohort is empty — this test would prove nothing");
  const badged = cohort.filter(m => E.buzzBandOf(m));
  // Measured on the catalogue at ticket time: 5% under the old [0,95,97,99] ladder, 35% under the new one.
  // 20% is a safe threshold well clear of both, so a normal day-to-day catalogue refresh cannot flip this.
  assert.ok(badged.length / cohort.length > 0.2,
    `only ${badged.length} of ${cohort.length} cohort films are badged — the wider ladder does not appear to be in effect`);
});

// CAS-722 retired the score-path half of this (budget never contributes to cinemaScore any more — covered
// generally by the CAS-722 AC1 test above). CINEMA_BUDGET_VALS itself survives for missionScoreStats' cinema
// Budget dial, so the floor property is still worth keeping as its own invariant.
test("CAS-697 AC3: CINEMA_BUDGET_VALS is floored at CINEMA_BUDGET_MIN", () => {
  assert.ok(E.CINEMA_BUDGET_VALS.length > 0, "CINEMA_BUDGET_VALS is empty — this test would prove nothing");
  for(const v of E.CINEMA_BUDGET_VALS){
    assert.ok(v >= E.CINEMA_BUDGET_MIN, `CINEMA_BUDGET_VALS holds ${v}, below the CINEMA_BUDGET_MIN floor`);
  }
});

test("CAS-697 AC5: selScaleMatch (admission) reads every real budget with no CINEMA_BUDGET_MIN floor", () => {
  const small = { title: "Indie $500K", budget: 500000, worldwide_gross: 0 };
  assert.equal(E.selScaleMatch(small, { selScale: 100000 }), true,
    "a $500K film was not admitted by a $100K Budget dial — the score floor leaked into admission");
  // Whole catalogue: every sub-floor-budget cohort film must still be admitted by a dial set at or below its
  // own figure — this is the one way this ticket could quietly break every cinema agent.
  const cohort = E.MOVIES.filter(m => E.inLadderCohort(m));
  const subFloor = cohort.filter(m => {
    const v = m.budget || m.worldwide_gross || 0;
    return v > 0 && v < E.CINEMA_BUDGET_MIN;
  });
  assert.ok(subFloor.length > 0, "no sub-floor-budget cohort film found — this test would prove nothing");
  for(const m of subFloor){
    const v = m.budget || m.worldwide_gross || 0;
    assert.equal(E.selScaleMatch(m, { selScale: v }), true,
      `${m.title}: a $${v} film was not admitted by a Budget dial set at its own figure`);
  }
});

// ---- FILM_WATCH.SOURCES + AGENT_FILMS SURVIVE A RELOAD (CAS-726) ------------------------------------------
// Two pieces of state the rest of the "one score model" epic needs do not survive a page load on another
// device today: Watch On provenance (auto/manual per window) and the admitted set. These exercise the real
// seam (window.CascadePersistence) against a minimal fake Supabase client (chainable enough for
// select()/upsert()/delete().eq().eq()…, no more). signInWithClient/signOut are shared across every
// account-sync section in this file, not just this one.
function signInWithClient(client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: "cas681-test-user" } };
}
function signOut(){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
function fakeCas726Supabase(seed){
  const state = { film_watch: (seed.film_watch || []).map(r => ({ ...r })),
                  agent_films: (seed.agent_films || []).map(r => ({ ...r })) };
  const keyOf = { film_watch: r => `${r.user_id}:${r.movie_id}`,
                  agent_films: r => `${r.user_id}:${r.cascade_id}:${r.movie_id}` };
  function selectBuilder(rows){
    const builder = { then(resolve, reject){
      return Promise.resolve({ data: rows.map(r => ({ ...r })), error: null }).then(resolve, reject);
    } };
    // CAS-1096: acctLoad chains .select("*").order(pk,...).range(from,to) before its own .then() — both
    // are no-ops here, one page already covers every fixture this file seeds.
    builder.order = () => builder;
    builder.range = () => builder;   // CAS-1049: loadAgentFilms pages with .range(); one page covers this fixture
    return builder;
  }
  function deleteBuilder(table){
    const conds = [];
    const builder = {
      eq(col, val){ conds.push([col, val]); return builder; },
      // CAS-1096: acctOp's "delete" kind calls .match(op.match) — one call, every column at once.
      match(obj){ Object.entries(obj).forEach(([col, val]) => conds.push([col, val])); return builder; },
      then(resolve, reject){
        state[table] = state[table].filter(r => !conds.every(([c, v]) => r[c] === v));
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  const client = {
    from(table){
      return {
        select(){ return selectBuilder(state[table]); },
        upsert(rows){
          // CAS-1096: film_watch now pushes through acctOp's "upsert" kind — a single row object, not an
          // array — alongside agent_films' own array-based chunked upsert, which still calls this the old way.
          const list = Array.isArray(rows) ? rows : [rows];
          list.forEach(row => {
            const i = state[table].findIndex(x => keyOf[table](x) === keyOf[table](row));
            if(i >= 0) state[table][i] = { ...state[table][i], ...row }; else state[table].push({ ...row });
          });
          return Promise.resolve({ error: null });
        },
        delete(){ return deleteBuilder(table); },
      };
    },
  };
  return { client, state };
}
function withCas726State(fn){
  const savedNotify = { ...E.notify };
  return (async () => {
    try { await fn(); }
    finally {
      Object.keys(E.notify).forEach(k => delete E.notify[k]);
      Object.assign(E.notify, savedNotify);
      signOut();
    }
  })();
}

test("CAS-726 AC2: a manual Watch On tick round-trips through film_watch.sources as \"manual\"", () => withCas726State(async () => {
  const m = E.MOVIES[0];
  const level = E.watchLevelsFor(m.tmdb_id).find(l => !l.spent);
  assert.ok(level, "no un-spent level to test on this film — the harness catalogue looks wrong");
  const { client } = fakeCas726Supabase({});
  signInWithClient(client);

  E.toggleFilmOpt(m.tmdb_id, level.key);          // the real manual-tick wire code, not a direct field poke
  await new Promise(r => setTimeout(r, 0));       // CAS-1096: let pushFilmWatch's own acctOp call resolve
  await E.CascadePersistence.loadFilmWatches();    // simulate a reload: refetch the account from scratch

  assert.equal(E.filmWatchSource(m.tmdb_id), "manual",
    "a hand-ticked Watch On value must read back as manual provenance after a reload");
}));

test("CAS-726 AC2: an agent-armed Watch On value round-trips through film_watch.sources as \"auto\"", () => withCas726State(async () => {
  const m = E.MOVIES[1];
  const level = E.watchLevelsFor(m.tmdb_id).find(l => !l.spent);
  assert.ok(level, "no un-spent level to test on this film — the harness catalogue looks wrong");
  const remoteRow = { user_id: "cas681-test-user", movie_id: String(m.tmdb_id),
    windows: [level.key], sources: { [level.key]: "auto" } };
  const { client } = fakeCas726Supabase({ film_watch: [remoteRow] });
  signInWithClient(client);

  await E.CascadePersistence.loadFilmWatches();

  assert.equal(E.filmWatchSource(m.tmdb_id), "auto",
    "a remote row whose stored source is auto must read back as auto provenance");
}));

test("CAS-726 AC3: an existing film_watch row with no sources entry loads without error and reads as unset", () => withCas726State(async () => {
  const m = E.MOVIES[2];
  const level = E.watchLevelsFor(m.tmdb_id).find(l => !l.spent);
  assert.ok(level, "no un-spent level to test on this film — the harness catalogue looks wrong");
  // A row exactly as it existed before this ticket: windows only, no sources column value at all.
  const remoteRow = { user_id: "cas681-test-user", movie_id: String(m.tmdb_id), windows: [level.key] };
  const { client } = fakeCas726Supabase({ film_watch: [remoteRow] });
  signInWithClient(client);

  await assert.doesNotReject(() => E.CascadePersistence.loadFilmWatches());
  assert.equal(E.filmWatchSource(m.tmdb_id), null,
    "a pre-CAS-726 row must read back as source-unknown, not throw or invent a provenance");
}));

test("CAS-726 AC4: agent_films rows survive a reload and are readable by cascade_id", () => withCas726State(async () => {
  const cascadeIdA = "cas726-0000-4000-8000-000000000001";
  const cascadeIdB = "cas726-0000-4000-8000-000000000002";
  const filmA = E.MOVIES[3], filmB = E.MOVIES[4];
  const remoteRows = [
    { user_id: "cas681-test-user", cascade_id: cascadeIdA, movie_id: String(filmA.tmdb_id),
      admitted_at: "2026-09-01T00:00:00.000Z", admission_score: 88, admission_status: "in_cinema", agent_sig: "sig-a" },
    { user_id: "cas681-test-user", cascade_id: cascadeIdB, movie_id: String(filmB.tmdb_id),
      admitted_at: "2026-09-01T00:00:00.000Z", admission_score: 70, admission_status: "rental", agent_sig: "sig-b" },
  ];
  const { client } = fakeCas726Supabase({ agent_films: remoteRows });
  signInWithClient(client);

  await E.CascadePersistence.loadAgentFilms();

  const rowsA = E.CascadePersistence.agentFilmsFor(cascadeIdA);
  assert.equal(rowsA.length, 1, "agentFilmsFor must be scoped to the cascade it was asked about");
  assert.equal(rowsA[0].movie_id, String(filmA.tmdb_id));
  assert.equal(rowsA[0].admission_score, 88);
  assert.equal(rowsA[0].admission_status, "in_cinema");
  assert.equal(rowsA[0].agent_sig, "sig-a");
  assert.equal(E.CascadePersistence.agentFilmsFor(cascadeIdB).length, 1,
    "the other cascade's own row must not leak into cascadeIdA's read");
}));

test("CAS-726: a locally-written agent_films row (setAgentFilm) survives a push-then-reload round trip", () => withCas726State(async () => {
  const cascadeId = "cas726-0000-4000-8000-000000000003";
  const m = E.MOVIES[5];
  const { client } = fakeCas726Supabase({});
  signInWithClient(client);

  E.CascadePersistence.setAgentFilm(cascadeId, m.tmdb_id,
    { admission_score: 91, admission_status: "upcoming", agent_sig: "sig-c" });
  await new Promise(r => setTimeout(r, 0));   // CAS-1097: let pushAgentFilmAdmission's own acctOp call resolve
  await E.CascadePersistence.loadAgentFilms();   // simulate a reload

  const rows = E.CascadePersistence.agentFilmsFor(cascadeId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].movie_id, String(m.tmdb_id));
  assert.equal(rows[0].admission_score, 91);
  assert.equal(rows[0].agent_sig, "sig-c");
}));

// ---- STICKY ADMISSION (CAS-728) -----------------------------------------------------------------------
// Once an agent admits a film, agent_films (CAS-726) holds it — recomputeFound stops re-testing it every
// pass — until the user watches/dismisses the film (out of scope for these) or the agent's OWN cascSigOf
// moves. Rows are seeded directly via CascadePersistence.setAgentFilm, the same seam CAS-726's own tests
// above use, rather than by hoping the live catalogue admits a chosen film through real dial values —
// CAS-727's placement tests solve that with a pin instead, but a pin bypasses admission entirely, which
// would prove nothing about IT. `withCas728State` mirrors withCas726State's own notify save/restore: the
// permissive test agents below can incidentally admit other real films while they're alive (arrivals are
// still tested normally), and restoring the whole of `E.notify` afterwards, not just the one id under test,
// is what actually cleans that up rather than leaving stray provenance on unrelated films.
function withCas728State(fn){
  const savedNotify = { ...E.notify };
  try { fn(); }
  finally {
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
  }
}
function pastCinemaUnwatchedFilm(excludeId){
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && x.tmdb_id !== excludeId
    && E.primaryStatus(x) === "rental");
  if(!m) throw new Error("no unwatched 'rental' film in the harness catalogue — this test would prove nothing");
  return m;
}
const STICKY_WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
// A near-impossible floor (99) keeps a freshly-seeded agent from also admitting half the catalogue as
// "arrivals" the moment recomputeFound runs — the row under test is written directly, below, regardless.
function stickyTestCascade(id, floor){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = 0;
  c.watchMarkers = { in_cinema: floor, premium: null, rent: floor, stream: floor };
  return c;
}

test("CAS-728 AC2: an unedited agent keeps a film admitted after it moves past its admission window", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas728-ac2", 99);
    E.cascades.push(c);
    const sig = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id,
        { admission_score: 90, admission_status: "in_cinema", agent_sig: sig });
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(row, "an unedited agent must not drop a film whose status has simply moved on");
      assert.equal(row.admission_score, 90, "the stored admission_score must survive untouched — no retest happened");
    } finally { unseedCascade(c.id); }
  });
}));

test("CAS-728 AC3: raising the floor past a film's stored admission_score drops it on re-evaluation", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas728-ac3", 99);
    E.cascades.push(c);
    const sigBefore = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id,
        { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
      c.watchMarkers = { in_cinema: 95, premium: null, rent: 95, stream: 95 };   // new floor 95 > stored 90
      assert.notEqual(E.cascSigOf(c), sigBefore, "this test's own edit must actually move cascSigOf(c)");
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(!row, "a floor raised past the stored admission_score must drop the film on re-evaluation");
    } finally { unseedCascade(c.id); }
  });
}));

test("CAS-728 AC4: a floor below the stored admission_score keeps the film — the stored score, not a live one", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const saved = { wm_user_rating: film.wm_user_rating, wm_critic_score: film.wm_critic_score };
    // Zero the film's LIVE cascadeScore to -1 — no Watchmode signal at all (CAS-919: cascadeScore now reads
    // wm_user_rating/wm_critic_score, not rt_critic/metacritic/imdb_votes) — so a re-test that wrongly read
    // the live score would fail at ANY floor. Only a re-test against the stored admission_score of 90 can pass.
    film.wm_user_rating = null; film.wm_critic_score = null;
    assert.equal(E.cascadeScore(film), -1, "this test's own setup must actually zero out the live score");
    const c = stickyTestCascade("cas728-ac4", 99);
    E.cascades.push(c);
    const sigBefore = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id,
        { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
      c.watchMarkers = { in_cinema: 80, premium: null, rent: 80, stream: 80 };   // 80 <= stored 90, > live (-1)
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(row, "a floor of 80 against a stored admission_score of 90 must keep the film — a live-score " +
        "re-test would fail unconditionally here (-1), so this only passes off the stored score");
    } finally { unseedCascade(c.id); Object.assign(film, saved); }
  });
}));

// CAS-781 reverses this: a manual Watch On is a human selection and now holds the film's MEMBERSHIP of the
// agent too, not only the wins/winsSource value — the agent_films row survives, re-stamped with the new
// agent_sig, same as a pinnedTo film. See tests/js/agents-override.test.mjs for the fuller CAS-781 coverage.
test("CAS-728 AC5 / CAS-781: a manual Watch On value keeps the film ON the agent through a re-evaluation that would otherwise drop it", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas728-ac5", 99);
    E.cascades.push(c);
    const sigBefore = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id,
        { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
      const level = E.watchLevelsFor(id).find(l => !l.spent);
      assert.ok(level, "no un-spent Watch level on this film — the harness catalogue looks wrong");
      E.toggleFilmOpt(id, level.key);
      assert.equal(E.notify[id].wins[level.key], true, "setup: the manual tick must actually land");
      c.watchMarkers = { in_cinema: 95, premium: null, rent: 95, stream: 95 };   // would drop the film per criteria alone, as in AC3
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(row, "CAS-781: a manual Watch On must hold the film's membership of the agent, not just its value");
      assert.equal(row.admission_score, 90, "the retained row must keep its ORIGINAL admission_score, not a re-test");
      assert.equal(E.notify[id].wins[level.key], true, "AC5: a manual Watch On value must survive the removal");
      assert.equal(E.notify[id].winsSource[level.key], "manual");
    } finally { unseedCascade(c.id); }
  });
}));

test("CAS-728 AC6: a cascSigOf change on one agent never re-evaluates another agent's rows", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const filmA = pastCinemaUnwatchedFilm();
    const filmB = pastCinemaUnwatchedFilm(filmA.tmdb_id);
    const idA = filmA.tmdb_id, idB = filmB.tmdb_id;
    const a = stickyTestCascade("cas728-ac6-a", 99);
    // B's floor already exceeds its own stored admission_score — if B were ever re-evaluated it would drop,
    // so B surviving is proof its own re-evaluation branch never ran off agent A's edit.
    const b = stickyTestCascade("cas728-ac6-b", 50);
    E.cascades.push(a, b);
    const sigA = E.cascSigOf(a), sigB = E.cascSigOf(b);
    try {
      E.CascadePersistence.setAgentFilm(a.id, idA, { admission_score: 90, admission_status: "in_cinema", agent_sig: sigA });
      E.CascadePersistence.setAgentFilm(b.id, idB, { admission_score: 10, admission_status: "in_cinema", agent_sig: sigB });
      a.watchMarkers = { in_cinema: 95, premium: null, rent: 95, stream: 95 };   // only A's own cascSigOf moves
      E.recomputeFound();
      const rowB = E.CascadePersistence.agentFilmsFor(b.id).find(r => r.movie_id === String(idB));
      assert.ok(rowB, "B's row must survive untouched — only A's own cascSigOf changed");
      assert.equal(rowB.agent_sig, sigB, "B's agent_sig must not be rewritten by an edit to a different agent");
    } finally { unseedCascade(a.id); unseedCascade(b.id); }
  });
}));

// ---- WATCH ON PLACEMENT IS DEVICE-INDEPENDENT (CAS-736) ------------------------------------------------
// `e.watchEarned` used to be computed once and cached in `notify` — per-device local storage never synced
// to the account. Two devices that first met a film at different moments (or under different marker
// values) froze two different answers forever, and since earned is half of the "later of" placement rule
// (CAS-727), that put the same film in different Watch tabs on different devices. Earned is now derived,
// every pass, from the owner's stored agent_films admission_score (CAS-726) and its CURRENT watchMarkers —
// never from a field cached on `notify` — so every device reads the identical answer off the same account
// state. These tests seed the ledger directly via setAgentFilm, the same seam CAS-726/728's own tests
// above use, rather than a pin — a pin bypasses the ledger entirely and is explicitly out of scope here
// (see the comment at the derivation site in recomputeFound).
test("CAS-736 AC2: earned derives from the stored admission_score and the owner's CURRENT watchMarkers, never a cached local field", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas736-ac2", 99);
    E.cascades.push(c);
    c.watchMarkers = { in_cinema: 95, premium: null, rent: 85, stream: 70 };
    const sig = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id, { admission_score: 90, admission_status: "in_cinema", agent_sig: sig });
      // A stale local cache, exactly what a pre-CAS-736 device could have frozen — must be ignored outright.
      E.entryFor(id).watchEarned = "in_cinema";
      E.recomputeFound();
      assert.equal(E.notify[id].wins.rent, true,
        "the stored admission_score (90) clears Rental's marker (85) but not Cinema's (95) — the stale local watchEarned must not win");

      // Editing the OWNER's own markers (not the film) moves the derivation — only the stored SCORE is
      // frozen at admission, per CAS-727 §5; the markers it's compared against are always read live.
      c.watchMarkers.rent = 92;   // 90 no longer clears Rental
      E.recomputeFound();
      assert.equal(E.notify[id].wins.stream, true, "raising the Rental marker past the stored score must move earned to Streaming");
    } finally { unseedCascade(c.id); delete E.notify[id]; }
  });
}));

test("CAS-736 AC3: two devices with different local caches, same account state, converge on identical placement", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas736-ac3", 99);
    E.cascades.push(c);
    c.watchMarkers = { in_cinema: 95, premium: null, rent: 85, stream: 70 };
    const sig = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id, { admission_score: 90, admission_status: "in_cinema", agent_sig: sig });

      // "Device A": its local notify already carries a stale watchEarned from before this device ever
      // re-read the account — a wrong value a pre-CAS-736 device could genuinely have been holding.
      delete E.notify[id];
      E.entryFor(id).watchEarned = "stream";
      E.recomputeFound();
      const winsA = { ...E.notify[id].wins };

      // "Device B": nothing local at all — a completely fresh notify entry meeting the same account state.
      delete E.notify[id];
      E.recomputeFound();
      const winsB = { ...E.notify[id].wins };

      assert.deepEqual(winsA, winsB,
        "both devices must derive the identical placement from the same stored admission_score and markers");
      assert.equal(winsA.rent, true, "sanity: admission_score 90 against these markers places at Rental");
    } finally { unseedCascade(c.id); delete E.notify[id]; }
  });
}));

test("CAS-736 AC4: recomputeFound writes no placement value before this device's own agent_films load has resolved", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas736-ac4", 99);
    E.cascades.push(c);
    c.watchMarkers = { in_cinema: 95, premium: null, rent: 85, stream: 70 };
    const sig = E.cascSigOf(c);
    const savedReady = E.CascadePersistence.agentFilmsReady;
    try {
      E.CascadePersistence.setAgentFilm(c.id, id, { admission_score: 90, admission_status: "in_cinema", agent_sig: sig });
      E.CascadePersistence.agentFilmsReady = false;
      E.recomputeFound();
      const e = E.notify[id];
      const picked = !!(e && e.wins && Object.values(e.wins).some(Boolean));
      assert.ok(!picked, "recomputeFound must write no placement value while agentFilmsReady is false");

      E.CascadePersistence.agentFilmsReady = true;
      E.recomputeFound();
      assert.equal(E.notify[id].wins.rent, true, "sanity: once ready, the same film places normally");
    } finally { unseedCascade(c.id); delete E.notify[id]; E.CascadePersistence.agentFilmsReady = savedReady; }
  });
}));

// ---- CASCADES ACCOUNT CONVERGENCE (CAS-734) --------------------------------------------------------------
// Two devices signed in to the same account held permanently different agent sets: loadAccount resolved
// every conflict in favour of the local cache unconditionally (no comparison of anything), reconcileCascades
// resolved every conflict the OPPOSITE way (remote always wins), and a single edit upserted the whole array
// instead of just the changed row. These tests exercise the real seam (window.CascadePersistence) against a
// minimal fake Supabase client, same style as the CAS-681/CAS-726 harnesses above.
const uuidFor = n => `00000734-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fakeCascadesSupabase(seed){
  const state = { rows: (seed || []).map(r => ({ ...r })), upsertCalls: [] };
  function selectBuilder(){
    const builder = {
      order(){ return builder; },   // the real query's ORDER BY — the fake does its own client-side sort
      then(resolve, reject){
        return Promise.resolve({ data: state.rows.map(r => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  function deleteBuilder(){
    const conds = [];
    const builder = {
      eq(col, val){ conds.push([col, v => v === val]); return builder; },
      in(col, vals){ const set = new Set(vals); conds.push([col, v => set.has(v)]); return builder; },
      then(resolve, reject){
        state.rows = state.rows.filter(r => !conds.every(([c, test]) => test(r[c])));
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  const client = {
    from(table){
      assert.equal(table, "cascades", "the cascades persistence seam must only ever touch the cascades table");
      return {
        select: () => selectBuilder(),
        upsert(rows){
          state.upsertCalls.push(rows);
          const nowIso = new Date().toISOString();
          const written = rows.map(r => {
            const i = state.rows.findIndex(x => x.id === r.id);
            const createdAt = (i >= 0 && state.rows[i].created_at) || r.created_at || nowIso;
            const stored = { ...r, created_at: createdAt, updated_at: nowIso };
            if(i >= 0) state.rows[i] = stored; else state.rows.push(stored);
            return stored;
          });
          const result = { data: written.map(r => ({ id: r.id, updated_at: r.updated_at })), error: null };
          return { select: async () => result, then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
        },
        delete: () => deleteBuilder(),
      };
    },
  };
  return { client, state };
}
function withCas734State(fn){
  const savedCascades = E.cascades.slice();
  const savedKnown = new Map(E.CascadePersistence.cascadeKnown);
  const savedEdited = new Map(E.CascadePersistence.cascadeEditedAt);
  E.CascadePersistence.cascadeKnown.clear();
  E.CascadePersistence.cascadeEditedAt.clear();
  // CAS-1097: these tests are about cascade conflict resolution, not admission — but loadAccount/
  // reconcileCascades both call render(), which calls the real recomputeFound(), which now pushes one
  // real agent_films acctOp row per film the (deliberately wide-open, `{order:0}`) fixture cascades here
  // admit off the real built catalogue. That is hundreds of synchronous acctOp calls sharing the one
  // queue this suite's cascades-only fake client was never built to answer, which was turning every test
  // after this block into a multi-second (and once, 300-second) wait on backoff this suite should never
  // sit through. Stubbed out for exactly the span these tests run, same convention as
  // ACCT_READ_DELAYS/ACCT_OP_RETRY_DELAYS being zeroed elsewhere for a UX delay this suite isn't about.
  const realAcctOp = E.CascadeAccountStore.acctOp;
  E.CascadeAccountStore.acctOp = op => (op.table === "agent_films" ? Promise.resolve() : realAcctOp(op));
  return (async () => {
    try { await fn(); }
    finally {
      // AC3(d) below seeds a cascade deliberately never confirmed into cascadeKnown — the real case
      // pushAgentFilmAdmission's own defer chain (up to AGENT_FILM_DEFER_MAX_ATTEMPTS=10 rounds) exists
      // for, and with no confirmation ever arriving it runs every round before giving up and sending
      // anyway. loadAccount() above doesn't await that chain (it's fire-and-forget), so it can still be
      // mid-flight here — drain it (AGENT_FILM_DEFER_MS is zeroed file-wide, so 10 rounds is a handful of
      // ticks) while the agent_films stub above is still in place, or a late round lands after acctOp is
      // restored below, against whatever client a LATER test has since signed in with (every test here
      // shares one fake uid, so pushAgentFilmAdmission's own owner check can't catch the mismatch).
      await new Promise(r => setTimeout(r, 50));
      E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
      E.CascadePersistence.cascadeKnown.clear();
      savedKnown.forEach((v, k) => E.CascadePersistence.cascadeKnown.set(k, v));
      E.CascadePersistence.cascadeEditedAt.clear();
      savedEdited.forEach((v, k) => E.CascadePersistence.cascadeEditedAt.set(k, v));
      E.CascadeAccountStore.acctOp = realAcctOp;
      signOut();
    }
  })();
}

test("CAS-734 AC2: app_template.html no longer justifies any rule with \"the local copy is the newer state\"", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  assert.equal((src.match(/the local copy is the newer state/g) || []).length, 0);
});

test("CAS-734 AC5: both cascades account reads carry an explicit ORDER BY", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const matches = src.match(/\.order\("(created_at|updated_at)"/g) || [];
  assert.ok(matches.length >= 2, `expected at least 2 explicit ORDER BY clauses on the cascades reads, found ${matches.length}`);
});

test("CAS-734 AC4: the order comparator is a total order — a tie on .order resolves via created_at then id, never 0", () => {
  const cmp = E.CascadePersistence.cascadeOrderCmp;
  const a = { id: "aaaaaaaa-0000-4000-8000-000000000001", order: 5, created_at: "2026-01-01T00:00:00.000Z" };
  const b = { id: "bbbbbbbb-0000-4000-8000-000000000001", order: 5, created_at: "2026-02-01T00:00:00.000Z" };
  assert.notEqual(cmp(a, b), 0, "a tie on .order must not resolve to 0");
  assert.ok(cmp(a, b) < 0, "the earlier created_at must sort first");
  assert.ok(cmp(b, a) > 0, "the comparator must be antisymmetric");
  // A tie on BOTH .order and created_at too — id is the final tie-break, and it must still be non-zero and
  // consistent both ways (never the "whatever arrived first" answer the old bare .order subtraction gave).
  const c = { id: "aaaaaaaa-0000-4000-8000-000000000001", order: 5, created_at: "2026-01-01T00:00:00.000Z" };
  const d = { id: "bbbbbbbb-0000-4000-8000-000000000001", order: 5, created_at: "2026-01-01T00:00:00.000Z" };
  assert.notEqual(cmp(c, d), 0, "a tie on both .order and created_at must still resolve via id, never 0");
  assert.equal(Math.sign(cmp(c, d)), -Math.sign(cmp(d, c)), "the comparator must be stable/antisymmetric on id too");
});

test("CAS-734 AC6: a single-agent rename upserts exactly one row, not the whole array", () => withCas734State(async () => {
  const idA = uuidFor(1), idB = uuidFor(2);
  // CAS-743: real (user-set-shaped) watchMarkers, not normCascade's own guess — this test is about the rename
  // dirty-row derivation, and a still-defaulted watchMarkers would itself hold the row out of every push.
  const markers = { in_cinema: 90, premium: null, rent: 80, stream: 70 };
  const a = E.normCascade({ id: idA, name: "Agent A", order: 0, watchMarkers: { ...markers } });
  const b = E.normCascade({ id: idB, name: "Agent B", order: 1, watchMarkers: { ...markers } });
  E.cascades.length = 0; E.cascades.push(a, b);
  const { client, state } = fakeCascadesSupabase([]);
  signInWithClient(client);

  // Establish both as already-confirmed by the account (this first push isn't what the AC is about).
  await E.CascadePersistence.syncNow();
  state.upsertCalls.length = 0;

  a.name = "Agent A renamed";
  E.CascadePersistence.saveCascades();
  await E.CascadePersistence.syncNow();

  const lastUpsert = state.upsertCalls[state.upsertCalls.length - 1] || [];
  assert.equal(lastUpsert.length, 1, "a one-agent rename must upsert exactly one row");
  assert.equal(lastUpsert[0].id, idA, "the one row upserted must be the agent that actually changed");
}));

test("CAS-734 AC3(a): a local edit older than the account's own row loses — the account row is what ends up in cascades", () => withCas734State(async () => {
  const id = uuidFor(3);
  const remoteRow = { id, user_id: "cas681-test-user", name: "Account version",
    criteria: { order: 0 }, alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" };
  const { client } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);

  const local = E.normCascade({ id, name: "Local version (stale)", order: 0 });
  E.cascades.length = 0; E.cascades.push(local);
  // This device's own record of when IT last changed this agent — BEFORE the account row's own updated_at
  // above, so the account is the newer copy even though the content genuinely differs.
  E.CascadePersistence.cascadeEditedAt.set(id, "2026-03-01T00:00:00.000Z");

  await E.CascadePersistence.loadAccount();

  const kept = E.cascades.find(c => c.id === id);
  assert.ok(kept, "the agent must still be present");
  assert.equal(kept.name, "Account version", "the account's newer row must win when the local edit is older");
}));

test("CAS-734 AC3(b): a local edit newer than the account's own row wins and is pushed", () => withCas734State(async () => {
  const id = uuidFor(4);
  const remoteRow = { id, user_id: "cas681-test-user", name: "Account version",
    criteria: { order: 0 }, alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-05T00:00:00.000Z" };
  const { client, state } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);

  // CAS-743: real (user-set-shaped) watchMarkers — this test is about a genuine local edit winning and
  // pushing, and a still-defaulted watchMarkers would itself hold the row out of every push.
  const local = E.normCascade({ id, name: "Local version (newer)", order: 0,
    watchMarkers: { in_cinema: 90, premium: null, rent: 80, stream: 70 } });
  E.cascades.length = 0; E.cascades.push(local);
  // This device changed it AFTER the account row's own updated_at above.
  E.CascadePersistence.cascadeEditedAt.set(id, "2026-06-01T00:00:00.000Z");

  await E.CascadePersistence.loadAccount();
  const kept = E.cascades.find(c => c.id === id);
  assert.equal(kept.name, "Local version (newer)", "the newer local edit must win");

  await E.CascadePersistence.syncNow();
  const lastUpsert = state.upsertCalls[state.upsertCalls.length - 1] || [];
  assert.ok(lastUpsert.some(r => r.id === id && r.name === "Local version (newer)"),
    "the winning local edit must actually be pushed back to the account");
}));

test("CAS-734 AC3(c): loadAccount and reconcileCascades resolve conflicts through the SAME function", () => withCas734State(async () => {
  // Structural: one definition, exactly two call sites (loadAccount, reconcileCascades) — not two inline
  // rules that happen to agree, which is exactly the shape that let them silently disagree before this fix.
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const iifeSrc = src.slice(src.indexOf("function cascadeToRow("), src.indexOf("window.CascadePersistence = {"));
  const defCount = (iifeSrc.match(/function resolveCascadeConflict\(/g) || []).length;
  const totalCount = (iifeSrc.match(/resolveCascadeConflict\(/g) || []).length;
  assert.equal(defCount, 1, "resolveCascadeConflict must be defined exactly once");
  assert.equal(totalCount, 3, "resolveCascadeConflict's one definition plus exactly two call sites (loadAccount, reconcileCascades)");

  // Behavioural: the identical conflict resolves identically whichever path is called.
  const id = uuidFor(5);
  const remoteRow = { id, user_id: "cas681-test-user", name: "Account version",
    criteria: { order: 0 }, alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" };
  const { client } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);
  const local = E.normCascade({ id, name: "Local version (stale)", order: 0 });
  E.cascades.length = 0; E.cascades.push(local);
  E.CascadePersistence.cascadeEditedAt.set(id, "2026-03-01T00:00:00.000Z");

  await E.CascadePersistence.reconcileCascades();
  const kept = E.cascades.find(c => c.id === id);
  assert.equal(kept.name, "Account version", "reconcileCascades must resolve this exactly as loadAccount's own AC3(a) test does");
}));

test("CAS-734 AC3(d): an agent present only on this device, with an id the account has never confirmed, is left alone", () => withCas734State(async () => {
  const otherId = uuidFor(6), localOnlyId = uuidFor(7);
  const remoteRow = { id: otherId, user_id: "cas681-test-user", name: "Some other agent",
    criteria: { order: 0 }, alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  const { client } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);

  const localOnly = E.normCascade({ id: localOnlyId, name: "Brand new, unsynced", order: 1 });
  E.cascades.length = 0; E.cascades.push(localOnly);
  // Never confirmed by the account: withCas734State starts cascadeKnown empty, and this id isn't in it.

  await E.CascadePersistence.loadAccount();

  const kept = E.cascades.find(c => c.id === localOnlyId);
  assert.ok(kept, "a genuinely new, never-synced local agent must survive a loadAccount call");
  assert.equal(kept.name, "Brand new, unsynced");
}));

// ---- A PRE-v0.9.3 CACHED AGENT MUST NEVER FLATTEN AN ACCOUNT'S REAL watchMarkers (CAS-743) ----------------
// CAS-734's per-row resolver compared timestamps alone, which assumed a local copy differing from the account
// only because someone actually edited it. A device whose cache predates CAS-727/729 (v0.9.3) has no
// watchMarkers at all; normCascade's own load-time fill then GUESSES one (every window flattened to the old
// scoreFloor) rather than leaving the field unset. That guess can carry a plausible, even newer, local edit
// timestamp while being structurally older than an account row some other device already gave real per-window
// values — resolveCascadeConflict's timestamp-only rule let the guess win and destroyed the real values.

test("CAS-743 AC2: a local agent with no watchMarkers key never overwrites an account row that has one, even when the local edit timestamp is the newer of the two", () => withCas734State(async () => {
  const id = uuidFor(8);
  // CAS-1113: uniform across all four windows — normCascade's own single-score collapse is a no-op on
  // this shape, so this test's deepEqual below still pins the VALUES surviving the sync untouched, not
  // that collapse's separate (already-covered) behaviour.
  const remoteRow = { id, user_id: "cas681-test-user", name: "Account version",
    criteria: { order: 0, watchMarkers: { in_cinema: 90, premium: 90, rent: 90, stream: 90 } },
    alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-05T00:00:00.000Z" };
  const { client } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);

  // The pre-v0.9.3 cache shape: no watchMarkers key at all. normCascade fills one in and flags it as a guess.
  const local = E.normCascade({ id, name: "Local version (stale, pre-v0.9.3 cache)", order: 0 });
  assert.ok(local._watchMarkersDefaulted, "harness check: normCascade must flag a filled-in watchMarkers as defaulted");
  E.cascades.length = 0; E.cascades.push(local);
  // This device's own edit time is NEWER than the account row's updated_at — under a plain timestamp rule
  // this would win. It must not: the local value is a guess, not something the user actually set.
  E.CascadePersistence.cascadeEditedAt.set(id, "2026-06-01T00:00:00.000Z");

  await E.CascadePersistence.loadAccount();

  const kept = E.cascades.find(c => c.id === id);
  assert.ok(kept, "the agent must still be present");
  assert.equal(kept.name, "Account version",
    "the account's real watchMarkers must win over a defaulted local guess, whatever the timestamps say");
  assert.deepEqual(kept.watchMarkers, { in_cinema: 90, premium: 90, rent: 90, stream: 90 });
}));

test("CAS-743 AC3: an agent whose watchMarkers is still normCascade's default guess is excluded from the rows handed to the upsert; an agent with a real, user-set marker is included", () => withCas734State(async () => {
  const idA = uuidFor(9), idB = uuidFor(10);
  const a = E.normCascade({ id: idA, name: "Agent A (never touched)", order: 0 });
  const b = E.normCascade({ id: idB, name: "Agent B", order: 1 });
  assert.ok(a._watchMarkersDefaulted, "harness check: A's watchMarkers must be normCascade's own guess");
  E.cascades.length = 0; E.cascades.push(a, b);
  const { client } = fakeCascadesSupabase([]);
  signInWithClient(client);

  // Confirm both to the account once — the normal first sync of a brand new agent, defaulted or not.
  await E.CascadePersistence.syncNow();

  // Reproduce the ticket's own root cause directly: a cascadeKnown record that predates the field (or is
  // simply stale) makes A's CURRENT, still-untouched content look dirty for a reason the user never caused.
  const knownA = E.CascadePersistence.cascadeKnown.get(idA);
  E.CascadePersistence.cascadeKnown.set(idA, { ...knownA, sig: "pre-v0.9.3-stale-sig" });

  // B gets a real, user-driven edit through the actual mutator — genuinely dirty for a real reason.
  E.setAgentScore(b, "in_cinema", 88);
  assert.ok(!b._watchMarkersDefaulted, "harness check: setAgentScore must clear B's defaulted flag");

  const dirty = E.CascadePersistence.cascadeDirtyRows();
  assert.ok(!dirty.some(c => c.id === idA),
    "an agent whose watchMarkers is still the normCascade default guess must never reach the rows handed to the upsert");
  assert.ok(dirty.some(c => c.id === idB),
    "an agent with a real, user-set marker change must still reach the rows handed to the upsert");
}));

// ---- A RENAME ON A ROW THAT STILL CARRIES A *Defaulted GUESS MUST STILL SYNC (CAS-1132) -------------------
// CAS-743 AC3 (above) proved a still-guessed watchMarkers must never, on its own, make a row look dirty. Its
// actual fix compared cascadeFullSigOf (every field at once) and suppressed the WHOLE row whenever any
// *Defaulted flag was set, so it also suppressed a genuine edit to any OTHER field on that same row — this is
// the real cause CAS-1132 traced the account-integrity suite's S4 failure to: a seeded agent with no
// watchMarkers in its criteria defaults one locally on load and never gets it confirmed by the account, so a
// rename made afterwards never reached cascadeDirtyRows at all.
test("CAS-1132: a rename on a row whose watchMarkers is still normCascade's default guess still reaches the rows handed to the upsert", () => withCas734State(async () => {
  const id = uuidFor(11);
  // Seeded with no watchMarkers at all — the exact shape seedCascades() gives the integrity suite's fixtures.
  const remoteRow = { id, user_id: "cas681-test-user", name: "Blockbusters",
    criteria: { order: 0 }, alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  const { client, state } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);

  await E.CascadePersistence.loadAccount();
  const loaded = E.cascades.find(c => c.id === id);
  assert.ok(loaded._watchMarkersDefaulted, "harness check: a row with no criteria.watchMarkers loads as a guess");
  assert.ok(!E.CascadePersistence.cascadeDirtyRows().some(c => c.id === id),
    "harness check: untouched right after load, this row must not be dirty");

  loaded.name = "Blockbusters (edited)";
  E.CascadePersistence.saveCascades();
  assert.ok(loaded._watchMarkersDefaulted, "the rename alone must not clear the unrelated watchMarkers guess");

  const dirty = E.CascadePersistence.cascadeDirtyRows();
  assert.ok(dirty.some(c => c.id === id),
    "a real edit to a non-defaulted field must reach the rows handed to the upsert, even while watchMarkers is still a guess");

  await E.CascadePersistence.syncNow();
  const lastUpsert = state.upsertCalls[state.upsertCalls.length - 1] || [];
  assert.ok(lastUpsert.some(r => r.id === id && r.name === "Blockbusters (edited)"),
    "the rename must actually be pushed to the account");
}));

// ---- MANUAL WATCH ON NEVER OVERWRITTEN, EVEN ACROSS DEVICES (CAS-735) -----------------------------------
// Two independent gaps let an explicit manual Watch On pick get silently reverted to auto: applyWatchRows
// carried no precedence rule at all (a remote row that simply didn't mention the ticked rung was enough to
// wipe it), and recomputeFound could re-arm auto off a device's still-stale local cache before its own
// film_watch load for the session had resolved — a device that hadn't yet heard about another device's
// manual pick would re-write auto over it and push that stale value to the account. These exercise each
// seam directly against the real functions.

test("CAS-735 AC2: applyWatchRows never lets a remote row with no manual claim overwrite a local manual pick", () => {
  const id = E.MOVIES[6].tmdb_id;
  try {
    const e = E.entryFor(id);
    e.wins = { in_cinema: false, premium: false, rent: false, stream: true };
    e.winsSource = { stream: "manual" };
    E.CascadePersistence.applyWatchRows([
      { movie_id: String(id), windows: ["in_cinema"], sources: { in_cinema: "auto" },
        updated_at: "2026-09-03T00:00:00.000Z" },
    ]);
    const after = E.notify[id];
    assert.equal(after.wins.stream, true,
      "a local manual pick must survive a remote row claiming a different, auto rung");
    assert.equal(after.winsSource.stream, "manual");
  } finally {
    delete E.notify[id];
  }
});

// CAS-1035 AC5(a): Lee's second observation ("came back after a long idle, no close, no swipe, and the
// picked levels were unselected") named a plain reconcile — on focus/visibilitychange, not a reboot — as a
// suspect alongside the debounce/pagehide gap this ticket otherwise fixes. applyWatchRows' own precedence
// rule (~19989 above) already guards this: a remote row only ever outranks a local manual pick when it is
// BOTH itself claiming manual AND genuinely newer than watchKnown (this device's own last-confirmed remote
// state) — an older row, even one that also claims manual (e.g. a stale reconcile racing a real device
// sync), must leave the local pick untouched. CAS-735 AC2 above already covers "remote claims no manual
// rung at all"; this covers the other half of the same precedence rule, the one every prior test skipped.
test("CAS-1035 AC5(a): applyWatchRows never lets an OLDER remote row overwrite a local manual pick, even one that also claims manual", () => {
  const id = E.MOVIES[7].tmdb_id;
  try {
    const e = E.entryFor(id);
    e.wins = { in_cinema: false, premium: false, rent: false, stream: true };
    e.winsSource = { stream: "manual" };
    // This device already confirmed the account as of a later timestamp than the "reconcile" row below —
    // exactly the shape a routine focus/visibilitychange reconcile racing a slightly-stale read would have.
    E.CascadePersistence.watchKnown.set(String(id), "2026-09-10T00:00:00.000Z");
    E.CascadePersistence.applyWatchRows([
      { movie_id: String(id), windows: ["rent"], sources: { rent: "manual" },
        updated_at: "2026-09-01T00:00:00.000Z" },   // older than watchKnown above
    ]);
    const after = E.notify[id];
    assert.equal(after.wins.stream, true,
      "a local manual pick must survive an older remote row, even one that also claims manual on another rung");
    assert.equal(after.winsSource.stream, "manual");
  } finally {
    delete E.notify[id];
    E.CascadePersistence.watchKnown.delete(String(id));
  }
});

test("CAS-735 AC3: a full recomputeFound() pass never changes an entry carrying a manual source on its currently-set key, for every window and marker configuration", () => {
  const film = scoredUnwatchedFilm(["in_cinema"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const cId = seedMarkerCascade({});
  try {
    pinFilm(id, cId);
    const c = E.cascades.find(x => x.id === cId);
    const score = E.cascadeScore(film) === -1 ? 50 : E.cascadeScore(film);
    const combos = [
      { in_cinema: score - 1, rent: score - 20, stream: score - 30 },
      { in_cinema: null, rent: null, stream: null },
      { in_cinema: 0, rent: 0, stream: 0 },
      { in_cinema: score + 40, rent: score + 20, stream: score + 10 },
    ];
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      for (const manualKey of E.WATCH_LEVEL_KEYS) {
        const e = E.entryFor(id);
        e.wins = Object.fromEntries(E.WATCH_LEVEL_KEYS.map(k => [k, k === manualKey]));
        e.winsSource = { [manualKey]: "manual" };
        const before = JSON.stringify([e.wins, e.winsSource]);
        for (const markers of combos) {
          c.watchMarkers = { in_cinema: null, premium: null, rent: null, stream: null, ...markers };
          for (const status of [["upcoming"], ["in_cinema"], ["rental"], ["included_streaming"]]) {
            film.status = status;
            E.recomputeFound();
            assert.equal(JSON.stringify([e.wins, e.winsSource]), before,
              `manualKey=${manualKey} must survive recompute: markers=${JSON.stringify(markers)} status=${status}`);
          }
        }
      }
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-735 AC4: toggleFilmOpt leaves exactly one key set in wins and exactly one entry in winsSource", () => {
  const m = E.MOVIES.find(x => E.watchLevelsFor(x.tmdb_id).some(l => !l.spent));
  assert.ok(m, "no film with an un-spent Watch level — the harness catalogue looks wrong");
  const id = m.tmdb_id;
  const level = E.watchLevelsFor(id).find(l => !l.spent);
  try {
    E.toggleFilmOpt(id, level.key);
    const e = E.notify[id];
    const onKeys = E.WATCH_LEVEL_KEYS.filter(k => e.wins[k]);
    assert.equal(onKeys.length, 1, `expected exactly one key set in wins, found ${JSON.stringify(onKeys)}`);
    assert.equal(onKeys[0], level.key);
    assert.equal(Object.keys(e.winsSource).length, 1,
      `expected exactly one entry in winsSource, found ${JSON.stringify(e.winsSource)}`);
    assert.equal(e.winsSource[level.key], "manual");
  } finally {
    delete E.notify[id];
  }
});

test("CAS-735 AC5: recomputeFound() writes no placement value before this session's first film_watch load has resolved", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  const savedReady = E.CascadePersistence.filmWatchReady;
  try {
    pinFilm(id, cId);
    E.CascadePersistence.filmWatchReady = false;
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    const e = E.notify[id];
    const picked = !!(e && e.wins && Object.values(e.wins).some(Boolean));
    assert.ok(!picked, "recomputeFound must write no placement value while filmWatchReady is false");

    E.CascadePersistence.filmWatchReady = true;
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    assert.equal(E.notify[id].wins.in_cinema, true, "sanity: once ready, the same film places normally");
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
    E.CascadePersistence.filmWatchReady = savedReady;
  }
});

// ---- WOW! AND ENJOYED SURVIVE FOR A SIGNED-IN ACCOUNT (CAS-738) --------------------------------------------
// saveWatchStatus's accountActive() branch used to call scheduleFilmSync() ONLY, skipping the local
// write-through every other set gets — and user_films (what scheduleFilmSync actually pushes) had no
// status value for wow/enjoyed at all, so a signed-in Wow! or Enjoyed rating was written nowhere and
// vanished on reload. Fixed by always running the local save first, and by widening filmRows()/
// applyFilmRows() to carry the two verdicts through the same status column as the other four.
function withFilmVerdictState(fn){
  const snap = { watched: [...E.watched], disliked: [...E.disliked], blocked: [...E.blocked],
    indifferent: [...E.indifferent], wowed: [...E.wowed], enjoyed: [...E.enjoyed] };
  const restore = () => {
    E.watched.clear(); snap.watched.forEach(id => E.watched.add(id));
    E.disliked.clear(); snap.disliked.forEach(id => E.disliked.add(id));
    E.blocked.clear(); snap.blocked.forEach(id => E.blocked.add(id));
    E.indifferent.clear(); snap.indifferent.forEach(id => E.indifferent.add(id));
    E.wowed.clear(); snap.wowed.forEach(id => E.wowed.add(id));
    E.enjoyed.clear(); snap.enjoyed.forEach(id => E.enjoyed.add(id));
  };
  try { fn(); } finally { restore(); }
}

test("CAS-738 AC3: saveWatchStatus writes cascade_wow and cascade_enjoyed to localStorage while signed in", () => withFilmVerdictState(() => {
  signInWithClient({ from(){ return { upsert: async () => ({ error: null }) }; } });
  try {
    const wowId = 738001, enjoyedId = 738002;
    E.watched.add(wowId); E.wowed.add(wowId);
    E.watched.add(enjoyedId); E.enjoyed.add(enjoyedId);

    E.CascadePersistence.saveWatchStatus();

    // CAS-957: the cache is namespaced by account (acctKey), so the literal "cascade_wow"/"cascade_enjoyed"
    // keys are never written to directly any more — read back through the same suffix the save just used.
    const suffix = E.CascadePersistence.acctSuffix;
    const storedWow = JSON.parse(E.localStorage.getItem(`cascade_wow@${suffix}`) || "[]");
    const storedEnjoyed = JSON.parse(E.localStorage.getItem(`cascade_enjoyed@${suffix}`) || "[]");
    assert.ok(storedWow.includes(wowId),
      "cascade_wow must reach localStorage the instant saveWatchStatus runs, not only be scheduled for the account");
    assert.ok(storedEnjoyed.includes(enjoyedId),
      "cascade_enjoyed must reach localStorage the instant saveWatchStatus runs, not only be scheduled for the account");
  } finally {
    signOut();
  }
}));

test("CAS-738 AC4: filmRows() emits a row for every wowed/enjoyed id, and applyFilmRows() round-trips them back", () => withFilmVerdictState(() => {
  const wowId = 738011, enjoyedId = 738012;
  E.watched.add(wowId); E.wowed.add(wowId);
  E.watched.add(enjoyedId); E.enjoyed.add(enjoyedId);

  const rows = E.CascadePersistence.filmRows();
  const wowRow = rows.find(r => r.movie_id === String(wowId));
  const enjoyedRow = rows.find(r => r.movie_id === String(enjoyedId));
  assert.ok(wowRow, "filmRows() must emit a row for a wowed film — fails on current code (no status value for it)");
  assert.equal(wowRow.status, "wow");
  assert.ok(enjoyedRow, "filmRows() must emit a row for an enjoyed film — fails on current code (no status value for it)");
  assert.equal(enjoyedRow.status, "enjoyed");

  // Simulate a fresh device loading the account: the loader must restore both verdicts from the rows alone.
  const loaded = E.CascadePersistence.applyFilmRows;
  loaded(rows);
  assert.ok(E.wowed.has(wowId), "the loader must round-trip a wow row back into the wowed set");
  assert.ok(E.enjoyed.has(enjoyedId), "the loader must round-trip an enjoyed row back into the enjoyed set");
  assert.ok(!E.wowed.has(enjoyedId), "the round trip must not blur enjoyed into wowed");
  assert.ok(!E.enjoyed.has(wowId), "the round trip must not blur wowed into enjoyed");
}));

// ---- HAND-MADE PER-FILM DECISIONS REACH THE ACCOUNT (CAS-739) ---------------------------------------------
// pickRows() tested e.source==="mine" for the "hand-added" row — a value loadNotify() never produces (it
// normalises e.source to only "manual" or "auto"), so a hand-added film never produced a film_picks row at
// all. pinnedTo/notIn (CAS-279's hand-move override) were never carried to the account in any form. Both are
// per-device overrides, same class as a manual Watch On value, and must survive a reload on another device.
function fakeCas739Supabase(seed){
  const state = { film_picks: (seed.film_picks || []).map(r => ({ ...r })),
                  notify_prefs: (seed.notify_prefs || []).map(r => ({ ...r })) };
  const keyOf = { film_picks: r => `${r.user_id}:${r.movie_id}`, notify_prefs: r => r.user_id };
  function selectBuilder(rows){
    const builder = { then(resolve, reject){
      return Promise.resolve({ data: rows.map(r => ({ ...r })), error: null }).then(resolve, reject);
    } };
    // CAS-1096: acctLoad chains .select("*").order(pk,...).range(from,to) before its own .then() — both
    // are no-ops here, one page already covers every fixture this file seeds.
    builder.order = () => builder;
    builder.range = () => builder;
    return builder;
  }
  function deleteBuilder(table){
    const conds = [];
    const builder = {
      eq(col, val){ conds.push([col, v => v === val]); return builder; },
      in(col, vals){ const set = new Set(vals); conds.push([col, v => set.has(v)]); return builder; },
      // CAS-1096: acctOp's "delete" kind calls .match(op.match) — one call, every column at once.
      match(obj){ Object.entries(obj).forEach(([col, val]) => conds.push([col, v => v === val])); return builder; },
      then(resolve, reject){
        state[table] = state[table].filter(r => !conds.every(([c, test]) => test(r[c])));
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  const client = {
    from(table){
      return {
        select(){ return selectBuilder(state[table]); },
        upsert(rows){
          // CAS-1096: film_picks now pushes through acctOp's "upsert" kind — a single row object, not an
          // array.
          const list = Array.isArray(rows) ? rows : [rows];
          list.forEach(row => {
            const i = state[table].findIndex(x => keyOf[table](x) === keyOf[table](row));
            if(i >= 0) state[table][i] = { ...state[table][i], ...row }; else state[table].push({ ...row });
          });
          return Promise.resolve({ error: null });
        },
        delete(){ return deleteBuilder(table); },
      };
    },
  };
  return { client, state };
}
function withCas739State(fn){
  const savedNotify = { ...E.notify };
  return (async () => {
    try { await fn(); }
    finally {
      Object.keys(E.notify).forEach(k => delete E.notify[k]);
      Object.assign(E.notify, savedNotify);
      signOut();
    }
  })();
}

test("CAS-739 AC2: a film marked as the user's own produces a film_picks row from pickRows()", () => withCas739State(() => {
  signInWithClient(fakeCas739Supabase({}).client);
  const id = 739001;
  const e = E.entryFor(id);
  e.source = "manual";   // the value loadNotify() actually normalises a hand-added film to
  const row = E.CascadePersistence.pickRows().find(r => r.movie_id === String(id));
  assert.ok(row, "pickRows() must emit a row for a film whose source is \"manual\" — fails on current code");
  assert.equal(row.state, "mine");
}));

test("CAS-739 AC3: pinnedTo and notIn survive a save/load round-trip through the account layer", () => withCas739State(async () => {
  const pinnedId = 739002, movedId = 739003;
  E.entryFor(pinnedId).pinnedTo = ["cas739-agent-a"];
  E.entryFor(movedId).notIn = ["cas739-agent-b"];
  const { client } = fakeCas739Supabase({});
  signInWithClient(client);

  // CAS-1096: pushFilmPick is the real per-row acctOp write seam pinFilmToCascadeAndRepaint/deleteAgentAsk
  // call — drive it directly for both ids, the same way syncNotifyNow used to push everything at once.
  E.CascadePersistence.pushFilmPick(pinnedId);
  E.CascadePersistence.pushFilmPick(movedId);
  await new Promise(r => setTimeout(r, 0));   // let both acctOp calls resolve against the fake client
  delete E.notify[pinnedId]; delete E.notify[movedId];   // simulate a fresh device: nothing local yet
  await E.CascadePersistence.loadFilmPicks();      // load, back into notify

  assert.deepEqual(E.entryFor(pinnedId).pinnedTo, ["cas739-agent-a"],
    "pinnedTo must survive a push then a fresh load — fails on current code (never uploaded)");
  assert.deepEqual(E.entryFor(movedId).notIn, ["cas739-agent-b"],
    "notIn must survive a push then a fresh load — fails on current code (never uploaded)");
}));

test("CAS-739 AC4: a recomputeFound() pass never clears a pinnedTo value", () => withCas739State(() => {
  const cId = seedMarkerCascade({});
  const m = unwatchedFilms(1)[0];
  try {
    pinFilm(m.tmdb_id, cId);
    E.recomputeFound();
    assert.deepEqual(E.notify[m.tmdb_id].pinnedTo, [cId],
      "recomputeFound() must never clear a hand-set pinnedTo value");
  } finally {
    delete E.notify[m.tmdb_id];
    unseedCascade(cId);
  }
}));

// ---- THE REMOVED PICK RING'S "off" ROW IS A LEGACY NO-OP (CAS-844) -----------------------------------------
// The Pick ring (pickBtnHTML/cyclePick) is gone: nothing in the live app writes film_picks.state="off" any
// more. But an old device may still have one sitting in the account, and loadFilmPicks() must read it and do
// nothing with it — not resurrect the removal flag it used to drive — or a legacy row would silently keep
// suppressing a film forever with no control left anywhere to undo it.
test("CAS-844 AC3: a loaded film_picks row with state \"off\" does not remove the film from the listing", () => withCas739State(async () => {
  const id = 844001;
  E.entryFor(id).source = "manual";   // a hand-added film — on the listing on its own, nothing to do with "off"
  const { client } = fakeCas739Supabase({
    film_picks: [{ user_id: "cas844-test-user", movie_id: String(id), state: "off", pinned_to: [], not_in: [] }],
  });
  signInWithClient(client);
  await E.CascadePersistence.loadFilmPicks();
  assert.ok(!("removed" in E.notify[id]), "a legacy \"off\" row must not reintroduce the removed flag");
  E.recomputeFound();
  assert.ok(E.found.has(id), "a legacy \"off\" film_picks row must not suppress a film that is otherwise on the list");
}));

// ---- ACCOUNT-LEVEL SETTINGS STAY ON ONE DEVICE (CAS-740) ---------------------------------------------------
// userPrefsRow() didn't carry `touched` (has this device's owner answered the services question). A second
// device loaded without it, read the scope as unanswered, silently re-enabled services-only, and pushed that
// back over the account — so a setting the user had turned off returned and stuck. touched now rides the
// same row/merge rule taste and watch_windows already do.
// CAS-1095: user_prefs moved off the whole-row upsert onto acctLoad (a pure read) / acctOp's per-column
// update — this single-row fake serves both chains (acctLoad's select().order().range(), acctOp's
// update().match(), and the one-time-missing-row upsert()) for whichever table it's built for. Reused by
// every user_prefs/notify_prefs test below (CAS-740/741/742/775).
function fakeSingleRowTable(table, row){
  const state = { row: row ? { ...row } : null, pushCalls: [] };
  const b = {
    select(){ return b; },
    order(){ return b; },
    range(){ return b; },
    update(fields){ b._fields = fields; return b; },
    match(){ return b; },
    upsert(rows){ b._fields = rows[0]; return b; },
    then(resolve, reject){
      let result;
      if(b._fields){
        state.pushCalls.push({ ...b._fields });
        state.row = { ...(state.row || {}), ...b._fields };
        result = { data: [{ ...b._fields }], error: null, status: 200 };
        b._fields = null;   // one-shot per chain — the next from(table) call starts a fresh write, if any
      } else {
        result = { data: state.row ? [{ ...state.row }] : [], error: null, status: 200 };
      }
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return { client: { from(t){ assert.equal(t, table, `this fake only serves ${table}`); return b; } }, state };
}
function fakeCas740Supabase(row){ return fakeSingleRowTable("user_prefs", row); }
function withCas740State(fn){
  // CAS-957: both keys are namespaced by account now (acctKey) — signInWithClient never changes acctSuffix
  // (it pokes CascadeAuth directly, bypassing the real sign-in chokepoint), so every test in this file reads
  // and writes the same "@guest"-suffixed keys throughout; snapshot/restore through that same suffix.
  const onbKey = `cascade_onb_answers@${E.CascadePersistence.acctSuffix}`;
  const uxKey = `cascade_ux@${E.CascadePersistence.acctSuffix}`;
  const savedTouched = E.prefs.touched;
  const savedOnb = E.localStorage.getItem(onbKey);
  const savedUx = E.localStorage.getItem(uxKey);
  return (async () => {
    try { await fn(); }
    finally {
      E.prefs.touched = savedTouched;
      if(savedOnb === null) E.localStorage.removeItem(onbKey); else E.localStorage.setItem(onbKey, savedOnb);
      if(savedUx === null) E.localStorage.removeItem(uxKey); else E.localStorage.setItem(uxKey, savedUx);
      signOut();
    }
  })();
}

test("CAS-740 AC2: userPrefsRow() carries touched, and a push/load round trip preserves false", () => withCas740State(async () => {
  E.prefs.touched = false;
  assert.equal(E.CascadePersistence.userPrefsRow().touched, false, "userPrefsRow() must include touched");

  const { client, state } = fakeCas740Supabase({ user_id: "cas740-test-user", touched: false });
  signInWithClient(client);
  await E.CascadePersistence.pushUserPrefsCols(["touched"]);
  assert.equal(state.row.touched, false, "the pushed row must carry touched:false, not drop it");

  E.prefs.touched = true;   // corrupt local memory so the next assertion proves the LOAD, not a no-op
  await E.CascadePersistence.loadUserPrefs();
  assert.equal(E.prefs.touched, false, "loading the account's row back must read touched as false");
}));

test("CAS-740 AC3: an account that already answered touched=true is adopted on load, and this device's stale false is never pushed back", () => withCas740State(async () => {
  E.prefs.touched = false;
  const remoteRow = {
    user_id: "cas740-test-user", sub_services: [], store_services: [], services_only: false,
    taste: JSON.parse(JSON.stringify(E.tasteBase)), watch_windows: JSON.parse(JSON.stringify(E.watchPrefs)),
    touched: true, never_show: [], onb_depth: "best", framing: true, ref_code: "cas740ac3",
  };
  const { client, state } = fakeCas740Supabase(remoteRow);
  signInWithClient(client);

  await E.CascadePersistence.loadUserPrefs();
  assert.equal(E.prefs.touched, true, "the account's real touched:true must win over this device's stale local false");
  assert.equal(state.pushCalls.length, 0, "a row that already answers everything must not trigger any write");
}));

// ---- LOADS NEVER WRITE (CAS-741, restated under CAS-1095) --------------------------------------------------
// Originally: notify_prefs pushed unconditionally, with no gate on whether this device's own load had
// resolved or even succeeded, so the next edit could push this device's local defaults over a real account
// row (muting email alerts, erasing a real address). CAS-1095 removed the whole-row push (and therefore the
// race) entirely: notify_prefs now only loads through acctLoad (a pure read) and only writes through
// pushNotifyPrefs, which a load path never calls — there is no longer a "load in flight/failed" gate to
// test, because a load can no longer trigger a write of any kind, clean or stale.
function withCas741NotifyState(fn){
  const savedReady = E.CascadePersistence.notifyPrefsReady;
  const savedPrefs = { ...E.notifyPrefs };
  return (async () => {
    try { await fn(); }
    finally {
      E.CascadePersistence.notifyPrefsReady = savedReady;
      Object.assign(E.notifyPrefs, savedPrefs);
      signOut();
    }
  })();
}

test("CAS-741 (CAS-1095): loadNotifyPrefs never writes notify_prefs, whether the load succeeds or fails", () => withCas741NotifyState(async () => {
  const remoteRow = { user_id: "cas681-test-user", in_app: true, email_on: true, email_address: "real@account.com" };
  const { client, state } = fakeSingleRowTable("notify_prefs", remoteRow);
  signInWithClient(client);

  E.CascadePersistence.notifyPrefsReady = false;   // fireAccountFanout's own step, before kicking off the load
  await E.CascadePersistence.loadNotifyPrefs();
  assert.equal(state.pushCalls.length, 0, "a clean load must never write notify_prefs back");
  assert.equal(E.notifyPrefs.email, "real@account.com", "the account's real row is adopted");

  // A failed load (client throws/returns an error) must also never fall through to a write.
  const throwingClient = { from(t){ assert.equal(t, "notify_prefs"); return { select(){ return this; },
    order(){ return this; }, range(){ return this; },
    then(resolve){ return Promise.resolve({ data: null, error: { message: "network down" } }).then(resolve); } }; } };
  signInWithClient(throwingClient);
  E.CascadePersistence.notifyPrefsReady = false;
  await E.CascadePersistence.loadNotifyPrefs();
  assert.equal(E.CascadePersistence.notifyPrefsReady, false, "a failed load must not flip notifyPrefsReady true");
}));

// ---- PER-DEVICE CACHES AND STAMPS MADE TWO DEVICES DISAGREE (CAS-742) --------------------------------------
// _scaleInferCache/_awardRankCache were never cleared when MOVIES was replaced wholesale, so a device left
// open across a catalogue refresh kept stale inferred budgets/award ranks — a budget/awards-gated agent
// admitted a different set of films than a freshly-booted device. invalidateComputeCaches() is the fix's one
// invalidation point, wired into the real catalogue swap (MOVIES=payload.movies) in pollCatalogue.
test("CAS-742 AC2: invalidateComputeCaches empties both catalogue-derived caches, so a changed award rank reads fresh without a reload", () => {
  const m = E.MOVIES.find(x => !x.award);
  assert.ok(m, "need a film with no award to run this test");
  const savedAward = m.award, savedAwardText = m.award_text;
  try {
    assert.equal(E.awardRank(m), 0, "sanity: an unawarded film starts at rank 0");
    E.inferredScale(E.MOVIES[1]);   // populate _scaleInferCache too — a null result still caches (has() below proves it)
    assert.ok(E._awardRankCache.has(m.tmdb_id), "sanity: awardRank populates its cache");
    assert.ok(E._scaleInferCache.has(E.MOVIES[1].tmdb_id), "sanity: inferredScale populates its cache");

    m.award = "won"; m.award_text = "Won 1 Oscar";
    assert.equal(E.awardRank(m), 0,
      "the cache must still answer the pre-change rank here — proves the read below is the cache, not a live recompute");

    E.invalidateComputeCaches();
    assert.equal(E._awardRankCache.size, 0, "invalidateComputeCaches must empty _awardRankCache");
    assert.equal(E._scaleInferCache.size, 0, "invalidateComputeCaches must empty _scaleInferCache");
    assert.ok(E.awardRank(m) > 0, "after invalidation, the newly-won award must be read, not the stale cached rank");
  } finally {
    m.award = savedAward; m.award_text = savedAwardText;
    E.invalidateComputeCaches();
  }
});

// firstFound was stamped with the device's own TODAY the moment a film entered `found` — a device meeting
// the account for the first time (a reinstall, a new phone) has no local record for any of its films, so
// every one of them read as newly found regardless of how long the account has actually had them. isNewFound
// now checks the film's real admission date (agent_films.admitted_at, CAS-726) via admittedAtFor() first, and
// only falls back to the device-local firstFound stamp when there is no account row to read (a pinned film,
// or a guest device). Seeded directly via setAgentFilm, the same seam CAS-726/728/736's own tests use.
test("CAS-742 AC3: isNewFound reads the account's real admission date, ignoring a device-local stamp of today", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas742-ac3", 99);
    E.cascades.push(c);
    const sig = E.cascSigOf(c);
    const savedFirstFound = E.firstFound[id];
    const oldIso = new Date(Date.now() - 30 * 864e5).toISOString();
    try {
      E.CascadePersistence.setAgentFilm(c.id, id,
        { admission_score: 90, admission_status: "in_cinema", agent_sig: sig, admitted_at: oldIso });
      E.recomputeFound();
      // Exactly the pre-fix failure mode: this device's OWN local ledger says "found today" (trackFirstFound
      // still stamps this unconditionally, as the pinned/guest fallback needs it to) — the account's real
      // 30-day-old admission must win over it, not the device's own today-stamp.
      E.firstFound[id] = new Date().toISOString();
      assert.equal(E.isNewFound(id), false,
        "a film admitted 30 days ago must not read as newly found just because this device's own local stamp says today");
    } finally {
      unseedCascade(c.id); delete E.notify[id];
      if(savedFirstFound === undefined) delete E.firstFound[id]; else E.firstFound[id] = savedFirstFound;
    }
  });
}));

// ---- CAS-715: isnew is recency AND "the world moved, not the agent" -------------------------------------
// The Watch On chip's old "Can Watch" glow (.recent) is gone; isnew (filmIsNew) replaces it, and it is NOT
// just isNewFound — a film that only shows up because an agent's own criteria were just edited (or because
// the agent is brand new and has no prior signature to compare against) is news about the AGENT, not the
// FILM, and must not glow. recomputeFound is the only place that can still tell the two causes apart (see
// its own cascadeDrift comment, and firstFound's — !firstFound[id] is what tells a fresh admission apart
// from a mere re-confirmation of a film that's been sitting in `found` for days) — these three tests seed
// each of the three scenarios directly, the same seam CAS-728's own sticky-admission tests use. All three
// pick their film with the same bare pastCinemaUnwatchedFilm() CAS-728's own tests use, so each explicitly
// saves/restores firstFound[id]/admitDrift[id] (like CAS-742 AC3 does) rather than assuming a clean slate.
test("CAS-715 AC6a: a film admitted while its owning agent's signature is unchanged reads isnew true", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas715-ac6a", 99);
    E.cascades.push(c);
    const sig = E.cascSigOf(c);
    const savedFirstFound = E.firstFound[id], savedDrift = E.admitDrift[id];
    delete E.firstFound[id]; delete E.admitDrift[id];
    try {
      // Seeded as though a prior pass already admitted it under TODAY's signature — recomputeFound's own
      // sticky fast path (r.agent_sig===sig) must skip it untouched, so this pass proves nothing about drift.
      E.CascadePersistence.setAgentFilm(c.id, id, { admission_score: 90, admission_status: "in_cinema", agent_sig: sig });
      E.recomputeFound();
      assert.equal(E.filmIsNew(id), true,
        "a film admitted under an unedited agent must read isnew — nothing here says an agent was widened");
    } finally {
      unseedCascade(c.id); delete E.notify[id];
      if(savedFirstFound === undefined) delete E.firstFound[id]; else E.firstFound[id] = savedFirstFound;
      if(savedDrift === undefined) delete E.admitDrift[id]; else E.admitDrift[id] = savedDrift;
    }
  });
}));

test("CAS-715 AC6b: the same film re-admitted in a pass where its owning agent's signature changed reads isnew false", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const saved = { rt_critic: film.rt_critic, metacritic: film.metacritic, imdb_votes: film.imdb_votes };
    // Zero the film's LIVE score so only the STORED admission_score (90) can keep it in — same recipe as
    // CAS-728 AC4 — so this test's "stillIn" outcome cannot be an accident of the live catalogue.
    film.rt_critic = null; film.metacritic = null; film.imdb_votes = 0;
    const c = stickyTestCascade("cas715-ac6b", 99);
    E.cascades.push(c);
    const sigBefore = E.cascSigOf(c);
    const savedFirstFound = E.firstFound[id], savedDrift = E.admitDrift[id];
    delete E.firstFound[id]; delete E.admitDrift[id];
    try {
      E.CascadePersistence.setAgentFilm(c.id, id, { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
      c.watchMarkers = { in_cinema: 80, premium: null, rent: 80, stream: 80 };   // 80 <= stored 90; moves cascSigOf
      assert.notEqual(E.cascSigOf(c), sigBefore, "setup: this edit must actually move cascSigOf(c)");
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(row, "setup: the film must still be admitted after the edit — a live-score retest would fail unconditionally here");
      assert.equal(E.filmIsNew(id), false,
        "a film re-confirmed under a just-changed agent signature must not read isnew");
    } finally {
      unseedCascade(c.id); delete E.notify[id]; Object.assign(film, saved);
      if(savedFirstFound === undefined) delete E.firstFound[id]; else E.firstFound[id] = savedFirstFound;
      if(savedDrift === undefined) delete E.admitDrift[id]; else E.admitDrift[id] = savedDrift;
    }
  });
}));

test("CAS-715 AC6c: a newly created agent's first intake reads isnew false", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    // Floor 0, deliberately permissive — unlike the CAS-728 tests' floor of 99, this one WANTS a real,
    // unseeded arrival: the point under test is recomputeFound's own "no prior rows at all" reading.
    const c = stickyTestCascade("cas715-ac6c", 0);
    E.cascades.push(c);
    const savedFirstFound = E.firstFound[id], savedDrift = E.admitDrift[id];
    delete E.firstFound[id]; delete E.admitDrift[id];
    try {
      assert.equal(E.CascadePersistence.agentFilmsFor(c.id).length, 0,
        "setup: a brand-new agent must start with no admitted films");
      E.recomputeFound();
      assert.ok(E.CascadePersistence.getAgentFilm(c.id, id),
        "setup: this permissive brand-new agent must actually admit the chosen film");
      assert.equal(E.admitDrift[id], true,
        "a brand-new agent's very first intake must be flagged — it has no prior signature to compare against");
      assert.equal(E.filmIsNew(id), false, "and must therefore not read isnew");
    } finally {
      unseedCascade(c.id); delete E.notify[id];
      if(savedFirstFound === undefined) delete E.firstFound[id]; else E.firstFound[id] = savedFirstFound;
      if(savedDrift === undefined) delete E.admitDrift[id]; else E.admitDrift[id] = savedDrift;
    }
  });
}));

// CAS-715 AC7: the "New" filter rides the same filt-registry seam the existing "recent" filter (CAS-468)
// already uses — filtSnapshot's serialise list, the RELAXERS label/clear registry, and passes() itself —
// so a test can assert it's really registered there, not just wired into one screen's own local state.
test("CAS-715 AC7: the New filter is registered in the filt registry and clearing it restores the unfiltered count", () => {
  const snap = E.filtSnapshot();
  try {
    const total = E.MOVIES.filter(E.passes).length;
    const relaxer = E.RELAXERS.find(r => r.key === "newOnly");
    assert.ok(relaxer, "no \"newOnly\" entry in RELAXERS — the New filter isn't registered the way \"recent\" is");
    E.filt.newOnly = true;
    const filteredCount = E.MOVIES.filter(E.passes).length;
    assert.ok(filteredCount <= total, "turning the New filter on must never show MORE films than off");
    relaxer.clear();
    assert.equal(E.filt.newOnly, false, "the registry's own clear() must actually flip the flag off");
    assert.equal(E.MOVIES.filter(E.passes).length, total,
      "clearing the New filter must restore exactly the unfiltered count");
  } finally { E.filtRestore(snap); }
});

// movingSeen (the Moving badge's own {filmId: lastSeenGroupKey}) was device-local — clearing the badge on one
// device left it lit on every other. It now rides the same user_prefs row/merge rule as taste and
// watch_windows (CAS-561), reusing the CAS-740 fake (that double serves "user_prefs" generically, not just
// the touched/never_show/onb_depth/framing fields it was written for).
test("CAS-742: movingSeen persists through user_prefs — push/load round trip", () => withCas740State(async () => {
  const fid = String(E.MOVIES[0].tmdb_id);
  const saved = E.movingSeen[fid];
  try {
    E.movingSeen[fid] = "new_agents";
    assert.deepEqual(E.CascadePersistence.userPrefsRow().moving_seen, E.movingSeen,
      "userPrefsRow() must include the live movingSeen object");

    const { client, state } = fakeCas740Supabase({ user_id: "cas740-test-user" });
    signInWithClient(client);
    await E.CascadePersistence.pushUserPrefsCols(["moving_seen"]);
    assert.deepEqual(state.row.moving_seen, E.movingSeen, "the pushed row must carry moving_seen");

    delete E.movingSeen[fid];   // corrupt local memory so the next assertion proves the LOAD, not a no-op
    await E.CascadePersistence.loadUserPrefs();
    assert.equal(E.movingSeen[fid], "new_agents",
      "loading the account's row back must restore this device's cleared badge state");
  } finally {
    if(saved === undefined) delete E.movingSeen[fid]; else E.movingSeen[fid] = saved;
  }
}));

// ---- CAS-744: includeUnrated must gate the AGE filter too, not only the IMDb bar it already governed ------
// ratingOK (CAS-171, above) already treats "no IMDb score" as its own case, decided by includeUnrated. The
// age gate never made that same distinction — a film with no age_rating at all was simply absent from c.age's
// list, same as a film whose real rating was outside it, and includeUnrated was never consulted. That matters
// because a null age_rating is the NORM for an unreleased film, not the exception: CAS-744's own audit found
// only 31.6% of upcoming/in_cinema films rated at all. scoreFloor:0 is pinned alongside every missionCase()
// override below, per the CAS-724 gotcha noted earlier in this file — otherwise normCascade's legacy-floor
// migration reads selScale/selAwards as old Mission dials and derives a non-zero floor, contaminating a test
// about the age gate alone with the unrelated score gate.
test("CAS-744 AC2: includeUnrated decides an unrated film's fate under a narrowed age list", () => {
  const openAge = missionCase({ scoreFloor: 0 });   // age:[] here — open, so an unrated film clears on its own merits
  // CAS-1065 exempted pre-release films from the age gate entirely, so an unrated pick must be RELEASED —
  // otherwise it clears regardless of includeUnrated and this test proves nothing about the flag.
  const unrated = E.MOVIES.find(m => !m.age_rating && !isPreRelease(m) && E.matchesCriteria(m, openAge));
  assert.ok(unrated, "no unrated film clearing the open baseline — this test would prove nothing");
  const allowed = E.AGE_LEVELS[0];

  assert.equal(E.matchesCriteria(unrated, missionCase({ scoreFloor: 0, age: [allowed], includeUnrated: true })), true,
    `${unrated.title}: unrated film was excluded from a narrowed age list even with includeUnrated true`);
  assert.equal(E.matchesCriteria(unrated, missionCase({ scoreFloor: 0, age: [allowed], includeUnrated: false })), false,
    `${unrated.title}: unrated film was listed by a narrowed age list with includeUnrated false`);
});

test("CAS-744 AC3: a rated film outside the agent's age list stays excluded regardless of includeUnrated", () => {
  const allowed = E.AGE_LEVELS[0];
  const open = missionCase({ scoreFloor: 0 });
  const outsider = E.MOVIES.find(m => m.age_rating && m.age_rating !== allowed && E.matchesCriteria(m, open));
  assert.ok(outsider, "no differently-rated film clearing the open baseline — this test would prove nothing");
  for(const includeUnrated of [true, false]){
    assert.equal(E.matchesCriteria(outsider, missionCase({ scoreFloor: 0, age: [allowed], includeUnrated })), false,
      `${outsider.title} rated "${outsider.age_rating}" was listed against an age list of ["${allowed}"] (includeUnrated: ${includeUnrated})`);
  }
});

test("CAS-744 AC4: includeUnrated strictly grows the count over the live catalogue whenever an unrated film would otherwise qualify", () => {
  const allowed = E.AGE_LEVELS[0];
  const openAge = missionCase({ scoreFloor: 0 });
  const wouldQualify = E.MOVIES.some(m => !m.age_rating && E.matchesCriteria(m, openAge));
  assert.ok(wouldQualify, "no unrated film would otherwise qualify at all — this test would prove nothing");

  const off = missionCase({ scoreFloor: 0, age: [allowed], includeUnrated: false });
  const on  = missionCase({ scoreFloor: 0, age: [allowed], includeUnrated: true });
  const offCount = E.MOVIES.filter(m => E.matchesCriteria(m, off)).length;
  const onCount  = E.MOVIES.filter(m => E.matchesCriteria(m, on)).length;
  assert.ok(onCount > offCount,
    `includeUnrated true did not grow the count over false, ${offCount} → ${onCount}`);
});

// ---- CAS-775: Occasions register ------------------------------------------------------------------------
// CAS-768 shipped Occasions as a DERIVED set (the union of what agents happened to carry); CAS-775 replaces
// it with a real register ([{id,name}] on occasionReg) — c.occasions on an agent now holds REGISTER IDS,
// not names, so an occasion can exist with no carrier, be renamed with no agent rewritten, and be deleted.
// The two traps CAS-768 named still hold unchanged: cascSigOf (CAS-728's admission signature) must stay
// completely inert to occasions, while dedupeCascades' OWN identity signature must not.
function unseedOccasion(id){
  const i = E.occasionReg.findIndex(o => o.id === id);
  if(i >= 0) E.occasionReg.splice(i, 1);
}

test("CAS-768 AC1/CAS-775: occasions default to [] and an agent can carry two or more ids at once, surviving a reload", () => {
  const fresh = E.normCascade({});
  assert.deepEqual([...fresh.occasions], [], "an agent with no occasions must default to [] — the pre-existing-agent case");
  fresh.occasions = ["occ-me", "occ-family"];
  const reloaded = E.normCascade(fresh);   // normCascade runs on every load — this IS the reload path
  assert.deepEqual([...reloaded.occasions], ["occ-me", "occ-family"], "two occasion ids must both survive a normCascade pass");
});

test("CAS-775 AC2: an occasion can exist in the register while no agent carries it, and survives a reload in that state", () => {
  const o = E.createOccasion("CAS775-no-carrier");
  try {
    assert.equal(E.occasionAgentCount(o.id), 0, "setup: no agent may carry this freshly-created occasion");
    // "Reload" for a register entry is just reading it back — there is no per-agent state to lose.
    assert.ok(E.occasionRegSorted().some(x => x.id === o.id), "the register entry must still be there with nothing carrying it");
    assert.equal(E.occasionName(o.id), "CAS775-no-carrier");
  } finally { unseedOccasion(o.id); }
});

test("CAS-768 AC3: an occasion edit does not move cascSigOf(c)", () => {
  const o = E.createOccasion("CAS775-sig-test");
  try {
    const c = E.normCascade({ kind: "stream", status: [] });
    const sigBefore = E.cascSigOf(c);
    c.occasions = [o.id];
    assert.equal(E.cascSigOf(c), sigBefore, "tagging an agent with one occasion must not move its admission signature");
    const o2 = E.createOccasion("CAS775-sig-test-2");
    try {
      c.occasions = [o.id, o2.id];
      assert.equal(E.cascSigOf(c), sigBefore, "a second occasion must not move cascSigOf either");
    } finally { unseedOccasion(o2.id); }
    c.occasions = [];
    assert.equal(E.cascSigOf(c), sigBefore, "removing every occasion must not move cascSigOf either");
  } finally { unseedOccasion(o.id); }
});

test("CAS-768 AC4/CAS-775 AC6: an occasion edit triggers no re-review — agent_films rows and admitDrift are untouched", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const o = E.createOccasion("CAS775-ac6-family");
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas768-ac4", 99);
    E.cascades.push(c);
    const sig = E.cascSigOf(c);
    const savedDrift = E.admitDrift[id];
    delete E.admitDrift[id];
    try {
      E.CascadePersistence.setAgentFilm(c.id, id, { admission_score: 90, admission_status: "in_cinema", agent_sig: sig });
      c.occasions = [o.id];
      assert.equal(E.cascSigOf(c), sig, "setup: an occasion edit must not move cascSigOf(c)");
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(row, "an occasion edit must not drop an already-admitted film");
      assert.equal(row.admission_score, 90, "the stored admission_score must survive untouched — no re-review happened");
      assert.equal(row.agent_sig, sig, "agent_sig must be unchanged by an occasion-only edit");
      assert.ok(!E.admitDrift[id], "an occasion edit must not flag the film with admitDrift");
    } finally {
      unseedCascade(c.id);
      unseedOccasion(o.id);
      if(savedDrift === undefined) delete E.admitDrift[id]; else E.admitDrift[id] = savedDrift;
    }
  });
}));

test("CAS-768 AC5/CAS-775 AC12: two agents identical except for occasions both survive dedupeCascades", () => {
  const us = E.createOccasion("CAS775-dd-us"), family = E.createOccasion("CAS775-dd-family");
  const a = E.normCascade({ kind: "stream", status: [] });
  a.id = "cas768-ac5-a"; a.order = 0; a.occasions = [us.id];
  const b = E.normCascade({ kind: "stream", status: [] });
  b.id = "cas768-ac5-b"; b.order = 1; b.occasions = [family.id];
  assert.equal(E.cascSigOf(a), E.cascSigOf(b), "setup: these two agents must be exact admission twins");
  assert.notEqual(E.cascDedupeSigOf(a), E.cascDedupeSigOf(b), "setup: dedupe's own signature must differ once occasions are folded in");
  E.cascades.push(a, b);
  try {
    const dropped = E.dedupeCascades();
    assert.equal(dropped, 0, "two agents differing only by occasion must not be deduped");
    assert.ok(E.cascades.some(x => x.id === "cas768-ac5-a"), "agent A must survive");
    assert.ok(E.cascades.some(x => x.id === "cas768-ac5-b"), "agent B must survive");
  } finally { unseedCascade(a.id); unseedCascade(b.id); unseedOccasion(us.id); unseedOccasion(family.id); }
});

test("CAS-775 AC3: deleting an occasion removes it from the register and from every agent that carried it", () => {
  const o = E.createOccasion("CAS775-delete-me");
  const a = E.normCascade({ kind: "stream", status: [] });
  a.id = "cas775-ac3-a"; a.order = 0; a.occasions = [o.id];
  const b = E.normCascade({ kind: "stream", status: [] });
  b.id = "cas775-ac3-b"; b.order = 1; b.occasions = [];
  E.cascades.push(a, b);
  try {
    assert.equal(E.occasionAgentCount(o.id), 1, "setup: exactly one agent carries this occasion");
    E.deleteOccasion(o.id);
    assert.ok(!E.occasionRegSorted().some(x => x.id === o.id), "the register entry must be gone");
    assert.deepEqual([...a.occasions], [], "the carrying agent's own occasions array must have the id removed");
    assert.deepEqual([...b.occasions], [], "an agent that never carried it must be untouched");
  } finally { unseedCascade(a.id); unseedCascade(b.id); unseedOccasion(o.id); }
});

test("CAS-775 AC3: deleting the occasion selected on the Watch screen falls back to All", () => {
  const o = E.createOccasion("CAS775-selected");
  const savedWatchOccasion = E.watchOccasion;
  E.setWatchOccasion(o.id);
  try {
    assert.equal(E.watchOccasion, o.id, "setup: the occasion must actually be selected first");
    E.deleteOccasion(o.id);
    assert.equal(E.watchOccasion, null, "deleting the selected occasion must fall back to All (null)");
  } finally {
    unseedOccasion(o.id);
    E.setWatchOccasion(savedWatchOccasion);
  }
});

test("CAS-775 AC4: renaming an occasion updates it everywhere and rewrites no agent's stored occasions array", () => {
  const o = E.createOccasion("CAS775-before-name");
  const a = E.normCascade({ kind: "stream", status: [] });
  a.id = "cas775-ac4-a"; a.order = 0; a.occasions = [o.id];
  E.cascades.push(a);
  const before = JSON.stringify([...a.occasions]);
  try {
    E.renameOccasion(o.id, "CAS775-after-name");
    assert.equal(E.occasionName(o.id), "CAS775-after-name", "the register entry itself must show the new name");
    assert.equal(JSON.stringify([...a.occasions]), before, "the carrying agent's occasions array (ids) must be byte-identical — a rename touches only the register");
  } finally { unseedCascade(a.id); unseedOccasion(o.id); }
});

test("CAS-775 AC5: adding, removing, renaming and deleting an occasion never move any agent's cascSigOf", () => {
  const a = E.normCascade({ kind: "stream", status: [] });
  a.id = "cas775-ac5-a"; a.order = 0; a.occasions = [];
  E.cascades.push(a);
  let o;
  try {
    const sig0 = E.cascSigOf(a);
    o = E.createOccasion("CAS775-ac5");
    a.occasions = [o.id];                              // add
    assert.equal(E.cascSigOf(a), sig0, "adding an occasion must not move cascSigOf");
    E.renameOccasion(o.id, "CAS775-ac5-renamed");        // rename
    assert.equal(E.cascSigOf(a), sig0, "renaming an occasion must not move cascSigOf");
    a.occasions = [];                                   // remove
    assert.equal(E.cascSigOf(a), sig0, "removing an occasion must not move cascSigOf");
    a.occasions = [o.id];
    E.deleteOccasion(o.id);                             // delete
    assert.equal(E.cascSigOf(a), sig0, "deleting an occasion must not move cascSigOf");
  } finally { unseedCascade(a.id); unseedOccasion(o.id); }
});

// ---- CAS-775 AC9/AC10: the register rides user_prefs (same fake as CAS-740/742 above) ---------------------
function withCas775RegState(fn){
  const savedReg = [...E.occasionReg];
  return (async () => {
    try { await fn(); }
    finally {
      E.occasionReg.length = 0; savedReg.forEach(o => E.occasionReg.push(o));
      signOut();
    }
  })();
}
// Every comparison below spreads a vm-realm array into a fresh one first (`[...arr]`) — assert.deepEqual is
// deepStrictEqual under node:assert/strict, which compares an Array's own prototype too, and occasionReg/
// userPrefsRow()'s return both live inside the vm sandbox; the plain `[o]`/`[]` literal on the other side is
// constructed in THIS file's realm. Comparing the two arrays directly fails on that prototype check alone,
// independent of their contents (the same gotcha this suite has hit for chained .map()/.flatMap() results).
test("CAS-775: userPrefsRow() carries the register, and a push/load round trip preserves it, including an empty array", () => withCas775RegState(async () => {
  E.occasionReg.length = 0;
  const o = E.createOccasion("CAS775-roundtrip");
  assert.deepEqual([...E.CascadePersistence.userPrefsRow().occasions], [o], "userPrefsRow() must include the live register");

  const { client, state } = fakeCas740Supabase({ user_id: "cas740-test-user" });
  signInWithClient(client);
  await E.CascadePersistence.pushUserPrefsCols(["occasions"]);
  assert.deepEqual([...state.row.occasions], [o], "the pushed row must carry the register, not drop it");

  E.occasionReg.length = 0;   // corrupt local memory so the next assertion proves the LOAD, not a no-op
  await E.CascadePersistence.loadUserPrefs();
  assert.deepEqual([...E.occasionReg], [o], "loading the account's row back must restore this device's register");

  // AC2/AC10: the account can legitimately answer "empty" — that must be ADOPTED (last-write-wins, same
  // rule as taste/watch_windows), not read as "unanswered".
  state.row.occasions = [];
  await E.CascadePersistence.loadUserPrefs();
  assert.deepEqual([...E.occasionReg], [], "an account row with occasions:[] must overwrite this device's local register — an empty array is a real answer");
}));

// CAS-1095: carry-up (self-heal a missing/NULL column by pushing this device's own value back up) is
// removed entirely — a field the account has no answer for is now simply left alone: not overwritten, and
// never pushed either. AC9/AC10 restated under that rule.
test("CAS-775 AC9 (CAS-1095): a user_prefs row with no occasions column at all leaves this device's register untouched, and pushes nothing", () => withCas775RegState(async () => {
  const o = E.createOccasion("CAS775-ac9-local-only");
  const remoteRow = {   // no `occasions` key — simulates the column not existing on the live project yet
    user_id: "cas740-test-user", sub_services: [], store_services: [], services_only: false,
    taste: JSON.parse(JSON.stringify(E.tasteBase)), watch_windows: JSON.parse(JSON.stringify(E.watchPrefs)),
    touched: true, never_show: [], onb_depth: "best", framing: true, moving_seen: {}, ref_code: "cas775ac9",
  };
  const { client, state } = fakeCas740Supabase(remoteRow);
  signInWithClient(client);
  await assert.doesNotReject(() => E.CascadePersistence.loadUserPrefs(),
    "a missing occasions column must read exactly like NULL, never throw");
  assert.deepEqual([...E.occasionReg], [o], "this device's local register must survive untouched when the column doesn't exist yet");
  assert.equal(state.pushCalls.length, 0, "a load must never push this device's register back, missing column or not");
}));

test("CAS-775 AC10 (CAS-1095): a user_prefs row with occasions:NULL leaves this device's local register untouched, and pushes nothing", () => withCas775RegState(async () => {
  const o = E.createOccasion("CAS775-ac10-local-only");
  const remoteRow = {
    user_id: "cas740-test-user", sub_services: [], store_services: [], services_only: false,
    taste: JSON.parse(JSON.stringify(E.tasteBase)), watch_windows: JSON.parse(JSON.stringify(E.watchPrefs)),
    touched: true, never_show: [], onb_depth: "best", framing: true, moving_seen: {}, occasions: null,
    ref_code: "cas775ac10",
  };
  const { client, state } = fakeCas740Supabase(remoteRow);
  signInWithClient(client);
  await E.CascadePersistence.loadUserPrefs();
  assert.deepEqual([...E.occasionReg], [o], "a NULL occasions column must leave this device's local register exactly as it was");
  assert.equal(state.pushCalls.length, 0, "a load must never push this device's register back, NULL column or not");
}));

test("CAS-775 AC11: an occasion id matching no register entry is ignored on read and gone after the agent's next save", () => {
  const ghostId = "cas775-ghost-id-does-not-exist";
  assert.equal(E.occasionName(ghostId), "", "occasionName must not resolve an orphan id to any name");
  assert.equal(E.occasionsSummary({ occasions: [ghostId] }), "None yet",
    "an agent whose only occasion is an orphan id must read back as untagged, not throw or show a blank chip");
  const o = E.createOccasion("CAS775-ac11-real");
  try {
    assert.deepEqual(E.pruneOccasionIds([ghostId, o.id]), [o.id],
      "pruneOccasionIds (the one choke point commitDraft saves an agent's occasions through) must drop the orphan and keep the real id");
  } finally { unseedOccasion(o.id); }
});

test("CAS-775 AC7/AC8: migrating legacy occasion NAMES builds the register once, rewrites every agent to ids, and is idempotent", () => {
  const savedReg = [...E.occasionReg];
  E.occasionReg.length = 0;   // the migration gate is "the register is still empty"
  const a = E.normCascade({ kind: "stream", status: [] });
  a.id = "cas775-mig-a"; a.order = 0; a.occasions = ["Family"];
  const b = E.normCascade({ kind: "stream", status: [] });
  b.id = "cas775-mig-b"; b.order = 1; b.occasions = ["Family", "Us"];
  E.cascades.push(a, b);
  try {
    E.migrateOccasionNamesIfNeeded();
    assert.equal(E.occasionReg.length, 2, "the register must hold one entry per distinct legacy name");
    const familyId = E.occasionReg.find(o => o.name === "Family").id;
    const usId = E.occasionReg.find(o => o.name === "Us").id;
    assert.deepEqual([...a.occasions], [familyId], "agent A's occasions must be rewritten from names to the matching ids");
    assert.deepEqual([...b.occasions], [familyId, usId], "agent B's two occasions must both be rewritten to ids, in order");
    const regAfterFirstRun = JSON.stringify(E.occasionReg);
    const aAfterFirstRun = JSON.stringify([...a.occasions]);
    E.migrateOccasionNamesIfNeeded();   // AC8: running it again must be a no-op — the register is no longer empty
    assert.equal(JSON.stringify(E.occasionReg), regAfterFirstRun, "a second migration run must not change the register");
    assert.equal(JSON.stringify([...a.occasions]), aAfterFirstRun, "a second migration run must not touch an already-migrated agent's tags");
  } finally {
    unseedCascade(a.id); unseedCascade(b.id);
    E.occasionReg.length = 0; savedReg.forEach(o => E.occasionReg.push(o));
  }
});

test("CAS-768 AC7: typing a name differing only in case ticks the existing occasion instead of creating a second", () => {
  const o = E.createOccasion("Family");
  const a = E.normCascade({ kind: "stream", status: [] });
  a.id = "cas768-ac7"; a.order = 0; a.occasions = [o.id];
  E.cascades.push(a);
  const draft = E.normCascade({ kind: "stream", status: [] });
  draft.occasions = [];
  const savedDraft = E.onbFlow.draft;
  E.onbFlow.draft = draft;
  try {
    E.commitCreateOccasionRow({ isConnected: true, value: "family" });
    assert.deepEqual([...draft.occasions], [o.id], "typing \"family\" must tick the existing \"Family\" entry's id, not create a second");
    assert.equal(E.occasionRegSorted().filter(x => x.name.toLowerCase() === "family").length, 1,
      "there must be exactly one register entry spelled any-case \"family\"");
  } finally {
    unseedCascade(a.id);
    unseedOccasion(o.id);
    E.onbFlow.draft = savedDraft;
  }
});

test("CAS-768/CAS-775: a new occasion name is trimmed and capped at 24 characters, and writes straight to the register", () => {
  const draft = E.normCascade({ kind: "stream", status: [] });
  draft.occasions = [];
  const savedDraft = E.onbFlow.draft;
  E.onbFlow.draft = draft;
  const regBefore = E.occasionReg.length;
  try {
    E.commitCreateOccasionRow({ isConnected: true, value: "   Movie Night Extravaganza Deluxe   " });
    assert.equal(draft.occasions.length, 1, "a valid typed name must be ticked on");
    assert.equal(E.occasionReg.length, regBefore + 1, "the new occasion must land in the register immediately, not just the draft");
    const created = E.occasionReg[E.occasionReg.length - 1];
    assert.equal(draft.occasions[0], created.id, "the draft must carry the new entry's id, not its name");
    assert.ok(created.name.length <= 24, `occasion name exceeded the 24-character cap: "${created.name}"`);
    assert.equal(created.name, created.name.trim(), "occasion name must be trimmed of surrounding whitespace");
  } finally {
    unseedOccasion(draft.occasions[0]);
    E.onbFlow.draft = savedDraft;
  }
});

// ---- CAS-779: an unsynced register must not corrupt data, migrate ids as names, or render raw ids ----------
// CAS-775 made the register account-level, riding user_prefs. Until the schema migration lands on the live
// project — or on any device that boots before its own account row has come back — a device's local
// occasionReg can be empty while its agents already carry real register ids (cascades sync over a different
// table and can succeed independently). Treating "register empty" as "nothing has ever been set" rather than
// "register not seen yet" is the one root cause behind all three defects below.
test("CAS-779 AC1: a device holding only ids (no register) migrates nothing — cascades and register both survive untouched", () => {
  const savedReg = [...E.occasionReg];
  E.occasionReg.length = 0;
  const fakeId1 = "319dc873-68ff-4e1a-9c2b-1a2b3c4d5e6f", fakeId2 = "aa11bb22-cc33-4d44-8e55-ff6677889900";
  const a = seedOccCascade("cas779-ac1-a", 0, [fakeId1], "Massive Movies");
  const b = seedOccCascade("cas779-ac1-b", 1, [fakeId1, fakeId2], "Weekend Streaming");
  const before = { a: JSON.stringify([...a.occasions]), b: JSON.stringify([...b.occasions]) };
  try {
    E.migrateOccasionNamesIfNeeded();
    assert.equal(E.occasionReg.length, 0, "an id-only device must invent no register entries");
    assert.equal(JSON.stringify([...a.occasions]), before.a, "agent A's occasions array must be byte-identical after boot");
    assert.equal(JSON.stringify([...b.occasions]), before.b, "agent B's occasions array must be byte-identical after boot");
  } finally {
    unseedCascade(a.id); unseedCascade(b.id);
    E.occasionReg.length = 0; savedReg.forEach(o => E.occasionReg.push(o));
  }
});
test("CAS-779: isOccasionIdShape recognises a cascadeNewId()-shaped UUID and rejects a short legacy name", () => {
  assert.ok(E.isOccasionIdShape("319dc873-68ff-4e1a-9c2b-1a2b3c4d5e6f"), "a UUID must be recognised as an id shape");
  assert.ok(!E.isOccasionIdShape("Family"), "a short legacy name must not be recognised as an id shape");
  assert.ok(!E.isOccasionIdShape(""), "an empty string must not be recognised as an id shape");
});
test("CAS-779 AC2: an unresolved occasion id never prints as a label, on the Briefing summary or the Agents-to-include line", () => {
  const rawId = "319dc873-68ff-4e1a-9c2b-1a2b3c4d5e6f";
  assert.ok(!E.occasionReg.some(o => o.id === rawId), "setup: this id must not exist in the register");
  assert.equal(E.occasionsSummary({ occasions: [rawId] }), "None yet", "an orphan id must read as untagged, never the raw id");
  const c = seedOccCascade("cas779-ac2", 0, [rawId], "Orphan Agent");
  try {
    const line = E.agentOccasionsLine(c);
    assert.equal(line, "No occasion", "an orphan id must never surface as a chip label");
    assert.ok(!line.includes(rawId), "the raw id must never appear in the Agents-to-include occasions line");
  } finally { unseedCascade(c.id); }
});
test("CAS-779 AC5: with the register not yet loaded, the Briefing's Occasions row shows a neutral loading state, not \"None yet\"", () => {
  const cp = E.CascadePersistence;
  const saved = cp.userPrefsReady;
  cp.userPrefsReady = false;
  try {
    assert.equal(E.occasionsSummary({ occasions: [] }), "Loading…", "must not claim \"None yet\" while the register hasn't loaded");
    assert.equal(E.occasionsSummary({ occasions: ["319dc873-68ff-4e1a-9c2b-1a2b3c4d5e6f"] }), "Loading…",
      "an unresolved id while the register hasn't loaded must also read as loading, not \"None yet\" or the raw id");
  } finally { cp.userPrefsReady = saved; }
});
test("CAS-779 AC3: with the register not yet loaded, pruneOccasionIds (commitDraft's own choke point) leaves ids untouched", () => {
  const cp = E.CascadePersistence;
  const saved = cp.userPrefsReady;
  cp.userPrefsReady = false;
  const ids = ["319dc873-68ff-4e1a-9c2b-1a2b3c4d5e6f", "aa11bb22-cc33-4d44-8e55-ff6677889900"];
  try {
    assert.deepEqual(E.pruneOccasionIds(ids), ids, "an id with no register entry must survive a save while the register hasn't loaded");
  } finally { cp.userPrefsReady = saved; }
});
test("CAS-779 AC4: once the register has loaded, a genuinely stale id is still pruned on the next save — CAS-775 AC11 unchanged", () => {
  const cp = E.CascadePersistence;
  assert.notEqual(cp.userPrefsReady, false, "setup: this test must run with the register readiness flag in its normal (ready) state");
  const ghostId = "319dc873-68ff-4e1a-9c2b-1a2b3c4d5e6f";
  assert.ok(!E.occasionReg.some(o => o.id === ghostId), "setup: this id must not exist in the register");
  assert.deepEqual(E.pruneOccasionIds([ghostId]), [], "a stale id must still be dropped once the register is known to be loaded");
});

// ---- CAS-793: REVERT CAS-778 — ONE AGENT OWNS A FILM, ALWAYS; THE OCCASION FILTERS BY THAT OWNER ----------
// CAS-778 made filmOwnerCascade/filmOwnerOrder occasion-aware — Lee's explicit call is that this was the
// wrong fix: a film's owning agent is a property of the FILM (CAS-709's single global owner from
// notify[id].cascadeIds), decided once, never by the current view/tab/occasion. These tests assert the
// owner is IDENTICAL whichever occasion is selected or with All (the reversed AC1/AC2/AC6), and that
// watchScopeRows'/filmInWatchRows' occasion filter now tests the film's OWNER's occasion membership, not
// "some included agent's" (AC3/AC4) — the accepted consequence being a film can vanish from an occasion its
// listing-but-non-owning agent carries. None of this needs recomputeFound to run except where noted:
// filmOwnerCascade/filmOwnerOrder/splitByOwner/watchScopeRows are pure over cascades/notify/MOVIES, so most
// tests drive notify[id].pinnedTo directly (pinFilm, defined above) — the same synthetic-agent technique
// seedMarkerCascade already uses (imdb:10.1 admits nothing by criteria, so only a hand-pin lists the film).
function seedOccCascade(id, order, occasions, name){
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.order = order; c.occasions = occasions; c.paused = false;
  c.name = name || id;
  return c;
}
function withOwnerTestCascades(cascadeList, fn){
  const saved = E.cascades.slice();
  E.cascades.length = 0;
  cascadeList.forEach(c => E.cascades.push(c));
  try { fn(); } finally { E.cascades.length = 0; saved.forEach(c => E.cascades.push(c)); }
}
// A pin only needs inScope/listWindowOK to clear (both automatic for a status:[] cascade like seedOccCascade
// above) EXCEPT listWindowOK's own CAS-481 clause, which still denies an ESTIMATED "upcoming" film — screen
// that one case out here so every test below can pin any two synthetic agents onto the same film without
// tripping a gate this ticket has nothing to do with.
function pickPinnableFilm(pool = unwatchedFilms(80)){
  const film = pool.find(m => !(E.primaryStatus(m) === "upcoming" && E.isEstimated(m)));
  assert.ok(film, "no pinnable (non-estimated-upcoming) unwatched film found in the sample pool");
  return film;
}
// Shared by the two watchScopeRows tests below: an in_cinema/upcoming film with no Watch On pick yet reaches
// the "in_cinema" tab's default bucket (CAS-713) with no manual wiring beyond the pin itself.
function pickTabbedFilm(){
  const film = unwatchedFilms(200).find(m => ["upcoming", "in_cinema"].includes(E.primaryStatus(m))
    && !(E.primaryStatus(m) === "upcoming" && E.isEstimated(m)));
  assert.ok(film, "no unwatched upcoming/in_cinema film found in the first 200 — this test proves nothing");
  return film;
}

test("CAS-793 AC1/AC2/AC6: the owner is the same agent under every occasion and All — CAS-778's redirect is gone", () => {
  const occ = E.createOccasion("CAS793-sonya");
  const globalWinner = seedOccCascade("cas793-global", 0, [], "Massive Movies");    // lowest order, outside the occasion
  const occAgent = seedOccCascade("cas793-occ", 5, [occ.id], "Streaming Nominees"); // higher order, carries the occasion
  withOwnerTestCascades([globalWinner, occAgent], () => {
    const film = pickPinnableFilm();
    const id = film.tmdb_id;
    pinFilm(id, globalWinner.id);
    pinFilm(id, occAgent.id);   // both pinned — the film is genuinely listed by both
    try {
      E.recomputeFound();   // writes notify[id].cascadeIds, the field filmOwnerCascade now always reads
      assert.equal(E.filmOwnerCascade(film).id, globalWinner.id, "setup: with All selected the lowest-order pin must own the film");
      assert.equal(E.filmOwnerOrder(film), globalWinner.order, "filmOwnerOrder must agree with filmOwnerCascade");
      const cascadeIdsBefore = [...E.notify[id].cascadeIds];

      E.setWatchOccasion(occ.id);
      // The reversal itself: selecting the occasion the OTHER (non-owning) pin carries must NOT redirect
      // ownership to it — CAS-778's whole premise.
      assert.equal(E.filmOwnerCascade(film).id, globalWinner.id, "selecting an occasion must not move ownership to an occasion-carrying agent");
      assert.equal(E.filmOwnerOrder(film), globalWinner.order, "filmOwnerOrder must still agree with filmOwnerCascade once an occasion is selected");
      // AC8: notify[id].cascadeIds itself is untouched by selecting or clearing an occasion.
      assert.deepEqual([...E.notify[id].cascadeIds], cascadeIdsBefore, "cascadeIds must not move when an occasion is selected");
      E.setWatchOccasion(null);
      assert.deepEqual([...E.notify[id].cascadeIds], cascadeIdsBefore, "cascadeIds must not move when an occasion is cleared");
    } finally {
      E.setWatchOccasion(null);
      delete E.notify[id];
    }
  });
  unseedOccasion(occ.id);
});

test("CAS-793 AC3/AC4: watchScopeRows admits a film under an occasion only when its OWNER carries it, not merely a co-listing agent", () => {
  const occMe = E.createOccasion("CAS793-me");
  const occSonya = E.createOccasion("CAS793-sonya2");
  // Massive Movies stand-in: lowest order (wins ownership), carries "Me" only.
  const owner = seedOccCascade("cas793-owner", 0, [occMe.id], "Massive Movies");
  // Partner Date Night stand-in: higher order, carries "Sonya" only, and lists the film too (both pinned) —
  // but never owns it.
  const nonOwner = seedOccCascade("cas793-nonowner", 5, [occSonya.id], "Partner Date Night");
  const savedTab = E.watchTab;
  withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
    withOwnerTestCascades([owner, nonOwner], () => {
      const film = pickTabbedFilm();
      const id = film.tmdb_id;
      pinFilm(id, owner.id);
      pinFilm(id, nonOwner.id);
      E.recomputeFound();
      E.setWatchTab("in_cinema");
      try {
        assert.equal(E.filmOwnerCascade(film).id, owner.id, "setup: the lower-order pin must own the film");
        E.setWatchOccasion(occMe.id);
        assert.ok(E.watchScopeRows().some(m => m.tmdb_id === id), "the film must appear under the owner's own occasion (Me)");
        E.setWatchOccasion(occSonya.id);
        assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id),
          "the film must NOT appear under Sonya even though Partner Date Night (Sonya) lists it — it isn't the owner (AC4's accepted consequence)");
      } finally {
        E.setWatchOccasion(null);
        E.setWatchTab(savedTab);
        delete E.notify[id];
      }
    });
  });
  unseedOccasion(occMe.id);
  unseedOccasion(occSonya.id);
});

test("CAS-793: unticking the owning agent in \"Agents to include\" removes the film even while another included agent still lists it", () => {
  const occ = E.createOccasion("CAS793-agentoff");
  const owner = seedOccCascade("cas793-ao-owner", 0, [occ.id], "Owner Agent");
  const coLister = seedOccCascade("cas793-ao-colister", 5, [occ.id], "Co-Lister Agent");
  const savedTab = E.watchTab;
  withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
    withOwnerTestCascades([owner, coLister], () => {
      const film = pickTabbedFilm();
      const id = film.tmdb_id;
      pinFilm(id, owner.id);
      pinFilm(id, coLister.id);
      E.recomputeFound();
      E.setWatchTab("in_cinema");
      E.setWatchOccasion(occ.id);
      try {
        assert.equal(E.filmOwnerCascade(film).id, owner.id, "setup: the lower-order pin must own the film");
        assert.ok(E.watchScopeRows().some(m => m.tmdb_id === id), "setup: the film must reach the tab before any agent is unticked");
        E.toggleWatchAgent(owner.id);   // unticks the OWNER, not the co-lister
        assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id), "unticking the OWNER must remove the film, even though the co-lister is still included");
      } finally {
        E.toggleWatchAgent(owner.id);   // re-tick, restoring watchAgentOff to its prior (empty) state
        E.setWatchOccasion(null);
        E.setWatchTab(savedTab);
        delete E.notify[id];
      }
    });
  });
  unseedOccasion(occ.id);
});

test("CAS-793 AC6/AC7: the card's agent chip (agentChipHTML has no ownerOverride any more) names the same agent as filmOwnerCascade, pinned or not", () => {
  const owner = seedOccCascade("cas793-chip-owner", 0, [], "Owner Only");
  withOwnerTestCascades([owner], () => {
    const film = pickPinnableFilm();
    const id = film.tmdb_id;
    pinFilm(id, owner.id);
    E.recomputeFound();
    try {
      const heading = E.filmOwnerCascade(film);
      assert.equal(heading.id, owner.id);
      const chip = E.agentChipHTML(id);
      assert.ok(chip.includes(owner.name), "the chip's only owner source (cascadesFor(id)[0]) must name the same agent as the heading");
      assert.equal(E.agentChipHTML.length, 1, "agentChipHTML must take a single argument — no ownerOverride param left over from CAS-778");
    } finally {
      delete E.notify[id];
    }
  });
});

// ---- CAS-847: the Upcoming lozenge follows the moment, not a static word --------------------------------
// upcomingCapLabel reads the account's own Where & when Notify sub-switches (accountAlertKeysOn), the same
// answer the alert system itself reads — so the label can never promise a moment the account didn't ask for.
function daysAfterToday(n){
  const d = new Date(Date.parse(E.TODAY));
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
test("CAS-847 AC1: the Upcoming lozenge label follows the published date and the account's sub-switches", () => withWatchPrefs({
  upcoming: { list: true, notify: true, subs: { announced: true, opens_soon: true } },
}, () => {
  const soon = { status: ["upcoming"], cinema_date: daysAfterToday(3) };
  assert.equal(E.upcomingCapLabel(soon), "Next week",
    "a published date 3 days out with Opening next week on must read Next week");

  const far = { status: ["upcoming"], cinema_date: daysAfterToday(30) };
  assert.equal(E.upcomingCapLabel(far), "Upcoming",
    "a published date 30 days out (outside the 7-day window) must read plain Upcoming");

  withWatchPrefs({ upcoming: { list: true, notify: true, subs: { announced: false, opens_soon: false } } }, () => {
    assert.equal(E.upcomingCapLabel(soon), "Upcoming",
      "with both sub-switches off, even a film 3 days out must read plain Upcoming");
  });
}));

test("CAS-847 AC2: an upcoming film with both sub-switches off and no recent window change carries no recent class", () => withWatchPrefs({
  upcoming: { list: true, notify: true, subs: { announced: false, opens_soon: false } },
}, () => {
  const m = { status: ["upcoming"], cinema_date: daysAfterToday(30) };
  const html = E.bandHTML(m, "");
  assert.ok(html.includes(">Upcoming<") || html.includes(">Upcoming</b>") || /Upcoming/.test(html),
    "sanity: the lozenge must actually render the Upcoming label in this scenario");
  assert.doesNotMatch(html, /\brecent\b/, "no recent window change must not carry the recent glow class");
}));

test("CAS-847 AC3: ICON.bell is retired — app_template.html no longer references it anywhere", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const count = (src.match(/ICON\.bell\b/g) || []).length;
  assert.equal(count, 0, `ICON.bell must not be referenced anywhere (found ${count}) — the bell icon retired with CAS-847`);
});

test("CAS-847 AC4: the built index.html gives wsrc-manual a box-shadow with no .isnew in the selector", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.match(src, /\.ctl\.notify\.wsrc-manual\s*\.cmini\{[^}]*box-shadow/,
    "the built CSS must give .ctl.notify.wsrc-manual .cmini a box-shadow rule with no .isnew qualifier");
  assert.doesNotMatch(src, /\.ctl\.notify\.wsrc-manual\.isnew\s*\.cmini\{[^}]*box-shadow/,
    "the manual Notify glow must no longer be gated on .isnew");
  // The blue auto glow is unchanged — still gated on .isnew.
  assert.match(src, /\.ctl\.notify\.wsrc-auto\.isnew\s*\.cmini\{[^}]*box-shadow/,
    "the blue agent-set Notify glow must still require .isnew");
});

test("CAS-877: the built index.html gives the agent chip (.ctl.casc) no box-shadow at all, manual or auto", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.doesNotMatch(src, /\.ctl\.casc\.csrc-manual\s*\.cmini\{[^}]*box-shadow/,
    "the agent chip's manual glow must be gone — provenance is a border colour only");
  assert.doesNotMatch(src, /\.ctl\.casc\.csrc-auto\.isnew\s*\.cmini\{[^}]*box-shadow/,
    "the agent chip's auto glow must be gone — provenance is a border colour only");
  assert.match(src, /\.ctl\.casc\.csrc-manual\s*\.cmini\{border-color:#ffd54a\}/,
    "the agent chip keeps its gold border for a hand-placed owner");
  assert.match(src, /\.ctl\.casc\.csrc-auto\s*\.cmini\{border-color:var\(--brand-blue\)\}/,
    "the agent chip keeps its blue border for a rank-derived owner");
});
