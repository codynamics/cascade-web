// CAS-1324: primaryStatus() used to decide a dual rent/stream title's standing by asking scopedFor(), which
// reads activeCascade() and substitutes the OPEN AGENT's own myServices for the account switch whenever any
// agent is open — so which section/count a film stood in on Watch flipped with whichever agent was last
// opened, not with the account's own "only my services" switch (CAS-853: the account switch is authoritative
// for every agent). Fix: primaryStatus now reads prefs.on directly (accountScopedFor()), never activeCascade().
// cardHTML's own card-level services narrowing gets the same fix, but only when rendering for Watch
// (inWatch:true) — Find and the Moving ledger are agent-builder/admission-adjacent screens that keep
// following the open agent's own scope via prefsActive(), untouched (see the ticket's own hypothesis).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// status:[]/imdb:10.1 agents admit nothing by criteria — the same synthetic-agent technique CAS-1146/
// CAS-1323's own tests use. Only .myServices matters for these tests.
function seedCascade(E, id, myServices){
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.order = 0; c.paused = false; c.name = id; c.myServices = myServices;
  return c;
}
// Clones a real catalogue film so every incidental field other code reads stays valid — only tmdb_id,
// status and offers are overridden: a dual rent/stream title (status order reversed from CASCADE's own
// ladder, so "last" and the scoped own-reach answer disagree whenever the bug is live — see AC1 below),
// reachable through a streaming service the account itself picks, not through the rental offer.
let cloneSeq = 0;
function cloneDualWindowFilm(E, subService, rentService){
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && !E.blocked.has(m.tmdb_id));
  assert.ok(donor, "no unwatched/unblocked film in the harness catalogue to clone — this test would prove nothing");
  cloneSeq++;
  const id = -1324000000 - cloneSeq;
  const film = { ...donor, tmdb_id: id, status: ["included_streaming", "rental"], cinema_date: null,
    offers: [{ service: subService, type: "sub", price: null }, { service: rentService, type: "rent", price: 9.99 }] };
  E.MOVIES.push(film);
  return id;
}
function unplantFilm(E, id){
  const i = E.MOVIES.findIndex(m => m.tmdb_id === id);
  if (i !== -1) E.MOVIES.splice(i, 1);
  delete E.notify[id];
}

test("CAS-1324 AC1: primaryStatus must return the same value with no agent open, and after opening either of two agents whose myServices differ", () => {
  const E = loadEngine();
  const savedOn = E.prefs.on;
  const savedSub = new Set(E.prefs.sub);
  const subService = E.SUB_SERVICES[0];
  E.prefs.on = true;
  E.prefs.sub.add(subService);
  const id = cloneDualWindowFilm(E, subService, E.STORE_SERVICES[0]);
  const film = E.MOVIES.find(m => m.tmdb_id === id);
  // agentA scopes neither window; agentB scopes both — pre-fix, scopedFor() substitutes the open agent's own
  // myServices for prefs.on, so these two disagree with each other AND with the no-agent reading.
  const agentA = seedCascade(E, "cas1324-a1", { pvod: false, rental: false, included_streaming: false });
  const agentB = seedCascade(E, "cas1324-b1", { pvod: false, rental: true, included_streaming: true });
  const savedCascades = E.cascades.slice();
  E.cascades.length = 0; E.cascades.push(agentA, agentB);
  try {
    const noAgent = E.primaryStatus(film);
    assert.equal(noAgent, "included_streaming", "setup: with the account scope on and the film reachable via a picked streaming service, no agent open must read Stream");
    E.setActive(agentA.id, false);
    const withA = E.primaryStatus(film);
    E.setActive(agentB.id, false);
    const withB = E.primaryStatus(film);
    assert.equal(withA, noAgent, "AC1: opening agentA must not change primaryStatus");
    assert.equal(withB, noAgent, "AC1: opening agentB must not change primaryStatus");
  } finally {
    E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
    E.prefs.on = savedOn;
    E.prefs.sub.clear(); savedSub.forEach(s => E.prefs.sub.add(s));
    unplantFilm(E, id);
  }
});

test("CAS-1324 AC2: watchStageCountFor must return the same count for a stage regardless of which agent is open", () => {
  const E = loadEngine();
  const savedOn = E.prefs.on;
  const savedSub = new Set(E.prefs.sub);
  const savedStore = new Set(E.prefs.store);
  const savedWatchPrefs = E.watchPrefs;
  const savedCascades = E.cascades.slice();
  const savedAgentOff = new Set(E.watchAgentOff);
  const subService = E.SUB_SERVICES[0], rentService = E.STORE_SERVICES[0];
  E.prefs.on = true;
  E.prefs.sub.add(subService);
  E.prefs.store.add(rentService);   // both windows reachable, so mineOnly (on by default) never hides the film
  E.setWatchPrefs({ ...savedWatchPrefs, in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
    rent: { list: true, notify: false }, stream: { list: true, notify: false } });
  E.watchAgentOff.clear();

  const id = cloneDualWindowFilm(E, subService, rentService);
  const agentA = seedCascade(E, "cas1324-a2", { pvod: false, rental: false, included_streaming: false });
  const agentB = seedCascade(E, "cas1324-b2", { pvod: false, rental: true, included_streaming: true });
  E.cascades.length = 0; E.cascades.push(agentA, agentB);
  // Wired straight into notify (pinnedTo, the CAS-793/CAS-1146 technique): listedBy admits it for both
  // agents trivially (status:[] can't by criteria), and a standing Stream Watch On key makes the stream
  // stage's own membership test (filmMatchesWatchTab) key off primaryStatus directly.
  E.notify[id] = { source: "auto", cascadeIds: [agentA.id, agentB.id], pinnedTo: [agentA.id, agentB.id], notIn: [],
    wins: { in_cinema: false, premium: false, rent: false, stream: true }, winsSource: { stream: "manual" } };

  try {
    const streamStop = { tabKey: "stream", key: "stream" };
    const noAgent = E.watchStageCountFor(streamStop);
    assert.equal(noAgent, 1, "setup: with no agent open the film must count toward the Stream stage");
    E.setActive(agentA.id, false);
    const withA = E.watchStageCountFor(streamStop);
    E.setActive(agentB.id, false);
    const withB = E.watchStageCountFor(streamStop);
    assert.equal(withA, noAgent, "AC2: opening agentA must not change the Stream stage's count");
    assert.equal(withB, noAgent, "AC2: opening agentB must not change the Stream stage's count");
  } finally {
    E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
    E.watchAgentOff.clear(); savedAgentOff.forEach(aid => E.watchAgentOff.add(aid));
    unplantFilm(E, id);
    E.prefs.on = savedOn;
    E.prefs.sub.clear(); savedSub.forEach(s => E.prefs.sub.add(s));
    E.prefs.store.clear(); savedStore.forEach(s => E.prefs.store.add(s));
    E.setWatchPrefs(savedWatchPrefs);
  }
});

// Brace-matches a top-level `function name(...){ ... }` declaration out of the source text, so the check
// below reads only primaryStatus's own body rather than the whole file (activeCascade/scopedFor are real,
// legitimate calls elsewhere — see scopedFor/servicesScoped and their remaining callers).
function extractFunctionBody(src, name){
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `${sig} not found in app_template.html`);
  const openBrace = src.indexOf("{", start);
  let depth = 0, i = openBrace;
  for (; i < src.length; i++){
    if (src[i] === "{") depth++;
    else if (src[i] === "}"){ depth--; if (depth === 0) break; }
  }
  return src.slice(openBrace, i + 1);
}

test("CAS-1324 AC3: primaryStatus no longer calls activeCascade, scopedFor or servicesScoped", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const body = extractFunctionBody(src, "primaryStatus");
  assert.ok(!body.includes("activeCascade"), "primaryStatus must not call activeCascade()");
  assert.ok(!body.includes("scopedFor("), "primaryStatus must not call scopedFor()");
  assert.ok(!body.includes("servicesScoped("), "primaryStatus must not call servicesScoped()");
  assert.ok(body.includes("accountScopedFor()"), "primaryStatus must read the account-switch-only helper");
});
