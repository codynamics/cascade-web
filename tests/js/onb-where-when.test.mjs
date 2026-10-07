// CAS-1157: a new member who says "No" to the cinema question and "No" to the rent question used to
// finish onboarding with Where & when's Upcoming, In cinema and Standard Rent windows all switched ON —
// nothing in the v2 onboarding flow ever wrote watchPrefs, so it just sat at watchPrefsDefaults(). The
// fix: onbApplyWatchPrefsV2(ans), the one function the v2_cinema/v2_rent answers and the v2_done roster
// commit all call, derives the account's windows straight off those two answers (CAS-1156's explicit
// {list:false} shape for an off window), with the usual CAS-1099 memory-only draft rule.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function ans(E, overrides){
  return { ...E.onbAnswersV2Default(), partner:"yes", kids:"yes", kidAges:["G","PG"], styles:[], ages:["M"], ...overrides };
}

test("CAS-1157 AC1: cinema no, rent no — every account window off except stream, agents follow stream only", () => {
  const E = loadEngine();
  const a = ans(E, { cinema:"no", rent:"no" });
  E.onbApplyWatchPrefsV2(a);

  assert.equal(E.windowEnabled("upcoming"), false);
  assert.equal(E.windowEnabled("in_cinema"), false);
  assert.equal(E.windowEnabled("premium"), false);
  assert.equal(E.windowEnabled("rent"), false);
  assert.equal(E.windowEnabled("stream"), true);

  const agents = E.buildOnbAgentsV2(a);
  assert.ok(agents.length>0, "sanity: partner yes/kids yes must build at least massive/favs/date/family");
  agents.forEach(c=>{
    E.WATCH_LEVEL_KEYS.forEach(key=>{
      assert.equal(E.windowUsable(c,key), key==="stream",
        `${c.name}: windowUsable(${key}) must be ${key==="stream"} when cinema/rent are both no`);
    });
  });
});

test("CAS-1157 AC2: cinema no, rent yes — rent and stream on, upcoming/in_cinema/premium off", () => {
  const E = loadEngine();
  E.onbApplyWatchPrefsV2(ans(E, { cinema:"no", rent:"yes" }));

  assert.equal(E.windowEnabled("rent"), true);
  assert.equal(E.windowEnabled("stream"), true);
  assert.equal(E.windowEnabled("upcoming"), false);
  assert.equal(E.windowEnabled("in_cinema"), false);
  assert.equal(E.windowEnabled("premium"), false);
});

test("CAS-1157 AC3: cinema yes, rent no — upcoming/in_cinema/stream on, rent/premium off", () => {
  const E = loadEngine();
  E.onbApplyWatchPrefsV2(ans(E, { cinema:"yes", rent:"no" }));

  assert.equal(E.windowEnabled("upcoming"), true);
  assert.equal(E.windowEnabled("in_cinema"), true);
  assert.equal(E.windowEnabled("stream"), true);
  assert.equal(E.windowEnabled("rent"), false);
  assert.equal(E.windowEnabled("premium"), false);
});

test("CAS-1157 AC4: cinema yes, rent yes — watchPrefs is exactly watchPrefsDefaults()", () => {
  const E = loadEngine();
  E.onbApplyWatchPrefsV2(ans(E, { cinema:"yes", rent:"yes" }));

  assert.equal(JSON.stringify(E.watchPrefs), JSON.stringify(E.watchPrefsDefaults()));
});

test("CAS-1157 AC5: no/no then yes/yes re-derives back to watchPrefsDefaults()", () => {
  const E = loadEngine();
  E.onbApplyWatchPrefsV2(ans(E, { cinema:"no", rent:"no" }));
  assert.equal(E.windowEnabled("in_cinema"), false, "sanity: the first answer took effect");

  E.onbApplyWatchPrefsV2(ans(E, { cinema:"yes", rent:"yes" }));
  assert.equal(JSON.stringify(E.watchPrefs), JSON.stringify(E.watchPrefsDefaults()));
});

test("CAS-1157 AC6: signed out, draft mode — windows stay memory-only, but reach complete_membership's own row", () => {
  const store = new Map();
  const E = loadEngine({ localStorageStore: store });
  E.CascadeAuth.enabled = true;   // membNeedsEmail() needs this; status stays "signed-out"
  E.flowStart();
  assert.equal(E.onbDraftModeOn, true, "sanity: a configured, signed-out run must be in draft mode");

  E.onbApplyWatchPrefsV2(ans(E, { cinema:"no", rent:"no" }));

  assert.equal(store.has("cascade_watch_prefs"), false, "a draft's windows must never be written to localStorage");
  const row = E.CascadePersistence.userPrefsRow();
  assert.equal(row.watch_windows.rent.list, false);
  assert.equal(row.watch_windows.in_cinema.list, false);
});

test("CAS-1157 AC7: flowStart() resets watchPrefs to defaults before any answer, signed out", () => {
  const E = loadEngine();
  E.CascadeAuth.enabled = true;
  // CAS-1221: watchPrefs is never read from disk any more — the leftover this guards against can only be
  // an in-memory carry-over from earlier in the same page load (e.g. a previous draft). watchPrefs itself
  // is exposed as a getter-only binding, so mutate the object in place rather than reassign it.
  Object.keys(E.watchPrefs).forEach(k => delete E.watchPrefs[k]);
  Object.assign(E.watchPrefs, { stream:{list:true}, rent:{list:false} });

  E.flowStart();

  assert.equal(JSON.stringify(E.watchPrefs), JSON.stringify(E.watchPrefsDefaults()),
    "a signed-out first run must not inherit a leftover watchPrefs value from earlier in this page's life");
});

test("CAS-1157 AC8: discardOnbDraft() resets watchPrefs back to defaults", () => {
  const E = loadEngine();
  E.onbApplyWatchPrefsV2(ans(E, { cinema:"no", rent:"no" }));
  assert.equal(E.windowEnabled("in_cinema"), false, "sanity: the draft answer took effect");

  E.discardOnbDraft();

  assert.equal(JSON.stringify(E.watchPrefs), JSON.stringify(E.watchPrefsDefaults()));
});
