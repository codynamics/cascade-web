// CAS-1106: production report — walking onboarding signed out, the services step opened with services
// (Netflix, Stan, Apple TV Store) already ticked, left over from an earlier session on this device. Cause:
// prefs.sub/prefs.store are read from localStorage[acctKey("cascade_prefs")], which on a signed-out device
// is the shared @guest key — nothing cleared it when onboarding started. Fix: flowStart() resets prefs.sub/
// prefs.store/prefs.touched (and saves) whenever acctSuffix is "guest", so a fresh onboarding run never
// inherits another session's picks off the same device.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

test("CAS-1106: flowStart() clears leftover @guest service picks before onboarding opens", () => {
  const store = new Map();
  store.set("cascade_prefs@guest", JSON.stringify({ on:false, touched:true, sub:["Netflix"], store:["Apple TV Store"] }));
  const E = loadEngine({ localStorageStore: store });

  assert.equal(E.prefs.sub.size, 1, "sanity: the engine loaded the leftover @guest pick");
  assert.equal(E.prefs.store.size, 1, "sanity: the engine loaded the leftover @guest pick");

  E.flowStart();

  assert.equal(E.prefs.sub.size, 0, "prefs.sub must be empty once onboarding starts signed out");
  assert.equal(E.prefs.store.size, 0, "prefs.store must be empty once onboarding starts signed out");
  assert.equal(E.prefs.touched, false, "prefs.touched must be reset so CAS-915's auto-arm still applies");

  const saved = JSON.parse(store.get("cascade_prefs@guest"));
  assert.deepEqual(saved.sub, [], "the reset must be persisted, not just held in memory");
  assert.deepEqual(saved.store, [], "the reset must be persisted, not just held in memory");
});

test("CAS-1106: a signed-in device's own picks are untouched by flowStart() (+ New Cascade)", () => {
  const store = new Map();
  store.set("cascade_acct_suffix", "abc123");
  store.set("cascade_prefs@abc123", JSON.stringify({ on:false, touched:true, sub:["Netflix"], store:["Stan"] }));
  const E = loadEngine({ localStorageStore: store });

  assert.equal(E.prefs.sub.size, 1, "sanity: the engine loaded the signed-in account's own pick");

  E.flowStart("pickagent");   // "+ New Cascade" — an already-onboarded user adding another agent

  assert.equal(E.prefs.sub.size, 1, "a signed-in device's own service picks must survive flowStart()");
  assert.equal(E.prefs.store.size, 1, "a signed-in device's own service picks must survive flowStart()");
});
