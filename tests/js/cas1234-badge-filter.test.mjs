// CAS-1234: the Watch Filters sheet's new Badges section — a multi-select over scaleTier(m)'s own values
// (landmark/mustsee/blockbuster/anticipated), empty-means-unfiltered, same shape as watchWatchedSel. AC1-3
// drive the real shipped engine (tests/js/engine.mjs's loadEngine(), reading the BUILT index.html) directly.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function unseedCascade(id){
  const i = E.cascades.findIndex(c => c.id === id);
  if(i >= 0) E.cascades.splice(i, 1);
}
function broadCascade(id, order, kind){
  const c = E.normCascade({ kind, status: [] });
  c.id = id; c.paused = false; c.order = order;
  return c;
}
// Seeds a broad cascade of `kind` (CAS-1235's own precedent: "stream"/status:[] lists almost everything;
// a cinema-kind agent is needed to reach the in-cinema/upcoming cohort the same way), switches to `tab`
// and turns the mine-only switch off (its CAS-753 default hides anything on a service the guest harness
// never configures — CAS-1222's own established way to reach past it, E.window.toggleWatchMineOnly()),
// then restores every bit of state afterwards regardless of how `fn` exits.
function withSeededTab(kind, tab, fn){
  const owner = broadCascade(`cas1234-${kind}`, 0, kind);
  E.cascades.push(owner);
  E.recomputeFound();
  const savedTab = E.watchTab;
  const savedMineOnly = E.watchMineOnlyOn();
  const savedSel = new Set(E.watchBadgeSel[tab]);
  try{
    E.setWatchTab(tab);
    if(savedMineOnly) E.window.toggleWatchMineOnly();
    E.watchBadgeSel[tab].clear();
    fn(tab);
  } finally{
    if(savedMineOnly !== E.watchMineOnlyOn()) E.window.toggleWatchMineOnly();
    E.watchBadgeSel[tab].clear();
    savedSel.forEach(v => E.watchBadgeSel[tab].add(v));
    E.setWatchTab(savedTab);
    unseedCascade(owner.id);
  }
}

test("CAS-1234 AC1: nothing selected leaves the list unchanged", () => withSeededTab("stream", "stream", tab => {
  const before = E.watchVisibleRows().rows.map(m => m.tmdb_id);
  assert.ok(before.length > 0, "setup: this test would prove nothing against an empty result");
  assert.equal(E.watchBadgeSel[tab].size, 0, "setup: nothing selected");
  const after = E.watchVisibleRows().rows.map(m => m.tmdb_id);
  assert.deepEqual(after, before, "AC1: an empty Badges selection must not narrow the list at all");
}));

test("CAS-1234 AC1: selecting Landmark leaves only films where scaleTier(m)===\"landmark\"", () => withSeededTab("stream", "stream", tab => {
  E.watchBadgeSel[tab].add("landmark");
  const rows = E.watchVisibleRows().rows;
  assert.ok(rows.length > 0, "setup: this test would prove nothing against an empty result");
  rows.forEach(m => assert.equal(E.scaleTier(m), "landmark",
    `AC1: ${m.title} has scaleTier ${E.scaleTier(m)}, not landmark`));
}));

test("CAS-1234 AC1: selecting Blockbuster and Anticipated leaves only films with either", () => withSeededTab("cinema", "in_cinema", tab => {
  E.watchBadgeSel[tab].add("blockbuster");
  E.watchBadgeSel[tab].add("anticipated");
  const rows = E.watchVisibleRows().rows;
  assert.ok(rows.length > 0, "setup: this test would prove nothing against an empty result");
  rows.forEach(m => assert.ok(["blockbuster", "anticipated"].includes(E.scaleTier(m)),
    `AC1: ${m.title} has scaleTier ${E.scaleTier(m)}, neither blockbuster nor anticipated`));
}));

test("CAS-1234 AC1: watchVisibleRows and filmInWatchRows's own badge gate always agree", () => withSeededTab("cinema", "in_cinema", tab => {
  E.watchBadgeSel[tab].add("mustsee");
  const rows = E.watchVisibleRows().rows;
  assert.ok(rows.length > 0, "setup: this test would prove nothing against an empty result");
  rows.forEach(m => assert.equal(E.filmInWatchRows(m), true,
    `AC1: ${m.title} is one of watchVisibleRows()'s own rows but filmInWatchRows disagrees`));
  const cohort = E.MOVIES.filter(m => E.filmMatchesWatchTab(m, tab));
  const trueButMissing = cohort.filter(m => E.filmInWatchRows(m) && !rows.some(r => r.tmdb_id === m.tmdb_id));
  assert.equal(trueButMissing.length, 0, "AC1: filmInWatchRows must never say yes for a film watchVisibleRows leaves out"
    + (trueButMissing.length ? ` (e.g. ${trueButMissing[0].title})` : ""));
}));

test("CAS-1234 AC2: the descriptor percentages are derived from the ladder constants", () => {
  const mustsee = E.BADGE_FILTER_OPTS.find(o => o.key === "mustsee");
  const before = mustsee.descriptor();
  assert.equal(before, `The top ${100 - E.BUZZ_PCTL[3]}% most talked-about new films`);

  const saved = E.BUZZ_PCTL[3];
  try{
    E.BUZZ_PCTL[3] = 90;
    const after = mustsee.descriptor();
    assert.notEqual(after, before, "AC2: changing the constant must change the descriptor text");
    assert.equal(after, "The top 10% most talked-about new films");
  } finally{
    E.BUZZ_PCTL[3] = saved;
  }
});

test("CAS-1234 AC3: the filter count increments by 1 when any badge is selected and returns to its previous value when cleared", () => {
  const savedTab = E.watchTab;
  const tab = "stream";
  const savedSel = new Set(E.watchBadgeSel[tab]);
  try{
    E.setWatchTab(tab);
    E.watchBadgeSel[tab].clear();
    const before = E.watchFiltersActiveCount();
    E.watchBadgeSel[tab].add("landmark");
    assert.equal(E.watchFiltersActiveCount(), before + 1,
      "AC3: selecting one badge must increment the active-filter count by exactly 1");
    E.watchBadgeSel[tab].add("mustsee");
    assert.equal(E.watchFiltersActiveCount(), before + 1,
      "AC3: a second badge selection must not add a second count — this is one filter, not one per option");
    E.clearAllWatchBadge();
    assert.equal(E.watchFiltersActiveCount(), before,
      "AC3: clearing the Badges selection must return the count to its pre-selection value");
  } finally{
    E.watchBadgeSel[tab].clear();
    savedSel.forEach(v => E.watchBadgeSel[tab].add(v));
    E.setWatchTab(savedTab);
  }
});
