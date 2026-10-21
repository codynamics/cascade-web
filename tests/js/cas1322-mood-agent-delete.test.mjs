// CAS-1322: a mood's agentsOff is an exclusion list, so deleting the only agent still included in a mood
// leaves every surviving agent excluded — Watch then reads "no agent is included" as "none of your agents
// track this tab" (the wrong, agent-blaming empty state). These tests drive the real seams: deleteAgentAsk
// (Change 1, the delete-time repair) and applyMoodToState (Change 2, the in-memory "all agents" widening
// for an account that drifted into this state before the repair existed).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

test("CAS-1322 AC1: deleting the only included agent clears that mood's agentsOff (and the live state, since it's the current mood)", () => {
  const E = loadEngine();
  const idA = "a1000000-0000-4000-8000-000000000001";
  const idB = "b1000000-0000-4000-8000-000000000002";
  const idC = "c1000000-0000-4000-8000-000000000003";
  const a = E.normCascade({ id: idA, name: "Agent A" });
  const b = E.normCascade({ id: idB, name: "Agent B" });
  const c = E.normCascade({ id: idC, name: "Agent C" });
  E.cascades.length = 0; E.cascades.push(a, b, c);
  const mood = { ...E.moodDefaultFieldsNow(), id: "t-1322-ac1", name: "Releases test", agentsOff: [idA, idB] };
  const savedMoods = [...E.watchMoods];
  const savedSel = E.watchMoodSel;
  E.watchMoods.push(mood);
  E.window.setWatchMood(mood.id);
  try {
    assert.equal(E.deleteAgentAsk(c), true, "the real delete path must report the delete as having happened");
    const stored = E.watchMoods.find(m => m.id === mood.id);
    assert.deepEqual([...stored.agentsOff], [], "only C was included; deleting C must widen agentsOff back to all agents ([])");
    assert.equal(E.watchAgentOff.size, 0, "the live state for the now-current mood must also read as all agents");
  } finally {
    E.cascades.length = 0;
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
    if (E.watchMoods.some(m => m.id === savedSel)) E.window.setWatchMood(savedSel);
  }
});

test("CAS-1322 AC2: deleting an excluded (non-included) agent only drops its own id from agentsOff, keeping a mood that still includes a surviving agent", () => {
  const E = loadEngine();
  const idA = "a2000000-0000-4000-8000-000000000001";
  const idB = "b2000000-0000-4000-8000-000000000002";
  const idC = "c2000000-0000-4000-8000-000000000003";
  const a = E.normCascade({ id: idA, name: "Agent A" });
  const b = E.normCascade({ id: idB, name: "Agent B" });
  const c = E.normCascade({ id: idC, name: "Agent C" });
  E.cascades.length = 0; E.cascades.push(a, b, c);
  // Not selected as the current mood — this checks the repair runs over every agents-sourced mood, not
  // only the one currently applied.
  const mood = { ...E.moodDefaultFieldsNow(), id: "t-1322-ac2", name: "Releases test 2", agentsOff: [idA, idB] };
  const savedMoods = [...E.watchMoods];
  E.watchMoods.push(mood);
  try {
    assert.equal(E.deleteAgentAsk(a), true, "the real delete path must report the delete as having happened");
    const stored = E.watchMoods.find(m => m.id === mood.id);
    assert.deepEqual([...stored.agentsOff], [idB], "deleting A (excluded) must drop only A's id, leaving B still excluded and C still the sole inclusion");
  } finally {
    E.cascades.length = 0;
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
  }
});

test("CAS-1322 AC3: applyMoodToState on a mood whose agentsOff lists every current cascade leaves watchAgentOff empty, with no pushViewField call", () => {
  const E = loadEngine();
  const idA = "a3000000-0000-4000-8000-000000000001";
  const idB = "b3000000-0000-4000-8000-000000000002";
  const idC = "c3000000-0000-4000-8000-000000000003";
  const a = E.normCascade({ id: idA, name: "Agent A" });
  const b = E.normCascade({ id: idB, name: "Agent B" });
  const c = E.normCascade({ id: idC, name: "Agent C" });
  E.cascades.length = 0; E.cascades.push(a, b, c);
  const pushCalls = [];
  const savedPersistence = E.window.CascadePersistence;
  E.window.CascadePersistence = {
    accountActive(){ return false; },
    pushViewField(key, value){ pushCalls.push({ key, value }); },
  };
  try {
    const mood = { ...E.moodDefaultFieldsNow(), id: "t-1322-ac3", name: "Drifted mood", agentsOff: [idA, idB, idC] };
    E.applyMoodToState(mood);
    assert.equal(E.watchAgentOff.size, 0, "a mood excluding every surviving agent must read as 'all agents' in memory");
    assert.equal(pushCalls.length, 0, "applyMoodToState itself must never write anything back (CAS-1218/1243)");
  } finally {
    E.window.CascadePersistence = savedPersistence;
    E.cascades.length = 0;
  }
});
