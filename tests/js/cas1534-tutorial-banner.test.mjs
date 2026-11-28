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
  visit: undefined, blocked: false, ...o });

test("CAS-1702: a banner from day one", () => {
  assert.equal(E.tutBannerDecide(base({ now: DAY1 })), true);
  assert.equal(E.tutBannerDecide(base()), true);
});
test("none once played", () => {
  assert.equal(E.tutBannerDecide(base({ seen: { agent: { played: true, dismissed: 0, shown: 1 } } })), false);
});
test("CAS-1702: first 3 shown visits only; dismissals never end it early", () => {
  assert.equal(E.tutBannerDecide(base({ seen: { agent: { played: false, dismissed: 2, shown: 2 } } })), true);
  assert.equal(E.tutBannerDecide(base({ seen: { agent: { played: false, dismissed: 3, shown: 3 } } })), false);
});
test("CAS-1702: once per visit and screen; a redraw of this visit's banner is allowed, a dismissed one is not", () => {
  const seen = { agent: { played: false, dismissed: 0, shown: 3 } };
  assert.equal(E.tutBannerDecide(base({ seen, visit: "shown" })), true);
  assert.equal(E.tutBannerDecide(base({ visit: "dismissed" })), false);
});
test("never while a tutorial runs or something covers the screen", () => {
  assert.equal(E.tutBannerDecide(base({ blocked: true })), false);
});
test("CAS-1702: Alerts gets its banner even with a 1-step tour", () => {
  assert.equal(E.tutBannerDecide(base({ key: "alerts", steps: 1 })), true);
  assert.equal(E.tutBannerDecide(base({ key: "alerts", steps: 0 })), false);
  assert.ok(E.TOURS.alerts.steps.length >= 1);
});
test("none for invite when signed out", () => {
  assert.equal(E.tutBannerDecide(base({ key: "invite", signedIn: false })), false);
  assert.equal(E.tutBannerDecide(base({ key: "invite" })), true);
});
test("starting a tutorial marks it played; adopting merges played and the larger dismissed count", () => {
  E.tutMarkPlayed("database");
  assert.equal(E.tutSeenMap.database.played, true);
  E.tutAdoptSeen({ database: { played: false, dismissed: 2, shown: 3 }, moods: { played: true, dismissed: 1 } });
  assert.equal(E.tutSeenMap.database.shown, 3);
  assert.equal(E.tutSeenMap.database.played, true); assert.equal(E.tutSeenMap.database.dismissed, 2);
  assert.equal(E.tutSeenMap.moods.played, true); assert.equal(E.tutSeenMap.moods.dismissed, 1);
});
