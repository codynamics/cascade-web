// CAS-1535: the day +1 catch-up's server picks (monitor/catchup_shim.mjs) must equal the app's own Me list.
//
// The "app" side is driven here by hand, the way the app drives itself after sign-in: the account facts
// are applied, the Me mood is selected (applyMoodToState), a stage tab is chosen, and the list is read off
// watchVisibleRows() -> listingGroups() - the entry points render() uses. The server side is the shim run
// as the monitor runs it (a child process, JSON on stdin/stdout). Only the server's own rule - drop films
// with a verdict, cap 3/5/10, streaming only on the member's own services - is applied on top.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIM = path.join(ROOT, "monitor", "catchup_shim.mjs");
const CAPS = { cinema: 3, coming: 5, streaming: 10 };
const STAGES = { cinema: ["in_cinema", "in_cinema"], coming: ["in_cinema", "upcoming"], streaming: ["stream", "in_cinema"] };

const CRITERIA = { v: 2, styles: {
  Drama: { bar: 40, al: {} }, Comedy: { bar: 40, al: {} }, Action: { bar: 40, al: {} },
  Thriller: { bar: 40, al: {} }, Horror: { bar: 40, al: {} }, Adventure: { bar: 40, al: {} } } };
const SERVICES = ["Netflix", "Stan"];
// A Me list the member has edited: its own Show cap, as the mood sheet would save it.
const ME = { id: "me", name: "Me", show: "40", watched: true, v2: true };

function runShim(user){
  const out = execFileSync("node", [SHIM], { input: JSON.stringify({ users: [user] }), encoding: "utf8", cwd: ROOT });
  return JSON.parse(out)[user.userId];
}

function user(filmStatuses){
  return { userId: "u1", langs: ["en"], subServices: SERVICES, storeServices: [], servicesOnly: false,
           filmStatuses, criteria: CRITERIA, moods: [ME] };
}

// The app's Me list for one stage, in its own order, before the server's own rule.
function appList(stage, filmStatuses){
  const E = loadEngine();
  E.CascadePersistence.accountActive = () => true;
  E.tasteBase.langs = ["en"];
  E.prefs.sub.clear(); SERVICES.forEach(s => E.prefs.sub.add(s));
  E.prefs.store.clear();
  E.prefs.on = false;
  E.CascadePersistence.applyFilmRows(filmStatuses);
  E.cascades.length = 0;
  E.cascades.push({ ...E.normCascade(JSON.parse(JSON.stringify(CRITERIA))), v: 2 });
  const mood = { ...E.oamMoodDefaultFields(), ...ME };
  E.watchMoods.length = 0; E.watchMoods.push(mood);
  E.applyMoodToState(mood);
  const [tab, half] = STAGES[stage];
  E.setWatchTab(tab); E.setWatchCinemaStage(half);
  const { rows } = E.watchVisibleRows();
  const ordered = E.listingGroups(rows, null).flatMap(g => g.items);
  return { E, ordered };
}

function expected(stage, filmStatuses){
  const held = new Set(filmStatuses.map(r => String(r.movie_id)));
  const { E, ordered } = appList(stage, filmStatuses);
  const own = new Set(SERVICES);
  // Array.from: the engine's arrays belong to its vm realm, and deepStrictEqual compares prototypes.
  return Array.from(ordered)
    .filter(m => !held.has(String(m.tmdb_id)))
    .filter(m => stage !== "streaming" || (m.offers || []).some(o => (o.type === "sub" || o.type === "free") && own.has(E.svcCanon(o.service))))
    .slice(0, CAPS[stage]).map(m => String(m.tmdb_id));
}

test("server picks equal the app's Me list for each group (caps 3/5/10)", () => {
  const got = runShim(user([]));
  for (const stage of Object.keys(CAPS)){
    assert.deepEqual(got[stage], expected(stage, []), stage);
    assert.ok(got[stage].length <= CAPS[stage], stage);
  }
  assert.ok(got.cinema.length > 0 && got.coming.length > 0 && got.streaming.length > 0, "fixture must fill every group");
});

test("a watched film and a Not for me film are skipped and the next one steps up, in the list's own order", () => {
  const base = runShim(user([]));
  const statuses = [
    { movie_id: base.cinema[0], status: "wow" },       // watched
    { movie_id: base.coming[0], status: "notfor" },    // Not for me
    { movie_id: base.streaming[1], status: "liked" },
  ];
  const got = runShim(user(statuses));
  assert.ok(!got.cinema.includes(base.cinema[0]));
  assert.ok(!got.coming.includes(base.coming[0]));
  assert.ok(!got.streaming.includes(base.streaming[1]));
  for (const stage of Object.keys(CAPS)) assert.deepEqual(got[stage], expected(stage, statuses), stage);
  assert.equal(got.cinema[0], base.cinema[1]);
});

test("streaming lists only films on the member's own services", () => {
  const { E } = appList("streaming", []);
  const got = runShim({ ...user([]), subServices: ["Stan"] });
  for (const id of got.streaming){
    const m = E.filmByMovieId(id);
    assert.ok((m.offers || []).some(o => (o.type === "sub" || o.type === "free") && E.svcCanon(o.service) === "Stan"), id);
  }
  const none = runShim({ ...user([]), subServices: [] });
  assert.deepEqual(none.streaming, []);
});

test("an account with no agent gets nothing", () => {
  const got = runShim({ ...user([]), criteria: null });
  assert.deepEqual(got, { cinema: [], coming: [], streaming: [] });
});

test("movingIsNewMoment('catchup') is true and REAL_MOMENT_SAID has a phrase for it (AC9)", () => {
  const E = loadEngine();
  assert.equal(E.movingIsNewMoment("catchup"), true);
  assert.equal(E.movingIsNewMoment("hits_cinema"), false);
  assert.ok(E.REAL_MOMENT_SAID.catchup && E.REAL_MOMENT_SAID.catchup.length > 0);
});
