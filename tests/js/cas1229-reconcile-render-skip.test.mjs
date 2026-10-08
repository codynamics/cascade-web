// CAS-1229: a reconcile pull that brings back exactly what this device already holds for a table must
// draw nothing — applyFilmRows/applyWatchRows guard their own render() call on a per-table signature
// (reconcileUnchanged, private to the account-sync IIFE) rather than always repainting. Exercises the two
// synchronous apply functions directly through CascadePersistence, the same seam every other account-sync
// test in this suite drives through.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

test("CAS-1229: applyFilmRows skips render() when a reconcile repeats the same user_films rows", () => {
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

test("CAS-1229: applyWatchRows skips render() when a reconcile repeats the same film_watch rows", () => {
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

test("CAS-1229: applyAgentFilmRows reports whether the pull actually changed anything", () => {
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
