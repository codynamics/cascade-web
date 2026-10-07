// CAS-1106: production report — walking onboarding signed out, the services step opened with services
// (Netflix, Stan, Apple TV Store) already ticked, left over from an earlier session on this device. Cause:
// prefs.sub/prefs.store used to be read from localStorage["cascade_prefs"], shared by every session on this
// device — nothing cleared it when onboarding started. Fix: flowStart() resets prefs.sub/prefs.store/
// prefs.touched whenever there is no signed-in account, so a fresh onboarding run never inherits another
// session's picks off the same device.
//
// CAS-1221: there is no longer a device cache to leak from at all — prefs/tasteBase/notifyPrefs/occasionReg
// start at their defaults every page load and are never read from disk (DEVICE_KEY_ALLOWLIST, app_template.
// html). The leftover this suite guards against can now only arise WITHIN one page load — e.g. a previous
// in-page session (another account signing out, or a prior onboarding draft) left its in-memory values
// behind before this flow started — so these tests seed in-memory state directly rather than localStorage,
// and assert nothing is ever written back to disk either (there is no longer a chokepoint that would).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

test("CAS-1106: flowStart() clears leftover service picks before onboarding opens, signed out", () => {
  const store = new Map();
  const E = loadEngine({ localStorageStore: store });
  E.prefs.sub = new Set(["Netflix"]); E.prefs.store = new Set(["Apple TV Store"]); E.prefs.touched = true;

  E.flowStart();

  assert.equal(E.prefs.sub.size, 0, "prefs.sub must be empty once onboarding starts signed out");
  assert.equal(E.prefs.store.size, 0, "prefs.store must be empty once onboarding starts signed out");
  assert.equal(E.prefs.touched, false, "prefs.touched must be reset so CAS-915's auto-arm still applies");
  assert.equal(store.has("cascade_prefs"), false, "CAS-1221: the reset must never reach localStorage — there is no device cache left to write");
});

test("CAS-1106: a signed-in device's own picks are untouched by flowStart() (+ New Cascade)", () => {
  const E = loadEngine();
  E.CascadeAuth.enabled = true; E.CascadeAuth.status = "signed-in";
  E.prefs.sub = new Set(["Netflix"]); E.prefs.store = new Set(["Stan"]);

  E.flowStart("pickagent");   // "+ New Cascade" — an already-onboarded user adding another agent

  assert.equal(E.prefs.sub.size, 1, "a signed-in device's own service picks must survive flowStart()");
  assert.equal(E.prefs.store.size, 1, "a signed-in device's own service picks must survive flowStart()");
});

// CAS-1099 AC5: the same leftover-state problem, now also covering taste, notify choices and the occasions
// register — and, for a configured (CascadeAuth.enabled) build, the reset itself must not be written back
// either, since the whole draft stays in memory until membership completes.
test("CAS-1099 AC5: flowStart() also clears leftover taste/notify/occasions for a configured, signed-out run, in memory only", () => {
  const store = new Map();
  const E = loadEngine({ localStorageStore: store });
  E.CascadeAuth.enabled = true;   // a configured build — membNeedsEmail() now depends on sign-in status alone
  E.prefs.sub = new Set(["Netflix"]); E.prefs.store = new Set(["Apple TV Store"]);
  E.tasteBase.genres = ["Horror"];
  E.notifyPrefs.email = "stale@example.com";
  E.occasionReg.push({ id:"me", name:"Me" });

  E.flowStart();

  assert.equal(E.onbDraftModeOn, true, "a configured, signed-out run must be in draft mode");
  assert.equal(E.prefs.sub.size, 0, "services must still reset");
  assert.equal(JSON.stringify(E.tasteBase.genres), JSON.stringify([]), "taste must reset to defaults, not the leftover pick");
  assert.equal(E.notifyPrefs.email, "", "notify choices must reset to defaults, not the leftover pick");
  assert.equal(E.occasionReg.length, 0, "the occasions register must reset to empty");
  for(const key of ["cascade_prefs", "cascade_taste_base", "cascade_notifyprefs", "cascade_occasions"]){
    assert.equal(store.has(key), false, `CAS-1221: ${key} must never reach localStorage, draft or not`);
  }
});
