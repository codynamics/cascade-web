// CAS-1274: agentAdvancedSet is the single "what counts as set in Advanced" rule shared by the Agents
// card's ADVANCED-tagged rows and Edit Agent's Basic-view "SET IN ADVANCED" section. Drives the real
// shipped engine (tests/js/engine.mjs's loadEngine(), reading the BUILT index.html) directly.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function agentWith(overrides){
  return E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 0, premium: null, rent: 0, stream: 0 }, ...overrides });
}
// The engine runs in its own vm realm — an object it hands back is a plain object by content but not by
// [[Prototype]], so assert.deepEqual (what the "strict" assert's .deepEqual actually is) fails on two
// objects that print identically. Spreading pulls the values into a plain object of THIS realm first.
const obj = o => ({...(o || {})});

test("CAS-1274 AC5: agentAdvancedSet flags exactly the setting each fixture sets, nothing for a default agent", () => {
  assert.deepEqual(obj(E.agentAdvancedSet(agentWith({}))),
    { budget: false, awards: false, years: false, cinema: false });
  assert.deepEqual(obj(E.agentAdvancedSet(agentWith({ selScale: 15000000 }))),
    { budget: true, awards: false, years: false, cinema: false });
  assert.deepEqual(obj(E.agentAdvancedSet(agentWith({ budget: 2 }))),
    { budget: true, awards: false, years: false, cinema: false });
  assert.deepEqual(obj(E.agentAdvancedSet(agentWith({ selAwards: 1 }))),
    { budget: false, awards: true, years: false, cinema: false });
  assert.deepEqual(obj(E.agentAdvancedSet(agentWith({ yearsBack: 3 }))),
    { budget: false, awards: false, years: true, cinema: false });
  assert.deepEqual(obj(E.agentAdvancedSet(agentWith({ year: [2024, 2025] }))),
    { budget: false, awards: false, years: true, cinema: false });
  assert.deepEqual(obj(E.agentAdvancedSet(agentWith({ cinemaReleaseOnly: true }))),
    { budget: false, awards: false, years: false, cinema: true });
});
