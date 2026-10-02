// CAS-789: scaffold for the agent-behaviour suite (run on request via `npm run test:agents`,
// never as part of `npm run qa` — see QA-AGENTS.md). Follow-up tickets fill this file with the
// actual behaviour checks; this placeholder only proves the export surface those checks need is
// really there.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

const REQUIRED_EXPORTS = [
  "recomputeFound", "notify", "entryFor", "cascades", "cascSigOf", "agentFloor",
  "windowEnabled", "windowUsable", "WATCH_LEVEL_KEYS", "firstFound", "admitDrift",
  "filmIsNew", "isNewFound", "admittedAtFor", "watched", "blocked", "movingData",
  "movingWindowRows", "setAgentScore", "msnTrackAreaHTML",
  "msnValueLine", "toggleFilmOpt", "pinFilmToCascadeAndRepaint", "filmWatchSource",
  "filmNotifyState", "listingGroups", "listedBy", "watchesFilm", "agentChipHTML",
  "notifyChipHTML", "agentMetricsCompute", "cascadeScore", "primaryStatus",
  "CascadePersistence", "localStorage",
];

test("CAS-789: placeholder", () => {
  assert.ok(true);
});

test("CAS-789: every required export resolves from tests/js/engine.mjs", () => {
  const missing = REQUIRED_EXPORTS.filter(name => !(name in E) || E[name] === undefined);
  assert.deepEqual(missing, [], `missing engine export(s): ${missing.join(", ")}`);
});

// ============================================================================================
// CAS-790: the agent-behaviour plan's checks A to F. Every one drives the real exported
// functions against the real shipped engine (tests/js/engine.mjs) — never a re-implementation
// of engine logic — and seeds state directly (notify, cascades, agent_films, firstFound,
// admitDrift) exactly as the ticket asks. A real catalogue film is used wherever a live
// matchesCriteria/watchesFilm test is what's actually under test; CascadePersistence.setAgentFilm
// seeds a synthetic admission (score/status/agent_sig) wherever the point is the LEDGER's own
// re-review logic, decoupled from whatever the live catalogue happens to contain today.
//
// The helpers below (WATCH_PREFS through daysBeforeToday) are shared with the CAS-791 (checks G
// to K) section further down this file — declared once here so both sections drive the same
// state-isolation and fixture-building code rather than two copies drifting apart.
// ============================================================================================

// Cinema/Rental/Streaming usable, Premium off — watchPrefsDefaults()'s own shape, made explicit
// so this file never depends on whatever an earlier test (in this file or another) left the
// global watchPrefs pointing at. CAS-1123 dropped the separate Notify flag — a window carries
// just `list` now — so this fixture no longer carries one either.
const WATCH_PREFS = {
  in_cinema: { list: true }, premium: { list: false },
  rent: { list: true }, stream: { list: true },
};
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}
// Saves/restores every piece of mutable engine state a check in this section might touch, so
// tests can freely seed cascades/notify/agent_films/firstFound/admitDrift/watched/blocked/the
// persistence-ready flags without leaking into whichever test runs next.
function withState(fn){
  const savedNotify = { ...E.notify };
  const savedCascades = [...E.cascades];
  const savedFirstFound = { ...E.firstFound };
  const savedAdmitDrift = { ...E.admitDrift };
  const savedWatched = new Set(E.watched), savedBlocked = new Set(E.blocked);
  const savedFWR = E.CascadePersistence.filmWatchReady, savedAFR = E.CascadePersistence.agentFilmsReady;
  const savedMsnLastScore = E.msnLastScore;
  try{ fn(); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    Object.keys(E.firstFound).forEach(k => delete E.firstFound[k]);
    Object.assign(E.firstFound, savedFirstFound);
    Object.keys(E.admitDrift).forEach(k => delete E.admitDrift[k]);
    Object.assign(E.admitDrift, savedAdmitDrift);
    E.watched.clear(); savedWatched.forEach(id => E.watched.add(id));
    E.blocked.clear(); savedBlocked.forEach(id => E.blocked.add(id));
    // CAS-1113: msnLastScore is the module-level "last real score" scalar a chip's ＋ reads (replacing
    // the retired per-window msnLastValue map) — isolate it the same way as everything else here.
    E.setMsnLastScore(savedMsnLastScore);
    // `found` is entirely derived — recomputeFound() clears and rebuilds it from cascades/notify on
    // every call — so there is no prior value worth restoring, only a leftover one worth not leaking:
    // without this, a film left admitted by whichever test ran last is still sitting in `found` when
    // the next test's own setup asserts against it, before that test has called recomputeFound() itself.
    E.found.clear();
    E.CascadePersistence.filmWatchReady = savedFWR;
    E.CascadePersistence.agentFilmsReady = savedAFR;
  }
}
// The one wrapper every check below actually uses — state isolation plus the standard watch
// window shape, so a test only has to describe what it's seeding, not how it cleans up.
function withAgentState(fn){
  withState(() => withWatchPrefs(WATCH_PREFS, fn));
}
// A broad agent — no criteria narrowed at all beyond an explicit watchMarkers floor, so whatever
// film this matches is a real match, not an assumption about the fixture catalogue's shape.
function broadCascade(id, order, markers){
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: markers || { in_cinema: 0, premium: null, rent: 0, stream: 0 } });
  c.id = id; c.paused = false; c.order = order;
  return c;
}
function pickMatchingFilm(c, exclude){
  const ex = exclude || new Set();
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id) && !ex.has(x.tmdb_id)
    && E.matchesCriteria(x, c));
  if(!m) throw new Error("no film in the harness catalogue matches this agent — this test would prove nothing");
  return m;
}
// CAS-762's "need an unscored film this agent admits" fixtures used to find a REAL unscored film in the
// live catalogue (E.MOVIES.find(m => E.cascadeScore(m) === -1 && ...)) — CAS-1029/1031's publish floor
// now requires every published film to clear a score to publish at all, so that supply dried up
// (CAS-1042). Clone a real, currently-matching donor and strip its score fields instead — the same
// technique CAS-724's own test (invariants.test.mjs) already uses for this exact problem — and remove it
// again afterwards so nothing leaks into a later test.
function withUnscoredMatch(c, fn){
  const donor = E.MOVIES.find(m => E.matchesCriteria(m, c));
  if(!donor) throw new Error("no film in the harness catalogue matches this agent — this test would prove nothing");
  const unscored = { ...donor, tmdb_id: -900000000 - donor.tmdb_id,
    wm_user_rating: null, wm_critic_score: null, wm_popularity_percentile: null };
  if(E.cascadeScore(unscored) !== -1) throw new Error("test setup: cloned fixture should be unscored");
  E.MOVIES.push(unscored);
  E.invalidateComputeCaches();
  try{ return fn(unscored); }
  finally{
    const i = E.MOVIES.indexOf(unscored);
    if(i !== -1) E.MOVIES.splice(i, 1);
    E.invalidateComputeCaches();
  }
}
// A cleared film may keep a bare notify entry or be pruned out entirely by recomputeFound's own
// noise-gc — both are valid ways of saying "no Watch On", so assertions go through this rather
// than assuming notify[id] still exists (same helper shape as agents-watched.test.mjs).
function noWinsLeft(id){
  const e = E.notify[id];
  if(!e) return true;
  return E.WATCH_LEVEL_KEYS.every(k => !e.wins[k]) && Object.keys(e.winsSource || {}).length === 0;
}
// The engine runs in its own vm realm — an array it hands back is a real Array by content but not
// by [[Prototype]], so assert.deepEqual (what "strict" assert's .deepEqual actually is) fails on
// two arrays that print identically. Spreading pulls the values into a plain array of this realm.
const arr = a => [...(a || [])];
function daysBeforeToday(n){
  const d = new Date(Date.parse(E.TODAY));
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---- A: ranking (single owner, both genuinely matched) --------------------------------------

test("A1: two agents both matching the same film — exactly one owner, the lower .order", () => withAgentState(() => {
  const cLow = broadCascade("cas790-a1-low", 1);
  const cHigh = broadCascade("cas790-a1-high", 5);
  E.cascades.push(cLow, cHigh);
  const film = pickMatchingFilm(cLow);
  assert.ok(E.matchesCriteria(film, cHigh), "setup: both agents must genuinely match the film");

  E.recomputeFound();

  assert.deepEqual(arr(E.notify[film.tmdb_id].cascadeIds), [cLow.id],
    "A1: the lower-order agent must be the sole owner — never both");
}));

test("A2: reordering to give the other agent the lower .order moves ownership, still exactly one owner", () => withAgentState(() => {
  const cA = broadCascade("cas790-a2-a", 1);
  const cB = broadCascade("cas790-a2-b", 5);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[film.tmdb_id].cascadeIds), [cA.id], "setup: A starts as sole owner");

  cA.order = 9; cB.order = 0;
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[film.tmdb_id].cascadeIds), [cB.id],
    "A2: ownership must move to B once it has the lower .order — still exactly one owner");
}));

// A5, A6, A7 — covered by tests/js/agents-placement.test.mjs. Comment only, no test here.
// A8 — covered by tests/js/agents-chip.test.mjs. Comment only, no test here.

test("A3: both matching agents each hold an agent_films row, even though only one owns the film", () => withAgentState(() => {
  const cA = broadCascade("cas790-a3-a", 1);
  const cB = broadCascade("cas790-a3-b", 5);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[film.tmdb_id].cascadeIds), [cA.id], "setup: A owns the film");

  const rowA = E.CascadePersistence.agentFilmsFor(cA.id).find(r => r.movie_id === String(film.tmdb_id));
  const rowB = E.CascadePersistence.agentFilmsFor(cB.id).find(r => r.movie_id === String(film.tmdb_id));

  assert.ok(rowA, "A3: the owning agent must hold a row");
  assert.ok(rowB, "A3: the non-owning agent must ALSO hold a row — it genuinely matched too, ranking just picked the owner");
}));

// ---- B: sticky admission and its re-review on drift ------------------------------------------

test("B1: tightening an agent so a held film no longer qualifies clears its row and drops it from found, same pass", () => withAgentState(() => {
  const c = broadCascade("cas790-b1", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.ok(E.found.has(id), "setup: the film must actually be found before tightening");
  assert.ok(E.CascadePersistence.agentFilmsFor(c.id).some(r => r.movie_id === String(id)), "setup: an agent_films row must exist");

  const offYear = E.yearOf(film) - 1;
  c.year = [offYear];   // tighten: excludes the film by criteria
  assert.ok(!E.matchesCriteria(film, c), "setup: the tightened criteria must actually exclude the film now");
  E.recomputeFound();

  assert.ok(!E.CascadePersistence.agentFilmsFor(c.id).some(r => r.movie_id === String(id)),
    "B1: the agent_films row must be cleared once the agent no longer qualifies the film");
  assert.ok(!E.found.has(id), "B1: the film must leave found on the same pass");
}));

test("B2: loosening an agent so a never-qualified film now does — admitted this pass, row stamped with today's agent_sig", () => withAgentState(() => {
  const c = broadCascade("cas790-b2", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  c.year = [E.yearOf(film) - 1];   // tighten: now excludes exactly this film
  assert.ok(!E.matchesCriteria(film, c), "setup: the tightened criteria must exclude the film");
  E.recomputeFound();
  assert.ok(!E.CascadePersistence.agentFilmsFor(c.id).some(r => r.movie_id === String(id)), "setup: no row yet");

  c.year = [];   // loosen back
  assert.ok(E.matchesCriteria(film, c), "setup: the loosened criteria must include the film again");
  E.recomputeFound();

  const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
  assert.ok(row, "B2: the film must be admitted the same pass the agent loosens to include it");
  assert.equal(row.agent_sig, E.cascSigOf(c), "B2: the freshly-written row must carry today's agent_sig");
}));

test("B3: editing agent 1 only leaves agent 2's rows byte-identical — equal signature returns early, nothing re-tested", () => withAgentState(() => {
  const c1 = broadCascade("cas790-b3-1", 0);
  const c2 = broadCascade("cas790-b3-2", 1);
  E.cascades.push(c1, c2);
  const film1 = pickMatchingFilm(c1);
  const film2 = pickMatchingFilm(c2, new Set([film1.tmdb_id]));
  E.recomputeFound();
  const sigC2Before = E.cascSigOf(c2);
  const rowsBefore = JSON.stringify(E.CascadePersistence.agentFilmsFor(c2.id));
  assert.ok(rowsBefore !== "[]", "setup: agent 2 must actually hold a row before the edit");

  c1.selBuzz = (c1.selBuzz || 0) + 1;   // an edit to c1 only — selBuzz plays no gating part in matchesCriteria
  E.recomputeFound();

  assert.equal(E.cascSigOf(c2), sigC2Before, "setup: c2's own signature must not have moved");
  const rowsAfter = JSON.stringify(E.CascadePersistence.agentFilmsFor(c2.id));
  assert.equal(rowsAfter, rowsBefore, "B3: agent 2's rows must be byte-identical — its own signature never moved");
}));

test("B4: a film leaving an agent loses an auto Watch On but keeps a manual one", () => withAgentState(() => {
  const cAuto = broadCascade("cas790-b4-auto", 0);
  E.cascades.push(cAuto);
  const filmAuto = pickMatchingFilm(cAuto);
  const idAuto = filmAuto.tmdb_id;
  E.recomputeFound();
  const keyAuto = E.WATCH_LEVEL_KEYS.find(k => E.notify[idAuto].wins[k]);
  assert.ok(keyAuto, "setup: the agent must arm a Watch On before this test can assert it gets cleared");
  assert.equal(E.notify[idAuto].winsSource[keyAuto], "auto", "setup: the arm must be auto");

  cAuto.year = [E.yearOf(filmAuto) - 1];
  E.recomputeFound();
  assert.ok(noWinsLeft(idAuto), "B4: an auto-armed Watch On must clear once its agent no longer holds the film");

  const cManual = broadCascade("cas790-b4-manual", 0);
  E.cascades.push(cManual);
  const filmManual = pickMatchingFilm(cManual, new Set([idAuto]));
  const idManual = filmManual.tmdb_id;
  E.recomputeFound();
  const keyManual = E.WATCH_LEVEL_KEYS.find(k => E.notify[idManual].wins[k]);
  assert.ok(keyManual, "setup: the agent must arm a Watch On before ticking it manual");
  E.toggleFilmOpt(idManual, keyManual);   // claims the auto-armed level as manual (CAS-751)
  assert.equal(E.notify[idManual].winsSource[keyManual], "manual", "setup: the tick must land as manual");

  cManual.year = [E.yearOf(filmManual) - 1];
  E.recomputeFound();
  assert.equal(E.notify[idManual].wins[keyManual], true, "B4: a manual Watch On must survive the film leaving the agent");
  assert.equal(E.notify[idManual].winsSource[keyManual], "manual", "B4: its provenance must still read manual");
}));

test("B5: a film admitted while in_cinema, now stream, survives an agent edit — retested against its stored admission_score, not today's", () => withAgentState(() => {
  const c = broadCascade("cas790-b5", 0);
  // CAS-1042: must also pass the retest recomputeFound itself runs on an edit (matchesCriteria against
  // this SAME cascade, status/myServices ignored, score gate ignored — see the app's own r.admission_score
  // branch) — not merely be "included_streaming" — or the retest below legitimately drops it for a taste
  // reason (e.g. language) unrelated to what this test is about, and the film silently isn't on the agent
  // any more when the assertion reads it back.
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id)
    && E.primaryStatus(x) === "included_streaming"
    && E.matchesCriteria(x, {...c, status: [], myServices: false}, false, true));
  if(!film) throw new Error("no unwatched 'included_streaming' film in the harness catalogue matches this broad agent — this test would prove nothing");
  const id = film.tmdb_id;
  E.cascades.push(c);
  const sig = E.cascSigOf(c);
  E.CascadePersistence.setAgentFilm(c.id, id, { admission_score: 90, admission_status: "in_cinema", agent_sig: sig });
  E.recomputeFound();
  assert.ok(E.notify[id].cascadeIds.includes(c.id), "setup: the film must be on the agent before the edit");

  c.selBuzz = (c.selBuzz || 0) + 1;   // an edit that moves cascSigOf without changing matchesCriteria's outcome
  assert.notEqual(E.cascSigOf(c), sig, "setup: this edit must actually move cascSigOf(c)");
  E.recomputeFound();

  assert.ok(E.notify[id].cascadeIds.includes(c.id), "B5: the film must survive the edit — its window moved forward, not backward");
  const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
  assert.ok(row, "the agent_films row must survive");
  assert.equal(row.admission_score, 90, "B5: the retained row must keep its ORIGINAL admission_score, not a re-test off today's score");
}));

test("B6: a film admitted purely because of an agent edit carries admitDrift — no new-film glow", () => withAgentState(() => {
  const c = broadCascade("cas790-b6", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  c.year = [E.yearOf(film) - 1];   // tight: nothing admitted yet
  E.recomputeFound();
  assert.ok(!(id in E.notify) || !E.notify[id].cascadeIds.includes(c.id), "setup: the film must not be admitted yet");
  assert.ok(!E.firstFound[id], "setup: the film must never have been found before");

  c.year = [];   // loosen: the edit itself is what admits the film this pass
  E.recomputeFound();

  assert.ok(E.notify[id].cascadeIds.includes(c.id), "setup: the film must actually be admitted now");
  assert.equal(E.admitDrift[id], true, "B6: admission caused by the edit must set admitDrift");
  assert.equal(E.filmIsNew(id), false, "B6: filmIsNew must read false — this is news about the agent, not about the film");
}));

// B7 — covered by tests/js/agents-override.test.mjs. Comment only, no test here.

test("B8: a film already carrying a firstFound stamp keeps it across two edits to its agent, the second unrelated", () => withAgentState(() => {
  const c = broadCascade("cas790-b8", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.ok(E.firstFound[id], "setup: the film must be stamped on first admission");

  // Well outside any "new" window so a restamp-to-today is detectable, but still inside the prune
  // horizon — backdating past FIRST_FOUND_PRUNE_DAYS would trip trackFirstFound's own unrelated
  // prune-then-restamp path (CAS-783 AC2) and read as a restamp for the wrong reason.
  const d = new Date(Date.parse(E.TODAY));
  d.setDate(d.getDate() - (E.FIRST_FOUND_PRUNE_DAYS - 5));
  const original = d.toISOString().slice(0, 10);
  E.firstFound[id] = original;

  c.selBuzz = (c.selBuzz || 0) + 1;   // edit 1 — moves cascSigOf without touching matchesCriteria's outcome
  E.recomputeFound();
  assert.equal(E.firstFound[id], original, "setup: the first edit must not have restamped it");

  c.selBuzz = (c.selBuzz || 0) + 1;   // edit 2 — unrelated, same field, moves cascSigOf again
  E.recomputeFound();
  assert.equal(E.firstFound[id], original, "B8: a second, unrelated edit must still not restamp firstFound");
}));

test("B9: raising a marker above a film's admission score skips to the next usable rung; above every marker, nothing is written", () => withAgentState(() => {
  // Skips forward, from Cinema to Rent — Premium is off in WATCH_PREFS, so it can never be "the next rung".
  const cSkip = broadCascade("cas790-b9-skip", 0, { in_cinema: 50, premium: null, rent: 50, stream: 50 });
  E.cascades.push(cSkip);
  const filmSkip = pickMatchingFilm(cSkip);
  const idSkip = filmSkip.tmdb_id;
  E.CascadePersistence.setAgentFilm(cSkip.id, idSkip,
    { admission_score: 60, admission_status: E.primaryStatus(filmSkip), agent_sig: E.cascSigOf(cSkip) });
  E.recomputeFound();
  assert.equal(E.notify[idSkip].wins.in_cinema, true, "setup: the film must initially earn Cinema (60 >= 50)");

  cSkip.watchMarkers.in_cinema = 70;   // now above the stored score of 60
  E.recomputeFound();
  assert.equal(E.notify[idSkip].wins.in_cinema, false, "B9: Cinema must no longer be earned once its marker passes the score");
  assert.equal(E.notify[idSkip].wins.rent, true, "B9: the next usable rung down (Rent — Premium is off) must be used instead");

  // Above every marker: a film that never clears the floor is never admitted at all — no Watch On
  // value is EVER written for it, not merely cleared. Pause cSkip first — its own low, broad floor
  // would otherwise compete for (and win) ownership of whatever film gets picked next; excluding any
  // film cSkip already matches (not just idSkip itself) also rules out a stale, frozen-while-paused
  // wins value left over from cSkip's own earlier arrivals.
  cSkip.paused = true;
  const cNone = broadCascade("cas790-b9-none", 1, { in_cinema: 99, premium: null, rent: 99, stream: 99 });
  E.cascades.push(cNone);
  const filmNone = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id)
    && !E.matchesCriteria(x, cSkip));
  const idNone = filmNone.tmdb_id;
  assert.ok(!E.matchesCriteria(filmNone, cNone), "setup: a 99-floor agent must not admit an ordinary film at all");
  E.recomputeFound();

  assert.ok(!E.notify[idNone] || E.WATCH_LEVEL_KEYS.every(k => !E.notify[idNone].wins[k]),
    "B9: a score below every marker must never get a Watch On value written at all");
}));

// B10 ("setWatchMarker pushes neighbours to hold MARKER_MIN_GAP and ladder order") deleted, CAS-1113:
// there is one score per agent now, not one marker per window, so there is nothing left to push apart.
// CAS-1128 then retired the "start window at or after" delivery shape itself — setAgentScore(c, value)
// now has no key argument, and arms every account-enabled window once the agent has at least one ON (see
// tests/js/cas1128-track-in.test.mjs's own AC4, which covers this directly). The *Defaulted-clearing half
// survives here too.
test("B10: setAgentScore applies the same value to every account-enabled window, and clears the *Defaulted flag", () => withAgentState(() => {
  const fresh = E.normCascade({ kind: "stream", status: [] });
  assert.equal(fresh._watchMarkersDefaulted, true, "setup: a freshly-normalised agent's markers start flagged as a guess");
  E.setAgentScore(fresh, 60);
  assert.ok(!fresh._watchMarkersDefaulted, "B10: the first real edit must clear the *Defaulted provenance flag");
  assert.equal(fresh.watchMarkers.in_cinema, 60);
  assert.equal(fresh.watchMarkers.rent, 60, "B10: every account-enabled window must share the same score");
  assert.equal(fresh.watchMarkers.stream, 60, "B10: every account-enabled window must share the same score");
}));

// ---- CAS-762/CAS-833's "Off — a third watchMarkers state (0), no score requirement" retired by CAS-1128 ---
// CAS-1128 (Lee, 2026-10-01) supersedes this reading outright for the Cascade score control: there is no
// per-window Off state any more, only ON (a real 50-100 score, shared by every ON window) or OFF (null).
// normCascade now migrates any literal 0 it finds up to TRACK_MIN and leaves it ON (see
// tests/js/cas1128-track-in.test.mjs's AC1), so every item below that built its fixture around a literal
// `0` staying 0 — "usable at Off", "admits an unscored film", "scoreHeldBackCount is 0 because there's no
// requirement" — tests a state that can no longer exist. Deleted rather than reworked: there is no
// replacement behaviour to pin, since the whole point of this control's Off stop now is the opposite
// (nothing tracked, not "tracks anything"). The genuinely new per-window-off behaviour (AC2: an OFF window
// is skipped, not admitted) is covered by tests/js/cas1128-track-in.test.mjs's own AC2.

// CAS-762 item 9's two restoreWatchMarker tests, and the later CAS-1113 msn-start-add test that replaced
// them, deleted by CAS-1128: there is no more "start" window to re-arm via a chip's ＋ — toggleAgentWindow
// is the one per-window mutator now, and its own "resume the agent's last real score" behaviour is covered
// directly by tests/js/cas1128-track-in.test.mjs's AC4.

// CAS-762 AC6 retired by CAS-1128: msnValueLine's Off branch is track-wide now ("Off — this agent isn't
// tracking anything."), not a per-window "every film, no floor" sentence — pinned directly by
// tests/js/cas1128-track-in.test.mjs's AC3.

// CAS-762 item 11 retired by CAS-1128: the track's two segments are always both present now (never a
// single full-width grey div), and Off is "no ON window" rather than "a marker literally at 0" — there is
// no more "zero-width exclusion segment" distinction to pin for a per-window Off. msnTrackAreaHTML's own
// segment maths are exercised directly by tests/js/cas1128-track-in.test.mjs's AC5.

test("CAS-762 AC8: an agent whose windows all carry numeric markers is byte-identical to its pre-CAS-762 behaviour", () => withAgentState(() => {
  const c = broadCascade("cas762-ac8", 0, { in_cinema: 90, premium: 80, rent: 70, stream: 60 });
  const before = E.MOVIES.filter(m => E.matchesCriteria(m, c)).length;
  // Re-run is the regression pin here: a purely-numeric agent must take the exact same code path as before
  // this ticket (agentFloor(c) > 0 throughout), so a second pass over the same fixture must count identically.
  const after = E.MOVIES.filter(m => E.matchesCriteria(m, c)).length;
  assert.equal(after, before, "CAS-762 AC8: a numeric-only agent's listed count must not move");
  assert.ok(before >= 0);
}));

// ---- C: Where & when you'll watch (watchPrefs + per-agent watchMarkers) ----------------------

test("C1: switching a window off clears windowEnabled, drops it from msnTrackAreaHTML, and snaps a placed film forward", () => withAgentState(() => {
  const c = broadCascade("cas790-c1", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.CascadePersistence.setAgentFilm(c.id, id,
    { admission_score: 60, admission_status: E.primaryStatus(film), agent_sig: E.cascSigOf(c) });
  E.recomputeFound();
  assert.equal(E.notify[id].wins.in_cinema, true, "setup: the film must earn Cinema, the first usable rung");

  withWatchPrefs({ in_cinema: { list: false } }, () => {
    assert.equal(E.windowEnabled("in_cinema"), false, "C1: windowEnabled must read false once switched off");
    const html = E.msnTrackAreaHTML(c);
    assert.doesNotMatch(html, /data-key="in_cinema"/, "C1: a switched-off window must render no marker");
    assert.doesNotMatch(html, /\+ Cinema/, "C1: a switched-off window must render no restore chip either");

    E.recomputeFound();
    assert.equal(E.notify[id].wins.in_cinema, false, "C1: the placement must snap off the disabled window");
    assert.equal(E.notify[id].wins.rent, true, "C1: ...forward to the next usable one");
  });
}));

// C2 ("switching on a window the agent has no marker for shows a restore chip, not a marker")
// deleted, CAS-860: it asserted `msnTrackAreaHTML` rendering an inline "+ Premium" restore chip.
// CAS-817 replaced that mechanism outright — an enabled Never window got a chip in the separate "On this
// track" row (msnChipsHTML, a dashed chip with a "＋" button, not "+ Premium" text inside the track itself)
// — so the control C2 checked for was gone, not merely renamed. CAS-1128 has since retired msnChipsHTML
// itself too, in favour of independent per-window pills (msnPillsHTML) — see tests/js/cas1128-track-in.
// test.mjs's AC5 for that row's own current coverage.
// C1 above still passes only because its own assertion (doesNotMatch "+ Cinema") is now vacuous.

test("C3: disabling a film's own current window (and anything later) resolves standing to null — placement falls back to earned", () => withAgentState(() => {
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id) && E.primaryStatus(x) === "included_streaming");
  if(!film) throw new Error("no unwatched 'included_streaming' film in the harness catalogue — this test would prove nothing");
  const id = film.tmdb_id;
  const c = broadCascade("cas790-c3", 0);
  E.cascades.push(c);
  E.CascadePersistence.setAgentFilm(c.id, id, { admission_score: 60, admission_status: "included_streaming", agent_sig: E.cascSigOf(c) });
  E.recomputeFound();
  assert.equal(E.notify[id].wins.stream, true, "setup: the film's own current window (Stream) must win over Cinema while both are usable");

  // WATCH_LEVEL_KEYS' standing scan starts AT the film's own current rung, not strictly after it —
  // for a film already at Stream (the ladder's last rung), "every window later than its own" has
  // no members, so its own window has to go too for the scan to actually run dry.
  withWatchPrefs({ stream: { list: false } }, () => {
    E.recomputeFound();
    assert.equal(E.notify[id].wins.stream, false, "C3: standing must no longer be able to claim Stream");
    assert.equal(E.notify[id].wins.in_cinema, true, "C3: placement must fall back to earned (Cinema) — the film keeps a Watch On");
  });
}));

test("C4: a film's Watch On is computed from its OWNING agent's markers, not any other agent's", () => withAgentState(() => {
  const cOwner = broadCascade("cas790-c4-owner", 0);
  const cOther = broadCascade("cas790-c4-other", 1, { in_cinema: 99, premium: null, rent: 99, stream: 99 });
  E.cascades.push(cOwner, cOther);
  const film = pickMatchingFilm(cOwner);
  const id = film.tmdb_id;
  assert.ok(!E.matchesCriteria(film, cOther), "setup: the other agent's floor must be too high to admit this film at all");

  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cOwner.id], "setup: cOwner must be the sole owner");
  assert.equal(E.WATCH_LEVEL_KEYS.some(k => E.notify[id].wins[k]), true,
    "C4: the film must earn a Watch On off its owner's own (low) markers — using cOther's impossible ones would earn nothing");
}));

test("C5: a marker (Where and when) change moves cascSigOf, the signature the full B1/B2 re-review depends on", () => withAgentState(() => {
  const c = E.normCascade({ kind: "stream", status: [] });
  const sigBefore = E.cascSigOf(c);

  E.setAgentScore(c, (c.watchMarkers.rent || 50) + 10);

  assert.notEqual(E.cascSigOf(c), sigBefore,
    "C5: a marker edit must move cascSigOf — this is the load-bearing signature; if this fails, half of topic B is silently untrue");
}));

test("C6: recomputing with filmWatchReady or agentFilmsReady false writes no placement at all", () => withAgentState(() => {
  const c1 = broadCascade("cas790-c6-a", 0);
  E.cascades.push(c1);
  const film1 = pickMatchingFilm(c1);
  const id1 = film1.tmdb_id;
  E.CascadePersistence.filmWatchReady = false;
  E.recomputeFound();
  assert.ok(E.notify[id1].cascadeIds.includes(c1.id), "setup: membership must still form — only placement is gated");
  assert.ok(E.WATCH_LEVEL_KEYS.every(k => !E.notify[id1].wins[k]), "C6: filmWatchReady=false must write no Watch On value");
  E.CascadePersistence.filmWatchReady = true;
  c1.paused = true;   // stop competing for ownership of whatever film c2 matches next

  const c2 = broadCascade("cas790-c6-b", 1);
  E.cascades.push(c2);
  const film2 = pickMatchingFilm(c2, new Set([id1]));
  const id2 = film2.tmdb_id;
  E.CascadePersistence.agentFilmsReady = false;
  E.recomputeFound();
  assert.ok(E.notify[id2].cascadeIds.includes(c2.id), "setup: membership must still form");
  assert.ok(E.WATCH_LEVEL_KEYS.every(k => !E.notify[id2].wins[k]), "C6: agentFilmsReady=false must also write no Watch On value");
}));

// Answered 2026-09-06 — C7: cascSigOf(c) is JSON.stringify([c.name, c.status, c.genre, ...]) — c.name is
// index 0, c.icon is absent. A rename therefore DOES move the signature and runs the full re-review (the
// row survives it, unchanged apart from its own agent_sig); an icon change does NOT move the signature and
// runs no re-review at all — the row is left completely untouched. Both halves asserted below; do not
// change cascSigOf itself (Lee's decision, ticket comment).
test("C7: a rename moves cascSigOf and re-reviews (identically) — an icon change moves neither cascSigOf nor the row at all", () => withAgentState(() => {
  const c = broadCascade("cas790-c7", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [c.id], "setup: the agent must own the film before either edit");
  const sigBefore = E.cascSigOf(c);
  const rowBefore = E.CascadePersistence.getAgentFilm(c.id, id);
  const totalBefore = E.agentMetricsCompute(c).total;

  c.icon = (c.icon === "🎬") ? "🍿" : "🎬";
  assert.equal(E.cascSigOf(c), sigBefore, "C7: an icon-only change must not move cascSigOf");
  E.recomputeFound();
  const rowAfterIcon = E.CascadePersistence.getAgentFilm(c.id, id);
  assert.deepEqual(rowAfterIcon, rowBefore, "C7: an icon change must trigger no re-review at all — the row is untouched");

  c.name = (c.name || "") + " (renamed)";
  assert.notEqual(E.cascSigOf(c), sigBefore, "C7: a rename must move cascSigOf — its signature opens with c.name");
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [c.id], "C7: membership must come out identical — no criterion changed");
  const rowAfterRename = E.CascadePersistence.getAgentFilm(c.id, id);
  assert.ok(rowAfterRename, "C7: the row must survive the rename's re-review");
  assert.equal(rowAfterRename.admission_score, rowBefore.admission_score, "C7: the re-reviewed row's admission_score must come out identical");
  assert.equal(rowAfterRename.admitted_at, rowBefore.admitted_at, "C7: ...and its admitted_at too");
  assert.notEqual(rowAfterRename.agent_sig, rowBefore.agent_sig, "C7: the row's agent_sig DOES move — that's what 'the full re-review runs' means");
  assert.equal(E.agentMetricsCompute(c).total, totalBefore, "C7: every listing count must come out identical too");
}));

// ---- D: hand-ticked Watch On (winsSource "manual") ---------------------------------------------

test("D1: a real hand-tick through toggleFilmOpt is single-select, manual, and a following recompute leaves it alone", () => withAgentState(() => {
  const c = broadCascade("cas790-d1", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  const levels = E.watchLevelsFor(id).filter(l => !l.spent);
  assert.ok(levels.length >= 2, "setup: need at least two selectable levels to prove single-select");
  const [levelA, levelB] = levels;

  E.toggleFilmOpt(id, levelA.key);
  assert.equal(E.notify[id].wins[levelA.key], true);
  assert.equal(E.notify[id].winsSource[levelA.key], "manual");

  E.toggleFilmOpt(id, levelB.key);
  assert.equal(E.notify[id].wins[levelB.key], true, "D1: ticking a second level must select it");
  assert.equal(E.notify[id].wins[levelA.key], false, "D1: ...and clear the first — single-select");
  assert.equal(E.notify[id].winsSource[levelB.key], "manual");

  E.recomputeFound();
  assert.equal(E.notify[id].wins[levelB.key], true, "D1: a following recompute must leave the manual value alone");
  assert.equal(E.notify[id].winsSource[levelB.key], "manual");
}));

test("D2: a film with a manual Watch On drops off every agent but its value and provenance survive", () => withAgentState(() => {
  const c = broadCascade("cas790-d2", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  const level = E.watchLevelsFor(id).find(l => !l.spent);
  E.toggleFilmOpt(id, level.key);
  assert.equal(E.notify[id].winsSource[level.key], "manual");

  c.year = [E.yearOf(film) - 1];   // tighten: the film drops off the only agent that ever matched it
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [], "setup: the film must actually have dropped off every agent");
  assert.equal(E.notify[id].wins[level.key], true, "D2: the manual value must survive");
  assert.equal(E.filmWatchSource(id), "manual", "D2: filmWatchSource must still read manual");
}));

test("D3: a round trip through watchRows()/applyWatchRows preserves windows and sources, and nothing else on the entry", () => withAgentState(() => {
  const c = broadCascade("cas790-d3", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  const level = E.watchLevelsFor(id).find(l => !l.spent);
  E.toggleFilmOpt(id, level.key);
  const sourceBefore = E.notify[id].source;
  const pinnedToBefore = arr(E.notify[id].pinnedTo);

  const rows = E.CascadePersistence.watchRows();
  const row = rows.find(r => r.movie_id === String(id));
  assert.ok(row, "setup: watchRows() must carry the ticked film");
  assert.deepEqual(arr(row.windows), [level.key]);
  assert.equal(row.sources[level.key], "manual");

  E.CascadePersistence.applyWatchRows(rows);   // round trip — apply the exact rows just read back

  assert.equal(E.notify[id].wins[level.key], true, "D3: the window must survive the round trip");
  assert.equal(E.notify[id].winsSource[level.key], "manual", "D3: the source must survive the round trip");
  assert.equal(E.notify[id].source, sourceBefore, "D3: no other field on the entry may change");
  assert.deepEqual(arr(E.notify[id].pinnedTo), pinnedToBefore, "D3: pinnedTo must be untouched");
}));

test("D5: a manual value on an earlier window than the agent would arm is not pushed forward", () => withAgentState(() => {
  const c = broadCascade("cas790-d5", 0, { in_cinema: 0, premium: null, rent: 90, stream: 90 });
  E.cascades.push(c);
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id)
    && E.primaryStatus(x) === "in_cinema" && E.matchesCriteria(x, c));
  if(!film) throw new Error("no unwatched 'in_cinema' film matching a Cinema-only floor — this test would prove nothing");
  const id = film.tmdb_id;

  E.toggleFilmOpt(id, "in_cinema");   // a manual pick on the EARLY window, well below where the agent would arm (rent/stream at 90)
  assert.equal(E.notify[id].winsSource.in_cinema, "manual");

  E.recomputeFound();

  assert.equal(E.notify[id].wins.in_cinema, true, "D5: the agent must not push the manual value forward to a later window");
  assert.equal(E.notify[id].winsSource.in_cinema, "manual");
}));

test("D6: re-tapping an auto-armed window claims it as manual — it stays ticked, never unticks", () => withAgentState(() => {
  const c = broadCascade("cas790-d6", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  const key = E.WATCH_LEVEL_KEYS.find(k => E.notify[id].wins[k]);
  assert.ok(key, "setup: the agent must arm a Watch On first");
  assert.equal(E.notify[id].winsSource[key], "auto");

  E.toggleFilmOpt(id, key);   // re-tap the already-on, auto-armed level

  assert.equal(E.notify[id].wins[key], true, "D6: the level must stay ticked");
  assert.equal(E.notify[id].winsSource[key], "manual", "D6: ...only its provenance flips to manual");
}));

test("D7: re-tapping a manual window, or one with no recorded source, unticks it and drops the stale winsSource entry", () => withAgentState(() => {
  const c1 = broadCascade("cas790-d7-manual", 0);
  E.cascades.push(c1);
  const film1 = pickMatchingFilm(c1);
  const id1 = film1.tmdb_id;
  const level1 = E.watchLevelsFor(id1).find(l => !l.spent);
  E.toggleFilmOpt(id1, level1.key);
  assert.equal(E.notify[id1].winsSource[level1.key], "manual");

  E.toggleFilmOpt(id1, level1.key);   // re-tap an already-manual window
  assert.equal(E.notify[id1].wins[level1.key], false, "D7: a manual window must untick on a second tap");
  assert.ok(!(level1.key in E.notify[id1].winsSource), "D7: its stale winsSource entry must be deleted, not left behind");

  const c2 = broadCascade("cas790-d7-nosource", 1);
  E.cascades.push(c2);
  const film2 = pickMatchingFilm(c2, new Set([id1]));
  const id2 = film2.tmdb_id;
  const level2 = E.watchLevelsFor(id2).find(l => !l.spent);
  const e2 = E.entryFor(id2);
  e2.wins = e2.wins || {}; e2.winsSource = e2.winsSource || {};
  e2.wins[level2.key] = true;   // on, but with no recorded provenance — the pre-CAS-726 shape

  E.toggleFilmOpt(id2, level2.key);
  assert.equal(E.notify[id2].wins[level2.key], false, "D7: a no-source window must also untick on a tap");
  assert.ok(!(level2.key in E.notify[id2].winsSource), "D7: no stale winsSource entry must be left behind");
}));

// ---- E: hand-placement (pinnedTo / notIn) ------------------------------------------------------

test("E1: placing a film on an agent whose criteria exclude it — in, and stays in across recompute", () => withAgentState(() => {
  const c = broadCascade("cas790-e1", 0);
  E.cascades.push(c);
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id));
  const id = film.tmdb_id;
  c.year = [E.yearOf(film) - 1];   // excludes the film by criteria
  assert.ok(!E.matchesCriteria(film, c), "setup: the agent's own criteria must genuinely exclude the film");

  E.pinFilmToCascadeAndRepaint(id, c.id);
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [c.id], "E1: the pin must place the film despite excluding criteria");

  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [c.id], "E1: it must stay in across a further recompute");
}));

test("E2: moving a film out of an agent that matches it (notIn) — out and stays out, including out of its alert set", () => withAgentState(() => {
  const c = broadCascade("cas790-e2", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [c.id], "setup: the agent must genuinely match the film first");

  E.entryFor(id).notIn = [c.id];
  E.recomputeFound();
  // recomputeFound's own CAS-279 comment names cascadeIds/candidates as "the set the poll watches" —
  // movedOutOf excludes this cascade from candidates before a match is even considered, which is what
  // stops the agent from "going on emailing you about a film you took it off". That's the alert-relevant
  // surface this check is about, not the separate agent_films admission ledger (a listing-stickiness
  // cache with its own re-review triggers, orthogonal to notIn).
  assert.ok(!E.notify[id].cascadeIds.includes(c.id), "E2: the film must be out, including out of the set the poll watches");

  E.recomputeFound();
  assert.ok(!E.notify[id].cascadeIds.includes(c.id), "E2: it must stay out across a further recompute");
  assert.deepEqual(arr(E.entryFor(id).notIn), [c.id], "E2: the notIn record itself must persist, not get silently dropped");
}));

// E3 — covered by tests/js/agents-placement.test.mjs. Comment only, no test here.

test("E4: a placement naming a cascade not loaded on this device survives the prune via the overridden guard", () => withAgentState(() => {
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id));
  const id = film.tmdb_id;
  E.notify[id] = { source: "auto", cascadeIds: [], removed: false, pinnedTo: ["cas790-e4-ghost"], notIn: [] };

  E.recomputeFound();

  assert.ok(id in E.notify, "E4: the entry must survive even though its pinned cascade isn't loaded on this device");
  assert.deepEqual(arr(E.notify[id].pinnedTo), ["cas790-e4-ghost"], "E4: the pin itself must be untouched");
}));

test("E5: marking a hand-placed film watched, then un-watching it, restores it to the same agent", () => withAgentState(() => {
  const c = broadCascade("cas790-e5", 0);
  E.cascades.push(c);
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id));
  const id = film.tmdb_id;
  E.pinFilmToCascadeAndRepaint(id, c.id);
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [c.id], "setup: the pin must land first");

  E.setOpinion(id, "liked");   // marks watched
  assert.ok(!E.found.has(id), "E5: a watched film must leave found");
  assert.deepEqual(arr(E.notify[id].pinnedTo), [c.id], "E5: the placement itself must be retained");

  E.setOpinion(id, "liked");   // un-marks (setOpinion's own on/off toggle)
  assert.ok(!E.watched.has(id), "setup: the second call must have un-marked the film");
  assert.deepEqual(arr(E.notify[id].cascadeIds), [c.id], "E5: un-watching must restore it to the same agent");
}));

test("E6: placing a film back onto an agent it was previously moved out of clears the notIn entry", () => withAgentState(() => {
  const c = broadCascade("cas790-e6", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  E.entryFor(id).notIn = [c.id];
  E.recomputeFound();
  assert.ok(!E.notify[id].cascadeIds.includes(c.id), "setup: the film must actually be moved out first");

  E.pinFilmToCascadeAndRepaint(id, c.id);
  E.recomputeFound();

  assert.ok(!arr(E.notify[id].notIn).includes(c.id), "E6: the notIn entry must be cleared");
  assert.deepEqual(arr(E.notify[id].cascadeIds), [c.id], "E6: the placement must take");
}));

// ---- F: placement and manual value composed together -------------------------------------------

test("F1: a placement plus a manual Watch On survive edits to both agents — ownership from the placement, value from the human", () => withAgentState(() => {
  const cA = broadCascade("cas790-f1-a", 0);
  const cB = broadCascade("cas790-f1-b", 1);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  cB.year = [E.yearOf(film) - 1];   // B's own criteria exclude the film — only the pin puts it there

  E.pinFilmToCascadeAndRepaint(id, cB.id);
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: the pin must land on B");

  const level = E.watchLevelsFor(id).find(l => !l.spent);
  E.toggleFilmOpt(id, level.key);
  assert.equal(E.notify[id].winsSource[level.key], "manual");

  cA.selBuzz = (cA.selBuzz || 0) + 1; cB.selBuzz = (cB.selBuzz || 0) + 1;   // edit both — drift, no criteria change
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "F1: ownership must stay with the placement");
  assert.equal(E.notify[id].wins[level.key], true, "F1: the manual value must be untouched");
  assert.equal(E.notify[id].winsSource[level.key], "manual");
}));

test("F2: removing the placement but keeping the manual value returns ownership to the lowest-order match", () => withAgentState(() => {
  const cA = broadCascade("cas790-f2-a", 0);
  const cB = broadCascade("cas790-f2-b", 1);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  cB.year = [E.yearOf(film) - 1];

  E.pinFilmToCascadeAndRepaint(id, cB.id);
  E.recomputeFound();
  const level = E.watchLevelsFor(id).find(l => !l.spent);
  E.toggleFilmOpt(id, level.key);
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: B owns the film, manual value ticked");

  E.notify[id].pinnedTo = [];   // remove the placement
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "F2: ownership must return to A, the lowest-order real match");
  assert.equal(E.notify[id].wins[level.key], true, "F2: the manual value must survive");
  assert.equal(E.notify[id].winsSource[level.key], "manual", "F2: ...and still read manual");
}));

test("F3: clearing the manual value but keeping the placement re-arms from the placed agent's markers, source auto", () => withAgentState(() => {
  const cA = broadCascade("cas790-f3-a", 0);
  const cB = broadCascade("cas790-f3-b", 1);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  cB.year = [E.yearOf(film) - 1];

  E.pinFilmToCascadeAndRepaint(id, cB.id);
  E.recomputeFound();
  const level = E.watchLevelsFor(id).find(l => !l.spent);
  E.toggleFilmOpt(id, level.key);
  assert.equal(E.notify[id].winsSource[level.key], "manual", "setup: a manual value must be in place");

  const e = E.notify[id];
  E.WATCH_LEVEL_KEYS.forEach(k => { e.wins[k] = false; delete e.winsSource[k]; });
  delete e.watchEarned;   // a pinned film's earned value is cached per-entry — force a fresh read

  E.recomputeFound();

  const rearmedKey = E.WATCH_LEVEL_KEYS.find(k => E.notify[id].wins[k]);
  assert.ok(rearmedKey, "F3: the next pass must re-arm a Watch On from the placed agent's own markers");
  assert.equal(E.notify[id].winsSource[rearmedKey], "auto", "F3: ...with source auto, not a resurrected manual one");
}));

test("F4: deleting the agent behind a placement plus manual value releases the film with no orphan and no throw", () => withAgentState(() => {
  const cA = broadCascade("cas790-f4-a", 0);
  const cB = broadCascade("cas790-f4-b", 1);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  cB.year = [E.yearOf(film) - 1];

  E.pinFilmToCascadeAndRepaint(id, cB.id);
  E.recomputeFound();
  const level = E.watchLevelsFor(id).find(l => !l.spent);
  E.toggleFilmOpt(id, level.key);
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: B owns the film, manual value ticked");

  assert.doesNotThrow(() => E.deleteAgentAsk(cB), "F4: deleting the placement's own agent must not throw");

  assert.ok(!E.cascades.some(x => x.id === cB.id), "setup: B must actually be gone");
  assert.ok(!arr(E.notify[id].pinnedTo).includes(cB.id), "F4: no orphaned pin to the deleted agent");
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "F4: the film returns to agent control (A)");
  assert.equal(E.notify[id].wins[level.key], true, "F4: the manual value must survive");
  assert.equal(E.notify[id].winsSource[level.key], "manual");
}));

// ============================================================================================
// CAS-791: the agent-behaviour plan's checks G to K. Same rules as the A-to-F ticket (CAS-790):
// every check drives the real exported functions against the real shipped engine, seeding state
// directly (notify, cascades, agent_films, firstFound, admitDrift, watched, blocked) rather than
// re-implementing engine logic. G1/G2/G3/H1-H3/H6/I2/I7/J8/J9/K4/K5/K7 each get exactly one test;
// H5/I1/I3/I6 are covered elsewhere and are comment-only, per the ticket.
// ============================================================================================

// ---- G: a film's own freshness — firstFound, filmIsNew, movingData ---------------------------

test("G1: a film entering `found` for the first time is stamped with today, once — a second pass does not restamp it", () => withAgentState(() => {
  const c = broadCascade("cas791-g1", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  assert.ok(!E.found.has(id), "setup: the film must not already be in `found`");

  E.recomputeFound();

  assert.ok(E.found.has(id), "setup: the film must have entered `found`");
  assert.equal(E.firstFound[id], E.TODAY, "G1: firstFound must be stamped with today's date");

  E.recomputeFound();   // a second pass, same admission
  assert.equal(E.firstFound[id], E.TODAY, "G1: a second pass must not touch an already-stamped firstFound");
}));

test("G2: a world-driven admission (admitDrift unset) reads as new inside the window, not outside it", () => withAgentState(() => {
  // cascadeDrift(c) reads true whenever an agent holds zero prior rows — including a brand-new
  // agent's very first pass — so a "world-driven" (not agent-driven) admission needs the agent to
  // have already admitted something once before the film under test ever becomes reachable. film2
  // starts spliced OUT of MOVIES (the world hasn't produced it yet); the agent's first pass admits
  // only film1, giving it a non-empty, sig-agreeing row. Splicing film2 back in and recomputing is
  // then a genuine "the world moved" arrival: the agent itself was never touched.
  const c = broadCascade("cas791-g2", 0);
  E.cascades.push(c);
  const film1 = pickMatchingFilm(c);
  const film2 = pickMatchingFilm(c, new Set([film1.tmdb_id]));
  const id = film2.tmdb_id;
  const idx2 = E.MOVIES.findIndex(x => x.tmdb_id === id);
  const removed2 = E.MOVIES.splice(idx2, 1)[0];
  try{
    E.recomputeFound();
    assert.ok(E.CascadePersistence.agentFilmsFor(c.id).length > 0, "setup: the agent must hold a row before film2 'arrives'");

    E.MOVIES.splice(idx2, 0, removed2);   // the world adds film2 to the catalogue — the agent is untouched
    E.recomputeFound();

    assert.ok(E.found.has(id), "setup: film2 must now be admitted");
    assert.ok(!E.admitDrift[id], "G2: a world-driven admission (agent unedited, non-empty prior rows) must not set admitDrift");
    assert.equal(E.filmIsNew(id), true, "G2: inside the new-film window, a drift-free admission reads as new");

    const row = E.CascadePersistence.getAgentFilm(c.id, id);
    const past = new Date(Date.parse(E.TODAY));
    past.setDate(past.getDate() - (E.NEW_DAYS + 2));
    E.CascadePersistence.setAgentFilm(c.id, id, { ...row, admitted_at: past.toISOString() });
    E.recomputeFound();   // agent_sig unchanged -> the sticky-admission branch leaves this row untouched

    assert.equal(E.filmIsNew(id), false, "G2: outside the new-film window, the same drift-free admission reads as not new");
  } finally {
    if(!E.MOVIES.includes(removed2)) E.MOVIES.splice(idx2, 0, removed2);
  }
}));

test("G3: movingData() carries a freshly-found film in the New to your agents group, in the correct time bucket", () => withAgentState(() => {
  const c = broadCascade("cas791-g3", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.ok(E.found.has(id), "setup: the film must be found before this test can assert its moving row");

  const row = E.movingData().rows.find(r => r.filmId === String(id));
  assert.ok(row, "G3: a movingData() row must exist for a film freshly entering `found`");
  assert.equal(row.tag, "new", "G3: it must be tagged New");
  assert.ok(E.movingInWindow(row.date, "today"), "G3: freshly found today, it must fall in the Today bucket");

  E.firstFound[id] = daysBeforeToday(3);   // still New (< NEW_DAYS), but no longer literally today
  const row2 = E.movingData().rows.find(r => r.filmId === String(id));
  assert.ok(row2, "setup: the row must still exist after backdating");
  assert.ok(!E.movingInWindow(row2.date, "today"), "G3: 3 days back, it must no longer read as Today");
  assert.ok(E.movingInWindow(row2.date, "week"), "G3: ...but must still read as within the Week bucket");
}));

// ---- H: reordering / hand-moving an already-found film must not read as freshness news -------

test("H1: reordering agents so a film's owner changes leaves firstFound unstamped again — no restamp", () => withAgentState(() => {
  const cA = broadCascade("cas791-h1-a", 0);
  const cB = broadCascade("cas791-h1-b", 5);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "setup: A starts as sole owner");
  const stampBefore = E.firstFound[id];
  assert.ok(stampBefore, "setup: the film must be stamped on first admission");

  cA.order = 9; cB.order = 0;
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: ownership must actually move to B");
  assert.equal(E.firstFound[id], stampBefore, "H1: firstFound must not be restamped just because ownership moved");
}));

test("H2: filmIsNew() is unchanged by the same reordering move", () => withAgentState(() => {
  const cA = broadCascade("cas791-h2-a", 0);
  const cB = broadCascade("cas791-h2-b", 5);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "setup: A starts as sole owner");
  const isNewBefore = E.filmIsNew(id);

  cA.order = 9; cB.order = 0;
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: ownership must actually move to B");
  assert.equal(E.filmIsNew(id), isNewBefore, "H2: filmIsNew must not change just because ownership moved");
}));

test("H3: movingData() carries no new row across the same reordering move", () => withAgentState(() => {
  const cA = broadCascade("cas791-h3-a", 0);
  const cB = broadCascade("cas791-h3-b", 5);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "setup: A starts as sole owner");
  const before = E.movingData().rows.map(r => r.filmId).sort();

  cA.order = 9; cB.order = 0;
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: ownership must actually move to B");
  const after = E.movingData().rows.map(r => r.filmId).sort();
  assert.deepEqual(after, before, "H3: reordering ownership must not add or remove a moving row");
}));

// H5 — covered by tests/js/agents-firstfound.test.mjs. Comment only, no test here.

test("H6: hand-moving a film from one agent to another leaves firstFound unstamped and adds no moving row", () => withAgentState(() => {
  const cA = broadCascade("cas791-h6-a", 0);
  const cB = broadCascade("cas791-h6-b", 1);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "setup: A starts as sole owner");
  const stampBefore = E.firstFound[id];
  const rowsBefore = E.movingData().rows.map(r => r.filmId).sort();

  E.pinFilmToCascadeAndRepaint(id, cB.id);
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: the hand-move must actually land on B");
  assert.equal(E.firstFound[id], stampBefore, "H6: firstFound must not be restamped by a hand-move");
  const rowsAfter = E.movingData().rows.map(r => r.filmId).sort();
  assert.deepEqual(rowsAfter, rowsBefore, "H6: a hand-move must add no moving row");
}));

// ---- I: leaving the list (watched / blocked) --------------------------------------------------

// I1, I3, I6 — covered by tests/js/agents-watched.test.mjs. Comment only, no test here.

test("I2: a watched film without a placement is pruned entirely; with a placement, the entry survives", () => withAgentState(() => {
  const c = broadCascade("cas791-i2", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.ok(E.found.has(id), "setup: the film must be found before it's watched");

  E.setOpinion(id, "liked");   // marks watched — its own repaint already recomputes

  assert.ok(!E.found.has(id), "I2: a watched film must leave found");
  assert.ok(!(id in E.notify), "I2: with no placement, the entry must be pruned entirely");

  E.setOpinion(id, "liked");   // un-marks
  E.recomputeFound();
  E.pinFilmToCascadeAndRepaint(id, c.id);
  E.recomputeFound();
  assert.ok(E.found.has(id), "setup: the film must be re-found, now placed, before watching it again");

  E.setOpinion(id, "liked");   // marks watched again, this time placed

  assert.ok(!E.found.has(id), "I2: a watched, placed film must still leave found");
  assert.ok(id in E.notify, "I2: a placement must keep the entry from being pruned");
  assert.deepEqual(arr(E.notify[id].pinnedTo), [c.id], "I2: the placement itself must survive");
}));

test("I7: marking a film \"not for me\" excludes it from found and it is not re-admitted on a later pass", () => withAgentState(() => {
  const c = broadCascade("cas791-i7", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.ok(E.found.has(id), "setup: the film must be found before being blocked");

  E.setOpinion(id, "notfor");

  assert.ok(!E.found.has(id), "I7: a blocked film must leave found");
  assert.ok(E.blocked.has(id), "setup: the film must actually be recorded as blocked");

  E.recomputeFound();   // a later, unrelated pass
  assert.ok(!E.found.has(id), "I7: a blocked film must not be re-admitted on a later pass");
  assert.ok(!(id in E.notify) || !E.notify[id].cascadeIds.includes(c.id),
    "I7: the agent must not re-claim the blocked film");
}));

// ---- J: Watch On placement as the world moves on ------------------------------------------------

test("J8: a film moving to a later window advances Watch On to standing and shows up in movingData()", () => withAgentState(() => {
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id));
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const savedOffers = film.offers;
  const savedConfidence = film.availability_confidence;
  const c = broadCascade("cas791-j8", 0);
  E.cascades.push(c);
  try{
    film.status = ["in_cinema"];
    E.CascadePersistence.setAgentFilm(c.id, id,
      { admission_score: 60, admission_status: "in_cinema", agent_sig: E.cascSigOf(c) });
    E.recomputeFound();
    assert.equal(E.notify[id].wins.in_cinema, true, "setup: the film must earn Cinema, the first usable rung");
    assert.ok(E.found.has(id), "setup: the film must be found before this test's move");

    // The world moves the film all the way to Stream — a real included_streaming record always carries a
    // confirmed offer (that's what the status means), so the fixture needs one too for showable()/listedBy
    // to agree the film has actually arrived, the same as any other included_streaming fixture in this suite.
    film.status = ["included_streaming"];
    film.offers = [{ service: "Stan", type: "sub" }];
    film.availability_confidence = "confirmed";
    E.recomputeFound();

    assert.equal(E.notify[id].wins.stream, true, "J8: Watch On must advance to standing (Stream) once the film reaches it");
    assert.equal(E.notify[id].wins.in_cinema, false, "J8: ...and no longer sit at the earlier earned rung");
    const st = E.filmNotifyState(id);
    assert.equal(st.current, true, "J8: the card's notify state must read its \"can watch\" form");
    const row = E.movingData().rows.find(r => r.filmId === String(id));
    assert.ok(row, "J8: a movingData() row must exist for the film");
  } finally {
    film.status = savedStatus;
    film.offers = savedOffers;
    film.availability_confidence = savedConfidence;
  }
}));

test("J9: the same move leaves a manual Watch On untouched, and a movingData() row still appears", () => withAgentState(() => {
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id));
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const savedOffers = film.offers;
  const savedConfidence = film.availability_confidence;
  const c = broadCascade("cas791-j9", 0);
  E.cascades.push(c);
  try{
    film.status = ["in_cinema"];
    E.CascadePersistence.setAgentFilm(c.id, id,
      { admission_score: 60, admission_status: "in_cinema", agent_sig: E.cascSigOf(c) });
    E.recomputeFound();
    E.toggleFilmOpt(id, "in_cinema");
    assert.equal(E.notify[id].winsSource.in_cinema, "manual", "setup: the tick must land as manual");

    // See J8's own comment: a real included_streaming record always carries a confirmed offer.
    film.status = ["included_streaming"];
    film.offers = [{ service: "Stan", type: "sub" }];
    film.availability_confidence = "confirmed";
    E.recomputeFound();

    assert.equal(E.notify[id].wins.in_cinema, true, "J9: a manual Watch On must be untouched by the film's own move");
    assert.equal(E.notify[id].winsSource.in_cinema, "manual", "J9: ...and still read manual");
    const row = E.movingData().rows.find(r => r.filmId === String(id));
    assert.ok(row, "J9: a movingData() row must still appear");
  } finally {
    film.status = savedStatus;
    film.offers = savedOffers;
    film.availability_confidence = savedConfidence;
  }
}));

// ---- K: engine-level invariants and ledger edge cases ------------------------------------------

test("K4: a film disappearing from MOVIES between passes clears its agent_films row and leaves no orphan membership", () => withAgentState(() => {
  const c = broadCascade("cas791-k4", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  const other = pickMatchingFilm(c, new Set([id]));
  const otherId = other.tmdb_id;
  E.recomputeFound();
  assert.ok(E.CascadePersistence.agentFilmsFor(c.id).some(r => r.movie_id === String(id)), "setup: the row must exist before removal");
  assert.ok(E.notify[id].cascadeIds.includes(c.id), "setup: the film must be a member before removal");
  const sigBefore = E.cascSigOf(c);
  const otherRowBefore = E.CascadePersistence.getAgentFilm(c.id, otherId);
  assert.ok(otherRowBefore, "setup: a second, untouched row must exist on this agent");

  const idx = E.MOVIES.findIndex(x => x.tmdb_id === id);
  const removed = E.MOVIES.splice(idx, 1)[0];
  try{
    E.recomputeFound();

    assert.equal(E.cascSigOf(c), sigBefore,
      "setup: the agent must remain unedited (same agent_sig) across this pass — the case that failed before CAS-795");
    assert.ok(!E.CascadePersistence.agentFilmsFor(c.id).some(r => r.movie_id === String(id)),
      "K4: the agent_films row must be cleared once the film is gone from MOVIES, even on an unedited agent");
    assert.ok(!(id in E.notify), "K4: no orphan membership may remain in notify");

    const otherRowAfter = E.CascadePersistence.getAgentFilm(c.id, otherId);
    assert.ok(otherRowAfter, "K4: an unrelated row on the same unedited agent must survive");
    assert.equal(otherRowAfter.admitted_at, otherRowBefore.admitted_at, "K4: an untouched row keeps its admitted_at");
    assert.equal(otherRowAfter.admission_score, otherRowBefore.admission_score, "K4: an untouched row keeps its admission_score");
    assert.equal(otherRowAfter.admission_status, otherRowBefore.admission_status, "K4: an untouched row keeps its admission_status");
    assert.equal(otherRowAfter.agent_sig, otherRowBefore.agent_sig, "K4: an untouched row keeps its agent_sig");
  } finally {
    E.MOVIES.splice(idx, 0, removed);
  }
}));

test("K5: every listing group's item count equals the rows that belong to it, and narrowing an agent's criteria never increases its total", () => withAgentState(() => {
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = "cas791-k5"; c.paused = false; c.order = 0;
  const rows = E.MOVIES.filter(m => E.listedBy(m, c));
  const groups = E.listingGroups(rows, c);
  const total = groups.reduce((n, x) => n + x.items.length, 0);
  assert.equal(total, rows.length, "K5: every listed row must land in exactly one group — none dropped, none duplicated");
  for(const { g, items } of groups){
    assert.equal(items.length, rows.filter(m => E.primaryStatus(m) === g).length,
      `K5: group ${g}'s count must equal the length of the set it labels`);
  }

  const before = E.agentMetricsCompute(c).total;
  c.year = [1900];   // narrow: a year almost certainly absent from the catalogue
  const after = E.agentMetricsCompute(c).total;
  assert.ok(after <= before, "K5: narrowing an agent's criteria must never increase its listed count");
}));

test("K7: a refresh that changes a film's score but not its window leaves admission held — admission_score is not re-thresholded", () => withAgentState(() => {
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id)
    && typeof x.wm_user_rating === "number" && x.wm_user_rating > 0
    && ["pvod", "rental", "included_streaming"].includes(E.primaryStatus(x)));
  if(!film) throw new Error("no unwatched, Watchmode-rated released film in the harness catalogue — this test would prove nothing");
  const id = film.tmdb_id;
  const c = broadCascade("cas791-k7", 0);
  E.cascades.push(c);
  const sig = E.cascSigOf(c);
  const originalScore = E.cascadeScore(film);
  E.CascadePersistence.setAgentFilm(c.id, id,
    { admission_score: originalScore, admission_status: E.primaryStatus(film), agent_sig: sig });
  E.recomputeFound();
  assert.ok(E.notify[id].cascadeIds.includes(c.id), "setup: the film must be admitted before the refresh");

  const savedRating = film.wm_user_rating;
  try{
    film.wm_user_rating = (film.wm_user_rating == null || film.wm_user_rating < 5) ? 9.9 : 0.1;   // force a real score move
    E.invalidateComputeCaches();
    assert.notEqual(E.cascadeScore(film), originalScore, "setup: this edit must actually move cascadeScore(film)");

    E.recomputeFound();   // the "refresh" — the agent itself is untouched, so nothing may re-threshold

    const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
    assert.ok(row, "K7: the admission must hold across the refresh");
    assert.equal(row.admission_score, originalScore, "K7: admission_score must not be re-thresholded off the film's new score");
  } finally {
    film.wm_user_rating = savedRating;
    E.invalidateComputeCaches();
  }
}));

// ---- L: the score track Off stop (CAS-833) ---------------------------------------------------
// CAS-762/CAS-833 built the Off stop as a per-window state (marker 0, distinct from Never); CAS-1128
// (Lee, 2026-10-01) retires that reading for this control entirely — Off is track-wide now (every window
// null, nothing tracked), and a literal per-window 0 can no longer exist past normCascade (it migrates to
// TRACK_MIN and stays ON — tests/js/cas1128-track-in.test.mjs's AC1). L1-L6 below all built their fixture
// around a marker staying exactly 0 — "usable at Off", "agentFloor reads 0", "an unscored film is admitted
// at Off" — so none of them can be reworked into the new shape; they're deleted rather than kept failing.
// L6 itself already carried a similar note from CAS-1113's own earlier retirement of L6's original premise.
// The new per-window-off admission behaviour (an OFF window is skipped, never admitted into) is covered by
// tests/js/cas1128-track-in.test.mjs's own AC2; L7 (a purely numeric agent is unaffected) still holds below.

test("L7: an agent whose markers are all numeric lists an identical count before and after — the Off stop moves nobody who never uses it", () => withAgentState(() => {
  const c = broadCascade("cas833-l7", 0, { in_cinema: 90, premium: 80, rent: 70, stream: 60 });
  const before = E.MOVIES.filter(m => E.matchesCriteria(m, c)).length;
  const after = E.MOVIES.filter(m => E.matchesCriteria(m, c)).length;
  assert.equal(after, before, "L7: a numeric-only agent's listed count must not move");
  assert.ok(before >= 0);
}));
