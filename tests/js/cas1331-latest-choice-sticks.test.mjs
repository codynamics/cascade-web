// CAS-1331: CAS-1328 fixed Latest's (id "releases") source/display-name to be fixed-by-the-app, but that
// made a person's own choice from the mood sheet (My agents / a typed name of "Releases") stick for exactly
// one render — the sheet still offered the controls, but reopening or reselecting always read the legacy
// fallback back. moodSource/moodDisplayName now distinguish "never actually chosen" (sourceChosen/nameChosen
// absent — the legacy-record case CAS-1328's own tests already cover) from "the person saved this from the
// sheet" (sourceChosen:true/nameChosen:true, stamped by saveMoodFromSheet only for this one id) — the latter
// always wins, including when it's literally "agents"/"Releases", the exact values the legacy fallback would
// otherwise have overridden.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// Same UTC-date arithmetic as the engine's own addDays (app_template.html) — not exported, so reproduced
// here against E.TODAY rather than hard-coding a date relative to the real wall clock (same technique
// cas1328-releases-becomes-latest.test.mjs uses).
function isoOffset(E, days){
  const d = new Date(E.TODAY + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// A minimal real cinema release: passes showable() via hasConfirmedOffer (a real offer, not estimated) and
// passesTasteBase() via the harness's default English-only taste baseline — only meaningful under Latest's
// catalogue branch (the agents branch never calls either).
let seq = 0;
function cinemaReleaseFixture(overrides){
  seq++;
  return { tmdb_id: 93310000 + seq, title: `CAS-1331 fixture ${seq}`, genres: ["Drama"], language: "en",
    status: ["included_streaming"], offers: [{ type: "sub", service: "netflix" }],
    cinema_release: true, _fixture: true, ...overrides };
}
function currentMood(E){ return E.watchMoods.find(m => m.id === E.watchMoodSel); }
// Replaces the built-in Latest record in place (watchMoods is reassigned wholesale elsewhere, never by this
// helper — mutating the array element is enough since engine.mjs's getter always returns the live array) and
// selects it through the real window.setWatchMood/applyMoodToState chokepoint, restoring both afterwards.
function withReleasesMood(E, overrides, fn){
  const idx = E.watchMoods.findIndex(m => m.id === "releases");
  const original = { ...E.watchMoods[idx] };
  const savedSel = E.watchMoodSel;
  E.watchMoods[idx] = { ...original, ...overrides };
  E.window.setWatchMood("releases");
  try { return fn(); }
  finally {
    E.watchMoods[idx] = original;
    if(E.watchMoodSel !== savedSel) E.window.setWatchMood(savedSel);
  }
}

test("CAS-1331: moodSource keeps Latest on catalogue by default and sticks to a saved choice once sourceChosen", () => {
  const E = loadEngine();
  assert.equal(E.moodSource({ id: "releases", source: "agents" }), "catalogue",
    "no sourceChosen at all: still the CAS-1328 legacy fallback");
  assert.equal(E.moodSource({ id: "releases", source: "agents", sourceChosen: true }), "agents",
    "sourceChosen:true: the person's own choice must win");
  assert.equal(E.moodSource({ id: "releases", source: "catalogue", sourceChosen: true }), "catalogue",
    "sourceChosen:true with Everything chosen must still read catalogue");
  // A non-Latest mood is untouched by sourceChosen entirely — the field means nothing off this one id.
  assert.equal(E.moodSource({ id: "t-other", source: "agents", sourceChosen: false }), "agents");
});

test("CAS-1331: moodDisplayName keeps the legacy \"Latest\" fallback by default and sticks to a saved name once nameChosen", () => {
  const E = loadEngine();
  assert.equal(E.moodDisplayName({ id: "releases", name: "Releases" }), "Latest",
    "no nameChosen: still the CAS-1328 legacy fallback");
  assert.equal(E.moodDisplayName({ id: "releases", name: "Releases", nameChosen: true }), "Releases",
    "nameChosen:true: the person deliberately kept/typed \"Releases\" and must see it verbatim");
  assert.equal(E.moodDisplayName({ id: "releases", name: "Friday night", nameChosen: true }), "Friday night");
});

test("CAS-1331: saving Latest from the sheet stamps sourceChosen/nameChosen; saving any other mood stamps neither", () => {
  const E = loadEngine();
  const savedSel = E.watchMoodSel;
  try{
    E.window.openMoodSheetFor("releases");
    E.window.setMoodDraftSource("agents");
    E.window.saveMoodFromSheet();
    const releases = E.watchMoods.find(m => m.id === "releases");
    assert.equal(releases.sourceChosen, true);
    assert.equal(releases.nameChosen, true, "a save always stamps nameChosen too, even when the name field was left untouched");

    const starred = E.watchMoods.find(m => m.id === "starred");
    E.window.openMoodSheetFor("starred");
    E.window.setMoodDraftName("My shortlist");
    E.window.saveMoodFromSheet();
    const savedStarred = E.watchMoods.find(m => m.id === "starred");
    assert.equal(savedStarred.name, "My shortlist", "sanity: the rename must actually have landed");
    assert.equal(savedStarred.sourceChosen, undefined, "sourceChosen is only ever stamped for id \"releases\"");
    assert.equal(savedStarred.nameChosen, undefined, "nameChosen is only ever stamped for id \"releases\"");
  } finally {
    E.window.setWatchMood(savedSel);
  }
});

test("CAS-1331 AC1: saving Latest from the sheet with source \"My agents\" sticks — reopens as agents, moodSource reads agents, and an unlisted recent release is excluded", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  const savedSel = E.watchMoodSel;
  const savedCascades = [...E.cascades];
  try{
    // CAS-1328's own differential: zero agents means an agents-sourced pool is [] outright (watchScopeRows'
    // own acs.length guard), while the catalogue pool ignores agents entirely — so if the save were silently
    // reverted back to catalogue (the bug this ticket fixes), the fixture below would still show.
    E.cascades.length = 0;
    E.window.openMoodSheetFor("releases");
    E.window.setMoodDraftSource("agents");
    E.window.saveMoodFromSheet();

    const saved = E.watchMoods.find(m => m.id === "releases");
    assert.equal(saved.source, "agents", "sanity: the saved record itself must carry source agents");
    assert.equal(E.watchMoodSel, "releases", "sanity: saving must keep Latest selected");
    assert.equal(E.moodSource(currentMood(E)), "agents", "AC1: moodSource(currentMood()) must read agents after save");

    const reopened = E.moodDraftFrom(saved);
    assert.equal(reopened.source, "agents", "AC1: reopening the draft must show the saved choice, not revert to Everything");

    E.setWatchTab("stream");
    const x = cinemaReleaseFixture({ cinema_date: isoOffset(E, -120) });
    E.MOVIES.push(x);
    try{
      const rows = [...E.watchScopeRows()];
      assert.ok(!rows.some(m => m.tmdb_id === x.tmdb_id),
        "AC1: a recent cinema release no agent admits must not show under Latest sourced from My agents");
    } finally {
      const i = E.MOVIES.findIndex(m => m.tmdb_id === x.tmdb_id); if(i !== -1) E.MOVIES.splice(i, 1);
    }
  } finally {
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.window.setWatchMood(savedSel);
    E.setWatchTab(savedTab);
  }
});

test("CAS-1331 AC2: a stored Latest record with source \"agents\" but no sourceChosen still loads as catalogue", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  const savedCascades = [...E.cascades];
  try{
    // Same zero-agents differential as AC1, inverted: if this legacy record were wrongly read as agents-
    // sourced, zero agents would make the pool [] outright; the catalogue fallback must still show the film.
    E.cascades.length = 0;
    withReleasesMood(E, { id: "releases", name: "Releases", source: "agents", agentsOff: ["an-agent-id"] }, () => {
      assert.equal(E.moodSource(currentMood(E)), "catalogue", "sanity: no sourceChosen must fall back to catalogue");
      E.setWatchTab("stream");
      const x = cinemaReleaseFixture({ cinema_date: isoOffset(E, -120) });
      E.MOVIES.push(x);
      try{
        const rows = [...E.watchScopeRows()];
        assert.ok(rows.some(m => m.tmdb_id === x.tmdb_id),
          "AC2: a legacy source:\"agents\" record with no sourceChosen must still behave as Latest's catalogue pool");
      } finally {
        const i = E.MOVIES.findIndex(m => m.tmdb_id === x.tmdb_id); if(i !== -1) E.MOVIES.splice(i, 1);
      }
    });
  } finally {
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.setWatchTab(savedTab);
  }
});

test("CAS-1331 AC3: with My agents chosen, Latest's 12-month window still excludes an old release an included agent admits", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  const savedCascades = [...E.cascades];
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = "cas1331-agent"; c.order = 0; c.paused = false; c.name = "Agent";
  E.cascades.length = 0; E.cascades.push(c);
  const oldId = -1331000001, freshId = -1331000002;
  try{
    withReleasesMood(E, { id: "releases", name: "Latest", source: "agents", sourceChosen: true, agentsOff: [] }, () => {
      E.setWatchTab("stream");
      // Clones a real catalogue film (same technique cas1329-watch-placement-by-standing.test.mjs uses) so
      // every incidental field other predicates read stays valid, and pins it straight into the seeded
      // agent via notify (bypassing matchesCriteria's own rungs entirely, same as that file's
      // wireFilmWithWatchOn) so admission is certain regardless of the agent's own criteria shape.
      const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id));
      assert.ok(donor, "setup: need an unwatched donor film in the harness catalogue to clone");
      const oldFilm = { ...donor, tmdb_id: oldId, status: ["included_streaming"], cinema_release: true, cinema_date: isoOffset(E, -425) };
      const freshFilm = { ...donor, tmdb_id: freshId, status: ["included_streaming"], cinema_release: true, cinema_date: isoOffset(E, -30) };
      E.MOVIES.push(oldFilm, freshFilm);
      E.notify[oldId] = { pinnedTo: [c.id], notIn: [] };
      E.notify[freshId] = { pinnedTo: [c.id], notIn: [] };

      assert.ok(E.listedBy(oldFilm, c), "sanity: the seeded agent must admit the old release");
      assert.ok(E.listedBy(freshFilm, c), "sanity: the seeded agent must admit the fresh release");
      const rows = [...E.watchScopeRows()];
      assert.ok(!rows.some(m => m.tmdb_id === oldId),
        "AC3: a 14-month-old release must not show under Latest even when an included agent admits it");
      assert.ok(rows.some(m => m.tmdb_id === freshId),
        "setup: a recent release from the same agent must still show — the exclusion is the window, not the agent");
    });
  } finally {
    [oldId, freshId].forEach(id => {
      const i = E.MOVIES.findIndex(m => m.tmdb_id === id); if(i !== -1) E.MOVIES.splice(i, 1);
      delete E.notify[id];
    });
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.setWatchTab(savedTab);
  }
});

test("CAS-1331 AC5: saving Latest's name as \"Releases\" from the sheet sticks — display name and reopened draft both read it verbatim", () => {
  const E = loadEngine();
  const savedSel = E.watchMoodSel;
  try{
    E.window.openMoodSheetFor("releases");
    E.window.setMoodDraftName("Releases");
    E.window.saveMoodFromSheet();

    const saved = E.watchMoods.find(m => m.id === "releases");
    assert.equal(saved.name, "Releases", "sanity: the save must actually persist the typed name");
    assert.equal(E.moodDisplayName(saved), "Releases",
      "AC5: the display name must read back exactly what was saved, not the legacy \"Latest\" fallback");

    const reopened = E.moodDraftFrom(saved);
    assert.equal(reopened.name, "Releases", "AC5: reopening the sheet must show the saved name, not revert to Latest");
  } finally {
    E.window.setWatchMood(savedSel);
  }
});
