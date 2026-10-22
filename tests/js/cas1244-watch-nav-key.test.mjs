// CAS-1244: watchNavKey() (app_template.html, CAS-1236's settled-list fingerprint) listed watchTab but not
// watchCinemaStage — so setWatchStage() ended in a plain render() that landed on reconcilePatchSettledList()
// and never rebuilt the list. Exercises watchNavKey() (exposed through CascadePersistence, same seam as the
// rest of this account-sync IIFE's surface) directly against the real stage mutator.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

test("CAS-1244 AC2: watchNavKey() changes when the Cinema stage changes, and back again", () => {
  const E = loadEngine();
  const CP = E.CascadePersistence;
  E.setWatchTab("in_cinema");
  E.setWatchCinemaStage("upcoming");

  const upcomingKey = CP.watchNavKey();
  E.window.setWatchStage("in_cinema");
  assert.equal(E.watchCinemaStage, "in_cinema", "sanity: the stage must have actually changed");
  const inCinemaKey = CP.watchNavKey();
  assert.notEqual(inCinemaKey, upcomingKey, "AC2: a stage change must change the nav key");

  E.window.setWatchStage("upcoming");
  assert.equal(CP.watchNavKey(), upcomingKey, "AC2: switching back must restore the original nav key");
});
