// CAS-1409: the Mood Override is a TRUE override — with topShare set, oamMoodBarFor returns
// oneBarForTopPct(style, topShare) whether that raises or lowers the genre's own bar; null (Off) keeps the
// agent's own bar.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1409-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}

test("CAS-1409: topShare 50 overrides a genre whose agent bar sits at a 20% share (raises the bar's reach)", () => {
  const style = "Action";
  const bar = E.oneBarForTopPct(style, 20);
  const got = E.oamMoodBarFor({ id:"m1", topShare:50 }, criteriaWith(style, bar), style);
  assert.equal(got, E.oneBarForTopPct(style, 50));
  assert.notEqual(got, bar, "sanity: the override must differ from the agent's own bar");
});

test("CAS-1409: topShare 50 overrides a genre whose agent bar sits at an 80% share (lowers the reach)", () => {
  const style = "Action";
  const bar = E.oneBarForTopPct(style, 80);
  const got = E.oamMoodBarFor({ id:"m1", topShare:50 }, criteriaWith(style, bar), style);
  assert.equal(got, E.oneBarForTopPct(style, 50));
  assert.notEqual(got, bar, "sanity: the override must differ from the agent's own bar");
});

test("CAS-1409: topShare null (Off) keeps the agent's own bar", () => {
  const style = "Action";
  const bar = E.oneBarForTopPct(style, 20);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:null }, criteriaWith(style, bar), style), bar);
});
