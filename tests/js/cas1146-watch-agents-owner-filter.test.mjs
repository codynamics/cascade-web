// CAS-1146: watchScopeRows' no-occasion branch admitted a film whenever ANY still-ticked agent listed it
// (MOVIES.filter(m=>acs.some(c=>listedBy(m,c))...)), never consulting filmOwnerCascade (the film's single
// CAS-709 global owner). So unticking an agent in "Agents to include" left its films on screen whenever a
// still-ticked agent happened to also list the same film, under the UNTICKED agent's own name/chip. Fix:
// once at least one agent is unticked for the tab, a film's owner must itself be ticked; all-ticked is
// untouched. The occasion branch (CAS-793) already worked this way and is not touched by this ticket.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

const PLACEMENT_WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try { fn(); } finally { E.setWatchPrefs(saved); }
}
// status:[] / imdb:10.1 agents admit nothing by criteria (imdb is above the real 0-10 scale) — only the
// explicit notify wiring below (pinnedTo/cascadeIds) decides what they list/own, the same synthetic-agent
// technique CAS-793's own owner tests use.
function seedCascade(id, order){
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.order = order; c.paused = false; c.name = id;
  return c;
}
function withTestCascades(list, fn){
  const saved = E.cascades.slice();
  E.cascades.length = 0;
  list.forEach(c => E.cascades.push(c));
  try { fn(); } finally { E.cascades.length = 0; saved.forEach(c => E.cascades.push(c)); }
}
// Clones a real catalogue film so every incidental field other predicates read (offers, availability
// fields, etc.) stays valid — only tmdb_id and status are overridden, forcing the clone to stand purely in
// included_streaming (stream's own standing, WATCH_TAB_OWN_STANDING) with no cinema run to confuse it.
let cloneSeq = 0;
function cloneStreamingFilm(){
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id));
  assert.ok(donor, "no unwatched film in the harness catalogue to clone — this test would prove nothing");
  cloneSeq++;
  const id = -961000000 - cloneSeq;
  const film = { ...donor, tmdb_id: id, status: ["included_streaming"], cinema_date: null };
  E.MOVIES.push(film);
  return id;
}
function unplantFilm(id){
  const i = E.MOVIES.findIndex(m => m.tmdb_id === id);
  if (i !== -1) E.MOVIES.splice(i, 1);
  delete E.notify[id];
}
// Wires a film straight into notify: pinnedTo (so the real listedBy() admits it for each listing agent,
// the pinnedInto path's inScope/listWindowOK both pass trivially against a status:[] agent) and cascadeIds
// (what filmOwnerCascade actually reads) plus a standing stream Watch On, matching WATCH_TAB_OWN_STANDING.
function wireFilm(id, listingCascadeIds){
  E.notify[id] = {
    source: "auto", cascadeIds: [...listingCascadeIds], pinnedTo: [...listingCascadeIds], notIn: [],
    wins: { in_cinema: false, premium: false, rent: false, stream: true },
    winsSource: { stream: "manual" },
  };
}

test("CAS-1146: watchScopeRows' no-occasion branch admits a film only when its OWNER is a ticked agent", () => {
  const a = seedCascade("cas1146-a", 0);   // lower order -> owns anything it co-lists with b
  const b = seedCascade("cas1146-b", 1);
  const savedTab = E.watchTab;
  withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
    withTestCascades([a, b], () => {
      const idF = cloneStreamingFilm();   // listed by both a and b -> owned by a (lower order)
      const idG = cloneStreamingFilm();   // listed by b only -> owned by b
      wireFilm(idF, [a.id, b.id]);
      wireFilm(idG, [b.id]);
      E.setWatchTab("stream");
      E.watchAgentOff.stream.clear();
      try {
        assert.equal(E.filmOwnerCascade(E.MOVIES.find(m => m.tmdb_id === idF)).id, a.id, "setup: a must own F");
        assert.equal(E.filmOwnerCascade(E.MOVIES.find(m => m.tmdb_id === idG)).id, b.id, "setup: b must own G");

        // Nothing unticked: both stand, and the set matches the plain "some listing agent" formula exactly.
        let rows = E.watchScopeRows().map(m => m.tmdb_id);
        assert.ok(rows.includes(idF), "nothing unticked: F must be present");
        assert.ok(rows.includes(idG), "nothing unticked: G must be present");
        const expected = E.MOVIES.filter(m => E.cascades.some(c => E.listedBy(m, c))
          && E.filmMatchesWatchTab(m, E.watchTab)).map(m => m.tmdb_id).sort();
        assert.deepEqual(rows.slice().sort(), expected, "AC5: with nothing unticked the set must equal the plain listedBy formula");

        // a (F's owner) unticked: F must drop even though b still co-lists it; G (owned by the still-ticked b) stands.
        E.toggleWatchAgent(a.id);
        rows = E.watchScopeRows();
        assert.ok(!rows.some(m => m.tmdb_id === idF), "a unticked: F (owned by the now-unticked a) must not appear");
        assert.ok(rows.some(m => m.tmdb_id === idG), "a unticked: G (owned by the still-ticked b) must still appear");
        rows.forEach(m => assert.equal(E.filmOwnerCascade(m).id, b.id, "a unticked: every returned row must be owned by b"));
        E.toggleWatchAgent(a.id);   // re-tick, restore watchAgentOff to empty

        // b (G's owner) unticked instead: G must drop, F (owned by the still-ticked a) stands.
        E.toggleWatchAgent(b.id);
        rows = E.watchScopeRows().map(m => m.tmdb_id);
        assert.ok(rows.includes(idF), "b unticked: F (owned by the still-ticked a) must still appear");
        assert.ok(!rows.includes(idG), "b unticked: G (owned by the now-unticked b) must not appear");
        E.toggleWatchAgent(b.id);   // re-tick, restore watchAgentOff to empty
      } finally {
        E.watchAgentOff.stream.clear();
        E.setWatchTab(savedTab);
        unplantFilm(idF);
        unplantFilm(idG);
      }
    });
  });
});
