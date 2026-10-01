// CAS-1128: the Cascade score control becomes one brand-gradient slider plus independent per-window
// toggles ("Track in: Cinema / Rent / Stream") — superseding CAS-917's start-window-forward model and
// CAS-762's "Off means any score" reading for this control. These pin the ACs the ticket names directly.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// Default watchPrefsDefaults(): in_cinema/rent/stream enabled, premium off.
const WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}
function withAgentState(fn){
  const savedNotify = { ...E.notify };
  const savedCascades = [...E.cascades];
  const savedFirstFound = { ...E.firstFound };
  const savedAdmitDrift = { ...E.admitDrift };
  try{ withWatchPrefs(WATCH_PREFS, fn); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    Object.keys(E.firstFound).forEach(k => delete E.firstFound[k]);
    Object.assign(E.firstFound, savedFirstFound);
    Object.keys(E.admitDrift).forEach(k => delete E.admitDrift[k]);
    Object.assign(E.admitDrift, savedAdmitDrift);
    E.found.clear();
  }
}
function broadCascade(id, watchMarkers){
  const c = E.normCascade({ kind: "stream", status: [], watchMarkers });
  c.id = id; c.paused = false; c.order = 0;
  return c;
}
function admitFilm(c, m, admission_score, status){
  m.status = [status];
  E.CascadePersistence.setAgentFilm(c.id, m.tmdb_id, { admission_score, admission_status: status, agent_sig: E.cascSigOf(c) });
  return m.tmdb_id;
}
const usedIds = new Set();
function nextFilm(){
  const m = E.MOVIES.find(x => !usedIds.has(x.tmdb_id) && !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id));
  if(!m) throw new Error("ran out of fixture films — this test would prove nothing");
  usedIds.add(m.tmdb_id);
  return m;
}

test("AC1: normCascade collapses armed markers to their own floor; a legacy per-window Off (0) migrates to TRACK_MIN on every window it touches", () => {
  const a = E.normCascade({ kind: "stream", status: [], watchMarkers: { in_cinema: 90, rent: 70, stream: 60 } });
  assert.deepEqual(a.watchMarkers, { in_cinema: 60, rent: 60, stream: 60 });

  const b = E.normCascade({ kind: "stream", status: [], watchMarkers: { in_cinema: null, rent: 0, stream: 0 } });
  assert.equal(b.watchMarkers.rent, 50, "a legacy Off (0) marker must migrate to TRACK_MIN (50), not stay 0");
  assert.equal(b.watchMarkers.stream, 50);
});

test("AC2: windowFollowed is false for an OFF window even once a later window is ON; placement only follows a film into a window this agent has switched on", () => withAgentState(() => {
  const c = broadCascade("cas1128-ac2", { in_cinema: 67, rent: null, stream: 67 });
  assert.equal(E.windowFollowed(c, "rent"), false, "AC2: an OFF window must never read as followed");
  assert.equal(E.windowFollowed(c, "stream"), true, "AC2: an ON window must read as followed");

  E.cascades.push(c);
  const film = nextFilm(), saved = film.status;
  try{
    const id = admitFilm(c, film, 70, "rental");   // rent is OFF for this agent
    E.recomputeFound();
    assert.equal(E.notify[id] && E.notify[id].wins.rent, undefined !== E.notify[id] ? E.notify[id].wins.rent : false,
      "setup check only — see the explicit assertion below");
    assert.ok(!E.notify[id] || !E.notify[id].wins.rent, "AC2: a 70-score film at an OFF window (rent) must not be listed there");

    film.status = ["included_streaming"];
    E.recomputeFound();
    assert.equal(E.filmNotifyState(id).key, "stream", "AC2: the same film must be listed once it reaches an ON window (stream)");
  } finally{
    film.status = saved;
  }
}));

test("AC3: msnValueLine names the ON windows at the shared score, and reads Off once every window is OFF", () => {
  const c = E.normCascade({ kind: "stream", status: [], watchMarkers: { in_cinema: 67, rent: null, stream: 67 } });
  assert.equal(E.msnValueLine(c),
    "Lists films scoring 67+ at the cinema or streaming — and follows each one from window to window. Under 67, not listed.");

  const off = E.normCascade({ kind: "stream", status: [], watchMarkers: { in_cinema: null, rent: null, stream: null } });
  assert.equal(E.msnValueLine(off), "Off — this agent isn't tracking anything.");
});

test("AC4: the slider/pill mutators — drag to Off nulls every marker, drag from Off arms every enabled window, unticking the last ON pill drops to Off", () => withWatchPrefs(WATCH_PREFS, () => {
  const c = E.normCascade({ kind: "stream", status: [], watchMarkers: { in_cinema: 80, premium: null, rent: 80, stream: 80 } });

  E.setAgentScore(c, 0);
  assert.deepEqual(c.watchMarkers, { in_cinema: null, premium: null, rent: null, stream: null },
    "AC4: dragging to Off must null every marker");

  E.setAgentScore(c, 72);
  assert.deepEqual(c.watchMarkers, { in_cinema: 72, premium: null, rent: 72, stream: 72 },
    "AC4: dragging from Off to 72 must set every account-enabled window to 72 (premium stays off-account, so null)");

  E.toggleAgentWindow(c, "in_cinema");   // unticking one of three ON pills
  assert.deepEqual(c.watchMarkers, { in_cinema: null, premium: null, rent: 72, stream: 72 },
    "AC4: unticking one ON pill (not the last) must leave the others exactly as they were");

  E.toggleAgentWindow(c, "rent");
  E.toggleAgentWindow(c, "stream");   // the last ON pill
  assert.deepEqual(c.watchMarkers, { in_cinema: null, premium: null, rent: null, stream: null },
    "AC4: unticking the last ON pill must leave every marker null");
}));

test("AC5: msnTrackAreaHTML draws exactly one .msnhandle and one pill per enabled window, ON matching the markers", () => withWatchPrefs(WATCH_PREFS, () => {
  const c = E.normCascade({ kind: "stream", status: [], watchMarkers: { in_cinema: 70, rent: null, stream: 70 } });
  const html = E.msnTrackAreaHTML(c);

  const handleCount = (html.match(/class="msnhandle"/g) || []).length;
  assert.equal(handleCount, 1, `expected exactly one .msnhandle, got ${handleCount}: ${html}`);

  const pillCount = (html.match(/class="msnpill (on|off)"/g) || []).length;
  assert.equal(pillCount, 3, `expected one pill per enabled window (cinema/rent/stream), got ${pillCount}: ${html}`);
  assert.match(html, /class="msnpill on" data-act="msn-pill-toggle" data-key="in_cinema"/);
  assert.match(html, /class="msnpill off" data-act="msn-pill-toggle" data-key="rent"/);
  assert.match(html, /class="msnpill on" data-act="msn-pill-toggle" data-key="stream"/);
}));
