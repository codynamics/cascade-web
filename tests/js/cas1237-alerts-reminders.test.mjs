// CAS-1237: Alerts > Today defects — opens_soon/past_opening_weekend get their own chip wording
// instead of borrowing CHANGED's (they're reminders; nothing about the film changed), consecutive
// rows in one lane sharing a reason/age say it once, ages and the Today period use the account
// holder's own Sydney calendar date instead of a rolling 24-hour window, and the header's freshness
// label converts the catalogue's real build instant through the same Sydney calendar date rather
// than showing the pipeline's bare UTC day (wrong for hours every AU morning).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// AC2: deterministic regardless of the real wall-clock moment the test runs at — both timestamps are
// derived from TODAY's own Sydney calendar date (sydneyYMD(Date.now())) rather than a fixed clock
// time, so "yesterday" always means exactly one Sydney calendar day back, whatever hour this runs at.
function sydneyMidnightUtcOf(daysAgo){
  const todaySyd = E.sydneyYMD(Date.now());
  return Date.parse(todaySyd) - daysAgo * 86400000;
}

test("CAS-1237 AC2: movingAgeText reads a timestamp from Sydney's previous calendar day as 'yesterday', and the Today period excludes it", () => {
  const yesterdayTs = sydneyMidnightUtcOf(1);
  assert.equal(E.movingAgeText(new Date(yesterdayTs).toISOString()), "yesterday");
  assert.equal(E.movingInWindow(new Date(yesterdayTs).toISOString(), "today"), false);
});

test("CAS-1237 AC2: movingAgeText reads a timestamp from Sydney's current calendar day as 'today', and the Today period includes it", () => {
  const todayTs = sydneyMidnightUtcOf(0);
  assert.equal(E.movingAgeText(new Date(todayTs).toISOString()), "today");
  assert.equal(E.movingInWindow(new Date(todayTs).toISOString(), "today"), true);
});

test("CAS-1237 AC3: an opens_soon row's chip reads SOON, not CHANGED", () => {
  assert.equal(E.movingChipLabel({tag:"changed", moment:"opens_soon"}), "SOON");
});

test("CAS-1237 AC3: a past_opening_weekend row's chip reads REMINDER, not CHANGED", () => {
  assert.equal(E.movingChipLabel({tag:"changed", moment:"past_opening_weekend"}), "REMINDER");
});

test("CAS-1237: NEW/CHANGED keep their current meaning for every other moment", () => {
  assert.equal(E.movingChipLabel({tag:"new", moment:"new_to_agent"}), "NEW");
  assert.equal(E.movingChipLabel({tag:"changed", moment:"hits_rent"}), "CHANGED");
});

test("CAS-1237 AC5: three consecutive opens_soon rows for one agent on the same day collapse to one group", () => {
  const rows = [1,2,3].map(n => ({filmId:String(n), tag:"changed", moment:"opens_soon",
    reason:"opens in cinemas soon", date:"2026-10-09T05:00:00Z"}));
  const groups = E.movingRowGroups(rows);
  assert.equal(groups.length, 1, "three identical (chip, reason, age) rows must be one group");
  assert.equal(groups[0].rows.length, 3);
  assert.equal(groups[0].chip, "SOON");
});

test("CAS-1237 AC5: a row with a different reason starts a new group", () => {
  const rows = [
    {filmId:"1", tag:"changed", moment:"opens_soon", reason:"opens in cinemas soon", date:"2026-10-09T05:00:00Z"},
    {filmId:"2", tag:"changed", moment:"hits_rent", reason:"dropped to a rental price", date:"2026-10-09T05:00:00Z"},
    {filmId:"3", tag:"changed", moment:"opens_soon", reason:"opens in cinemas soon", date:"2026-10-09T05:00:00Z"},
  ];
  const groups = E.movingRowGroups(rows);
  assert.equal(groups.length, 3, "a differing reason in the middle must not be folded into either neighbour");
});

test("CAS-1237 AC4: the header label for a catalogue generated at 2026-10-07T20:30Z reads 8 Oct", () => {
  const pointer = {generated:"2026-10-07", generatedAt:"2026-10-07T20:30:00Z"};
  assert.equal(E.fmtDay(E.catalogueHeaderDate(pointer)), "8 Oct 26");
});

test("CAS-1237 AC4: a pointer with no generatedAt falls back to the bare generated date unchanged", () => {
  const pointer = {generated:"2026-10-07"};
  assert.equal(E.catalogueHeaderDate(pointer), "2026-10-07");
});
