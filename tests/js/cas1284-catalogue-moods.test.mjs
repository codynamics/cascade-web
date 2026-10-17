// CAS-1284: three catalogue-wide starter moods (Action, Imagine, Fun) replace agent-scoped membership with
// "every film in MOVIES standing in the current stage" (source:"catalogue"), Best N replaces the old
// boolean "top 10" switch, and Styles are back in the mood sheet (reversing CAS-1273). These tests drive
// the pure pipeline functions directly — watchScopeRows/watchVisibleRows/moodBestN/moodBestScore and the
// MOOD_DEFAULTS shape itself — the same technique cas1235/cas1256's own mood tests already use.
//
// A note on assert.deepEqual here: the engine runs in its own vm realm (engine.mjs), so an array built by
// calling .map()/.filter() directly on an engine-exported array (MOOD_DEFAULTS, MOVIES, a watchMoods getter
// result, ...) is itself a foreign-realm Array — deepStrictEqual (what assert/strict's deepEqual aliases)
// treats that as a type mismatch against a same-looking literal built in this file, even though every
// element is a plain string/number. Spreading first (`[...arr]`) re-materialises the array in THIS file's
// realm before any .map()/.filter() runs on it, which is why every comparison below spreads before mapping.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function freshCatalogueMood(E, overrides){
  // mineOnly:false by default — CAS-753's mine-only default would otherwise hide every row the guest
  // harness has no configured service for, which is not what these tests are about (mood-styles-any.test.mjs
  // notes the same reach-past).
  return { ...E.moodDefaultFieldsNow(), id:"t-catalogue", name:"Test", source:"catalogue", order:"score",
    best:30, mineOnly:false, ...overrides };
}
// Selects `mood` as the live mood for the duration of `fn`, restoring the previous selection afterwards.
// watchMoods/watchMoodSel are both reassigned wholesale elsewhere in the engine, so — like
// cas1248-watch-nav-key.test.mjs — this drives the real window.setWatchMood/applyMoodToState chokepoints
// rather than poking the live state by hand.
function withMood(E, mood, fn){
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  const savedSel = E.watchMoodSel;
  E.watchMoods.push(mood);
  E.window.setWatchMood(mood.id);
  try { fn(); }
  finally {
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
    E.window.setWatchMood(savedSel);
  }
}

test("CAS-1284 Change 5: MOOD_DEFAULTS carries the three catalogue starters, after Top scores/Releases, five in total", () => {
  const E = loadEngine();
  const ids = [...E.MOOD_DEFAULTS].map(m => m.id);
  assert.deepEqual(ids, ["top", "releases", "action", "imagine", "fun"]);
  const allGenres = [...new Set([...E.MOVIES].flatMap(m => m.genres || []))];
  const starters = { action: ["Action", "Crime", "Thriller"], imagine: ["Science Fiction", "Fantasy"], fun: ["Comedy", "Romance"] };
  for(const [id, keep] of Object.entries(starters)){
    const mood = [...E.MOOD_DEFAULTS].find(m => m.id === id);
    assert.equal(mood.source, "catalogue", `${id}: source must be catalogue`);
    assert.equal(mood.best, 30, `${id}: best must be 30`);
    assert.equal(mood.order, "you", `${id}: order must be you`);
    assert.equal(mood.mineOnly, true, `${id}: mineOnly must be true`);
    assert.deepEqual([...mood.watched].sort(), ["liked", "wow"], `${id}: watched must be wow+liked`);
    const offSet = new Set(mood.stylesOff);
    keep.forEach(g => assert.ok(!offSet.has(g), `${id}: ${g} must be ON (not in stylesOff)`));
    allGenres.filter(g => !keep.includes(g)).forEach(g =>
      assert.ok(offSet.has(g), `${id}: ${g} must be OFF (in stylesOff)`));
  }
});

test("CAS-1284 Change 5: moodDefaultsNow() keeps each starter's own mineOnly/watched/stylesOff rather than the generic defaults clobbering them", () => {
  const E = loadEngine();
  // Fresh boot state (no account load yet) is exactly moodDefaultsNow()'s own output.
  const imagine = [...E.watchMoods].find(m => m.id === "imagine");
  assert.ok(imagine, "setup: imagine must be one of the boot-time default moods");
  assert.equal(imagine.mineOnly, true);
  assert.deepEqual([...new Set(imagine.watched)].sort(), ["liked", "wow"]);
  assert.ok(imagine.stylesOff.length > 0, "imagine must carry a real stylesOff list, not the empty default");
});

test("CAS-1284 Change 2: moodBestN resolves best over legacy top, and an explicit null (All) is respected", () => {
  const E = loadEngine();
  assert.equal(E.moodBestN({ best: 30 }), 30);
  assert.equal(E.moodBestN({ best: null }), null, "an explicit All must not fall back to top");
  assert.equal(E.moodBestN({ top: true }), 10, "AC6: a legacy top:true mood with no best field reads as best:10");
  assert.equal(E.moodBestN({ top: false }), null, "a legacy top:false mood with no best field reads as All");
  assert.equal(E.moodBestN({ best: 20, top: true }), 20, "best always wins once the mood carries the field");
});

test("CAS-1284 Change 2: moodBestScore blends You+Public signed in with a taste profile, falls back to cascadeScore otherwise", () => {
  const E = loadEngine();
  const m = [...E.MOVIES].find(x => E.cascadeScore(x) >= 0);
  assert.ok(m, "setup: a scored film must exist in the harness catalogue");
  // Signed out (or signed in with no verdicts yet): plain cascadeScore.
  assert.equal(E.moodBestScore(m), E.cascadeScore(m));
});

test("CAS-1284 Change 1: a catalogue mood's pool is every film standing in the current stage, agents ignored entirely", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  const savedCascades = [...E.cascades];
  try{
    E.setWatchTab("stream");
    // Zero agents — an agents-sourced mood would return [] outright (watchScopeRows' own `!acs.length`
    // guard); a catalogue mood must still list every standing film regardless.
    E.cascades.length = 0;
    withMood(E, freshCatalogueMood(E), () => {
      const rows = [...E.watchScopeRows()];
      const expected = [...E.MOVIES].filter(m => E.primaryStatus(m) === "included_streaming");
      assert.ok(expected.length > 0, "setup: the harness catalogue must have streaming films to prove this");
      assert.equal(rows.length, expected.length);
      assert.deepEqual(rows.map(m => m.tmdb_id).sort(), expected.map(m => m.tmdb_id).sort());
      rows.forEach(m => assert.equal(E.primaryStatus(m), "included_streaming"));
    });
  } finally {
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.setWatchTab(savedTab);
  }
});

test("CAS-1284 Change 1: Picked by never narrows a catalogue mood's rows", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  const savedPickedBy = E.watchPickedBy.stream;
  try{
    E.setWatchTab("stream");
    withMood(E, freshCatalogueMood(E, { best: null }), () => {
      E.watchPickedBy.stream = "manual";   // a real, narrow Picked by value (PICKED_BY_OPTS' "Me")
      const { rows } = E.watchVisibleRows();
      const expected = [...E.MOVIES].filter(m => E.primaryStatus(m) === "included_streaming");
      assert.ok(expected.length > 0, "setup: the harness catalogue must have streaming films to prove this");
      assert.equal(rows.length, expected.length, "Picked by must be ignored for a catalogue mood");
    });
  } finally {
    E.watchPickedBy.stream = savedPickedBy;
    E.setWatchTab(savedTab);
  }
});

test("CAS-1284 Change 2: Best N keeps exactly the top N rows by moodBestScore, ties broken on tmdb_id", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  try{
    E.setWatchTab("stream");
    withMood(E, freshCatalogueMood(E, { best: 5 }), () => {
      const { rows } = E.watchVisibleRows();
      const pool = [...E.MOVIES].filter(m => E.primaryStatus(m) === "included_streaming");
      assert.ok(pool.length > 5, "setup: the pool must exceed the cap to actually test the cut");
      const ranked = [...pool].sort((a, b) => {
        const diff = E.moodBestScore(b) - E.moodBestScore(a);
        return diff !== 0 ? diff : a.tmdb_id - b.tmdb_id;
      });
      const expectedIds = ranked.slice(0, 5).map(m => m.tmdb_id).sort((a, b) => a - b);
      assert.equal(rows.length, 5);
      assert.deepEqual([...rows].map(m => m.tmdb_id).sort((a, b) => a - b), expectedIds);
    });
  } finally {
    E.setWatchTab(savedTab);
  }
});

test("CAS-1284 Change 3: applyMoodToState restores watchGenreOff from mood.stylesOff (reverses CAS-1273)", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  try{
    E.setWatchTab("stream");
    const allGenres = [...new Set([...E.MOVIES].flatMap(m => m.genres || []))];
    const keepOnly = ["Comedy"];
    const stylesOff = allGenres.filter(g => !keepOnly.includes(g));
    withMood(E, freshCatalogueMood(E, { best: null, stylesOff }), () => {
      assert.deepEqual([...E.watchGenreOff.stream].sort(), [...stylesOff].sort(),
        "AC: a mood's own stylesOff must land straight in watchGenreOff for the active tab");
      const { rows } = E.watchVisibleRows();
      const expected = [...E.MOVIES].filter(m => E.primaryStatus(m) === "included_streaming" && (m.genres || []).includes("Comedy"));
      assert.ok(expected.length > 0, "setup: a Comedy streaming film must exist in the harness catalogue");
      assert.ok(rows.length > 0, "the Styles filter must not empty the list outright");
      assert.deepEqual([...rows].map(m => m.tmdb_id).sort(), expected.map(m => m.tmdb_id).sort());
    });
  } finally {
    E.setWatchTab(savedTab);
  }
});

test("CAS-1284 Change 6: an existing account's saved moods are provisioned with the missing starters once, never duplicated, never resurrected after delete", async () => {
  const E = loadEngine();
  function makeFakeClient(row){
    const rpcCalls = [];
    function builder(table){
      const state = { table, kind: "select" };
      const b = {
        select(){ return b; }, order(){ return b; }, range(){ return b; },
        upsert(fields){ state.kind = "upsert"; state.fields = fields; return b; },
        match(){ return b; },
        then(resolve){
          return Promise.resolve().then(() => (table === "user_prefs" && state.kind === "select")
            ? { data: row ? [row] : [], error: null } : { data: [], error: null }).then(resolve);
        },
      };
      return b;
    }
    return { rpcCalls, from(table){ return builder(table); },
      rpc(name, params){ rpcCalls.push({ name, params }); return Promise.resolve({ data: null, error: null }); } };
  }
  const settle = () => new Promise(r => setTimeout(r, 0));
  const client = makeFakeClient({
    user_id: "cas1284-test-user",
    view: { moods: [{ id: "custom-a", name: "Custom A", order: "score" }, { id: "custom-b", name: "Custom B", order: "score" }] },
  });
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: "cas1284-test-user" } };
  try{
    await E.CascadePersistence.loadUserPrefs();
    await settle();

    const ids = [...E.watchMoods].map(m => m.id);
    assert.equal(ids.length, 5, "AC4: two saved moods load as five, the three starters appended");
    assert.deepEqual(ids, ["custom-a", "custom-b", "action", "imagine", "fun"],
      "AC4: saved moods keep their order; only the three starters are appended, in MOOD_DEFAULTS order — never Top scores/Releases");

    // AC4 "reload": a second load, now with moodsProvisioned carried on the row, must never duplicate.
    const reloadRow = { user_id: "cas1284-test-user",
      view: { moods: [...E.watchMoods].map(m => ({ ...m })), moodsProvisioned: 1 } };
    client.from = table => ({
      select(){ return this; }, order(){ return this; }, range(){ return this; },
      then(resolve){ return Promise.resolve().then(() => (table === "user_prefs")
        ? { data: [reloadRow], error: null } : { data: [], error: null }).then(resolve); },
    });
    await E.CascadePersistence.loadUserPrefs();
    await settle();
    assert.equal(E.watchMoods.length, 5, "a reload with the flag set must not re-provision or duplicate");

    // Delete Fun, then reload with that deletion already reflected server-side — it must not come back.
    const afterDelete = [...E.watchMoods].filter(m => m.id !== "fun");
    const deletedRow = { user_id: "cas1284-test-user",
      view: { moods: afterDelete.map(m => ({ ...m })), moodsProvisioned: 1 } };
    client.from = table => ({
      select(){ return this; }, order(){ return this; }, range(){ return this; },
      then(resolve){ return Promise.resolve().then(() => (table === "user_prefs")
        ? { data: [deletedRow], error: null } : { data: [], error: null }).then(resolve); },
    });
    await E.CascadePersistence.loadUserPrefs();
    await settle();
    assert.ok(![...E.watchMoods].some(m => m.id === "fun"), "AC4: a deleted starter must not be reprovisioned once the flag is set");
    assert.equal(E.watchMoods.length, 4);
  } finally {
    auth.enabled = false; auth.client = null; auth.session = null;
  }
});
