// CAS-1235: films "disappear" when a Watch On pick (e.g. Upcoming → Streaming) outruns the person's own
// Also-show widening (CAS-823's watchAlsoShow/ALSO_SHOW_WINDOWS/filmMatchesWatchTab), because every window
// earlier than a tab's own standing started OFF by default. The fix (WATCH_ALSO_SHOW_DEFAULT, app_template.html)
// switches every earlier-than-own-standing window ON by default on Rental/Premium/Streaming, renders an
// earlier-stage section's heading as "<stage> · set to watch on <tab>" (watchGroupHeading), and treats only a
// DEVIATION from that default — not a non-empty set — as an active filter (watchAlsoShowIsDefault).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function unseedCascade(id){
  const i = E.cascades.findIndex(c => c.id === id);
  if(i >= 0) E.cascades.splice(i, 1);
}
function broadCascade(id, order){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = order;
  return c;
}
// A film currently sitting in cinemas, listed by `owner`, not watched/blocked — the exact situation Lee
// reported: a film admitted earlier whose Watch On is then moved to a later stage.
function pickListedInCinemaFilm(owner){
  const m = E.MOVIES.find(x => E.primaryStatus(x) === "in_cinema" && !E.watched.has(x.tmdb_id)
    && !E.blocked.has(x.tmdb_id) && E.listedBy(x, owner));
  if(!m) throw new Error("no listed in-cinema film in the harness catalogue — this test would prove nothing");
  return m;
}
function withStreamWatchOn(film, fn){
  const e = E.entryFor(film.tmdb_id);
  e.wins = e.wins || {};
  e.winsSource = e.winsSource || {};
  const savedWins = { ...e.wins };
  const savedSrc = { ...e.winsSource };
  const savedTab = E.watchTab;
  try{
    E.WATCH_LEVEL_KEYS.forEach(k => { e.wins[k] = false; });
    e.wins.stream = true;
    e.winsSource.stream = "manual";
    fn(e);
  } finally{
    e.wins = savedWins;
    e.winsSource = savedSrc;
    E.setWatchTab(savedTab);
  }
}

test("CAS-1235 AC1: a film with Watch On = Streaming whose primaryStatus is in_cinema appears on the Streaming tab by default, under 'In Cinema · set to watch on Stream', ahead of the Streaming section", () => {
  const owner = broadCascade("cas1235-ac1", 0);
  E.cascades.push(owner);
  // recomputeFound() auto-places every OTHER listed film's Watch On too — needed so the Streaming tab's own
  // section has real content to come after, not just the one film this test force-places there.
  E.recomputeFound();
  try{
    const film = pickListedInCinemaFilm(owner);
    withStreamWatchOn(film, () => {
      E.setWatchTab("stream");
      assert.equal(E.filmNotifyState(film.tmdb_id).key, "stream", "setup: the film's Watch On must read as Streaming");

      const rows = E.watchScopeRows();
      assert.ok(rows.some(m => m.tmdb_id === film.tmdb_id),
        "AC1: an in-cinema film whose Watch On is Streaming must appear on the Streaming tab by default");

      assert.equal(E.watchGroupHeading("in_cinema"), "In Cinema · set to watch on Stream",
        "AC1: the earlier-stage section's heading must read '<stage> · set to watch on <tab>'");

      const groups = E.listingGroups(rows, null);
      const order = groups.map(g => g.g);
      const inCinemaIdx = order.indexOf("in_cinema");
      const streamIdx = order.indexOf("included_streaming");
      assert.ok(inCinemaIdx >= 0, "setup: the In Cinema section must actually be present");
      assert.ok(streamIdx >= 0, "setup: the Streaming section must actually be present");
      assert.ok(inCinemaIdx < streamIdx, "AC1: 'In Cinema · set to watch on Stream' must come before the 'Streaming' section");
    });
  } finally{
    unseedCascade(owner.id);
  }
});

test("CAS-1235 AC2: defaults hide the Filters badge; switching one Also-show window off counts as 1; clear returns to defaults and hides it again", () => {
  const savedTab = E.watchTab;
  const savedStream = new Set(E.watchAlsoShow.stream);
  try{
    E.setWatchTab("stream");
    assert.ok(E.watchAlsoShowIsDefault("stream"), "setup: a freshly-loaded stream tab must start at the default");
    assert.equal(E.watchFiltersActiveCount(), 0, "AC2: with defaults in force the Filters badge count must be 0");

    E.watchAlsoShow.stream.delete("rental");
    assert.equal(E.watchFiltersActiveCount(), 1, "AC2: switching one Also-show window off must count as exactly 1");

    E.clearWatchAlsoShow();
    assert.ok(E.watchAlsoShowIsDefault("stream"), "AC2: clear must return Also-show to the default, not to empty");
    assert.equal(E.watchFiltersActiveCount(), 0, "AC2: after clear the Filters badge count must be 0 again");
  } finally{
    E.watchAlsoShow.stream = savedStream;
    E.setWatchTab(savedTab);
  }
});

test("CAS-1235 AC4: the Streaming stage count equals the number of cards watchScopeRows() lists for the Streaming tab", () => {
  const owner = broadCascade("cas1235-ac4", 0);
  E.cascades.push(owner);
  E.recomputeFound();
  const savedTab = E.watchTab, savedStage = E.watchCinemaStage;
  try{
    const film = pickListedInCinemaFilm(owner);
    withStreamWatchOn(film, () => {
      E.setWatchTab("stream");
      const listed = E.watchVisibleRows().rows.filter(m => !E.taggedOut(m)).length;
      const stop = E.watchStageStopsNow().find(s => s.tabKey === "stream");
      assert.ok(stop, "setup: the Streaming tab must have a stage stop");
      assert.equal(E.watchStageCountFor(stop), listed,
        "AC4: the Streaming stage count must equal the number of cards the Streaming tab lists");
    });
  } finally{
    unseedCascade(owner.id);
    E.setWatchTab(savedTab); E.setWatchCinemaStage(savedStage);
  }
});
