// CAS-1123 (Lee, 2026-10-01): there is no separate Notify switch for a window any more — a window that's
// switched on in Where & when you'll watch is both listed and alerted. migrateWatch folds any stored
// `notify` flag into `list` on the way in and drops `notify` for good; accountAlertKeysOn/alertLive (and so
// momentsOf, what the account sync writes as alert_moments) read a window's single `list` flag instead of
// a separate notify one.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}

test("CAS-1123: migrateWatch folds a stored notify flag into list and drops notify", () => {
  const migrated = E.migrateWatch({ rent: { list: false, notify: true } });
  // JSON.stringify, not deepEqual: migrateWatch runs inside the vm sandbox, whose plain objects carry a
  // different realm's Object.prototype — node:assert/strict's deepEqual is deepStrictEqual, which compares
  // prototypes and fails even on structurally identical objects across that boundary (see the same pattern
  // in tests/js/data-integrity.test.mjs).
  assert.equal(JSON.stringify(migrated), JSON.stringify({ rent: { list: true } }),
    "list must read true (list || notify) and no notify key must survive");
  assert.ok(!("notify" in migrated.rent), "notify must not merely be false — it must be gone entirely");
});

test("CAS-1177: watchPrefsDefaults ticks Upcoming's announced and opens_soon moments for a new account", () => {
  const defaults = E.watchPrefsDefaults();
  assert.equal(defaults.upcoming.subs.announced, true, "announced must default on");
  assert.equal(defaults.upcoming.subs.opens_soon, true, "opens_soon must default on");
});

test("CAS-1123: momentsOf includes hits_rent only while Rent is switched on", () => {
  // status:[] reads as "watching the whole ladder" (reachableRows), so this isolates the Rent window's
  // own switch rather than any scope/reachability gating. alertsOn:true (CAS-1198) so the agent's own
  // Alerts switch isn't the thing gating hits_rent here.
  const c = { status: [], alertsOn: true };
  withWatchPrefs({ rent: { list: true } }, () => {
    assert.ok(Array.from(E.CascadeShape.momentsOf(c)).includes("hits_rent"),
      "Rent on must make hits_rent a live moment");
  });
  withWatchPrefs({ rent: { list: false } }, () => {
    assert.ok(!Array.from(E.CascadeShape.momentsOf(c)).includes("hits_rent"),
      "Rent off must drop hits_rent from the live moments");
  });
});
