// CAS-1238: re-tapping the stage that is already selected did nothing — setWatchStage's own early-return
// shape (app_template.html) only ever handled "switch tab" or "switch Cinema stage"; a tap that changed
// neither fell through to no-op. The fix adds a third branch: jump back to the stage's own section via the
// same jumpToSection landing a stage switch already uses (no new scroll code, no render()). usageQueue
// (every logEvent call, including jumpToSection's own "jump_to_section" and setWatchTab/setWatchStage's
// "watch_tab") is the harness's only window onto which path actually ran, since the DOM stub swallows the
// scroll/render writes themselves.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function setup(tab, stage){
  E.setWatchTab(tab);
  if(stage) E.setWatchCinemaStage(stage);
  E.clearUsageQueue();
}

test("CAS-1238 AC1: re-tapping the already-selected Streaming stage jumps to its own section, no tab/stage change", () => {
  setup("stream");
  E.window.setWatchStage("stream");

  assert.equal(E.watchTab, "stream", "AC1: the tab must not change");
  const jumps = E.usageQueue.filter(q => q.type === "jump_to_section");
  assert.equal(jumps.length, 1, "AC1: exactly one jump must fire");
  assert.equal(jumps[0].data.key, "included_streaming", "AC1: the jump must target Streaming's own section");
  assert.equal(E.usageQueue.filter(q => q.type === "watch_tab").length, 0,
    "AC1: no watch_tab change-event may fire — that is render()'s own gate, and none ran");
});

test("CAS-1238 AC2: re-tapping the already-selected Cinema stage (Upcoming or In Cinema) jumps to its own section", () => {
  setup("in_cinema", "upcoming");
  E.window.setWatchStage("upcoming");
  let jumps = E.usageQueue.filter(q => q.type === "jump_to_section");
  assert.equal(jumps.length, 1, "AC2/Upcoming: exactly one jump must fire");
  assert.equal(jumps[0].data.key, "upcoming", "AC2/Upcoming: the jump must target Upcoming's own section, not In Cinema");
  assert.equal(E.watchCinemaStage, "upcoming", "AC2/Upcoming: the stage must not change");
  assert.equal(E.usageQueue.filter(q => q.type === "watch_tab").length, 0, "AC2/Upcoming: no stage-change event may fire");

  setup("in_cinema", "in_cinema");
  E.window.setWatchStage("in_cinema");
  jumps = E.usageQueue.filter(q => q.type === "jump_to_section");
  assert.equal(jumps.length, 1, "AC2/In Cinema: exactly one jump must fire");
  assert.equal(jumps[0].data.key, "in_cinema", "AC2/In Cinema: the jump must target In Cinema's own section, not Upcoming");
  assert.equal(E.watchCinemaStage, "in_cinema", "AC2/In Cinema: the stage must not change");
  assert.equal(E.usageQueue.filter(q => q.type === "watch_tab").length, 0, "AC2/In Cinema: no stage-change event may fire");
});

test("CAS-1238: tapping a DIFFERENT Cinema stage still takes the real switch branch, untouched by this fix", () => {
  setup("in_cinema", "upcoming");
  E.window.setWatchStage("in_cinema");

  assert.equal(E.watchCinemaStage, "in_cinema", "a genuine stage switch must still change the stage");
  assert.equal(E.usageQueue.filter(q => q.type === "watch_tab").length, 1, "a genuine stage switch must still log watch_tab");
});
