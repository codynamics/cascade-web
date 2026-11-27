// CAS-1391: the mood sheet's Mood Override Filter — a per-genre top-share filter (mood.topShare, 1-99 or
// null=off) replacing CAS-1365's cross-genre minScore slider. oamMoodBarFor is the one chokepoint every
// mood-membership path (oamFilmMeetsMoodRules, and so Watch listing/counts/Where it lists/mood alerts) reads
// the applied bar through, so asserting it directly here covers all of them without re-deriving the
// pipeline. Replaces CAS-1365's cas1365-mood-minscore.test.mjs (minScore removed).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1391-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}

// CAS-1690: the Override filter (topShare) and the five-stop levels are retired — a list's own Off / Include / Favourite
// per genre is the bar. oamMoodBarFor is still the one chokepoint: Include = the genre's top 25%, Favourite = no
// floor (0), Off = null; nothing reads topShare, levels or the agent's own bar for an ordinary list.
test("CAS-1391 (CAS-1690): an ordinary list's Include bar is the genre's top 25%, whatever the agent's own bar", () => {
  const c = criteriaWith("Action", 55);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:null }, c, "Action"), E.oneBarForTopPct("Action", 25));
});

test("CAS-1391 (CAS-1690): a retired topShare and levels are ignored", () => {
  const c = criteriaWith("Action", 55);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:40, levels:{ Action:10 } }, c, "Action"), E.oneBarForTopPct("Action", 25));
});

test("CAS-1391 (CAS-1690): a genre the agent has off still gets a bar in an ordinary list (Include); Latest and Best stays off", () => {
  const c = criteriaWith("Action", null);
  assert.equal(E.oamMoodBarFor({ id:"m1" }, c, "Action"), E.oneBarForTopPct("Action", 25));
  assert.equal(E.oamMoodBarFor({ id:"releases", favs:[] }, c, "Action"), null);
});

test("CAS-1391 (CAS-1690): a legacy {id:'best', minScore:85} with no topShare reads like any other list — the minScore is ignored", () => {
  const c = criteriaWith("Action", 55);
  const legacy = E.oamMoodBarFor({ id:"best", minScore:85 }, c, "Action");
  assert.equal(legacy, E.oamMoodBarFor({ id:"m1" }, c, "Action"));
});

test("CAS-1391 (CAS-1690): a Favourite genre has no floor; an unticked genre has no bar", () => {
  const c = criteriaWith("Action", 55);
  assert.equal(E.oamMoodBarFor({ id:"m1", favs:["Action"] }, c, "Action"), 0);
  assert.equal(E.oamMoodBarFor({ id:"m1", styles:["Drama"] }, c, "Action"), null);
});
