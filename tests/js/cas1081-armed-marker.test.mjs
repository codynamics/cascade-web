// CAS-1081: production QA (ONB-09) hit Family Movies with kids=Yes and the done step read "SCORE 101+ in
// cinema · 91+ rent · 84+ streaming" — cinema rides s+17 above the trial score `s` (onbFamilyCritV2), which
// can clear 100 on a high solve. A marker above 100 can never be met by a 0-100 admission score, so the
// agent already never admits from that window; only the score line's OWN wording read "101+" instead of
// dropping the window the way a Never (null) marker already does everywhere else. This asserts the display
// fix (windowArmed) without touching windowUsable, the predicate admission/placement actually run on.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// Family Movies' own shape at a trial score of 84 (a real solve the ONB-09 case hit): cinema = 84+17 = 101,
// rent = 84+7 = 91, stream = 84 — the exact ladder onbFamilyCritV2 builds, restated directly here rather than
// imported so this test still catches a regression even if that recipe's own deltas ever change.
function familyLikeCascade(){
  return { watchMarkers: { in_cinema: 101, premium: null, rent: 91, stream: 84 } };
}

function withFamilyWatchPrefs(fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({
    in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
    rent: { list: true, notify: false }, stream: { list: true, notify: true },
  });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}

test("CAS-1081: windowArmed reads a >100 marker as Never; windowUsable (admission) is untouched", () => {
  withFamilyWatchPrefs(() => {
    const c = familyLikeCascade();
    assert.equal(E.windowUsable(c, "in_cinema"), true,
      "admission/placement must keep seeing the real marker — behaviour must not change");
    assert.equal(E.windowArmed(c, "in_cinema"), false, "a marker above 100 must read as not armed");
    assert.equal(E.windowArmed(c, "rent"), true);
    assert.equal(E.windowArmed(c, "stream"), true);
  });
});

test("CAS-1081: agentCascadeSumHTML (onboarding reveal/done step/Agents list) drops the >100 window", () => {
  withFamilyWatchPrefs(() => {
    const html = E.agentCascadeSumHTML(familyLikeCascade());
    assert.ok(!html.includes("101"), `must never show an impossible "101+": ${html}`);
    assert.ok(!html.includes("in cinema"), `cinema must be left out of the score line: ${html}`);
    assert.ok(html.includes("91+ rent"), `rent must still read its real marker: ${html}`);
    assert.ok(html.includes("84+ streaming"), `stream must still read its real marker: ${html}`);
  });
});

test("CAS-1081: msnValueLine/msnChipsHTML (the agent editor) also treat the >100 marker as never", () => {
  withFamilyWatchPrefs(() => {
    const c = familyLikeCascade();
    const line = E.msnValueLine(c);
    assert.ok(!line.includes("101"), `value line must never show "101+": ${line}`);
    assert.ok(!/cinema/i.test(line), `cinema must be left out of the value line: ${line}`);
    assert.ok(line.startsWith("91+, rent it"), `rent must lead the sentence: ${line}`);

    const chips = E.msnChipsHTML(c);
    assert.ok(!chips.includes("101"), `chips must never show "101+": ${chips}`);
    assert.ok(chips.includes("Cinema — never"), `cinema's chip must read Never, like any other Never window: ${chips}`);
  });
});
