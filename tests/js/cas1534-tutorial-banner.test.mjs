// CAS-1534: the tutorial banner's decision function, and "starting a tutorial marks it played".
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// Sydney is UTC+11 in November: 2026-11-20 10:00 UTC is 21:00 on the 20th there.
const CREATED = "2026-11-20T10:00:00Z";
const DAY1 = Date.parse("2026-11-20T12:00:00Z");   // same Sydney calendar day (23:00 on the 20th)
const DAY2 = Date.parse("2026-11-21T00:00:00Z");   // 11:00 on the 21st in Sydney
const base = (o = {}) => ({ key: "agent", now: DAY2, createdAt: CREATED, signedIn: true, seen: {}, steps: 5,
  shownThisVisit: false, blocked: false, ...o });

test("no banner on day 1", () => {
  assert.equal(E.tutBannerDecide(base({ now: DAY1 })), false);
});
test("a banner on day 2 for an unplayed tutorial", () => {
  assert.equal(E.tutBannerDecide(base()), true);
});
test("day 2 is counted in Sydney time, not UTC", () => {
  // 13:30 UTC on the 20th is 00:30 on the 21st in Sydney, still the same UTC date as creation.
  assert.equal(E.tutBannerDecide(base({ now: Date.parse("2026-11-20T13:30:00Z") })), true);
});
test("none once played", () => {
  assert.equal(E.tutBannerDecide(base({ seen: { agent: { played: true, dismissed: 0 } } })), false);
});
test("none after 2 dismissals, still one after 1", () => {
  assert.equal(E.tutBannerDecide(base({ seen: { agent: { played: false, dismissed: 1 } } })), true);
  assert.equal(E.tutBannerDecide(base({ seen: { agent: { played: false, dismissed: 2 } } })), false);
});
test("only one per visit", () => {
  assert.equal(E.tutBannerDecide(base({ shownThisVisit: true })), false);
});
test("never while a tutorial runs or something covers the screen", () => {
  assert.equal(E.tutBannerDecide(base({ blocked: true })), false);
});
test("none for Alerts while its tutorial has 1 step", () => {
  assert.equal(E.tutBannerDecide(base({ key: "alerts", steps: 1 })), false);
  assert.equal(E.tutBannerDecide(base({ key: "alerts", steps: 3 })), true);
  assert.ok(E.TOURS.alerts.steps.length >= 1);
});
test("none for invite when signed out", () => {
  assert.equal(E.tutBannerDecide(base({ key: "invite", signedIn: false })), false);
  assert.equal(E.tutBannerDecide(base({ key: "invite" })), true);
});
test("starting a tutorial marks it played; adopting merges played and the larger dismissed count", () => {
  E.tutMarkPlayed("database");
  assert.equal(E.tutSeenMap.database.played, true);
  E.tutAdoptSeen({ database: { played: false, dismissed: 2 }, moods: { played: true, dismissed: 1 } });
  assert.equal(E.tutSeenMap.database.played, true); assert.equal(E.tutSeenMap.database.dismissed, 2);
  assert.equal(E.tutSeenMap.moods.played, true); assert.equal(E.tutSeenMap.moods.dismissed, 1);
});
