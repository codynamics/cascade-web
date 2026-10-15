// CAS-1268: an agent's style choice is no longer only whole-style (c.genre/c.exclude) — a pair of two
// styles can be set to "+" (list) or "-" (skip) in c.pairs, and a combination beats its styles. Drives
// the real shipped engine (tests/js/engine.mjs's loadEngine(), reading the BUILT index.html) directly,
// never a re-derivation of matchesCriteria's/normCascade's own rules.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function agentWith(overrides){
  return E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 0, premium: null, rent: 0, stream: 0 }, ...overrides });
}
// Clone a real, currently-admitted film so every OTHER requirement matchesCriteria checks (language,
// score, offers, window...) is already satisfied by construction, the same technique
// cas1147-genre-any-style.test.mjs's donorFilm uses, so only the style/pairs dimension under test varies.
function donorFilm(){
  const openCascade = agentWith({ genre: [] });
  const donor = E.MOVIES.find(m => E.matchesCriteria(m, openCascade));
  if(!donor) throw new Error("no film in the harness catalogue is admitted by a fully-open agent — this test would prove nothing");
  return donor;
}
// The engine runs in its own vm realm — an object it hands back is a plain object by content but not by
// [[Prototype]], so assert.deepStrictEqual (what the "strict" assert's .deepEqual actually is) fails on two
// objects that print identically (see tests/js/agents-placement.test.mjs's own arr() for the array case).
// Spreading pulls the values into a plain object of THIS realm first.
const obj = o => ({...(o || {})});

// ---- AC1: pairVerdict + matchesCriteria -------------------------------------------------------

test("CAS-1268 AC1: a '-' pair rejects a film carrying both styles, regardless of order", () => {
  const c = agentWith({ genre: ["Science Fiction"], pairs: { "Animation|Science Fiction": "-" } });
  const film = { ...donorFilm(), genres: ["Science Fiction", "Animation"] };
  assert.equal(E.pairVerdict(film, c), "out");
  assert.equal(E.matchesCriteria(film, c), false);
});

test("CAS-1268 AC1: the same agent still admits a film outside that pair", () => {
  const c = agentWith({ genre: ["Science Fiction"], pairs: { "Animation|Science Fiction": "-" } });
  const film = { ...donorFilm(), genres: ["Science Fiction", "Action"] };
  assert.equal(E.pairVerdict(film, c), null);
  assert.equal(E.matchesCriteria(film, c), true);
});

test("CAS-1268 AC1: a '+' pair admits a film whose styles are neither listed nor excluded", () => {
  const c = agentWith({ genre: ["Action"], pairs: { "Comedy|Drama": "+" } });
  const film = { ...donorFilm(), genres: ["Comedy", "Drama"] };
  assert.equal(E.pairVerdict(film, c), "in");
  assert.equal(E.matchesCriteria(film, c), true);
});

test("CAS-1268 AC1: a '+' pair beats an exclude on one of its own styles", () => {
  const c = agentWith({ exclude: ["Comedy"], pairs: { "Comedy|Drama": "+" } });
  const film = { ...donorFilm(), genres: ["Comedy", "Drama"] };
  assert.equal(E.pairVerdict(film, c), "in");
  assert.equal(E.matchesCriteria(film, c), true);
});

test("CAS-1268 AC1: a '-' pair wins over a '+' pair on the same film — skip beats list", () => {
  const c = agentWith({ pairs: { "Action|Comedy": "+", "Comedy|Drama": "-" } });
  const film = { ...donorFilm(), genres: ["Action", "Comedy", "Drama"] };
  assert.equal(E.pairVerdict(film, c), "out");
  assert.equal(E.matchesCriteria(film, c), false);
});

test("CAS-1268 AC1: pairs:{} never engages the pair gate — admission is unchanged for every STARTERS preset", () => {
  for(const s of E.STARTERS){
    assert.deepEqual(obj(s.crit.pairs), {}, `setup: ${s.key} must carry no pairs by default`);
    for(const m of E.MOVIES) assert.equal(E.pairVerdict(m, s.crit), null);
  }
});

// ---- AC2: round trip + normCascade validation -------------------------------------------------

test("CAS-1268 AC2: pairs round-trips through cascadeToRow/rowToCascade unchanged", () => {
  const c = agentWith({ pairs: { "Action|Comedy": "+", "Comedy|Drama": "-" } });
  const row = E.CascadeShape.cascadeToRow(c);
  const back = E.CascadeShape.rowToCascade(row);
  assert.deepEqual(obj(back.pairs), obj(c.pairs));
});

test("CAS-1268 AC2: normCascade drops a pair key whose two styles are out of A-Z order", () => {
  const c = agentWith({ pairs: { "Drama|Action": "+" } });
  assert.deepEqual(obj(c.pairs), {});
});

test("CAS-1268 AC2: normCascade drops a pair key naming the same style twice", () => {
  const c = agentWith({ pairs: { "Drama|Drama": "-" } });
  assert.deepEqual(obj(c.pairs), {});
});
