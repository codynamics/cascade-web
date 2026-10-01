// CAS-231: load the SHIPPED engine, in Node, with no browser.
//
// The engine is not a module — it is the one big classic <script> inside index.html, and it is deliberately so
// (the app is one file you can open from disk). That leaves two ways to unit-test it: extract the engine into
// its own file and change what ships, or evaluate the shipped script as-is against a stand-in DOM. This is the
// second, because the first would mean the tests exercise a copy of the engine rather than the engine.
//
// What makes it work: nothing in the engine's DECISIONS touches the DOM. matchesCriteria, watchCount,
// starterPreview, axisCountsNow and the rest are arithmetic over MOVIES. The DOM appears only in the paint and
// wire code that runs alongside them, and that code does not care whether its writes land anywhere — so a
// permissive stub absorbs it and the arithmetic is the real arithmetic, against the real catalogue that the
// build inlined. If the engine ever starts reading a measurement back and deciding on it, this harness will
// notice: the stub answers 0 for every number, so a decision that depends on layout will visibly change.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every stub node: reads give another stub, calls give another stub, writes are swallowed, and any coercion
// gives 0 or "" instead of throwing.
const node = () => new Proxy(function(){}, {
  get(t, k){
    if(k === "length") return 0;
    if(k === "children") return [];
    if(k === Symbol.iterator) return [][Symbol.iterator].bind([]);
    if(k === Symbol.toPrimitive) return hint => (hint === "string" ? "" : 0);
    if(k === "toString") return () => "";
    if(k === "valueOf") return () => 0;
    if(k === "textContent" || k === "innerHTML" || k === "value" || k === "className") return "";
    if(k === "then") return undefined;                    // must never look like a promise
    return node();
  },
  set(){ return true; },
  apply(){ return node(); },
  has(){ return true; },
  deleteProperty(){ return true; },
});

// CAS-969: localStorageStore lets a test share one backing Map across two loadEngine() calls, simulating
// a page reload (a fresh JS realm, the same on-device storage) — needed to assert "asked at most once per
// version" actually survives a reload, not just a second call within the same load. Optional and unused
// by every existing test, which keeps getting its own private Map exactly as before.
function makeContext(localStorageStore){
  const doc = new Proxy({}, {
    get(t, k){
      if(k === "querySelectorAll" || k === "getElementsByClassName" || k === "getElementsByTagName") return () => [];
      return node();
    },
    set(){ return true; },
  });
  const store = localStorageStore || new Map();
  const sessionStore = new Map();
  const ctx = {
    document: doc,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
      clear: () => store.clear(),
      get length(){ return store.size; },
      key: i => [...store.keys()][i] ?? null,
    },
    // CAS-553: the diagnostics panel's `?diag` handling reads/writes sessionStorage at the top level of
    // the engine script (same reasoning as `performance` below, CAS-460) — not browser-only, in reach here.
    sessionStorage: {
      getItem: k => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => { sessionStore.set(k, String(v)); },
      removeItem: k => { sessionStore.delete(k); },
      clear: () => sessionStore.clear(),
      get length(){ return sessionStore.size; },
      key: i => [...sessionStore.keys()][i] ?? null,
    },
    // Quiet: the engine logs its own analytics line on load, and a test run is not the place for it.
    console: { log(){}, warn(){}, error(){}, info(){}, debug(){} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    navigator: { userAgent: "node", language: "en-AU", vibrate(){}, onLine: true },
    // CAS-787: diagReport() (the on-device diagnostics panel) reads screen.orientation for its geometry
    // section — not needed by any decision under test before now, so nothing stubbed it.
    screen: { orientation: { type: "portrait-primary" } },
    location: { href: "http://localhost/", search: "", hash: "", pathname: "/", origin: "http://localhost" },
    history: { replaceState(){}, pushState(){} },
    matchMedia: () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){} }),
    getComputedStyle: () => node(),
    CSS: { escape: s => String(s) },
    URLSearchParams, URL, TextEncoder, TextDecoder, structuredClone, crypto,
    CustomEvent: class { constructor(type, opts){ this.type = type; Object.assign(this, opts || {}); } },
    Event: class { constructor(type){ this.type = type; } },
    MutationObserver: class { observe(){} disconnect(){} takeRecords(){ return []; } },
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    ResizeObserver: class { observe(){} unobserve(){} disconnect(){} },
    Image: class { set src(v){} },
    performance,
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
    fetch: () => Promise.reject(new Error("the engine must not need the network")),
    // CAS-782: deleteAgentAsk's own dialog — a test driving the real delete path needs it to always proceed,
    // the same way alert()/scrollTo() below are stubbed rather than left to throw as "not a function".
    alert(){}, confirm(){ return true; }, scrollTo(){}, scrollBy(){}, open(){ return null; },
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2, scrollY: 0,
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx; ctx.top = ctx;
  return ctx;
}

// The engine's top-level `const`/`let` are lexical, exactly as in a browser, so they are not properties of the
// global. Appending the export block INSIDE the same script is what puts them in reach — the same scope the
// engine's own code reads them from, so a test can never accidentally be handed a copy.
// Mutable bindings (flowKind, onbFlow's fields) are exposed through getters so a test always sees live state.
const EXPORTS = `
// CAS-667: window.CascadeAuth is normally set up by the auth module script (a separate <script type="module">
// this harness deliberately does not load, per the file-level comment above — the engine itself never needs
// it directly, only through window.CascadePersistence.accountActive()). Seed the same shape that module sets
// on a guest device so accountActive() has something real to read, and a test can flip it to simulate sign-in.
if(typeof window.CascadeAuth === "undefined"){
  window.CascadeAuth = { enabled:false, client:null, user:null, session:null, status:"guest" };
}
;globalThis.__ENGINE__ = {
  MOVIES, CASCADE, STATUS_LABEL, SHOWABLE_N,
  // CAS-771: filmByMovieId is the exact lookup the bell (realAlertsHTML) and Moving (movingData) use to
  // resolve a stored movie_id string to its catalogue record — exported so the tmdb_id guardrail test can
  // drive the real comparison rather than re-implementing it.
  filmByMovieId: mid => MOVIES.find(x => String(x.tmdb_id) === String(mid)),
  matchesCriteria, countCriteria, watchCount, watchesFilm, matchesTaste, listedBy, listWindowOK,
  listedCount, onbShownCount,
  // CAS-780: awardsListOK is listedBy's own extra Awards check (no pre-release exemption, unlike
  // matchesCriteria's) — exported so a test can name it directly as the reason a followed pre-release film
  // misses its listing, rather than re-deriving the same rank comparison inline.
  awardsListOK,
  // CAS-723: inScope is the predicate the "one agent type" invariant is actually about — exported so a test
  // can assert it directly rather than re-deriving it from watchesFilm's combination with matchesTaste.
  inScope,
  // CAS-863: inFindScope/scope are the Find-scope predicates the (now-removed) list editor's own
  // ymFeedList/ymAgentListCount/scopeRows used to sit alongside — those went with the rest of the
  // retired watch-list model; the live Watch screen reads watchScopeRows (exported below) instead.
  inFindScope, scope,
  // CAS-682: taggedOut — the predicate that decides card vs. stub — so a test can assert a stub is really
  // a stub, rather than assuming a watched film demonstrates it.
  // CAS-718: opinionOf alongside it — the verdict key a taggedOut film carries, which watchWatchedSel below
  // is keyed by.
  taggedOut, opinionOf,
  // CAS-718: the Filters sheet's own per-tab state (watchTab/watchWatchedSel/watchGenreOff/watchSearch) and
  // the predicate render() filters through (filmMatchesWatchedFilter) — exported the same way watchGenreOff
  // et al. would be, so a test can drive a tab's Watched/Styles selection directly rather than only through
  // DOM clicks the stub absorbs.
  // CAS-750: raw setter (unlike window.setWatchTab, it never calls render()/jumpToSection — those are wire
  // code the stub absorbs anyway) so a test can drive listingGroups' tab-based order directly.
  get watchTab(){ return watchTab; },
  setWatchTab(v){ watchTab = v; },
  watchWatchedSel, watchGenreOff, watchSearch, filmMatchesWatchedFilter, filmMatchesWatchTab,
  // CAS-793: watchAgentOff (CAS-720's own per-tab "Agents to include" state, by reference like watchGenreOff
  // above) and toggleWatchAgent (its wire mutator, wrapped like toggleFilmOpt below) — so a test can drive a
  // real untick through the real function and assert watchScopeRows' owner-based occasion filter honours it.
  watchAgentOff, toggleWatchAgent: (id) => window.toggleWatchAgent(id),
  // CAS-863: WATCH_STEPS is the watched-verdict ramp the Watch On panel renders — unrelated to the retired
  // watch-list model despite once sitting next to it. YM_SVC/ymSvcOn/ymSvcToggle/ymSvcSetAll/ymWatchedOn/
  // leInnerHTML/leComputeCounts all went with that model.
  WATCH_STEPS,
  normCascade, showable, primaryStatus, inCinemaWindow, isEstimated, deriveStatus, isUpcoming,
  // CAS-608: exported so a fixture-based test can assert this agrees with poc_pipeline.py's
  // _offerless_window directly, rather than only indirectly through deriveStatus.
  offerlessWindow,
  // CAS-255: the my-services scope and the stage dates are both places the app makes a claim about what you
  // can watch and when, so the QA gate needs to reach them the same way the listing does.
  prefs, servicesPicked, matchesServices, scopeOf, anyScope, HOME_KEYS,
  // CAS-1095: onChipToggle is the real wire chokepoint a ⚙️ service-chip tap goes through — exported so a
  // test can drive an actual service toggle through the real function and assert the acctOp update it
  // issues, rather than poking prefs.sub by hand.
  onChipToggle,
  // CAS-1053 AC4: watchMineOnlyOn (the "Show only available on my services" per-tab switch) and
  // watchMineOnlyEmptyKind (the pure loading-vs-dead-end decision behind the Watch list's mineOnly empty
  // state) — exported so a test can assert the loading state wins while user_prefs hasn't loaded, without
  // parsing the rendered HTML the DOM stub swallows.
  watchMineOnlyOn, watchMineOnlyEmptyKind,
  svcCanon, svcName, SVC_LEAD, myService,
  // CAS-1124: serviceAdvice/svcAdviceFilms are the Service analysis screen's own arithmetic (headline
  // total/coverage, "worth adding" ranking) — exported so a test can drive them against a controlled
  // population rather than the DOM they normally render into.
  serviceAdvice, svcAdviceFilms,
  SUB_SERVICES, STORE_SERVICES, stageDate, curSlot, cinemaState, EST_OFFSET, TODAY,
  inCinemaRun, CINEMA_RUN_DAYS, LISTING_ORDER, orderFor, listingOrder,
  // CAS-702: the one default-sort constant, and the raw comparator dispatch, so a test can assert the
  // rendered order against an independently-run comparator rather than re-deriving sortForKey's branches.
  DEFAULT_SORT, sortForKey,
  fmtDay, fmtDate, bandHTML, windowsLineHTML, savingsHTML,
  // CAS-1119: cardTopHTML is the expanded card's whole "about this film" block (poster..director/cast),
  // shared verbatim with filmPageHTML (the invite/share-link page) — exported together so a test can assert
  // the invite page's rendered top literally contains the same cardTopHTML(m) output, not a re-derived copy.
  cardTopHTML, filmPageHTML,
  inferredScale, inferScaleWhy, budgetCell, moneyRowHTML, SCALE_INFER_MIN_PEERS, popOf, scaleTier,
  // CAS-742: the two catalogue-derived compute-once caches, exposed by reference (Map, never reassigned) so
  // a test can assert their .size directly, plus the one function that clears both — the real invalidation
  // point wired into the catalogue swap.
  _scaleInferCache, _awardRankCache, invalidateComputeCaches,
  agentWindow, winOn, subOn, winSubs, ALERT_SHORT, ALERT_MOMENT,
  alertLive, reachableRows, liveAlerts, drawWatchLanes,
  // CAS-847: accountAlertKeysOn is the account-wide Notify answer the Upcoming lozenge now reads (via
  // upcomingCapLabel) instead of always saying "Upcoming" — exported alongside it so a test can drive the
  // sub-switches directly rather than only asserting the label they produce.
  accountAlertKeysOn, upcomingCapLabel,
  selScaleMatch, voteReadout, critScoreReadout, scaleReadout,
  // CAS-920: critScore (the one recorded critics figure, now Watchmode's wm_critic_score) so a test can
  // assert it independently rather than re-deriving it from wmQScore's output alone.
  critScore, sortMoviesBy, ratingOf,
  // CAS-695: the Cascade score's own basis switch (cascadeScore/cascadeScoreSourcesText, dispatching on
  // isPreRelease) and the buzz-percentile accessor it used to dispatch to before CAS-919 — exported
  // independently so a test can assert each stage rather than only the combined qScoreHTML output.
  // CAS-722 retired budgetPctlOf itself (budget left the score); CINEMA_BUDGET_VALS/CINEMA_BUDGET_MIN
  // survive — CAS-724's legacyMissionFloorDefault still reads them for a cinema agent's one-time
  // scoreFloor migration.
  cascadeScore, cascadeScoreSourcesText, isPreRelease, buzzPctlOf, pctRankOf,
  // CAS-919: wmQScoreSourcesText is wmQScore's own text, exported so a test can assert the blended
  // cascadeScoreSourcesText's Watchmode half directly.
  wmQScoreSourcesText,
  // CAS-919: wmQScore/wmCascadeScore are cascadeScore's own Watchmode basis, exported the same way so a
  // test can assert each stage directly rather than only the rendered row. WM_SCALE/wmScaled are the
  // frozen piecewise-linear map wmQScore runs its raw mean through, and scoresRowHTML is the card's own
  // People/Critics render — all exported so a test can assert each directly rather than only the rendered
  // card.
  wmQScore, wmCascadeScore, WM_SCALE, wmScaled, scoresRowHTML,
  // CAS-907: the Watchmode-sourced mirror of the buzz chain (WM_BUZZ_POP_VALS/wmBuzzPctlOf/wmReleasedScoreVals/
  // wmCinemaScore) that wmCascadeScore's pre-release/blended branches call — exported independently so a
  // test can assert each stage rather than only wmCascadeScore's combined output.
  WM_BUZZ_POP_VALS, wmBuzzPctlOf, wmReleasedScoreVals, wmCinemaScore,
  BUZZ_POP_VALS, CINEMA_BUDGET_VALS, CINEMA_BUDGET_MIN,
  // CAS-703: the Target score hard gate's own held-back count, so a test can assert it against the set it
  // claims to describe without re-deriving it from stepCountLine's HTML output.
  scoreHeldBackCount,
  // CAS-686: the per-film predicate that decides which condensed-card stats row shows (r-scores vs
  // r-cinfo), so a test can assert the row choice directly rather than re-deriving the three-source rule.
  condensedShowsScores,
  SCALE_REF, BUZZ_STOPS, VOTE_REF, CRIT_MARKS, AWARD_STOPS, awardRank, parseAwards,
  // CAS-678: the one popularity ladder — its cohort gate, its cuts, the per-film stop it computes, and
  // Landmark's own (unchanged) predicate, so a test can assert the badge/dial/cohort/Landmark relationships
  // directly rather than re-deriving them from scaleTier() alone.
  isLandmark, inLadderCohort, buzzStop, buzzBandOf, BUZZ_CUTS, BUZZ_PCTL, BUZZ_KEY,
  AGE_LEVELS, ONB_GENRES, LANG_OPTS, GENRE_COUNT,
  YEARS_STOPS, YEARS_STOP_POS, yearsForPos, posForYears, yearsCutoff, releasedSince,
  yearsFromLegacy, yearsLabel, yearsReadout, flowYearsBack, baseYearsBack, yearOf,
  MIN_INITIAL_MATCHES, autoRelaxBar, barDialSnapshot,
  STARTERS, starterPreview, starterCount, starterAgentName, starterWatch, RECOMMENDED_FOR,
  AGENT_WINDOWS, agentWindows, watchToStatuses, listToStatuses, migrateWatch,
  MISSION_DIALS, MISSION_DIALS_USED, missionRest, missionKind, laneCrit,
  axisCountsNow, genreCountsNow,
  onbApply, onbCount, pickStarter, flowStart, flowStop, FLOWS,
  // CAS-1080: the v2 onboarding answers default and its four-agent generator, plus the shared
  // reveal-time cap they solve against — exported so a test can build a real onboarding roster
  // from a fixed answer set and assert watchCount() against the cap directly.
  onbAnswersV2Default, buildOnbAgentsV2, ONB_AGENT_CAP_V2,
  // CAS-1099: membCompleteNewMembership is the one complete_membership() RPC chokepoint a brand-new,
  // signed-out signup drives — exported so a test can call it directly against a stubbed CascadeAuth.client,
  // the same convention CascadePersistence's own write seams use. membNeedsEmail/membStart/membStartWork are
  // window-assigned (or plain) wire code alongside it; onbDraftModeOn is reassigned wholesale by flowStart/
  // flowStop/membCompleteNewMembership, so it's exposed through a getter/setter like flowKind elsewhere here.
  membCompleteNewMembership, membNeedsEmail,
  get onbDraftModeOn(){ return onbDraftModeOn; },
  setOnbDraftModeOn(v){ onbDraftModeOn=!!v; },
  get onbMembershipInFlight(){ return onbMembershipInFlight; },
  // CAS-1099: tasteBase is reassigned wholesale in more places than loadUserPrefs/maybeSwitchAcctSuffix now
  // (flowStart()'s own leftover-@guest-draft reset) — exposed through a getter, like watchPrefs/notifyPrefs
  // below, so a test sees the CURRENT binding even across a reassignment, not a snapshot frozen at load time.
  get tasteBase(){ return tasteBase; },
  cascades,
  get onbFlow(){ return onbFlow; },
  get flowKind(){ return flowKind; },
  setFlowKind(k){ flowKind = k; },
  // CAS-863: activeIds is what the live listing (watchScopeRows) and the empty state (emptyResultsHTML)
  // both read — seeded straight from the agents themselves now that the watch-list model (and the list
  // editor's own ymCascOff/ymCascToggle/leOpen scratch state) is retired.
  emptyResultsHTML,
  get activeIds(){ return activeIds; },
  // CAS-667: movingData is wire-adjacent (it reads window.CascadePersistence.accountActive()) but its
  // row-selection arithmetic is exactly the kind of decision this harness exists to test. realAlerts and
  // firstFound are exposed by reference (mutated via push, never reassigned, in test use) so a test can seed
  // the ledger; CascadeAuth is exposed the same way so a test can flip a device between guest and signed-in
  // by setting .enabled/.client/.session, exactly as the real sign-in path does.
  movingData, realAlerts, firstFound, watched,
  // CAS-742: isNewFound is the decision this ticket moved onto the account (admittedAtFor, read off
  // agent_films.admitted_at) rather than the device-local firstFound stamp above — exported so a test can
  // assert the derived answer directly instead of re-deriving daysSince/admittedAtFor by hand.
  isNewFound, admittedAtFor,
  // CAS-783: NEW_DAYS (already used above by isNewFound) and FIRST_FOUND_PRUNE_DAYS (the date-based bound
  // that replaced the old on-exit-from-found delete) — exported so a test can pick dates relative to the
  // real horizon rather than hard-coding a day count that could silently drift from the engine's own.
  NEW_DAYS, FIRST_FOUND_PRUNE_DAYS,
  // CAS-846: isRecent is the "recent window" decision the status pill glow reads — exported so a test can
  // assert its NEW_DAYS boundary directly instead of re-deriving daysSince/primaryStatus by hand.
  isRecent,
  // CAS-738: the other five watched-film verdict sets, exposed by reference like watched above —
  // a test needs to seed/restore all of them to exercise filmRows()/applyFilmRows() without leaking
  // state into later tests, since applyFilmRows() rebuilds every one of them from scratch.
  disliked, indifferent, blocked, wowed, enjoyed,
  get movingReady(){ return movingReady; },
  setMovingReady(v){ movingReady = v; },
  get CascadeAuth(){ return window.CascadeAuth; },
  // CAS-670: movingData/renderMovingScreen's guest branch now keys off localStorage's cascade_had_account,
  // not accountActive() — exposing the stub localStorage (already the engine's own global) lets a test drive
  // that key directly instead of only being able to flip the (now branch-irrelevant) CascadeAuth fields.
  localStorage,
  // CAS-1119: the stub global itself (window === globalThis in this sandbox, same object as ctx in
  // makeContext) — exposed the same way localStorage is above, so a test can stub window.open and assert a
  // CTA like filmPageCta actually called it, rather than only checking it didn't throw.
  window,
  // CAS-1119: filmPageCta is the invite/film page's one action — exported directly (it's window.filmPageCta,
  // a plain global function) so a test can call it and assert the window.open it makes.
  filmPageCta: (...args) => window.filmPageCta(...args),
  // CAS-668: the badge/list agreement — movingWindowRows is the one recipe both renderMovingScreen and
  // movingUnseenCount filter through, movingBadgeWindow is which window applies right now (live if Moving
  // is open, predicted — always "2weeks", CAS-848 — if it's not), and openMovingScreen/closeMovingScreen/
  // setMovingWindow are the real wire code (DOM reads/writes absorbed by the stub, exactly like the rest of
  // this file's wire calls).
  movingWindowRows, movingUnseenCount, movingBadgeWindow, movingInWindow,
  // CAS-848: movingLanes is the pure per-agent grouping/ranking step renderMovingScreen paints from — a
  // test can assert lane order/membership without parsing the rendered HTML.
  // CAS-852: movingWindowRank is the per-row ladder position movingLanes now sorts by ahead of newest-
  // first, and movingLedgerTruncated is the 200-row-cap predicate behind the (DOM-only) truncation notice —
  // both exported so a test can assert them directly.
  movingLanes, movingWindowRank, movingLedgerTruncated,
  // CAS-869: movingSections is the MAJOR (status) grouping layer above movingLanes — one section per
  // LISTING_ORDER status holding that status's own lanes — exported so a test can assert section order/
  // membership/emptiness without parsing renderMovingScreen's HTML.
  movingSections,
  MOVING_WINDOWS, movingSeen,
  // CAS-858: MOVING_EMPTY_NO_OWNER_COPY is the empty-state copy shown when a window's entries were all
  // dropped for having no owning agent, and movingEmptyCopy is the pure decision between it and the
  // generic MOVING_EMPTY_COPY — both exported so a test can assert the choice directly instead of
  // parsing renderMovingScreen's DOM-only write.
  MOVING_EMPTY_NO_OWNER_COPY, MOVING_EMPTY_COPY, movingEmptyCopy,
  // CAS-670 AC2/AC4: renderMovingScreen is wire code (its DOM write is absorbed by the stub) but its early
  // return on the loading-state guard is a real decision — whether it marks any row seen — so a test needs
  // to call the real function rather than re-deriving the guard.
  renderMovingScreen: () => window.renderMovingScreen(),
  get movingWindow(){ return movingWindow; },
  get movingIsOpen(){ return movingIsOpen; },
  openMovingScreen: () => window.openMovingScreen(),
  closeMovingScreen: () => window.closeMovingScreen(),
  setMovingWindow: (key) => window.setMovingWindow(key),
  // CAS-662: the listing's own group partition — pure over a rows set and an active agent, no DOM, so it is
  // exactly the "decision" half of render() this harness exists to test independent of the paint half.
  listingGroups,
  // CAS-793: filmOwnerCascade/filmOwnerOrder/splitByOwner/watchScopeRows are all pure over cascades/notify/
  // MOVIES, exactly like listingGroups above — exported so a test can drive the single CAS-709 global-owner
  // lookup and the occasion pool test directly rather than scraping rendered headings. agentChipHTML is the
  // one DOM-free render helper worth exporting here too, so a test can assert the chip's own name/HTML.
  filmOwnerCascade, filmOwnerOrder, splitByOwner, watchScopeRows, agentChipHTML,
  // CAS-819: listingGroups reads sortPicked (the Watch bar's own #sort control) — exposed through a
  // get/set-over-a-let shape so a test can drive it the way #sort's own onchange does. ymSort itself
  // (Your Movies' own sort control) went with the rest of the retired watch-list model in CAS-863.
  get sortPicked(){ return sortPicked; },
  setSortPicked(v){ sortPicked = v; },
  // CAS-613: auto-notify's own decision surface. recomputeFound is the wire-adjacent entry point (it reads
  // cascades/MOVIES and writes notify), exposed the same way movingData is above; notify/entryFor let a test
  // seed and read the per-film arming state directly; watchPrefs is exposed through a getter/setter (like
  // flowKind) because the engine REASSIGNS the binding wholesale on load/sync, not just its contents.
  recomputeFound, notify, entryFor, watchLevelsFor, WATCH_LEVEL_KEYS,
  // CAS-741: notifyPrefs (reassigned wholesale on load, so exposed through a getter like watchPrefs/flowKind
  // below) — so a test can seed/read the exact state the notify_prefs load-gate operates over.
  get notifyPrefs(){ return notifyPrefs; },
  // CAS-731: placementSplitHTML (the Mission mirror's placement split) and filmNotifyState (the Watch On
  // value it now counts by) — exported so a test can assert the parts sum to the headline directly, rather
  // than scraping the rendered string.
  placementSplitHTML, filmNotifyState, windowUsable,
  // CAS-1081: windowArmed (a marker above 100 reads as Never, display-only — windowUsable itself, and
  // therefore admission, is untouched) and agentCascadeSumHTML (the SCORE row it feeds — shared by the
  // onboarding reveal/done step, the agent editor and the Agents list) — exported so a test can assert
  // the rendered row directly rather than re-deriving the >100 case by hand.
  windowArmed, agentCascadeSumHTML,
  // CAS-728: cascSigOf/agentFloor are what recomputeFound's own sticky-admission re-evaluation reads to
  // decide whether an agent has changed and what its current floor is — exported so a test can compute the
  // exact signature/floor a seeded agent_films row should carry, rather than guessing at internal state.
  cascSigOf, agentFloor,
  // CAS-1097: earnedWindowForScore/autoPlacementFor/autoPlacementForAdmission are recomputeFound's own
  // Watch-On placement arithmetic, extracted into standalone pure functions so the monitor's
  // placement_shim.mjs can ask the exact same question (a frozen admission_score -> the window it earns,
  // carried forward to the film's current standing) through this same harness, rather than a second,
  // hand-ported copy — the CAS-825 lesson applied to placement, not just admission.
  earnedWindowForScore, autoPlacementFor, autoPlacementForAdmission,
  // CAS-1113: setAgentScore is the one real mutator a user-driven score edit goes through now (it also
  // clears the *Defaulted provenance flag normCascade's own guess sets) — exported so a test can drive a
  // genuine edit through the real function rather than poking c.watchMarkers by hand. Replaces the retired
  // per-window setWatchMarker.
  setAgentScore,
  // CAS-726: filmWatchSource is the provenance read the round-trip test asserts against directly;
  // toggleFilmOpt is wire code (window-assigned, like ymCascToggle above) — a test drives a manual
  // tick through the real function rather than poking notify[id].wins by hand.
  filmWatchSource,
  toggleFilmOpt: (id, key) => window.toggleFilmOpt(id, key),
  // CAS-788: setOpinion is wire code too (window-assigned, same pattern as toggleFilmOpt above) — a
  // test drives a real Watched/"not for me" verdict through it rather than poking watched/blocked by hand.
  setOpinion: (id, kind) => window.setOpinion(id, kind),
  get watchPrefs(){ return watchPrefs; },
  setWatchPrefs(w){ watchPrefs = w; },
  watchPrefsDefaults,
  // CAS-602: the bell's own moment-copy lookup, so a test can assert a monitor moment key can never
  // render as its raw string (see REAL_MOMENT_SAID's own use at the ntfrow render site).
  REAL_MOMENT_SAID,
  // CAS-674: the Agents row's own metrics compute, so a test can check its "total" agrees with the
  // listing (listedCount) rather than the wider watch-ahead set (watchesFilm) it used to read.
  agentMetricsCompute,
  // CAS-681: the account-persistence seam (load/sync/reconcile for cascades/films/lists/watchlists/etc,
  // CAS-212's pendingMerge, CAS-408's reconcile family) lives on window.CascadePersistence, assigned once
  // at the bottom of the account-sync IIFE — a live reference, so a test can stub CascadeAuth.client with
  // a fake Supabase and call e.g. CascadePersistence.loadWatchlistAccount() directly.
  get CascadePersistence(){ return window.CascadePersistence; },
  // CAS-1094: the server-first account store core (acctLoad/acctOp and the persisted op queue) lives on
  // window.CascadeAccountStore, assigned once at the bottom of its own IIFE — the same live-reference
  // reasoning as CascadePersistence above, so a test can stub CascadeAuth.client with a fake Supabase and
  // call acctOp/acctLoad directly.
  get CascadeAccountStore(){ return window.CascadeAccountStore; },
  // CAS-843: momentsOf (alert_moments derivation, now off the account's own Where & when Notify switches
  // rather than a per-agent field) lives on window.CascadeShape, the same live-reference reasoning as
  // CascadePersistence above.
  get CascadeShape(){ return window.CascadeShape; },
  // CAS-715: filmIsNew is the Watch On chip's combined "isnew" rule (isNewFound AND admitDrift — "the world
  // moved, not the agent"); admitDrift is exposed by reference (mutated via property assignment inside
  // recomputeFound, never reassigned) so a test can seed/read it the same way firstFound above is. filt/
  // passes/RELAXERS are the Find screen's own filter registry — the "New" filter this ticket adds rides the
  // same seam the existing "recent" filter does, so a test can assert it's registered there directly.
  filmIsNew, admitDrift, filt, passes, RELAXERS, filtSnapshot, filtRestore,
  // CAS-764: the stub navigator, by reference — so a test can flip .onLine the same way a real device
  // going offline would, and assert the acct banner (which reads navigator.onLine directly) responds.
  navigator,
  // CAS-768: dedupeCascades/cascDedupeSigOf are plain top-level functions, exported directly like cascSigOf
  // above.
  dedupeCascades, cascDedupeSigOf,
  // CAS-782: deleteAgentAsk is the one real delete path (confirm() dialog stubbed above to always proceed),
  // so a test can drive an actual agent deletion — including the release of any pinnedTo/notIn it held —
  // rather than re-deriving the removal by hand. pinFilmToCascadeAndRepaint is window-assigned wire code
  // (wrapped the same way toggleFilmOpt above is) so a test can drive a real hand-placement the same way a
  // person tapping a Watch panel row does.
  deleteAgentAsk, pinFilmToCascadeAndRepaint: (id, cid) => window.pinFilmToCascadeAndRepaint(id, cid),
  // CAS-775: the Occasions register replaces CAS-768's derived-from-agents allOccasionNames — occasionReg
  // is exported by reference (mutated in place by create/rename/delete, never reassigned) so a test can
  // seed/read the exact register state. create/rename/delete/
  // occasionAgentCount/occasionName/occasionRegSorted are plain top-level functions, exported directly.
  // migrateOccasionNamesIfNeeded is exposed so a test can call the real one-time upgrade rather than
  // re-deriving its legacy-name detection by hand. briefToggleOccasion/commitCreateOccasionRow are
  // window-assigned Briefing wire code (same wrap shape as ymSvcToggle above) — both now operate on ids,
  // not names.
  occasionReg, createOccasion, renameOccasion, deleteOccasion, occasionAgentCount, occasionName,
  occasionRegSorted, occasionsSummary, migrateOccasionNamesIfNeeded, pruneOccasionIds,
  // CAS-779: isOccasionIdShape is the UUID-shape test the migration now runs before treating a string as a
  // legacy name — exported so a test can assert the shape check directly. agentOccasionsLine is the Watch
  // "Agents to include" row's own occasion line (CAS-777) — a test can assert AC2 (never an unresolved id)
  // against the real render helper rather than re-deriving occasionName's filter by hand.
  isOccasionIdShape, agentOccasionsLine,
  get watchOccasion(){ return watchOccasion; },
  setWatchOccasion: id => window.setWatchOccasion(id),
  briefToggleOccasion: id => window.briefToggleOccasion(id),
  commitCreateOccasionRow: inputEl => window.commitCreateOccasionRow(inputEl),
  // CAS-787: the on-device diagnostics panel's own pure report builders (diagReport/diagReportText) and the
  // per-target status-label helper (diagSyncStatusText) — plain top-level functions, exported directly so a
  // test can assert the panel/copy-button text without a real DOM or the 5-tap gesture.
  diagReport, diagReportText, diagSyncStatusText,
  // CAS-789: rounding out the agent-behaviour suite's export surface — windowEnabled (the watchPrefs
  // Where-and-when gate), msnTrackAreaHTML/msnValueLine (the Cascade score track's own render helpers)
  // and notifyChipHTML (the Watch On chip's own render, alongside agentChipHTML above) — plain top-level
  // functions, exported directly like the rest of this file.
  windowEnabled, msnTrackAreaHTML, msnValueLine, notifyChipHTML,
  // CAS-1128: windowFollowed (now a plain "enabled AND ON" predicate, the CAS-917 start-window-forward
  // model retired) and msnPillsHTML (the independent per-window "Track in" pill row that replaces the
  // retired start/follow chip row, msnChipsHTML) — exported so a test can assert both the placement
  // decision and its render surfaces directly.
  windowFollowed, msnPillsHTML,
  // CAS-1128: msnOnWindows is the shared "which windows is this agent actually tracking" decision
  // msnValueLine/msnPillsHTML/msnTrackAreaHTML all read — exported so a test can assert it directly.
  // toggleAgentWindow is the pill-tap mutator, alongside setAgentScore (the drag mutator) above. msnLastScore
  // (a single remembered value) is reassigned by both, so it's exposed through a getter/setter like
  // flowKind/watchTab elsewhere in this file.
  msnOnWindows, toggleAgentWindow,
  get msnLastScore(){ return msnLastScore; },
  setMsnLastScore(v){ msnLastScore=v; },
  // CAS-790/791: found — the live membership Set recomputeFound rebuilds every pass, by reference like
  // watched/blocked above — needed for the A-F and G/I checks' direct membership assertions.
  // (watchRows/applyWatchRows already reach a test through CascadePersistence, same as the rest of the
  // account-sync IIFE's surface.)
  found,
  // CAS-929: inviteUrlFor/shareTextFor are the pure text/link builders the WhatsApp/SMS device hand-off and
  // its clipboard fallback both read; openNextInviteChannel/openNextRecommendChannel are the hand-off
  // functions themselves (window.open is stubbed to always return null here, so calling them always
  // exercises the clipboard-fallback branch) — exported so a test can assert the fallback's payload really
  // carries the link, the same guarantee CAS-929 asked for on the now-removed navigator.share path.
  inviteUrlFor, shareTextFor, openNextInviteChannel, openNextRecommendChannel,
  // CAS-1125: friendRowHTML is the shared recipient-row renderer (now a single tap target, not a separate
  // circle) and recommendMessageFor is the Recommend sheet's own default-message text — both plain
  // top-level functions, exported directly. toggleFriendSelect is window-assigned wire code (wrapped like
  // toggleFilmOpt above). friends/recommendFriendSel are reassigned wholesale elsewhere (loadFriends,
  // openRecommend/sendRecommend), so both are exposed through a getter/setter, like watchPrefs above.
  friendRowHTML, recommendMessageFor,
  toggleFriendSelect: (ctx, id) => window.toggleFriendSelect(ctx, id),
  // CAS-1131: sendRecommend is window-assigned wire code (same reason as toggleFriendSelect above),
  // exported so a test can drive the real de-dupe-by-email filter instead of re-deriving it.
  sendRecommend: (...args) => window.sendRecommend(...args),
  get friends(){ return friends; },
  setFriends(v){ friends = v; },
  get recommendFriendSel(){ return recommendFriendSel; },
  setRecommendFriendSel(v){ recommendFriendSel = v; },
  // CAS-968: the unread-reply badge/pill decision surface. invites is reassigned wholesale by loadInvites
  // (like watchPrefs/notifyPrefs above), so it's exposed through a getter/setter rather than by reference;
  // invitesUnseenCount/invitesBadgeText are the pure count -> display-text decision every badge reads, and
  // inviteRowHTML is the Invites screen's own per-row render, exported so a test can assert the New pill
  // directly off its HTML rather than driving the DOM.
  get invites(){ return invites; },
  setInvites(v){ invites=v; },
  invitesUnseenCount, invitesBadgeText, inviteRowHTML,
  // CAS-969: the rating-prompt predicate and its state helpers — exported so a test can drive the
  // threshold boundaries directly, and (via loadEngine's shared localStorageStore) assert the "asked"
  // flag really does survive a reload rather than only a second call within the same load.
  reviewPromptEligible, REVIEW_PROMPT_MIN_SESSIONS,
  bumpReviewPromptSessionCount, reviewPromptSessionCount,
  reviewPromptAskedVersion, markReviewPromptAsked, maybeRequestReview,
  // CAS-985: the client-side half of error/failure routing into usage_events. window.onerror is a real
  // property assignment (unlike addEventListener, which the stub below discards), so it's callable
  // directly; handleUnhandledRejection is a plain top-level function for the same reason. logSyncFailed/
  // clientErrorPayload/clientRejectionPayload/authFailedPayload are the pure shaping functions AC4 needs
  // to assert directly; usageQueue is exposed live (get, like watchPrefs elsewhere) so a test can read
  // back what actually reached the queue without waiting on a real Supabase flush.
  onerror: (...args) => window.onerror(...args),
  handleUnhandledRejection, logClientHealthEvent, logSyncFailed,
  clientErrorPayload, clientRejectionPayload, authFailedPayload, diagCurrentScreen, redactPII,
  resetClientHealthEventCounts(){ clientHealthEventCounts = {}; },
  get usageQueue(){ return usageQueue; },
  clearUsageQueue(){ usageQueue = []; },
  get diagLog(){ return diagLog; },
  // CAS-1103: pollCatalogue is a plain top-level function, exported directly like recomputeFound above.
  // catalogueHash is reassigned wholesale on every successful swap (never mutated in place), so it's
  // exposed through a getter/setter like watchPrefs/flowKind elsewhere in this file — a test resets it to
  // null to simulate a fresh load, or reads it back to assert a swap actually landed.
  pollCatalogue,
  get catalogueHash(){ return catalogueHash; },
  setCatalogueHash(v){ catalogueHash = v; },
};
`;

/** Read index.html, take its ONE classic engine script, and evaluate it against the stub DOM. */
export function loadEngine({ htmlPath = path.join(ROOT, "index.html"), localStorageStore } = {}){
  const html = fs.readFileSync(htmlPath, "utf8");
  const open = html.indexOf("<script>");
  if(open < 0) throw new Error(`no classic <script> found in ${htmlPath}`);
  const close = html.indexOf("</script>", open);
  if(close < 0) throw new Error(`unterminated <script> in ${htmlPath}`);
  const src = html.slice(open + "<script>".length, close);
  // A truncated or reshaped build would silently give us a tiny "engine" that passes everything, so refuse
  // anything that obviously isn't it.
  if(src.length < 200000) throw new Error(`engine script is only ${src.length} chars — is this a real build?`);

  const ctx = makeContext(localStorageStore);
  const sandbox = vm.createContext(ctx);
  vm.runInContext(src + EXPORTS, sandbox, { filename: `${path.basename(htmlPath)}#engine`, timeout: 120000 });
  const api = ctx.__ENGINE__;
  if(!api) throw new Error("engine loaded but exported nothing");
  for(const [k, v] of Object.entries(api)) if(v === undefined) throw new Error(`engine export "${k}" is undefined`);
  return api;
}

/** A fresh flow, seeded exactly the way a person walking the app seeds it. */
export function pickInLane(E, kind, presetKey){
  E.flowStart();
  E.setFlowKind(kind);
  E.pickStarter(presetKey);
  return E;
}
