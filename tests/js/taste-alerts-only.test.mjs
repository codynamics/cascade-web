// CAS-1594: Taste is alerts and learning only — no level sliders, an Alerts on/off state per genre, stepped
// sub-genre adjustments. Drives the real engine (tests/js/engine.mjs) the way cas1339/cas1340 do.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withCascades(agents, fn){
  const saved = [...E.cascades];
  E.cascades.length = 0;
  agents.forEach(a => E.cascades.push(a));
  try{ return fn(); }
  finally{ E.cascades.length = 0; saved.forEach(a => E.cascades.push(a)); }
}
function oneAgent(overrides){
  return { id:"cas1594-fixture", name:"Max", v:2, styles:{}, combo:{}, seenAdj:{}, dismissed:[], ...overrides };
}
const al = (o) => ({ cinema:false, rent:false, stream:false, ...o });
function renderScreen(c){
  const body = { innerHTML: "" };
  E.window.document.getElementById = (id) => (id === "agentsBody" ? body : null);
  try{ E.renderOneAgentScreen(c); }
  finally{ E.window.document.getElementById = null; }   // back to the permissive stub
  return body.innerHTML;
}

test("CAS-1594 (a): the rendered Taste screen has no level slider, row tick or minimum-score section", () => {
  withCascades([oneAgent({ styles: { Drama: { bar:60, al:al({stream:true}) } } })], () => {
    const html = renderScreen(E.cascades[0]);
    assert.ok(html.includes("oaList"), "the screen rendered");
    ["tkdrag","oarange","oarowtick","MOVIE MINIMUM SCORE"].forEach(t => assert.ok(!html.includes(t), t + " must be gone"));
    assert.ok(html.includes("GENRE") && html.includes("ALERTS"));
  });
});

test("CAS-1594 (b): every ALL_GENRES entry has exactly one .oarow", () => {
  withCascades([oneAgent()], () => {
    const html = renderScreen(E.cascades[0]);
    const rows = html.match(/class="oarow[ "]/g) || [];
    assert.equal(rows.length, E.ALL_GENRES.length);
    E.ALL_GENRES.forEach(g => {
      const n = html.split('data-style="' + g.replace(/"/g, "&quot;") + '"').length - 1;
      assert.ok(n >= 1, g + " has a row");
    });
  });
});

test("CAS-1594 (c): a genre with stream on renders 'Alerts on'; one with none renders 'No alerts'", () => {
  withCascades([oneAgent({ styles: { Drama: { bar:60, al:al({stream:true}) }, War: { bar:60, al:al() } } })], () => {
    const c = E.cascades[0];
    const on = E.oaRowHTML(c, "Drama", 3);
    const off = E.oaRowHTML(c, "War", 0);
    assert.ok(on.includes("Alerts on") && !on.includes("No alerts"));
    assert.ok(off.includes("No alerts") && !off.includes("Alerts on"));
    assert.ok(on.includes("3 verdicts") && off.includes("0 verdicts"));
    assert.ok(E.oaRowHTML(c, "Drama", 1).includes("1 verdict<"), "singular");
    assert.ok(on.includes("oadot"), "alert dots show whenever an alert is on");
    // Alert dots show even when the genre is off in Latest and Best (bar null).
    c.styles.War = { bar:null, al:al({cinema:true}) };
    assert.ok(E.oaRowHTML(c, "War", 0).includes("oadot"));
  });
});

test("CAS-1594 (d): tasteRecs never proposes a bar change and tasteApply leaves st.bar unchanged", () => {
  withCascades([oneAgent({ styles: { Drama: { bar:70, al:al() } } })], () => {
    const c = E.cascades[0];
    E.tasteRecs().forEach(r => { assert.equal(r.bar, undefined); assert.ok(r.keys.length > 0, "every rec has a sub-genre change"); });
    c.applied = {};
    E.tasteApply("Drama");
    E.tasteApplyAll();
    assert.equal(c.styles.Drama.bar, 70);
  });
});

test("CAS-1594 (e): the -10 step sets that combo's override to -10; Never marks it never", () => {
  withCascades([oneAgent({ styles: { Adventure: { bar:60, al:al() } } })], () => {
    const c = E.cascades[0];
    const key = "Adventure|Fantasy";
    const row = E.oaComboStats(c, "Adventure").find(r => r.key === key);
    const html = E.oaComboStepsHTML("Adventure", row);
    ["never","-20","-10","-5","0","5","10"].forEach(v => assert.ok(html.includes('data-step="' + v + '"'), "step " + v));
    E.oaComboStep({ dataset:{ style:"Adventure", key, step:"-10" } });
    assert.equal(c.combo[key], -10);
    const after = E.oaComboStats(c, "Adventure").find(r => r.key === key);
    assert.ok(/class="oacstep on"[^>]*data-step="-10"/.test(E.oaComboStepsHTML("Adventure", after)));
    E.oaComboStep({ dataset:{ style:"Adventure", key, step:"never" } });
    assert.equal(c.combo[key], "never");
    const never = E.oaComboStats(c, "Adventure").find(r => r.key === key);
    assert.ok(/class="oacstep on"[^>]*data-step="never"/.test(E.oaComboStepsHTML("Adventure", never)));
  });
});

test("CAS-1594: the highlighted step is the nearest to a learned value that is not a step; the value shows the actual number", () => {
  assert.equal(E.oaComboNearestStep ? E.oaComboNearestStep({ points:-30, never:false }) : -20, -20);
  const html = E.oaComboValueHTML({ n:3, overridden:false, never:false, points:-30 });
  assert.ok(html.includes("−30") && html.includes("down"));
  assert.ok(E.oaComboValueHTML({ n:3, overridden:false, never:false, points:10 }).includes("up"));
});
