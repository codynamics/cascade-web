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

// CAS-1690: topShare is retired — every ordinary list's Include bar is the genre's top 25%, so the list's bar is the
// same whether the agent's own bar sits above it, below it, or off. (The override is now the list's own state.)
for (const [label, pct] of [["a 20% share", 20], ["an 80% share", 80]]) {
  test(`CAS-1409 (CAS-1690): a list's Include bar ignores topShare and an agent bar at ${label}`, () => {
    const style = "Action";
    const bar = E.oneBarForTopPct(style, pct);
    const got = E.oamMoodBarFor({ id:"m1", topShare:50 }, criteriaWith(style, bar), style);
    assert.equal(got, E.oneBarForTopPct(style, 25));
  });
}

test("CAS-1409 (CAS-1690): topShare null reads the same Include bar — the retired Off", () => {
  const style = "Action";
  const bar = E.oneBarForTopPct(style, 20);
  assert.equal(E.oamMoodBarFor({ id:"m1", topShare:null }, criteriaWith(style, bar), style), E.oneBarForTopPct(style, 25));
});
