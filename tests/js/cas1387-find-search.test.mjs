// CAS-1387: Find's search now ANDs comma-separated exact-phrase terms (no space-splitting), and the
// Director/Cast "match reason" line CAS-1379 added to collapsed rows is gone. filmMatchesSearch is the one
// shared matcher findSortedRows (Find) and the listing's own filt.search test both call — asserted here
// directly against the real built catalogue, the same convention cas1379's own test uses.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

test("CAS-1387 AC1a: comma-separated phrases must each match independently (AND)", () => {
  // Built from a real donor film's own director + first cast name, so the AND is proven against the real
  // catalogue (per the ticket's "checked independently" wording) without assuming a specific name pair
  // (e.g. "Tom Cruise, Russo") happens to co-occur in whatever catalogue snapshot the build picked up.
  const donor = E.MOVIES.find(m => m.director && m.director.trim() && (m.cast || []).length);
  assert.ok(donor, "setup: need a catalogue film with both a director and a cast member");
  const d = donor.director.toLowerCase(), c = donor.cast[0].toLowerCase();
  const matched = E.MOVIES.filter(m => E.filmMatchesSearch(m, `${d}, ${c}`));
  assert.ok(matched.some(m => m.tmdb_id === donor.tmdb_id),
    `AC1a: ${donor.title} must match its own director phrase AND its own cast phrase`);
  const hasPhrase = (m, phrase) => {
    if (m.title.toLowerCase().includes(phrase)) return true;
    if (m.director && m.director.toLowerCase().includes(phrase)) return true;
    return (m.cast || []).some(x => x.toLowerCase().includes(phrase));
  };
  matched.forEach(m => {
    assert.ok(hasPhrase(m, d), `${m.title} was returned but doesn't match "${d}"`);
    assert.ok(hasPhrase(m, c), `${m.title} was returned but doesn't match "${c}"`);
  });
});

test("CAS-1387 AC1b: a single-term query returns the same set as before this change", () => {
  const expected = E.MOVIES.filter(m => (m.cast || []).some(c => c.toLowerCase() === "tom cruise"));
  assert.ok(expected.length >= 1, "setup: the catalogue must have at least one Tom Cruise film");
  const matched = E.MOVIES.filter(m => E.filmMatchesSearch(m, "tom cruise"));
  expected.forEach(m => assert.ok(matched.includes(m), `${m.title} carries Tom Cruise but was not matched`));
});

test("CAS-1387 AC1c: 'cruise tom' is one phrase, not two space-split terms", () => {
  const crossMatches = E.MOVIES.filter(m => (m.cast || []).some(c => c.toLowerCase() === "tom cruise"));
  assert.ok(crossMatches.length >= 1, "setup: need at least one Tom Cruise film");
  crossMatches.forEach(m => assert.equal(E.filmMatchesSearch(m, "cruise tom"), false,
    `${m.title} matched "cruise tom" merely for having "Tom Cruise" in cast — phrase, not space-split`));
});

test("CAS-1387 AC1d: ', ,' (all-empty parts) matches every film", () => {
  assert.ok(E.MOVIES.length >= 1, "setup: need a non-empty catalogue");
  E.MOVIES.forEach(m => assert.ok(E.filmMatchesSearch(m, ", ,"),
    `${m.title} should match an all-empty-parts query`));
});

test("CAS-1387 AC1e: findMatchReasonHTML no longer exists on the loaded engine", () => {
  assert.equal(typeof E.window.findMatchReasonHTML, "undefined");
});
