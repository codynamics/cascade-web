// CAS-1338: the v2 agent's single score box (oneScoreBoxHTML) replacing today's You+Public lozenge pair on
// a signed-in v2 account's card, plus its expanded-card sentence companion (oneScoreTextHTML). Drives the
// real shipped engine (tests/js/engine.mjs's loadEngine(), reading the BUILT index.html) directly, the same
// convention tests/js/cas1337-one-agent.test.mjs and tests/js/match-honest.test.mjs use — never a
// re-derivation of oneScoreBoxHTML's own rules.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function ratingForScore(target){
  let lo = 0, hi = 100;
  for(let i = 0; i < 60; i++){
    const mid = (lo + hi) / 2;
    if(Math.round(E.wmScaled(mid)) < target) lo = mid; else hi = mid;
  }
  let v = hi;
  for(let i = 0; i < 2000 && Math.round(E.wmScaled((v/10)*10)) !== target; i++) v += 0.01;
  return v / 10;
}
let _nextFixtureId = 90600001;
function scoredFilm(genres, score){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title:`CAS-1338 fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true };
  const got = E.cascadeScore(m);
  if(got !== score) throw new Error(`test setup: fixture ${id} cascadeScore computed ${got}, expected ${score}`);
  return m;
}
function withCascades(agents, fn){
  const saved = [...E.cascades];
  E.cascades.length = 0;
  agents.forEach(a => E.cascades.push(a));
  try{ return fn(); }
  finally{ E.cascades.length = 0; saved.forEach(a => E.cascades.push(a)); }
}
function oneAgent(overrides){
  return { id:"cas1338-fixture", name:"My agent", v:2, styles:{}, combo:{}, seenAdj:{}, dismissed:[], ...overrides };
}

// ---- case 4 (ticket's own AC1 fixture): adjusted down -------------------------------------------------

test("CAS-1338 case 4 / AC1: Public 74, override -9, shows 65 and ▼9, box offset down with a ghost outline", () => {
  withCascades([oneAgent({ combo: { "Action|Horror": -9 } })], () => {
    const html = E.oneScoreBoxHTML(scoredFilm(["Action","Horror"], 74));
    assert.match(html, /^<span class="qone down" title="Public 74, -9 from your verdicts">/);
    assert.ok(html.includes('<span class="qghost"></span>'), "a dashed outline marks the unadjusted position");
    assert.ok(html.includes('<span class="qpub lo"><b>65</b><small>▼9</small></span>'));
  });
});

// ---- case 3: adjusted up --------------------------------------------------------------------------------

test("CAS-1338 case 3: Public 70, override +5, shows 75 and ▲5, box offset up with a ghost outline", () => {
  withCascades([oneAgent({ combo: { "Action|Horror": 5 } })], () => {
    const html = E.oneScoreBoxHTML(scoredFilm(["Action","Horror"], 70));
    assert.match(html, /^<span class="qone up" title="Public 70, \+5 from your verdicts">/);
    assert.ok(html.includes('<span class="qghost"></span>'));
    assert.ok(html.includes('<span class="qpub mid"><b>75</b><small>▲5</small></span>'));
  });
});

// ---- case 2: no adjustment — looks like today's Public lozenge, labelled SCORE --------------------------

test("CAS-1338 case 2: a zero override shows no ghost, no up/down class, and label SCORE", () => {
  withCascades([oneAgent({ combo: { "Action|Horror": 0 } })], () => {
    const html = E.oneScoreBoxHTML(scoredFilm(["Action","Horror"], 80));
    assert.match(html, /^<span class="qone " title="Public 80">/);
    assert.ok(!html.includes("qghost"));
    assert.ok(html.includes('<span class="qpub mid"><b>80</b><small>SCORE</small></span>'));
  });
});

// ---- case 1: a film with only one style (no combo at all) is the Public score, unadjusted ---------------

test("CAS-1338 case 1: a single-style film (no parts) shows Public unadjusted, labelled SCORE", () => {
  withCascades([oneAgent()], () => {
    const html = E.oneScoreBoxHTML(scoredFilm(["Documentary"], 62));
    assert.match(html, /^<span class="qone " title="Public 62">/);
    assert.ok(html.includes('<span class="qpub lo"><b>62</b><small>SCORE</small></span>'));
  });
});

// ---- case 5: unscored --------------------------------------------------------------------------------

test("CAS-1338 case 5: a film with no Public score shows an en dash and SCORE", () => {
  withCascades([oneAgent()], () => {
    const noScoreFilm = { tmdb_id: 90600099, genres: ["Documentary"], status: ["included_streaming"] };
    const html = E.oneScoreBoxHTML(noScoreFilm);
    assert.equal(html,
      '<span class="qone" title="Not enough agreement to score this yet">'
      + '<span class="qpub none"><b>&ndash;</b><small>SCORE</small></span></span>');
  });
});

// ---- the expanded card's sentence companion --------------------------------------------------------------

test("CAS-1338 §7: the expanded card's sentence lists the Action|Horror part behind a -9 adjustment", () => {
  withCascades([oneAgent({ combo: { "Action|Horror": -9 } })], () => {
    const html = E.oneScoreTextHTML(scoredFilm(["Action","Horror"], 74));
    assert.equal(html,
      '<span class="qonetext">Score 65 = Public 74 −9 from your verdicts on Action + Horror (−9)</span>');
  });
});

test("CAS-1338 §7: a single-style film's sentence names no verdicts on its combinations yet", () => {
  withCascades([oneAgent()], () => {
    const html = E.oneScoreTextHTML(scoredFilm(["Documentary"], 62));
    assert.equal(html, '<span class="qonetext">Score 62 = Public; no verdicts on its combinations yet</span>');
  });
});
