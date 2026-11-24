// CAS-1566: the Watch reminder / Taste card decision, and the reminder's no-button markup.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
const CREATED = "2026-11-20T10:00:00Z";                       // 21:00 on the 20th, Sydney
const DAY2 = Date.parse("2026-11-21T00:00:00Z");              // day 2 (11:00 on the 21st)
const DAY3 = Date.parse("2026-11-22T00:00:00Z");              // day 3
const ADJ = { pts: 6, text: "Sci-fi with Thriller is up 6 from your ratings" };
const base = (o = {}) => ({ signedIn: true, now: DAY3, createdAt: CREATED, ratings: 0, adj: null,
  seen: { rem: 0, taste: false }, tutorialShownThisVisit: false, cardShownThisVisit: false, blocked: false, ...o });

test("reminder: not on day 1-2, shown on day 3 with 0 ratings", () => {
  assert.equal(E.rnudgeDecide(base({ now: DAY2 })), null);
  assert.equal(E.rnudgeDecide(base({ now: Date.parse("2026-11-20T12:00:00Z") })), null);
  assert.equal(E.rnudgeDecide(base()), "reminder");
});
test("reminder: not at 5 ratings, still shown at 4", () => {
  assert.equal(E.rnudgeDecide(base({ ratings: 4 })), "reminder");
  assert.equal(E.rnudgeDecide(base({ ratings: 5 })), null);
});
test("reminder: not after 3 showings", () => {
  assert.equal(E.rnudgeDecide(base({ seen: { rem: 2 } })), "reminder");
  assert.equal(E.rnudgeDecide(base({ seen: { rem: 3 } })), null);
});
test("taste card: not with 9 ratings, shown with 10 and a 5+ adjustment", () => {
  assert.equal(E.rnudgeDecide(base({ ratings: 9, adj: ADJ, seen: { rem: 3 } })), null);
  assert.equal(E.rnudgeDecide(base({ ratings: 10, adj: ADJ })), "taste");
});
test("taste card: not when no adjustment reaches 5, nor after dismissal", () => {
  assert.equal(E.rnudgeDecide(base({ ratings: 10, adj: { pts: 4, text: "x" } })), null);
  assert.equal(E.rnudgeDecide(base({ ratings: 10, adj: null })), null);
  assert.equal(E.rnudgeDecide(base({ ratings: 12, adj: ADJ, seen: { taste: true } })), null);
  assert.equal(E.rnudgeDecide(base({ ratings: 10, adj: { pts: -6, text: "x" } })), "taste");
});
test("one card per visit, none on a visit that showed a tutorial banner, none signed out or blocked", () => {
  assert.equal(E.rnudgeDecide(base({ cardShownThisVisit: true })), null);
  assert.equal(E.rnudgeDecide(base({ tutorialShownThisVisit: true })), null);
  assert.equal(E.rnudgeDecide(base({ signedIn: false })), null);
  assert.equal(E.rnudgeDecide(base({ blocked: true })), null);
});
test("the reminder card has no button but the dismiss cross; the Taste card adds See Taste", () => {
  const rem = E.rnudgeCardHTML("reminder", "Max", "");
  assert.equal((rem.match(/<button/g) || []).length, 1);
  assert.match(rem, /class="x"/);
  assert.match(rem, /The more you rate, the better Max gets/);
  const t = E.rnudgeCardHTML("taste", "Max", ADJ.text);
  assert.equal((t.match(/<button/g) || []).length, 2);
  assert.match(t, /See Taste/);
  assert.match(t, /Max has learned something/);
});
