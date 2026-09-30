// CAS-1113: the agent editor's Cascade score control becomes a single slider — one score for the start
// window and every window it follows, not a marker per window. These pin the three ACs the ticket names
// directly: normCascade's own collapse, the new value-line copy, and the track rendering exactly one handle.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// Default watchPrefsDefaults(): in_cinema/rent/stream enabled, premium off — so a fresh engine load
// already matches this fixture's three windows without any extra setup.

test("CAS-1113 AC1: normCascade collapses an agent's armed markers to its own floor, and agentFloor is unchanged", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 90, rent: 70, stream: 60 } });
  assert.deepEqual(c.watchMarkers, { in_cinema: 60, rent: 60, stream: 60 });
  assert.equal(E.agentFloor(c), 60);
});

test("CAS-1113 AC2: msnValueLine reads the new single-score copy, windows in ladder order", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 60, rent: 60, stream: 60 } });
  assert.equal(E.msnValueLine(c),
    "Lists films scoring 60+ wherever they are now — at the cinema, to rent or streaming — and follows each one to the next. Under 60, not listed.");
});

test("CAS-1113 AC3: msnTrackAreaHTML draws exactly one handle, with a CINEMA/RENT/STREAM label stack in order", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 60, rent: 60, stream: 60 } });
  const html = E.msnTrackAreaHTML(c);
  const handleCount = (html.match(/class="msnhandle"/g) || []).length;
  assert.equal(handleCount, 1, `expected exactly one .msnhandle, got ${handleCount}: ${html}`);
  const cinemaAt = html.indexOf("CINEMA"), rentAt = html.indexOf("RENT"), streamAt = html.indexOf("STREAM");
  assert.ok(cinemaAt >= 0 && rentAt > cinemaAt && streamAt > rentAt,
    `expected CINEMA, RENT and STREAM in that order in the label stack: ${html}`);
});

test("CAS-1113: Off (0) is a valid single score — every listed window collapses to it, agentFloor reads 0", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 0, rent: 40, stream: 25 } });
  assert.deepEqual(c.watchMarkers, { in_cinema: 0, rent: 0, stream: 0 });
  assert.equal(E.agentFloor(c), 0);
});

test("CAS-1113: setAgentScore sets every enabled window at or after the start to the same value, and clears anything before it", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: null, rent: 70, stream: 70 } });
  E.setAgentScore(c, "rent", 85);
  assert.deepEqual(c.watchMarkers, { in_cinema: null, rent: 85, stream: 85 });
  assert.ok(!c._watchMarkersDefaulted, "a real score edit must clear the *Defaulted provenance flag");
});

test("CAS-1113: msn-start-add moves the start backward and applies the current score to the newly-added window", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: null, rent: 70, stream: 70 } });
  const { startKey } = E.msnListedWindows(c);
  assert.equal(startKey, "rent");
  E.setAgentScore(c, "in_cinema", c.watchMarkers.rent);
  assert.deepEqual(c.watchMarkers, { in_cinema: 70, rent: 70, stream: 70 });
});

test("CAS-1113: msn-start-remove advances the start forward to the next enabled window, same score", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 70, rent: 70, stream: 70 } });
  E.setAgentScore(c, "rent", c.watchMarkers.in_cinema);   // in_cinema removed -> rent becomes the start
  assert.deepEqual(c.watchMarkers, { in_cinema: null, rent: 70, stream: 70 });
});
