// CAS-1236 (redo of CAS-1229, reverted by CAS-1231): a reconcile pull that brings back exactly what this
// device already holds for a table must draw nothing — applyFilmRows/applyWatchRows/applyAgentFilmRows
// guard their own render() call on a per-table signature (reconcileUnchanged, private to the account-sync
// IIFE) rather than always repainting. Exercises the synchronous apply functions directly through
// CascadePersistence, the same seam every other account-sync test in this suite drives through.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

test("CAS-1236: applyFilmRows skips render() when a reconcile repeats the same user_films rows", () => {
  const E = loadEngine();
  const CP = E.CascadePersistence;

  CP.renderCallCount = 0;
  CP.applyFilmRows([{ user_id: "u1", movie_id: "100", status: "liked" }]);
  assert.equal(CP.renderCallCount, 1, "the first pull must still paint");

  CP.applyFilmRows([{ user_id: "u1", movie_id: "100", status: "liked" }]);   // a fresh array, same content
  assert.equal(CP.renderCallCount, 1, "a repeat of the same rows must call render() zero more times");

  CP.applyFilmRows([{ user_id: "u1", movie_id: "100", status: "disliked" }]);
  assert.equal(CP.renderCallCount, 2, "a genuinely different row must still repaint");
});

test("CAS-1236: applyWatchRows skips render() when a reconcile repeats the same film_watch rows", () => {
  const E = loadEngine();
  const CP = E.CascadePersistence;

  const rows = [{ user_id: "u1", movie_id: "200", windows: ["stream"], sources: { stream: "manual" } }];
  CP.renderCallCount = 0;
  CP.applyWatchRows(rows);
  assert.equal(CP.renderCallCount, 1, "the first pull must still paint");

  CP.applyWatchRows(rows.map(r => ({ ...r })));
  assert.equal(CP.renderCallCount, 1, "a repeat of the same rows must call render() zero more times");

  CP.applyWatchRows([{ user_id: "u1", movie_id: "200", windows: ["rent"], sources: { rent: "manual" } }]);
  assert.equal(CP.renderCallCount, 2, "a genuinely different row must still repaint");
});

test("CAS-1236: applyAgentFilmRows reports whether the pull actually changed anything", () => {
  const E = loadEngine();
  const CP = E.CascadePersistence;

  const rows = [{ cascade_id: "c1", movie_id: "300", admitted_at: "2026-10-01T00:00:00Z",
    admission_score: 1, admission_status: "ok", agent_sig: "sig1" }];
  assert.equal(CP.applyAgentFilmRows(rows), true, "the first pull always counts as a change");
  assert.equal(CP.applyAgentFilmRows(rows.map(r => ({ ...r }))), false,
    "a repeat of the same rows must report no change");
  assert.equal(
    CP.applyAgentFilmRows([{ ...rows[0], admission_status: "revoked" }]),
    true, "a genuinely different row must report a change");
});

// AC-LOAD: CAS-1231's exact failure — a full rebuild ran (and recorded a nav key) against a list that had
// nothing to show, and a LATER render against the SAME nav key (nothing navigational touched in between)
// trusted that key and only ever patched the existing — empty — list, which can never ADD a card. The real
// bug needed window.CascadePersistence to not exist yet (the very first boot paint, before the account-sync
// IIFE has even run) — unreachable from this harness, since CascadePersistence is already fully constructed
// by the time any test runs. The harness-reachable equivalent the ticket's own words cover just as literally
// ("any render where the list was empty") is used instead: a full rebuild that legitimately found nothing
// (no agents loaded yet), followed by one that does, with the Watch screen's own nav state (stage, agents,
// sort, filter, search) completely untouched in between.
function seedWideOpenAgent(E, id){
  // status:[] with an unreachable imdb floor matches nothing by criteria alone (same synthetic-agent
  // technique cas1226/cas1146 use) — membership instead comes from the explicit pin below, so this test
  // depends on nothing about the real catalogue's current contents.
  const c = E.normCascade({ id, name: "AC-LOAD agent", kind: "stream", status: [], imdb: 10.1 });
  c.paused = false;
  E.cascades.push(c);
  return c;
}
function plantAndAdmit(E, cascadeId){
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id));
  assert.ok(donor, "no unwatched film in the harness catalogue to clone — this test would prove nothing");
  const id = -1236000001;
  const film = { ...donor, tmdb_id: id, status: ["upcoming"], cinema_date: null };
  E.MOVIES.push(film);
  // Pins the film straight to this one agent (CAS-1226's wireFilm technique) — admits it regardless of the
  // agent's own (deliberately unmatchable) criteria, and needs no Watch On level: "upcoming" already lands
  // in the in_cinema tab's default bucket with no further wiring.
  E.notify[id] = { source: "auto", cascadeIds: [cascadeId], pinnedTo: [cascadeId], notIn: [],
    wins: { in_cinema: false, premium: false, rent: false, stream: false }, winsSource: {} };
  return id;
}

test("CAS-1236 AC-LOAD: a render that found nothing must not block the list from filling once the account's real data arrives, even with no navigation in between", () => {
  const E = loadEngine();
  const CP = E.CascadePersistence;
  E.CascadeAuth.enabled = true;
  E.CascadeAuth.client = {};
  E.CascadeAuth.session = { user: { id: "u-ac-load" } };
  E.setWatchTab("in_cinema");

  try{
    // Pass 1: the account is signed in and nothing is blocking accountFanoutSettled() (CAS-1231's own
    // premature-settle condition), but no agent has loaded yet — a full rebuild runs (watchSettledNavKey was
    // still null), finds zero rows, and must record that the list came up empty.
    CP.applyFilmRows([{ user_id: "u-ac-load", movie_id: "900001", status: "liked" }]);
    assert.equal(CP.watchListFilled, false, "sanity: no agents loaded yet, so nothing to show");

    // Pass 2: the account's agent (and its one admitted film) actually arrives — CAS-1231's "the account's
    // 4 agents loaded" — with nothing about the Watch screen's own nav state touched in between, so
    // watchNavKey() is byte-identical to what pass 1 recorded. The old (CAS-1229) code trusted that match
    // and only ever patched the existing, still-empty list — exactly the failure CAS-1231 reverted.
    const agentId = "ac-load-agent";
    seedWideOpenAgent(E, agentId);
    plantAndAdmit(E, agentId);
    CP.applyFilmRows([{ user_id: "u-ac-load", movie_id: "900002", status: "liked" }]);   // a distinct row, so this pull isn't itself skipped as unchanged

    assert.equal(CP.watchListFilled, true,
      "the list must fill once the account's real data arrives, even at an unchanged nav key");
  } finally {
    E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null;
  }
});
