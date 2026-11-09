// CAS-1412: a new mood starts with "Include watched" on; existing and built-in moods are untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

test("CAS-1412 AC1a: a brand-new draft starts with watched on", () => {
  assert.equal(E.oamMoodDraftFrom(null).watched, true);
});

test("CAS-1412 AC1b: editing a stored mood with watched:false keeps it off", () => {
  const mood = { ...E.oamMoodDefaultFields(), id:"cas1412-mood", name:"Stored", watched:false };
  assert.equal(E.oamMoodDraftFrom(mood).watched, false);
});

test("CAS-1412 AC1c: Find's Save as mood prefill has watched on", () => {
  assert.equal(E.oamFindPrefillFields("Tom Cruise", null).watched, true);
});

test("CAS-1412 AC1d: oamMoodDefaultFields stays watched:false so built-ins are unchanged", () => {
  assert.equal(E.oamMoodDefaultFields().watched, false);
});
