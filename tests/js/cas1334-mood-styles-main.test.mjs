// CAS-1334: a mood's Styles filter now matches a film by its MAIN style only (m.genres[0]) — the same rule
// CAS-1318 already gave agents, and applies to every mood including Latest (id "releases"), whose own
// Styles section was previously hidden (CAS-1328) and is now shown. See filmPassesStylesOff (app_template.html)
// and mood-styles-any.test.mjs for the direct, pure-function coverage of the rule itself; this file drives
// the full mood pipeline the ACs describe (a real mood object, Latest's window, and the Filters/stage counts).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

let seq = 0;
// A minimal real streaming film: passes showable() via a confirmed offer and passesTasteBase() via the
// harness's default English-only taste baseline (CAS-1286/CAS-560), the same recipe cas1328's own fixture uses.
function streamingFixture(E, genres, overrides){
  seq++;
  return { tmdb_id: 93340000 + seq, title: `CAS-1334 fixture ${seq}`, genres, language: "en",
    status: ["included_streaming"], offers: [{ type: "sub", service: "netflix" }], ...overrides };
}
function withFixtures(E, films, fn){
  films.forEach(f => E.MOVIES.push(f));
  try { return fn(); }
  finally { films.forEach(f => { const i = E.MOVIES.findIndex(m => m.tmdb_id === f.tmdb_id); if(i !== -1) E.MOVIES.splice(i, 1); }); }
}
function withMood(E, mood, fn){
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  const savedSel = E.watchMoodSel;
  E.watchMoods.push(mood);
  E.window.setWatchMood(mood.id);
  try { return fn(); }
  finally {
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
    E.window.setWatchMood(savedSel);
  }
}
// Same UTC-date arithmetic cas1328/cas1331's own tests use against E.TODAY, not the real wall clock.
function isoOffset(E, days){
  const d = new Date(E.TODAY + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function stylesOffExcept(E, keep){
  const allGenres = [...new Set([...E.MOVIES].flatMap(m => m.genres || []))];
  return allGenres.filter(g => g !== keep);
}

test("CAS-1334 AC1: a mood with only Comedy on lists a Comedy-main film, hides a Comedy-secondary film", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  try {
    E.setWatchTab("stream");
    const filmA = streamingFixture(E, ["Comedy", "Drama"]);
    const filmB = streamingFixture(E, ["Drama", "Comedy"]);
    withFixtures(E, [filmA, filmB], () => {
      const mood = { ...E.moodDefaultFieldsNow(), id: "t-cas1334-ac1", name: "Test", source: "catalogue",
        order: "score", topYou: null, topPublic: null, mineOnly: false,
        stylesOff: stylesOffExcept(E, "Comedy") };
      withMood(E, mood, () => {
        const ids = E.watchVisibleRows().rows.map(m => m.tmdb_id);
        assert.ok(ids.includes(filmA.tmdb_id), "AC1: genres [Comedy, Drama] (main Comedy) must be listed");
        assert.ok(!ids.includes(filmB.tmdb_id), "AC1: genres [Drama, Comedy] (main Drama) must NOT be listed");
      });
    });
  } finally {
    E.setWatchTab(savedTab);
  }
});

test("CAS-1334 AC2: Latest, with Styles set to Comedy only, applies the same main-style rule inside its 12-month window", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  const savedSel = E.watchMoodSel;
  try {
    E.setWatchTab("stream");
    const filmA = streamingFixture(E, ["Comedy", "Drama"], { cinema_release: true, cinema_date: isoOffset(E, -120) });
    const filmB = streamingFixture(E, ["Drama", "Comedy"], { cinema_release: true, cinema_date: isoOffset(E, -120) });
    withFixtures(E, [filmA, filmB], () => {
      const idx = E.watchMoods.findIndex(m => m.id === "releases");
      const original = { ...E.watchMoods[idx] };
      // mineOnly:false reaches past CAS-753's default (which would otherwise hide a fixture the guest
      // harness has no configured service for) — the same device mood-styles-any.test.mjs's own AC2 uses.
      E.watchMoods[idx] = { ...original, mineOnly: false, stylesOff: stylesOffExcept(E, "Comedy") };
      E.window.setWatchMood("releases");
      try {
        const ids = E.watchVisibleRows().rows.map(m => m.tmdb_id);
        assert.ok(ids.includes(filmA.tmdb_id), "AC2: genres [Comedy, Drama] (main Comedy) must be listed under Latest");
        assert.ok(!ids.includes(filmB.tmdb_id), "AC2: genres [Drama, Comedy] (main Drama) must NOT be listed under Latest");
      } finally {
        E.watchMoods[idx] = original;
      }
    });
  } finally {
    if(E.watchMoodSel !== savedSel) E.window.setWatchMood(savedSel);
    E.setWatchTab(savedTab);
  }
});

test("CAS-1334 AC3: the Filters/stage count for Streaming equals the number of rows watchVisibleRows actually lists there", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  try {
    E.setWatchTab("stream");
    const filmA = streamingFixture(E, ["Comedy", "Drama"]);
    const filmB = streamingFixture(E, ["Drama", "Comedy"]);
    withFixtures(E, [filmA, filmB], () => {
      const mood = { ...E.moodDefaultFieldsNow(), id: "t-cas1334-ac3", name: "Test", source: "catalogue",
        order: "score", topYou: null, topPublic: null, mineOnly: false,
        stylesOff: stylesOffExcept(E, "Comedy") };
      withMood(E, mood, () => {
        const n = E.watchStageCountFor({ key: "stream", tabKey: "stream" });
        const { rows } = E.watchVisibleRows();
        const listed = E.watchGroupRows(rows, "included_streaming").length;
        assert.equal(n, listed, "AC3: the stage count must equal the number of rows actually listed for that stage");
        assert.ok(listed > 0, "setup: the Comedy-main fixture must be counted");
      });
    });
  } finally {
    E.setWatchTab(savedTab);
  }
});
