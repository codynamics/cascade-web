// CAS-1248: watchNavKey() (app_template.html, CAS-1236's settled-list fingerprint) listed neither the tabs
// a Where & when switch leaves enabled, nor the services matchesServices() tests against, nor a mood's own
// id/name — so switching a service chip off, switching a window off in Where & when, or renaming the
// selected mood all ended in a plain render() that reconcilePatchSettledList() absorbed instead of rebuilding
// the list/top area. AC5 exercises watchNavKey() directly against the three real mutators the ticket names.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

test("CAS-1248 AC5: watchNavKey() changes when a picked subscription is removed", () => {
  const E = loadEngine();
  const CP = E.CascadePersistence;
  E.setWatchTab("stream");
  E.prefs.sub.add("Netflix");

  const before = CP.watchNavKey();
  E.prefs.sub.delete("Netflix");
  assert.equal(E.prefs.sub.has("Netflix"), false, "sanity: the subscription must actually be gone");
  assert.notEqual(CP.watchNavKey(), before, "AC5: removing a picked subscription must change the nav key");
});

test("CAS-1248 AC5: watchNavKey() changes when wwToggleWin('rent') runs in Preferences mode", () => {
  const E = loadEngine();
  const CP = E.CascadePersistence;
  E.setWatchTab("rent");
  E.setPrefsWatchMode(true);
  E.setWatchPrefs({ ...E.watchPrefsDefaults(), rent: { list: true } });

  const before = CP.watchNavKey();
  E.window.wwToggleWin("rent");
  assert.equal(E.window.windowEnabled("rent"), false, "sanity: the window must actually be off now");
  assert.notEqual(CP.watchNavKey(), before, "AC5: switching a window off in Preferences mode must change the nav key");

  const off = CP.watchNavKey();
  E.window.wwToggleWin("rent");
  assert.equal(E.window.windowEnabled("rent"), true, "sanity: the window must actually be back on");
  assert.notEqual(CP.watchNavKey(), off, "AC5: switching it back on must change the nav key again");
});

test("CAS-1248 AC5: watchNavKey() changes when a mood is renamed through saveMoodFromSheet()", () => {
  const E = loadEngine();
  const CP = E.CascadePersistence;
  const mood = E.watchMoods.find(m => m.id === E.watchMoodSel);

  const before = CP.watchNavKey();
  E.window.openMoodSheetFor(mood.id);
  E.window.setMoodDraftName("Best ten");
  E.window.saveMoodFromSheet();

  const renamed = E.watchMoods.find(m => m.id === mood.id);
  assert.equal(renamed.name, "Best ten", "sanity: the mood must actually have been renamed");
  assert.notEqual(CP.watchNavKey(), before, "AC5: renaming the selected mood must change the nav key");
});
