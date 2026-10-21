// CAS-1328: the built-in "Releases" mood (id "releases") becomes "Latest" — every cinema release of the
// last 12 months or still ahead, in release order, whatever any agent thinks of it. source/sort are fixed
// by the app for this one id, never taken from an existing account's stored record (CAS-1218/1243: a load
// never rewrites it), and the display name reads "Latest" unless the person has typed their own.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Same UTC-date arithmetic as the engine's own addDays (app_template.html) — not exported, so reproduced
// here against E.TODAY rather than hard-coding a date relative to the real wall clock.
function isoOffset(E, days){
  const d = new Date(E.TODAY + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A minimal real cinema release: passes showable() via hasConfirmedOffer (a real offer, not estimated) and
// passesTasteBase() via the harness's default English-only taste baseline (CAS-1286/CAS-560).
let seq = 0;
function cinemaReleaseFixture(E, overrides){
  seq++;
  return { tmdb_id: 93280000 + seq, title: `CAS-1328 fixture ${seq}`, genres: ["Drama"], language: "en",
    status: ["included_streaming"], offers: [{ type: "sub", service: "netflix" }],
    cinema_release: true, _fixture: true, ...overrides };
}
function withFixture(E, film, fn){
  E.MOVIES.push(film);
  try { return fn(); }
  finally { const i = E.MOVIES.findIndex(m => m.tmdb_id === film.tmdb_id); if(i !== -1) E.MOVIES.splice(i, 1); }
}
function withReleasesSelected(E, fn){
  const savedSel = E.watchMoodSel;
  if(savedSel !== "releases") E.window.setWatchMood("releases");
  try { return fn(); }
  finally { if(E.watchMoodSel !== savedSel) E.window.setWatchMood(savedSel); }
}

test("CAS-1328: MOOD_DEFAULTS' built-in releases entry is named Latest and sourced from the catalogue", () => {
  const E = loadEngine();
  const releases = [...E.MOOD_DEFAULTS].find(m => m.id === "releases");
  assert.equal(releases.name, "Latest");
  assert.equal(releases.source, "catalogue");
  assert.equal(releases.topYou, null, "Latest ignores Show top You — every release, not a ranked cut");
  assert.equal(releases.topPublic, null, "Latest ignores Show top Public — every release, not a ranked cut");
});

test("CAS-1328 Change 1: moodSource/moodSort are fixed for id \"releases\", ignoring whatever a stored record carries", () => {
  const E = loadEngine();
  const legacyStored = { id: "releases", name: "Releases", source: "agents", sort: "score", agentsOff: ["any-agent"] };
  assert.equal(E.moodSource(legacyStored), "catalogue", "source is fixed by the app, never the stored field");
  assert.equal(E.moodSort(legacyStored), "release", "sort is fixed by the app, never the stored field");
  // A non-Latest mood is untouched by either override.
  const other = { id: "t-other", source: "agents", sort: "score" };
  assert.equal(E.moodSource(other), "agents");
  assert.equal(E.moodSort(other), "score");
});

test("CAS-1328 Change 1: moodDisplayName reads \"Latest\" for the untouched default, keeps a name the person typed themselves", () => {
  const E = loadEngine();
  assert.equal(E.moodDisplayName({ id: "releases", name: "Releases" }), "Latest");
  assert.equal(E.moodDisplayName({ id: "releases", name: "Friday night" }), "Friday night",
    "a name the person actually typed is never overridden");
  assert.equal(E.moodDisplayName({ id: "t-other", name: "Releases" }), "Releases",
    "the override is keyed off id \"releases\" only, never off the literal name elsewhere");
});

test("CAS-1328 AC1: a cinema release 4 months old, standing in Streaming, shows under Latest with no agent admitting it", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  E.setWatchTab("stream");
  const x = cinemaReleaseFixture(E, { cinema_date: isoOffset(E, -120) });
  withFixture(E, x, () => {
    withReleasesSelected(E, () => {
      const rows = [...E.watchScopeRows()];
      assert.ok(rows.some(m => m.tmdb_id === x.tmdb_id),
        "AC1: a recent cinema release standing in Streaming must show under Latest");
    });
  });
  E.setWatchTab(savedTab);
});

test("CAS-1328 AC2: a cinema release 14 months old never shows under Latest; one releasing next month shows in Upcoming", () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
  const savedStage = E.watchCinemaStage;
  const y = cinemaReleaseFixture(E, { cinema_date: isoOffset(E, -425) });
  const z = cinemaReleaseFixture(E, { status: ["upcoming"], cinema_date: isoOffset(E, 30) });
  withFixture(E, y, () => withFixture(E, z, () => {
    withReleasesSelected(E, () => {
      E.setWatchTab("stream");
      const streamRows = [...E.watchScopeRows()];
      assert.ok(!streamRows.some(m => m.tmdb_id === y.tmdb_id),
        "AC2: a cinema release over 12 months old must not show under Latest on any stage");

      E.setWatchTab("in_cinema");
      E.setWatchCinemaStage("upcoming");
      const upcomingRows = [...E.watchScopeRows()];
      assert.ok(upcomingRows.some(m => m.tmdb_id === z.tmdb_id),
        "AC2: a cinema release due next month must show under Latest's Upcoming stage");
    });
  }));
  E.setWatchTab(savedTab);
  E.setWatchCinemaStage(savedStage);
});

test("CAS-1328 AC3: an account whose stored releases mood still carries source:\"agents\" and every agent off still lists Latest's catalogue pool, with no write on load", async () => {
  const E = loadEngine();
  const savedTab = E.watchTab;
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
  // moodsProvisioned already at the latest level so the unrelated CAS-1284/1287/1295 starter-provisioning
  // steps don't also fire here (same precedent as the CAS-1303 AC3 engine test).
  const legacyMood = { id: "releases", name: "Releases", source: "agents", agentsOff: ["an-agent-id"] };
  const client = makeFakeClient({
    user_id: "cas1328-test-user",
    view: { moods: [legacyMood], mood: "releases", moodsProvisioned: 3 },
  });
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: "cas1328-test-user" } };
  const x = cinemaReleaseFixture(E, { cinema_date: isoOffset(E, -120) });
  E.MOVIES.push(x);
  try{
    await E.CascadePersistence.loadUserPrefs();
    await settle();

    assert.equal(E.watchMoodSel, "releases", "setup: the account's own mood.mood selection must have loaded");
    E.setWatchTab("stream");
    const rows = [...E.watchScopeRows()];
    assert.ok(rows.some(m => m.tmdb_id === x.tmdb_id),
      "AC3: a legacy source:\"agents\" stored record must still behave as Latest's catalogue pool");
    assert.equal(client.rpcCalls.length, 0, "CAS-1218/1243: loading an account must never write anything back");
  } finally {
    const i = E.MOVIES.findIndex(m => m.tmdb_id === x.tmdb_id); if(i !== -1) E.MOVIES.splice(i, 1);
    auth.enabled = false; auth.client = null; auth.session = null;
    E.setWatchTab(savedTab);
  }
});

test("CAS-1328 AC4: app_template.html names the mood \"Latest\"", () => {
  const html = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const count = (html.match(/"Latest"/g) || []).length;
  assert.ok(count >= 1, "AC4: app_template.html must contain the literal \"Latest\" string");
});
