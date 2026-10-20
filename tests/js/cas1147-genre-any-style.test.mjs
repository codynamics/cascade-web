// CAS-1318: an agent's Styles match a film by its MAIN style only (m.genres[0], TMDB's lead genre) —
// supersedes CAS-1147's "ANY of the film's styles counts" rule. AC1-AC3 below drive the real shipped
// engine (tests/js/engine.mjs's loadEngine(), reading the BUILT index.html) directly, never a
// re-derivation of matchesCriteria's/cascSigOf's own rules.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function agentWith(overrides){
  return E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 0, premium: null, rent: 0, stream: 0 }, ...overrides });
}
// Clone a real, currently-admitted film so every OTHER requirement matchesCriteria checks (language,
// score, offers, window...) is already satisfied by construction — the same cloning technique
// tests/js/agents.test.mjs's withUnscoredMatch uses, so only the genre dimension under test varies.
function donorFilm(){
  const openCascade = agentWith({ genre: [] });
  const donor = E.MOVIES.find(m => E.matchesCriteria(m, openCascade));
  if(!donor) throw new Error("no film in the harness catalogue is admitted by a fully-open agent — this test would prove nothing");
  return donor;
}

// ---- AC1: matchesCriteria tests only the film's MAIN style (m.genres[0]) ---------------------

test("CAS-1318 AC1: a film carrying the wanted style FIRST matches", () => {
  const film = { ...donorFilm(), genres: ["Action", "Drama"] };
  const c = agentWith({ genre: ["Action"] });
  assert.equal(E.matchesCriteria(film, c), true);
});

test("CAS-1318 AC1: the same style SECOND no longer matches — main style only", () => {
  const film = { ...donorFilm(), genres: ["Drama", "Action"] };
  const c = agentWith({ genre: ["Action"] });
  assert.equal(E.matchesCriteria(film, c), false);
});

test("CAS-1318 AC1: a secondary style off the on-list no longer rejects a film whose main style is on", () => {
  const film = { ...donorFilm(), genres: ["War", "Action", "History"] };
  const c = agentWith({ genre: ["Action"] });
  assert.equal(E.matchesCriteria(film, c), false);
});

test("CAS-1318 AC1: a film carrying none of the wanted styles does not match", () => {
  const film = { ...donorFilm(), genres: ["Drama", "Comedy"] };
  const c = agentWith({ genre: ["Science Fiction"] });
  assert.equal(E.matchesCriteria(film, c), false);
});

test("CAS-1318 AC1: an empty style list never rejects on genre", () => {
  const film = { ...donorFilm(), genres: ["Drama", "Comedy"] };
  const c = agentWith({ genre: [] });
  assert.equal(E.matchesCriteria(film, c), true);
});

test("CAS-1318 AC1: a null style list admits nothing", () => {
  const film = { ...donorFilm(), genres: ["Drama", "Comedy"] };
  const c = agentWith({ genre: null });
  assert.equal(E.matchesCriteria(film, c), false);
});

// ---- AC2: an open style list with an exclude still subtracts from the on-list by MAIN style ----

test("CAS-1318 AC2: the excluded style as MAIN is rejected even with genre open", () => {
  const film = { ...donorFilm(), genres: ["Horror", "Comedy"] };
  const c = agentWith({ genre: [], exclude: ["Horror"] });
  assert.equal(E.matchesCriteria(film, c), false);
});

test("CAS-1318 AC2: the excluded style as SECONDARY is admitted — exclude only ever reads the main style", () => {
  const film = { ...donorFilm(), genres: ["Comedy", "Horror"] };
  const c = agentWith({ genre: [], exclude: ["Horror"] });
  assert.equal(E.matchesCriteria(film, c), true);
});

// ---- the GENRE_RULE_V bump: a rule-change admission reads as news about the agent, not the film ----

function withAgentFilmsState(fn){
  const savedCascades = [...E.cascades];
  const savedFirstFound = { ...E.firstFound };
  const savedAdmitDrift = { ...E.admitDrift };
  const savedFWR = E.CascadePersistence.filmWatchReady, savedAFR = E.CascadePersistence.agentFilmsReady;
  try{ fn(); }
  finally{
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    Object.keys(E.firstFound).forEach(k => delete E.firstFound[k]);
    Object.assign(E.firstFound, savedFirstFound);
    Object.keys(E.admitDrift).forEach(k => delete E.admitDrift[k]);
    Object.assign(E.admitDrift, savedAdmitDrift);
    E.found.clear();
    E.CascadePersistence.filmWatchReady = savedFWR;
    E.CascadePersistence.agentFilmsReady = savedAFR;
  }
}
function daysBeforeToday(n){
  const d = new Date(Date.parse(E.TODAY));
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

test("CAS-1318: a pre-rule-change agent_films row re-admitted under the new rule carries admitDrift, not filmIsNew", () => withAgentFilmsState(() => {
  const c = agentWith({ genre: ["Science Fiction"] });
  c.id = "cas1318-genrerulev"; c.order = 0;
  E.cascades.push(c);

  // An existing, long-admitted film (main-style match, still admitted under the new rule) — stamped
  // with a signature that predates this ticket's GENRE_RULE_V bump (2 -> 3), exactly as a real
  // pre-migration agent_films row would read, so this cascade's own cascadeDrift reads true on the
  // very next recomputeFound() pass.
  const anchor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && !E.blocked.has(m.tmdb_id)
    && (m.genres||[])[0] === "Science Fiction" && E.matchesCriteria(m, c));
  if(!anchor) throw new Error("no main-style Science-Fiction film in the harness catalogue matches this agent — this test would prove nothing");
  E.CascadePersistence.setAgentFilm(c.id, anchor.tmdb_id, {
    admission_score: E.cascadeScore(anchor), admission_status: E.primaryStatus(anchor),
    agent_sig: "pre-cas1318-sig",
  });
  E.firstFound[anchor.tmdb_id] = daysBeforeToday(10);

  // A second main-style match this cascade has never seen before — the rule-version bump alone must
  // be enough to re-admit it as news about the AGENT, even though its own admission is unchanged.
  const target = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && !E.blocked.has(m.tmdb_id)
    && m.tmdb_id !== anchor.tmdb_id && (m.genres||[])[0] === "Science Fiction" && E.matchesCriteria(m, c));
  if(!target) throw new Error("no second main-style Science-Fiction film in the harness catalogue matches this agent — this test would prove nothing");
  assert.ok(!E.firstFound[target.tmdb_id], "setup: the target film must never have been found before");

  E.recomputeFound();

  assert.ok(E.found.has(target.tmdb_id), "a main-style match must still be admitted under the new rule");
  assert.equal(E.admitDrift[target.tmdb_id], true, "admission caused by the rule-version bump must set admitDrift");
  assert.equal(E.filmIsNew(target.tmdb_id), false, "filmIsNew must read false — this is news about the rule, not the film");
}));

// ---- AC3 (CAS-1147, unchanged by CAS-1318): dedupe still only collapses exact twins -----------

test("CAS-1147 AC3: exact twins still share one cascDedupeSigOf value", () => {
  const a = agentWith({ genre: ["Science Fiction", "Thriller"] });
  const b = agentWith({ genre: ["Science Fiction", "Thriller"] });
  assert.equal(E.cascDedupeSigOf(a), E.cascDedupeSigOf(b));
});

test("CAS-1147 AC3: agents differing by one style do not share a cascDedupeSigOf value", () => {
  const a = agentWith({ genre: ["Science Fiction", "Thriller"] });
  const b = agentWith({ genre: ["Science Fiction"] });
  assert.notEqual(E.cascDedupeSigOf(a), E.cascDedupeSigOf(b));
});
