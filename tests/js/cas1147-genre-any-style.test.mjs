// CAS-1147: an agent's Styles match a film when ANY of the film's styles is one the agent asks for —
// not only the film's first-listed style, the old rule. AC1-AC3 below drive the real shipped engine
// (tests/js/engine.mjs's loadEngine(), reading the BUILT index.html) directly, never a re-derivation
// of matchesCriteria's/cascSigOf's own rules.
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

// ---- AC1: matchesCriteria tests ANY of the film's styles ------------------------------------

test("CAS-1147 AC1: a film carrying the wanted style SECOND still matches", () => {
  const film = { ...donorFilm(), genres: ["Drama", "Science Fiction"] };
  const c = agentWith({ genre: ["Science Fiction"] });
  assert.equal(E.matchesCriteria(film, c), true);
});

test("CAS-1147 AC1: a film carrying none of the wanted styles does not match", () => {
  const film = { ...donorFilm(), genres: ["Drama", "Comedy"] };
  const c = agentWith({ genre: ["Science Fiction"] });
  assert.equal(E.matchesCriteria(film, c), false);
});

test("CAS-1147 AC1: exclude still beats an any-style match", () => {
  const film = { ...donorFilm(), genres: ["Horror", "Science Fiction"] };
  const c = agentWith({ genre: ["Science Fiction"], exclude: ["Horror"] });
  assert.equal(E.matchesCriteria(film, c), false);
});

test("CAS-1147 AC1: an empty style list never rejects on genre", () => {
  const film = { ...donorFilm(), genres: ["Drama", "Comedy"] };
  const c = agentWith({ genre: [] });
  assert.equal(E.matchesCriteria(film, c), true);
});

test("CAS-1147 AC1: a null style list admits nothing", () => {
  const film = { ...donorFilm(), genres: ["Drama", "Comedy"] };
  const c = agentWith({ genre: null });
  assert.equal(E.matchesCriteria(film, c), false);
});

// ---- AC2: a rule-change admission reads as news about the agent, not the film ---------------

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

test("CAS-1147 AC2: a film the any-style rule alone admits carries admitDrift, not filmIsNew", () => withAgentFilmsState(() => {
  const c = agentWith({ genre: ["Science Fiction"] });
  c.id = "cas1147-ac2"; c.order = 0;
  E.cascades.push(c);

  // An existing, long-admitted film (primary-genre match) — stamped with a signature that predates
  // this ticket's GENRE_RULE_V element, exactly as a real pre-migration agent_films row would read,
  // so this cascade's own cascadeDrift reads true on the very next recomputeFound() pass.
  const anchor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && !E.blocked.has(m.tmdb_id)
    && (m.genres||[])[0] === "Science Fiction" && E.matchesCriteria(m, c));
  if(!anchor) throw new Error("no primary-Science-Fiction film in the harness catalogue matches this agent — this test would prove nothing");
  E.CascadePersistence.setAgentFilm(c.id, anchor.tmdb_id, {
    admission_score: E.cascadeScore(anchor), admission_status: E.primaryStatus(anchor),
    agent_sig: "pre-cas1147-sig",
  });
  E.firstFound[anchor.tmdb_id] = daysBeforeToday(10);

  // The film only the any-style rule admits: Science Fiction, not in first position, never seen before.
  const target = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && !E.blocked.has(m.tmdb_id)
    && m.tmdb_id !== anchor.tmdb_id && (m.genres||[]).includes("Science Fiction")
    && (m.genres||[])[0] !== "Science Fiction" && E.matchesCriteria(m, c));
  if(!target) throw new Error("no secondary-Science-Fiction film in the harness catalogue matches this agent — this test would prove nothing");
  assert.ok(!E.firstFound[target.tmdb_id], "setup: the target film must never have been found before");

  E.recomputeFound();

  assert.ok(E.found.has(target.tmdb_id), "AC2: the any-style rule must admit the secondary-style film");
  assert.equal(E.admitDrift[target.tmdb_id], true, "AC2: admission caused by the rule change must set admitDrift");
  assert.equal(E.filmIsNew(target.tmdb_id), false, "AC2: filmIsNew must read false — this is news about the rule, not the film");
}));

// ---- AC3: dedupe still only collapses exact twins --------------------------------------------

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
