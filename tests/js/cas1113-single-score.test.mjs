// CAS-1113 built the single-score agent (one number, not a marker per window); CAS-1128 (Lee, 2026-10-01)
// replaced its own start-window-forward delivery mechanism with independent per-window on/off toggles —
// every enabled window is simply ON (shares the agent's one score) or OFF (null), with no more "start
// window and everything after it" chain. The normCascade collapse these ACs pin (one score, not a marker
// per window) is unchanged; only how a window joins/leaves the ON set moved to tests/js/cas1128-track-in.
// test.mjs. This file keeps CAS-1113's own three named ACs, updated for the new mechanics where they
// touch it.
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
    "Lists films scoring 60+ at the cinema, to rent or streaming — and follows each one from window to window. Under 60, not listed.");
});

test("CAS-1113 AC3: msnTrackAreaHTML draws exactly one handle", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 60, rent: 60, stream: 60 } });
  const html = E.msnTrackAreaHTML(c);
  const handleCount = (html.match(/class="msnhandle"/g) || []).length;
  assert.equal(handleCount, 1, `expected exactly one .msnhandle, got ${handleCount}: ${html}`);
});

// CAS-1128: Off (0) retired as a per-window value entirely (superseding this AC's own premise) — a marker
// of exactly 0 is now normCascade's migration signal for "this used to be the old per-window Off state",
// converted to TRACK_MIN (the track's own lowest real score) and left ON, never left at 0. The conversion
// runs BEFORE the collapse-to-floor step, not instead of it — a 0 sitting alongside markers already below
// TRACK_MIN still ends up pulled down to their (lower) floor, same as any other mixed set of markers would.
test("CAS-1128: a legacy per-window Off (0) marker converts to TRACK_MIN before the floor collapse, not after", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 0, rent: 40, stream: 25 } });
  assert.deepEqual(c.watchMarkers, { in_cinema: 25, rent: 25, stream: 25 },
    "0 converts to TRACK_MIN (50) first, then the usual collapse pulls every marker down to the true lowest (25)");
  assert.equal(E.agentFloor(c), 25);
});

test("CAS-1113: setAgentScore sets every currently-ON window to the same value, leaving an OFF window alone", () => {
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: null, rent: 70, stream: 70 } });
  E.setAgentScore(c, 85);
  assert.deepEqual(c.watchMarkers, { in_cinema: null, rent: 85, stream: 85 });
  assert.ok(!c._watchMarkersDefaulted, "a real score edit must clear the *Defaulted provenance flag");
});

// msn-start-add/msn-start-remove (the retired chip controls) deleted, CAS-1128: there is no more "start"
// window to move backward/forward — toggleAgentWindow (one tick per pill) replaces both. See
// tests/js/cas1128-track-in.test.mjs for the pill-tap ACs this ticket names directly.
