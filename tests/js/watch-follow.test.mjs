// CAS-917: the start-window model — a later enabled window can never be Never once an agent has a start
// window (its earliest marker-carrying window in ladder order). Drives the shipped engine out of the built
// index.html via tests/js/engine.mjs (CAS-231's own harness), never a re-implementation of the decision.
// Not part of `npm run qa` — run on request with `node --test tests/js/watch-follow.test.mjs` (AC9).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// Cinema/Rental/Streaming usable, Premium off — the ticket's own account fixture (AC1's "Account windows
// in_cinema, rent, stream switched on").
const WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}
// Same state-isolation shape as tests/js/agents.test.mjs's withState — every piece of mutable engine state
// a check here might touch, restored so nothing leaks into a later test in this file or another.
function withState(fn){
  const savedNotify = { ...E.notify };
  const savedCascades = [...E.cascades];
  const savedFirstFound = { ...E.firstFound };
  const savedAdmitDrift = { ...E.admitDrift };
  const savedWatched = new Set(E.watched), savedBlocked = new Set(E.blocked);
  const savedFWR = E.CascadePersistence.filmWatchReady, savedAFR = E.CascadePersistence.agentFilmsReady;
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
    E.found.clear();
    E.CascadePersistence.filmWatchReady = savedFWR;
    E.CascadePersistence.agentFilmsReady = savedAFR;
  }
}
function withAgentState(fn){ withState(() => withWatchPrefs(WATCH_PREFS, fn)); }

function broadCascade(id, order, watchMarkers){
  const c = E.normCascade({ kind: "stream", status: [], watchMarkers });
  c.id = id; c.paused = false; c.order = order;
  return c;
}

// A fresh, never-reused catalogue film — status and admission are both forced directly (CascadePersistence.
// setAgentFilm, same technique as agents.test.mjs's B5), decoupled from whatever the real catalogue happens
// to contain, exactly like the rest of this suite's fixtures.
const usedIds = new Set();
function nextFilm(){
  const m = E.MOVIES.find(x => !usedIds.has(x.tmdb_id) && !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id));
  if(!m) throw new Error("ran out of fixture films — this test would prove nothing");
  usedIds.add(m.tmdb_id);
  return m;
}
// Forces a film straight into an agent's agent_films ledger at an exact admission_score/status, bypassing
// matchesCriteria/watchesFilm entirely — the ledger's own sticky-admission read (recomputeFound's priorRows
// walk) is what's under test here, not whether this film would naturally match a broad agent's criteria.
function admitFilm(c, m, admission_score, status){
  m.status = [status];
  E.CascadePersistence.setAgentFilm(c.id, m.tmdb_id, { admission_score, admission_status: status, agent_sig: E.cascSigOf(c) });
  return m.tmdb_id;
}

test("CAS-917 AC1 a-g: Cinema never · Rent 70+ · Stream follows — placement and provenance", () => withAgentState(() => {
  const c = broadCascade("cas917-ac1", 0, { in_cinema: null, premium: null, rent: 70, stream: null });
  E.cascades.push(c);

  const filmA = nextFilm(), savedA = filmA.status;
  const filmB = nextFilm(), savedB = filmB.status;
  const filmD = nextFilm(), savedD = filmD.status;
  const filmE = nextFilm(), savedE = filmE.status;
  const filmF = nextFilm(), savedF = filmF.status;
  try{
    // (a) admission_score 75, status rental -> rent
    const idA = admitFilm(c, filmA, 75, "rental");
    E.recomputeFound();
    assert.equal(E.filmNotifyState(idA).key, "rent", "a: 75 in rental must place at rent");

    // (b) admission_score 75, status included_streaming -> stream
    const idB = admitFilm(c, filmB, 75, "included_streaming");
    E.recomputeFound();
    assert.equal(E.filmNotifyState(idB).key, "stream", "b: 75 in streaming must place at stream");

    // (c) the film from (a), after its status changes to included_streaming and the pass re-runs -> stream,
    // with winsSource.stream === "auto"
    filmA.status = ["included_streaming"];
    E.recomputeFound();
    assert.equal(E.filmNotifyState(idA).key, "stream", "c: an admitted, unwatched film must move forward to stream");
    assert.equal(E.notify[idA].winsSource.stream, "auto", "c: the forward move must be recorded as auto");

    // (d) admission_score 75, status in_cinema -> rent
    const idD = admitFilm(c, filmD, 75, "in_cinema");
    E.recomputeFound();
    assert.equal(E.filmNotifyState(idD).key, "rent", "d: in_cinema must snap forward to rent, its start window");

    // (e) score 65 -> not admitted, no Watch On
    const idE = admitFilm(c, filmE, 65, "rental");
    E.recomputeFound();
    assert.equal(E.filmNotifyState(idE).key, null, "e: below every marker must leave no Watch On");

    // (f) a film with a manual rent win, status included_streaming -> stays rent
    const idF = admitFilm(c, filmF, 75, "rental");
    E.recomputeFound();
    assert.equal(E.filmNotifyState(idF).key, "rent", "setup: f must start at rent");
    E.toggleFilmOpt(idF, "rent");   // claims the auto-armed level as manual (CAS-751)
    assert.equal(E.notify[idF].winsSource.rent, "manual", "setup: f's rent win must now be manual");
    filmF.status = ["included_streaming"];
    E.recomputeFound();
    // Asserted against notify directly, not filmNotifyState(id).key: once the film's real status has moved
    // two rungs past rent, watchLevelsFor's own pre-existing (CAS-473) "spent" rule excludes rent from the
    // offered levels regardless of which key holds the win, manual or auto — a display-layer concern this
    // ticket's Change section does not touch. recomputeFound's own placement decision is what's under test.
    assert.equal(E.notify[idF].wins.rent, true, "f: a manual win must never move forward");
    assert.equal(E.notify[idF].winsSource.rent, "manual", "f: the win must still read manual");
    assert.equal(E.notify[idF].wins.stream, false, "f: stream must never be armed over a manual rent win");

    // (g) filmMatchesWatchTab(m,"stream") is true for (b) and (c)
    assert.equal(E.filmMatchesWatchTab(filmB, "stream"), true, "g: (b) must match the Streaming tab");
    assert.equal(E.filmMatchesWatchTab(filmA, "stream"), true, "g: (c) must match the Streaming tab");
  } finally{
    filmA.status = savedA; filmB.status = savedB; filmD.status = savedD;
    filmE.status = savedE; filmF.status = savedF;
  }
}));

test("CAS-917 AC2: Cinema 90 · Rent none · Stream none — a later window with no marker still follows", () => withAgentState(() => {
  const c = broadCascade("cas917-ac2", 0, { in_cinema: 90, premium: null, rent: null, stream: null });
  E.cascades.push(c);

  const filmRental = nextFilm(), savedRental = filmRental.status;
  const filmStream = nextFilm(), savedStream = filmStream.status;
  try{
    const idRental = admitFilm(c, filmRental, 92, "rental");
    E.recomputeFound();
    assert.equal(E.filmNotifyState(idRental).key, "rent", "status rental must place at rent");

    const idStream = admitFilm(c, filmStream, 92, "included_streaming");
    E.recomputeFound();
    assert.equal(E.filmNotifyState(idStream).key, "stream", "status included_streaming must place at stream");
  } finally{
    filmRental.status = savedRental; filmStream.status = savedStream;
  }
}));

test("CAS-917 AC3: stream switched off account-wide — an account-off window is still skipped, not followed", () => withAgentState(() => {
  withWatchPrefs({ stream: { list: false, notify: false } }, () => {
    const c = broadCascade("cas917-ac3", 0, { in_cinema: null, premium: null, rent: 70, stream: null });
    E.cascades.push(c);
    const film = nextFilm(), saved = film.status;
    try{
      const id = admitFilm(c, film, 75, "included_streaming");
      E.recomputeFound();
      // Asserted against notify directly, not filmNotifyState(id).key: the film's real status is two rungs
      // past rent, so watchLevelsFor's own pre-existing (CAS-473) "spent" rule excludes rent from the
      // offered levels regardless of which key holds the win — a display-layer concern this ticket's Change
      // section does not touch. recomputeFound's own placement decision is what's under test.
      assert.equal(E.notify[id].wins.rent, true,
        "with stream off account-wide, a film in streaming must resolve to rent, not stream");
      assert.equal(E.notify[id].wins.stream, false, "stream must never be armed while its window is off");
    } finally{
      film.status = saved;
    }
  });
}));

test("CAS-917 AC4: msnValueLine names every enabled window at or after the start, followed windows included", () => withWatchPrefs(WATCH_PREFS, () => {
  const c1 = broadCascade("cas917-ac4-1", 0, { in_cinema: null, premium: null, rent: 70, stream: null });
  assert.equal(E.msnValueLine(c1),
    "Lists films scoring 70+ wherever they are now — to rent or streaming — and follows each one to the next. Under 70, not listed.");

  const c2 = broadCascade("cas917-ac4-2", 1, { in_cinema: 90, premium: null, rent: null, stream: null });
  assert.equal(E.msnValueLine(c2),
    "Lists films scoring 90+ wherever they are now — at the cinema, to rent or streaming — and follows each one to the next. Under 90, not listed.");
}));

test("CAS-917 AC5: msnChipsHTML — a followed window shows a plain ✓, a window before the start offers ＋", () => withWatchPrefs(WATCH_PREFS, () => {
  const c = broadCascade("cas917-ac5", 0, { in_cinema: null, premium: null, rent: 70, stream: null });
  const html = E.msnChipsHTML(c);
  assert.match(html, /data-act="msn-start-add" data-key="in_cinema"/,
    "a window before the start window must offer to move the start back to it");
  assert.match(html, /data-act="msn-start-remove" data-key="rent"/,
    "the start window's own chip must offer to remove it");
  assert.match(html, /Stream<\/span><span class="msnchipck"/,
    "a followed window (after the start, no marker of its own) must show a plain ✓ right after its label");
  assert.doesNotMatch(html, /data-key="stream"/,
    "a followed window's chip must carry no button/control at all — data-key only ever lives on one");
}));
