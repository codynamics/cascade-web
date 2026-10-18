// CAS-1284: three catalogue-wide starter moods (Action, Imagine, Fun) replace agent-scoped membership with
// "every film in MOVIES standing in the current stage" (source:"catalogue"), and Styles are back in the
// mood sheet (reversing CAS-1273).
// CAS-1287: Best N's single `best` field is replaced by "Show top" — two independent counts, topYou and
// topPublic, combined with OR (moodShowTopKeep). These tests drive the pure pipeline functions directly —
// watchScopeRows/watchVisibleRows/moodShowTopKeep/moodTopYouN/moodTopPublicN and the MOOD_DEFAULTS shape
// itself — the same technique cas1235/cas1256's own mood tests already use.
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
  // notes the same reach-past). topYou:null (signed out in most of these tests, so it would be forced Off
  // regardless) / topPublic:30 approximates CAS-1284's old best:30 default for a signed-out run.
  return { ...E.moodDefaultFieldsNow(), id:"t-catalogue", name:"Test", source:"catalogue", order:"score",
    topYou:null, topPublic:30, mineOnly:false, ...overrides };
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
// CAS-1287: saves/clears/restores every verdict set moodShowTopKeep's own ranking (tasteMatch/taggedOut)
// can read, so a test can build a small, fully-controlled taste profile off one or two donor films without
// any real-catalogue verdict leaking in or a test's own donors outliving it.
function withCleanVerdicts(E, fn){
  const saved = {
    watched: new Set(E.watched), disliked: new Set(E.disliked), indifferent: new Set(E.indifferent),
    wowed: new Set(E.wowed), enjoyed: new Set(E.enjoyed), blocked: new Set(E.blocked),
  };
  E.watched.clear(); E.disliked.clear(); E.indifferent.clear(); E.wowed.clear(); E.enjoyed.clear(); E.blocked.clear();
  E.invalidateComputeCaches();
  try { return fn(); }
  finally {
    E.watched.clear(); saved.watched.forEach(id => E.watched.add(id));
    E.disliked.clear(); saved.disliked.forEach(id => E.disliked.add(id));
    E.indifferent.clear(); saved.indifferent.forEach(id => E.indifferent.add(id));
    E.wowed.clear(); saved.wowed.forEach(id => E.wowed.add(id));
    E.enjoyed.clear(); saved.enjoyed.forEach(id => E.enjoyed.add(id));
    E.blocked.clear(); saved.blocked.forEach(id => E.blocked.add(id));
    E.invalidateComputeCaches();
  }
}

test("CAS-1284 Change 5 / CAS-1287 Change 1: MOOD_DEFAULTS carries the three catalogue starters, after Top scores/Releases, five in total", () => {
  const E = loadEngine();
  const ids = [...E.MOOD_DEFAULTS].map(m => m.id);
  // CAS-1295: Starred is now a sixth default, directly after Releases.
  assert.deepEqual(ids, ["top", "releases", "starred", "action", "imagine", "fun"]);
  const allGenres = [...new Set([...E.MOVIES].flatMap(m => m.genres || []))];
  const starters = { action: ["Action", "Crime", "Thriller"], imagine: ["Science Fiction", "Fantasy"], fun: ["Comedy", "Romance"] };
  for(const [id, keep] of Object.entries(starters)){
    const mood = [...E.MOOD_DEFAULTS].find(m => m.id === id);
    assert.equal(mood.source, "catalogue", `${id}: source must be catalogue`);
    assert.equal(mood.topYou, 20, `${id}: topYou must be 20`);
    assert.equal(mood.topPublic, 10, `${id}: topPublic must be 10`);
    assert.equal(mood.order, "you", `${id}: order must be you`);
    assert.equal(mood.mineOnly, true, `${id}: mineOnly must be true`);
    assert.deepEqual([...mood.watched].sort(), ["liked", "wow"], `${id}: watched must be wow+liked`);
    const offSet = new Set(mood.stylesOff);
    keep.forEach(g => assert.ok(!offSet.has(g), `${id}: ${g} must be ON (not in stylesOff)`));
    allGenres.filter(g => !keep.includes(g)).forEach(g =>
      assert.ok(offSet.has(g), `${id}: ${g} must be OFF (in stylesOff)`));
  }
  const top = [...E.MOOD_DEFAULTS].find(m => m.id === "top");
  assert.equal(top.topYou, null, "Top scores: topYou must be Off");
  assert.equal(top.topPublic, 10, "Top scores: topPublic must be 10 (the old top:true cap)");
  const releases = [...E.MOOD_DEFAULTS].find(m => m.id === "releases");
  assert.equal(releases.topYou, null, "Releases: topYou must be Off");
  assert.equal(releases.topPublic, null, "Releases: topPublic must be Off");
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

test("CAS-1287 AC5 / Change 1: moodTopPublicN resolves topPublic over legacy best over legacy top; moodTopYouN never falls back", () => {
  const E = loadEngine();
  assert.equal(E.moodTopPublicN({ topPublic: 30 }), 30);
  assert.equal(E.moodTopPublicN({ topPublic: null }), null, "an explicit Off on the new field must not fall back");
  assert.equal(E.moodTopPublicN({ best: 30 }), 30, "AC5: legacy best:N reads as topPublic:N");
  assert.equal(E.moodTopPublicN({ best: null }), null, "legacy best:null (All) reads as topPublic Off, not a fall-through to top");
  assert.equal(E.moodTopPublicN({ top: true }), 10, "AC5: legacy top:true with no best/topPublic field reads as topPublic:10");
  assert.equal(E.moodTopPublicN({ top: false }), null, "a legacy top:false mood with no best/topPublic field reads as Off");
  assert.equal(E.moodTopPublicN({ topPublic: 20, best: 30, top: true }), 20, "topPublic always wins once the mood carries the field");
  assert.equal(E.moodTopYouN({ topYou: 20 }), 20);
  assert.equal(E.moodTopYouN({}), null, "a mood that never carried topYou has no legacy fallback — it simply reads as Off");
});

test("CAS-1287: moodTopYouAvailable/moodTopYouEffectiveN are Off unless signed in with a real taste profile", () => {
  const E = loadEngine();
  const auth = E.CascadeAuth;
  const saved = { enabled: auth.enabled, client: auth.client, session: auth.session };
  try{
    auth.enabled = false; auth.client = null; auth.session = null;
    assert.equal(E.moodTopYouAvailable(), false, "signed out: unavailable");
    assert.equal(E.moodTopYouEffectiveN({ topYou: 20 }), null, "signed out: topYou reads as Off regardless of the mood");

    withCleanVerdicts(E, () => {
      auth.enabled = true; auth.client = {}; auth.session = { user: { id: "cas1287-availability-test" } };
      assert.equal(E.moodTopYouAvailable(), false, "signed in with no verdicts yet: still unavailable");
      assert.equal(E.moodTopYouEffectiveN({ topYou: 20 }), null);

      const donorId = 90400201;
      E.MOVIES.push({ tmdb_id: donorId, genres: ["Action"], status: ["included_streaming"], _fixture: true });
      try{
        E.watched.add(donorId); E.enjoyed.add(donorId); E.invalidateComputeCaches();
        assert.equal(E.moodTopYouAvailable(), true, "signed in with a real verdict: available");
        assert.equal(E.moodTopYouEffectiveN({ topYou: 20 }), 20);
      } finally {
        const i = E.MOVIES.findIndex(m => m.tmdb_id === donorId); if(i !== -1) E.MOVIES.splice(i, 1);
      }
    });
  } finally {
    auth.enabled = saved.enabled; auth.client = saved.client; auth.session = saved.session;
    E.invalidateComputeCaches();
  }
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
      const expected = [...E.MOVIES].filter(m => E.primaryStatus(m) === "included_streaming" && E.showable(m) && E.passesTasteBase(m));
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
    withMood(E, freshCatalogueMood(E, { topYou: null, topPublic: null }), () => {
      E.watchPickedBy.stream = "manual";   // a real, narrow Picked by value (PICKED_BY_OPTS' "Me")
      const { rows } = E.watchVisibleRows();
      const expected = [...E.MOVIES].filter(m => E.primaryStatus(m) === "included_streaming" && E.showable(m) && E.passesTasteBase(m));
      assert.ok(expected.length > 0, "setup: the harness catalogue must have streaming films to prove this");
      assert.equal(rows.length, expected.length, "Picked by must be ignored for a catalogue mood");
    });
  } finally {
    E.watchPickedBy.stream = savedPickedBy;
    E.setWatchTab(savedTab);
  }
});

test("CAS-1287 AC3: Show top with both topYou and topPublic Off keeps every row of the pool", () => {
  const E = loadEngine();
  withMood(E, { ...E.moodDefaultFieldsNow(), id:"t-showtop-off", name:"Test", order:"score", topYou:null, topPublic:null }, () => {
    const rows = [
      { tmdb_id: 1, genres: [], status: ["included_streaming"] },
      { tmdb_id: 2, genres: [], status: ["included_streaming"] },
      { tmdb_id: 3, genres: [], status: ["included_streaming"] },
    ];
    const kept = E.moodShowTopKeep(rows, new Set());
    assert.deepEqual(kept.map(m => m.tmdb_id), [1, 2, 3]);
  });
});

test("CAS-1287 AC1/Change 2: Show top keeps exactly the union of the top-N unwatched by You and the top-N unwatched by Public", () => {
  const E = loadEngine();
  const auth = E.CascadeAuth;
  const saved = { enabled: auth.enabled, client: auth.client, session: auth.session };
  withCleanVerdicts(E, () => {
    // CAS-1293: You v3 is Public adjusted, so — unlike formula C — a film needs a real Public score to
    // get a You at all, and a film with no judged style PAIR still gets a You (its own Public, unadjusted)
    // rather than null. To keep pub1/pub2 topping the Public axis without also topping the You axis
    // (which would crowd you1/you2 out), pub1/pub2/neither carry a SECOND, two-style donor pool
    // (Documentary/History) that the person rated consistently worse than their Action/Comedy baseline —
    // Public stays high (it's an intrinsic wm_user_rating), You comes down with it.
    const donorA = []; // majority pool: sets the baseline high; Action/Comedy itself only drifts a little off it.
    for(let i = 0; i < 20; i++){
      const d = { tmdb_id: 90400310 + i, genres: ["Action", "Comedy"], status: ["included_streaming"], _fixture: true };
      E.MOVIES.push(d); donorA.push(d);
    }
    const donorB = []; // minority pool: judged clearly worse than the baseline above.
    for(let i = 0; i < 5; i++){
      const d = { tmdb_id: 90400330 + i, genres: ["Documentary", "History"], status: ["included_streaming"], _fixture: true };
      E.MOVIES.push(d); donorB.push(d);
    }
    try{
      auth.enabled = true; auth.client = {}; auth.session = { user: { id: "cas1287-ac1-test" } };
      donorA.forEach(d => { E.watched.add(d.tmdb_id); E.wowed.add(d.tmdb_id); });
      donorB.forEach(d => { E.watched.add(d.tmdb_id); E.indifferent.add(d.tmdb_id); });
      E.invalidateComputeCaches();

      // you1/you2 share the majority pool's exact genre pair, so tasteMatch gives both a real You score a
      // little above their own Public; noYou shares no genre with any donor and carries no Public score
      // either, so tasteMatch is null (youScore's own -1 fallback). pub1/pub2/neither carry the minority
      // pair, with cascadeScore (wm_user_rating-driven) ranked 96/88/3 — clear top-2/bottom — but a You
      // pulled down to 56/48/1 by that pair's own worse-than-baseline record.
      const you1 = { tmdb_id: 90400302, genres: ["Action", "Comedy"], status: ["included_streaming"], wm_user_rating: 7.0 };
      const you2 = { tmdb_id: 90400303, genres: ["Action", "Comedy"], status: ["included_streaming"], wm_user_rating: 6.5 };
      const noYou = { tmdb_id: 90400304, genres: ["Documentary"], status: ["included_streaming"] };
      const pub1 = { tmdb_id: 90400305, genres: ["Documentary", "History"], status: ["included_streaming"], wm_user_rating: 9.5 };
      const pub2 = { tmdb_id: 90400306, genres: ["Documentary", "History"], status: ["included_streaming"], wm_user_rating: 8.5 };
      const neither = { tmdb_id: 90400307, genres: ["Documentary", "History"], status: ["included_streaming"], wm_user_rating: 0.5 };

      assert.ok(E.tasteMatch(you1).value > 0, "setup: you1 must get a real You score off the donor");
      assert.equal(E.tasteMatch(noYou), null, "setup: noYou must share no genre with any donor, and has no Public score of its own");
      assert.ok(E.cascadeScore(pub1) > E.cascadeScore(neither), "setup: pub1 must score clearly higher than neither");
      assert.ok(E.tasteMatch(you1).value > E.tasteMatch(pub1).value && E.tasteMatch(you2).value > E.tasteMatch(pub2).value,
        "setup: you1/you2 must clearly out-You pub1/pub2, even though pub1/pub2 out-score them on Public");

      withMood(E, { ...E.moodDefaultFieldsNow(), id:"t-showtop-ac1", name:"Test", order:"score", topYou:2, topPublic:2 }, () => {
        const rows = E.moodShowTopKeep([you1, you2, noYou, pub1, pub2, neither], new Set());
        assert.deepEqual(rows.map(m => m.tmdb_id).sort((a, b) => a - b),
          [you1, you2, pub1, pub2].map(m => m.tmdb_id).sort((a, b) => a - b));
      });
    } finally {
      [...donorA, ...donorB].forEach(d => {
        const i = E.MOVIES.findIndex(m => m.tmdb_id === d.tmdb_id); if(i !== -1) E.MOVIES.splice(i, 1);
      });
      auth.enabled = saved.enabled; auth.client = saved.client; auth.session = saved.session;
    }
  });
});

test("CAS-1287 AC2/Change 2: a watched row is listed only once its own You (or Public) score meets the kept unwatched list's own threshold", () => {
  const E = loadEngine();
  const auth = E.CascadeAuth;
  const saved = { enabled: auth.enabled, client: auth.client, session: auth.session };
  withCleanVerdicts(E, () => {
    const donorId = 90400401;
    E.MOVIES.push({ tmdb_id: donorId, genres: ["Action", "Comedy"], status: ["included_streaming"], _fixture: true });
    try{
      auth.enabled = true; auth.client = {}; auth.session = { user: { id: "cas1287-ac2-test" } };
      E.watched.add(donorId); E.wowed.add(donorId); E.invalidateComputeCaches();

      // CAS-1293: unwatchedHi/watchedPass need a real Public score now (You v3 is Public adjusted) —
      // watchedFail/unwatchedLo keep none, so they stay null exactly as before, just for the "no Public
      // score" reason rather than "no combination film" (You v3 has no such concept).
      const unwatchedHi = { tmdb_id: 90400402, genres: ["Action", "Comedy"], status: ["included_streaming"], wm_user_rating: 7.0 };
      const unwatchedLo = { tmdb_id: 90400403, genres: ["Documentary"], status: ["included_streaming"] };
      const watchedPass = { tmdb_id: 90400404, genres: ["Action", "Comedy"], status: ["included_streaming"], wm_user_rating: 7.0 };
      const watchedFail = { tmdb_id: 90400405, genres: ["Documentary"], status: ["included_streaming"] };
      E.watched.add(watchedPass.tmdb_id); E.wowed.add(watchedPass.tmdb_id);
      E.watched.add(watchedFail.tmdb_id); E.wowed.add(watchedFail.tmdb_id);
      E.invalidateComputeCaches();

      assert.ok(E.taggedOut(watchedPass) && E.taggedOut(watchedFail), "setup: both must read as watched");
      const threshold = E.tasteMatch(unwatchedHi).value;
      assert.equal(E.tasteMatch(watchedPass).value, threshold,
        "setup: watchedPass shares the exact same genres/donor, so it ties the kept unwatched film's own You score");
      assert.equal(E.tasteMatch(watchedFail), null, "setup: watchedFail must have no You score at all");

      withMood(E, { ...E.moodDefaultFieldsNow(), id:"t-showtop-ac2", name:"Test", order:"score", topYou:1, topPublic:null }, () => {
        const rows = E.moodShowTopKeep([unwatchedHi, unwatchedLo, watchedPass, watchedFail], new Set());
        assert.deepEqual(rows.map(m => m.tmdb_id).sort((a, b) => a - b),
          [unwatchedHi, watchedPass].map(m => m.tmdb_id).sort((a, b) => a - b),
          "unwatchedHi stays the real cut, watchedPass is added by the threshold rule, unwatchedLo/watchedFail stay excluded, "
          + "and neither watched row changes which unwatched row was kept");
      });
    } finally {
      const i = E.MOVIES.findIndex(m => m.tmdb_id === donorId); if(i !== -1) E.MOVIES.splice(i, 1);
      auth.enabled = saved.enabled; auth.client = saved.client; auth.session = saved.session;
    }
  });
});

test("CAS-1284 Change 3: applyMoodToState restores watchGenreOff from mood.stylesOff (reverses CAS-1273)", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  try{
    E.setWatchTab("stream");
    const allGenres = [...new Set([...E.MOVIES].flatMap(m => m.genres || []))];
    const keepOnly = ["Comedy"];
    const stylesOff = allGenres.filter(g => !keepOnly.includes(g));
    withMood(E, freshCatalogueMood(E, { topYou: null, topPublic: null, stylesOff }), () => {
      assert.deepEqual([...E.watchGenreOff.stream].sort(), [...stylesOff].sort(),
        "AC: a mood's own stylesOff must land straight in watchGenreOff for the active tab");
      const { rows } = E.watchVisibleRows();
      const expected = [...E.MOVIES].filter(m => E.primaryStatus(m) === "included_streaming" && E.showable(m) && E.passesTasteBase(m) && (m.genres || []).includes("Comedy"));
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
    // CAS-1295: this same load also runs the Starred provisioning step (level<3) — appended last since
    // this account's saved moods carry no "releases" to anchor it after.
    assert.equal(ids.length, 6, "AC4: two saved moods load as six, the three starters plus Starred appended");
    assert.deepEqual(ids, ["custom-a", "custom-b", "action", "imagine", "fun", "starred"],
      "AC4: saved moods keep their order; the three starters are appended first, in MOOD_DEFAULTS order — never Top scores/Releases — then Starred");

    // CAS-1287 Change 6 piggybacks on this same load: a brand-new account (moodsProvisioned absent, level 0)
    // runs both steps in one pass, so the just-appended starters already carry topYou:20/topPublic:10
    // straight off MOOD_DEFAULTS.
    ["action", "imagine", "fun"].forEach(id => {
      const mood = [...E.watchMoods].find(m => m.id === id);
      assert.equal(mood.topYou, 20, `${id}: topYou must be 20`);
      assert.equal(mood.topPublic, 10, `${id}: topPublic must be 10`);
    });

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
    assert.equal(E.watchMoods.length, 6, "a reload with the flag set must not re-provision or duplicate");

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
    assert.equal(E.watchMoods.length, 5);
  } finally {
    auth.enabled = false; auth.client = null; auth.session = null;
  }
});

test("CAS-1287 Change 6: an account already carrying the old moodsProvisioned:1 flag gets its three starters' topYou/topPublic set once, to 20/10", async () => {
  const E = loadEngine();
  function makeFakeClient(row){
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
    return { from(table){ return builder(table); }, rpc(){ return Promise.resolve({ data: null, error: null }); } };
  }
  const settle = () => new Promise(r => setTimeout(r, 0));
  // A CAS-1284-era account: the three starters still carry legacy `best`, flagged fully provisioned under
  // the OLD flag value (1) — step 1 (append) must not touch it, since all three are already present.
  const row = {
    user_id: "cas1287-test-user",
    view: {
      moods: [
        { id: "action", name: "Action", source: "catalogue", best: 30, order: "you" },
        { id: "imagine", name: "Imagine", source: "catalogue", best: 30, order: "you" },
        { id: "fun", name: "Fun", source: "catalogue", best: 30, order: "you" },
        { id: "custom-a", name: "Custom A", order: "score" },
      ],
      moodsProvisioned: 1,
    },
  };
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = makeFakeClient(row); auth.session = { user: { id: "cas1287-test-user" } };
  try{
    await E.CascadePersistence.loadUserPrefs();
    await settle();
    const byId = id => [...E.watchMoods].find(m => m.id === id);
    ["action", "imagine", "fun"].forEach(id => {
      assert.equal(byId(id).topYou, 20, `${id}: topYou must become 20`);
      assert.equal(byId(id).topPublic, 10, `${id}: topPublic must become 10`);
    });
    assert.equal(byId("custom-a").topYou, undefined, "a non-starter mood must be untouched by the migration");
    // CAS-1295: this load's moodsProvisionedLevel (1) is also <3, so the Starred provisioning step runs
    // too, appending a fifth mood — the CAS-1287 step itself still adds/removes none of the original four.
    assert.equal(E.watchMoods.length, 5, "CAS-1287's own step adds/removes none of the original four; Starred is CAS-1295's separate step");
    assert.ok(byId("starred"), "CAS-1295: Starred is appended by the same load");
  } finally {
    auth.enabled = false; auth.client = null; auth.session = null;
  }
});
