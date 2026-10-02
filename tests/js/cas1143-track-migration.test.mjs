// CAS-1143: an agent saved before CAS-1128's independent-toggle model tracked every window from its
// start window onward (CAS-917's old chain) — CAS-1128 (b1348fe) switched windowFollowed to plain
// windowUsable with no migration, so an agent stored cinema-only lost Rent and Streaming outright. This
// pins normCascade's one-time trackV-guarded migration, the Massive Movies recipe fix it required, and
// the engine-level placement it restores.
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

test("AC1: normCascade migrates an un-migrated agent's start window forward and stamps trackV:2, leaving a v2 agent untouched", () => {
  const a = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 85, premium: null, rent: null, stream: null } });
  assert.deepEqual(a.watchMarkers, { in_cinema: 85, premium: 85, rent: 85, stream: 85 });
  assert.equal(a.trackV, 2);

  const b = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: null, premium: null, rent: 75, stream: null } });
  assert.deepEqual(b.watchMarkers, { in_cinema: null, premium: null, rent: 75, stream: 75 });
  assert.equal(b.trackV, 2);

  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: null, premium: null, rent: null, stream: null } });
  assert.deepEqual(c.watchMarkers, { in_cinema: null, premium: null, rent: null, stream: null });
  assert.equal(c.trackV, 2);

  const d = E.normCascade({ kind: "stream", status: [], trackV: 2,
    watchMarkers: { in_cinema: 85, premium: null, rent: null, stream: null } });
  assert.deepEqual(d.watchMarkers, { in_cinema: 85, premium: null, rent: null, stream: null },
    "AC1: an agent already carrying trackV:2 must be returned unchanged");
  assert.equal(d.trackV, 2);
});

test("AC2: buildOnbAgentsV2's Massive Movies agent shares one score across its BIG window and everything later, and every returned agent is stamped trackV:2", () => {
  const agents = E.buildOnbAgentsV2({ cinema: "yes" });
  const massive = agents.find(a => a.template === "onb_massive");
  assert.ok(massive, "setup: cinema:'yes' must still produce a Massive Movies agent");
  assert.ok(massive.watchMarkers.in_cinema != null, "AC2: in_cinema must be armed");
  assert.equal(massive.watchMarkers.rent, massive.watchMarkers.in_cinema,
    "AC2: rent must share the same score as in_cinema (BIG window onward)");
  assert.equal(massive.watchMarkers.stream, massive.watchMarkers.in_cinema,
    "AC2: stream must share the same score as in_cinema (BIG window onward)");
  agents.forEach(a => assert.equal(a.trackV, 2, `AC2: every onboarding agent must be stamped trackV:2 (${a.template} was not)`));
});

test("AC3: a cinema-only agent saved before CAS-1128 (no trackV) follows an admitted film onto Stream once it leaves cinemas", () => withAgentState(() => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 60, premium: null, rent: null, stream: null } });
  assert.equal(c.trackV, 2, "setup: normCascade must have migrated and stamped this agent");
  assert.ok(c.watchMarkers.stream != null, "setup: migration must have armed stream");
  c.id = "cas1143-ac3"; c.paused = false; c.order = 0;

  E.cascades.push(c);
  const film = nextFilm(), saved = film.status;
  try{
    const id = admitFilm(c, film, c.watchMarkers.stream, "included_streaming");
    E.recomputeFound();
    assert.equal(E.filmNotifyState(id).key, "stream",
      "AC3: a migrated cinema-only agent must follow its admitted film onto Stream");
    assert.equal(E.filmMatchesWatchTab(film, "stream"), true,
      "AC3: filmMatchesWatchTab must agree the film belongs on the Streaming tab");
  } finally{
    film.status = saved;
  }
}));
