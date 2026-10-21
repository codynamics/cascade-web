// CAS-1326: opening, saving or creating an agent, signing in, and app start must never change Watch — Watch
// is driven only by the selected mood and the stage buttons (Lee, 21 Oct 2026). CAS-1323 already stopped
// applyCascade from touching filt.sort/sortPicked (AC1 below confirms that holds through every call site
// the ticket names). This ticket's own fixes: openCascade no longer calls settleWatchHeldOpen() or forces
// the Watch list's "listloading" blur (Change 3/5), attributionHTML no longer depends on activeIds while on
// Watch (Change 2/AC2), and renderCascadeBar's services warning no longer names the open agent (Change 4).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// status:[]/imdb:10.1 agents admit nothing by criteria — the same synthetic-agent technique CAS-1180/
// CAS-1323's own tests use. Only .order (agent rank) matters for the AC1 tests below.
function seedCascade(E, id, order){
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.order = order; c.paused = false; c.name = id;
  return c;
}
// A genuinely permissive agent (no criteria narrows anything) — the "broadCascade" pattern CAS-786's own
// agentChipHTML tests use, needed here because AC2 reads watchesFilm (via attributionHTML), which the
// status:[]/imdb:10.1 trick above deliberately defeats.
function broadCascade(E, id, order){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.order = order; c.paused = false; c.name = id;
  return c;
}
function withMoodAndCascades(E, mood, cascadeList, fn){
  const savedCascades = E.cascades.slice();
  const savedMoods = [...E.watchMoods];
  const savedSel = E.watchMoodSel;
  E.cascades.length = 0; cascadeList.forEach(c => E.cascades.push(c));
  E.watchMoods.push(mood);
  E.window.setWatchMood(mood.id);
  try { fn(); }
  finally {
    E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
    if (E.watchMoods.some(m => m.id === savedSel)) E.window.setWatchMood(savedSel);
  }
}
// Mirrors the real "Releases" built-in mood (sort:"release") — translates to filt.sort:"cinema" in
// applyMoodToState, with sortPicked forced true. Same fixture CAS-1323's own test uses.
function releasesStyleMood(E, id){
  return { ...E.moodDefaultFieldsNow(), id, name: "Releases test", order: "release", sort: "release",
    topYou: null, topPublic: null };
}

test("CAS-1326 AC1: commitDraft of an edited agent does not touch filt.sort/sortPicked", () => {
  const E = loadEngine();
  const a = seedCascade(E, "cas1326-commit", 0);
  withMoodAndCascades(E, releasesStyleMood(E, "t-1326-commit"), [a], () => {
    assert.equal(E.filt.sort, "cinema", "setup: the Releases-style mood must set filt.sort to the release-date key");
    assert.equal(E.sortPicked, true, "setup: applyMoodToState must leave sortPicked true");
    E.setDraft({ ...a, name: "Edited agent name" });
    E.commitDraft();
    assert.equal(E.filt.sort, "cinema", "AC1: commitDraft of an edited agent must not change filt.sort");
    assert.equal(E.sortPicked, true, "AC1: commitDraft of an edited agent must not change sortPicked");
    E.setDraft(null);
  });
});

test("CAS-1326 AC1: openMovingAgent does not touch filt.sort/sortPicked", () => {
  const E = loadEngine();
  const a = seedCascade(E, "cas1326-moving", 0);
  withMoodAndCascades(E, releasesStyleMood(E, "t-1326-moving"), [a], () => {
    assert.equal(E.filt.sort, "cinema", "setup: the Releases-style mood must set filt.sort to the release-date key");
    assert.equal(E.sortPicked, true, "setup: applyMoodToState must leave sortPicked true");
    E.window.openMovingAgent(a.id);
    assert.equal(E.filt.sort, "cinema", "AC1: openMovingAgent must not change filt.sort");
    assert.equal(E.sortPicked, true, "AC1: openMovingAgent must not change sortPicked");
  });
});

test("CAS-1326 AC1: the sign-in arrival path (openCascade on the first agent) does not touch filt.sort/sortPicked", () => {
  const E = loadEngine();
  const a = seedCascade(E, "cas1326-signin", 0);
  withMoodAndCascades(E, releasesStyleMood(E, "t-1326-signin"), [a], () => {
    assert.equal(E.filt.sort, "cinema", "setup: the Releases-style mood must set filt.sort to the release-date key");
    assert.equal(E.sortPicked, true, "setup: applyMoodToState must leave sortPicked true");
    // Mirrors afterSignIn()'s own arrival call verbatim: openCascade(cascades[0].id, false).
    E.window.openCascade(E.cascades[0].id, false);
    assert.equal(E.filt.sort, "cinema", "AC1: the sign-in arrival path must not change filt.sort");
    assert.equal(E.sortPicked, true, "AC1: the sign-in arrival path must not change sortPicked");
  });
});

test("CAS-1326 AC2: attributionHTML in Watch mode is identical before and after openCascade(<agent>)", () => {
  const E = loadEngine();
  const a = broadCascade(E, "cas1326-attrib-a", 0);
  const b = broadCascade(E, "cas1326-attrib-b", 1);
  const saved = E.cascades.slice();
  E.cascades.length = 0; E.cascades.push(a, b);
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && !E.blocked.has(m.tmdb_id));
  assert.ok(donor, "no unwatched/unblocked film in the harness catalogue to clone — this test would prove nothing");
  try {
    assert.ok(E.watchesFilm(donor, a) && E.watchesFilm(donor, b),
      "setup: both broad agents must find the donor film, or this comparison proves nothing");
    // Before: no single agent open (activeIds names both) — pre-fix, attributionHTML's own
    // activeIds.length<2 gate hid the chip the moment that collapsed to one agent.
    E.activeIds.length = 0; E.activeIds.push(a.id, b.id);
    const before = E.attributionHTML(donor, true);
    assert.ok(before.length > 0, "setup: the chip must actually render something, or this comparison proves nothing");

    E.window.openCascade(a.id, false);   // CAS-1326's trigger: opening an agent collapses activeIds to one

    const after = E.attributionHTML(donor, true);
    assert.equal(after, before, "AC2: attributionHTML in Watch mode must not change once an agent is opened");
  } finally {
    E.cascades.length = 0; saved.forEach(c => E.cascades.push(c));
  }
});

// Same pinnedTo wiring CAS-1180's own held-film tests use: pinnedTo bypasses matchesCriteria entirely
// (listedBy's pinnedInto branch), so the status:[]/imdb:10.1 agent above still "lists" the planted film.
let cloneSeq = 0;
function plantFilm(E, status){
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id));
  assert.ok(donor, "no unwatched film in the harness catalogue to clone — this test would prove nothing");
  cloneSeq++;
  const id = -1326000000 - cloneSeq;
  const film = { ...donor, tmdb_id: id, status: [status], cinema_date: null };
  E.MOVIES.push(film);
  return id;
}
function unplantFilm(E, id){
  const i = E.MOVIES.findIndex(m => m.tmdb_id === id);
  if (i !== -1) E.MOVIES.splice(i, 1);
  delete E.notify[id];
}
function wireFilm(E, id, cascadeId){
  E.notify[id] = {
    source: "auto", cascadeIds: [cascadeId], pinnedTo: [cascadeId], notIn: [],
    wins: { in_cinema: false, premium: false, rent: false, stream: false },
    winsSource: {},
  };
}
function visibleOn(E, tab){
  return E.watchScopeRows()
    .filter(m => E.filmMatchesWatchedFilter(m) || E.watchHeldOpen[tab].has(m.tmdb_id))
    .map(m => m.tmdb_id);
}

test("CAS-1326 AC3: a film marked watched this visit is still in the Watch rows after openCascade(<agent>)", () => {
  const E = loadEngine();
  const a = seedCascade(E, "cas1326-ac3", 0);
  const savedCascades = E.cascades.slice();
  const savedTab = E.watchTab;
  E.cascades.length = 0; E.cascades.push(a);
  const id = plantFilm(E, "included_streaming");
  wireFilm(E, id, a.id);
  E.setWatchTab("stream");
  E.watchAgentOff.clear();
  try {
    E.setOpinion(id, "enjoyed");   // a verdict given THIS VISIT -> watchHeldOpen.stream picks it up (CAS-752)
    assert.ok(E.watchHeldOpen.stream.has(id), "setup: setOpinion must hold the film open on its tab this visit");
    assert.ok(visibleOn(E, "stream").includes(id), "setup: the held film must actually be visible before the trigger");

    E.window.openCascade(a.id, false);

    assert.ok(E.watchHeldOpen.stream.has(id),
      "AC3: opening an agent must not settle Watch's held-open films");
    assert.ok(visibleOn(E, "stream").includes(id),
      "AC3: a film marked watched this visit is still in the Watch rows after opening an agent");
  } finally {
    E.watchWatchedSel.stream.clear();
    E.watchAgentOff.clear();
    E.watchHeldOpen.stream.clear();
    E.setWatchTab(savedTab);
    E.setOpinion(id, "enjoyed");   // setOpinion's own on/off toggle — undoes the verdict before unplanting
    unplantFilm(E, id);
    E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
  }
});

test("CAS-1326 AC4: watchNavKey is unchanged by openCascade(<agent>)", () => {
  const E = loadEngine();
  const a = seedCascade(E, "cas1326-ac4", 0);
  const saved = E.cascades.slice();
  E.cascades.length = 0; E.cascades.push(a);
  try {
    const before = E.watchNavKey();
    E.window.openCascade(a.id, false);
    const after = E.watchNavKey();
    assert.equal(after, before, "AC4: opening an agent must not change watchNavKey (or its equivalent)");
  } finally {
    E.cascades.length = 0; saved.forEach(c => E.cascades.push(c));
  }
});

// Brace-matches a `window.<name>=(...)=>{ ... }` arrow assignment out of the source text — same technique
// CAS-1324's own extractFunctionBody uses for a `function name(){...}` declaration, adapted for openCascade's
// arrow-assignment shape.
function extractArrowAssignmentBody(src, signature){
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found in app_template.html`);
  const openBrace = src.indexOf("{", start);
  let depth = 0, i = openBrace;
  for (; i < src.length; i++){
    if (src[i] === "{") depth++;
    else if (src[i] === "}"){ depth--; if (depth === 0) break; }
  }
  return src.slice(openBrace, i + 1);
}

test("CAS-1326 Change 3/5: openCascade no longer settles Watch's held-open films or forces a listloading blur", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const body = extractArrowAssignmentBody(src, "window.openCascade=(id, push=true)=>{");
  assert.ok(!body.includes("settleWatchHeldOpen"),
    "openCascade must not call settleWatchHeldOpen() — that is navigating-away-from-Watch's job (syncWatchChip), not opening an agent");
  assert.ok(!body.includes("listloading"),
    "openCascade must not force the Watch list's listloading blur — watchNavKey is unchanged (AC4), so render() would patch in place and never clear it");
});
