// CAS-1340: Score adjustments section (v2 accounts) — section 3 of an open style: CAS-1337's learned
// comboAdj per (style, other) combo, a hand override, and "adjusted since you last looked" against
// criteria.seenAdj. Drives the real shipped engine (tests/js/engine.mjs's loadEngine(), reading the BUILT
// index.html) directly, the same convention tests/js/cas1337-one-agent.test.mjs and
// tests/js/cas1339-agent-screen.test.mjs use.
//
// AC4 (the section-3 bars' white line lines up with section 1's thumb at 390px) is a real-browser layout
// claim this harness cannot see — engine.mjs's own stub answers 0 for every DOM read/measurement (see its
// header comment). What's tested here instead is that both marks share the exact same value->position
// formula (oaTrackPct, the one function either mark's x ever goes through), which is the only part of that
// claim pure arithmetic can verify; the rendered pixel result is a Playwright/visual concern CC_AUTONOMY.md
// explicitly keeps out of this in-session gate (only tests/e2e/smoke.spec.mjs runs in CI).
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
let _nextFixtureId = 90900001;
function scoredFilm(genres, score, title){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title: title || `CAS-1340 fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true,
    availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };
  const got = E.cascadeScore(m);
  if(got !== score) throw new Error(`test setup: fixture ${id} cascadeScore computed ${got}, expected ${score}`);
  return m;
}
function withTasteFixture(assignments, fn){
  const saved = {
    watched: new Set(E.watched), disliked: new Set(E.disliked), indifferent: new Set(E.indifferent),
    wowed: new Set(E.wowed), enjoyed: new Set(E.enjoyed), blocked: new Set(E.blocked),
  };
  E.watched.clear(); E.disliked.clear(); E.indifferent.clear(); E.wowed.clear(); E.enjoyed.clear(); E.blocked.clear();
  const films = assignments.map(([m]) => m);
  films.forEach(m => E.MOVIES.push(m));
  assignments.forEach(([m, kind]) => {
    if(kind === "notfor"){ E.blocked.add(m.tmdb_id); return; }
    E.watched.add(m.tmdb_id);
    if(kind === "disliked") E.disliked.add(m.tmdb_id);
    if(kind === "soso") E.indifferent.add(m.tmdb_id);
    if(kind === "wow") E.wowed.add(m.tmdb_id);
    if(kind === "enjoyed") E.enjoyed.add(m.tmdb_id);
  });
  E.invalidateComputeCaches();
  try{ return fn(films); }
  finally{
    films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); });
    E.watched.clear(); saved.watched.forEach(id => E.watched.add(id));
    E.disliked.clear(); saved.disliked.forEach(id => E.disliked.add(id));
    E.indifferent.clear(); saved.indifferent.forEach(id => E.indifferent.add(id));
    E.wowed.clear(); saved.wowed.forEach(id => E.wowed.add(id));
    E.enjoyed.clear(); saved.enjoyed.forEach(id => E.enjoyed.add(id));
    E.blocked.clear(); saved.blocked.forEach(id => E.blocked.add(id));
    E.invalidateComputeCaches();
  }
}
function withCascades(agents, fn){
  const saved = [...E.cascades];
  E.cascades.length = 0;
  agents.forEach(a => E.cascades.push(a));
  try{ return fn(); }
  finally{ E.cascades.length = 0; saved.forEach(a => E.cascades.push(a)); }
}
function oneAgent(overrides){
  return { id:"cas1340-fixture", name:"My agent", v:2, styles:{}, combo:{}, seenAdj:{}, seenAdjAt:{}, dismissed:[], ...overrides };
}
// ---- AC1: an overridden row's value/left text, and "use <learned>" clearing the override -------------------

test("CAS-1340 AC1: an override >=5 from learned shows '±0' underlined and 'your verdicts say <learned> · use <learned>'; use clears it", () => {
  // Same fixture tests/js/cas1337-one-agent.test.mjs's own AC1 uses (two disliked Sci-fi/Thriller verdicts),
  // which that ticket already proved makes oneComboAdj("Science Fiction|Thriller") round to -7 — reusing a
  // value an existing, passing test already pins means this test isn't quietly trusting its own arithmetic.
  const evidence = [scoredFilm(["Science Fiction","Thriller"], 50), scoredFilm(["Science Fiction","Thriller"], 50)];
  withTasteFixture(evidence.map(m => [m, "disliked"]), () => {
    const key = "Science Fiction|Thriller";
    assert.equal(E.oneComboAdj(key), -7, "test setup: this fixture's learned value");
    withCascades([oneAgent({ combo: { [key]: 0 },
        styles: { "Science Fiction": { bar:70, al:{cinema:false,rent:false,stream:false} } } })], () => {
      const c = E.cascades[0];
      const rows = E.oaComboStats(c, "Science Fiction");
      const row = rows.find(r => r.key === key);
      assert.ok(row, "the combo appears as a row");
      assert.equal(row.overridden, true);
      assert.equal(row.learned, -7);
      const valueHTML = E.oaComboValueHTML(row);
      assert.ok(valueHTML.includes("±0"), "override 0 renders as ±0");
      assert.ok(valueHTML.includes("oacval-over"), "an overridden value is marked (underlined gold)");
      const leftHTML = E.oaOverrideLeftHTML(row);
      assert.ok(leftHTML.includes("Set by you") && leftHTML.includes("your verdicts say −7")
        && leftHTML.includes("use −7"), `left text: ${leftHTML}`);
      // The bar's own dashed mark sits at the learned position (bar + learned), not the override.
      const barHTML = E.oaComboBarHTML(c, "Science Fiction", row);
      assert.ok(barHTML.includes("oacdash"), "an overridden row draws the dashed learned-position mark");

      E.oaUseLearned(key);
      assert.equal(c.combo[key], undefined, "use <learned> deletes the override");
    });
  });
});

test("CAS-1340 AC1b: an override within 5 of learned shows 'let the agent decide' instead", () => {
  const r = { key:"Drama|Comedy", other:"Comedy", learned:10, override:8, overridden:true, never:false,
    points:8, n:3, filmCount:3, adjusted:false, seen:0 };
  const leftHTML = E.oaOverrideLeftHTML(r);
  assert.ok(leftHTML.includes("Set by you") && leftHTML.includes("let the agent decide"), leftHTML);
  assert.ok(!leftHTML.includes("your verdicts say"), "the close-override branch skips the learned comparison clause");
});

// ---- AC2 (CAS-1351): dragging a combo to the far left saves "never" and the admission gate drops its films ---

test("CAS-1351 AC2: releasing a combo's range at share 0 (far left) saves \"never\" and matchesCriteria rejects its films", () => {
  withCascades([oneAgent({ styles: { "Adventure": { bar:60, al:{cinema:false,rent:false,stream:false} } } })], () => {
    const c = E.cascades[0];
    const key = "Adventure|Animation";
    E.oaComboOnRelease({ dataset:{ style:"Adventure", key } , value:"0" });
    assert.equal(c.combo[key], "never", "the release handler writes the literal sentinel, not a number");
    const film = scoredFilm(["Adventure","Animation"], 90);
    assert.equal(E.matchesCriteria(film, c), false, "a 'never' combo's films are not admitted (CAS-1337's own gate)");
  });
});

test("CAS-1351 AC2b: releasing above 0 writes a numeric combo[k] = bar - oneBarForTopPct(style, pct)", () => {
  withCascades([oneAgent({ styles: { "Adventure": { bar:60, al:{cinema:false,rent:false,stream:false} } } })], () => {
    const c = E.cascades[0];
    const key = "Adventure|Fantasy";
    E.oaComboOnRelease({ dataset:{ style:"Adventure", key }, value:"75" });
    assert.equal(c.combo[key], 60 - E.oneBarForTopPct("Adventure", 75), "bar(60) - oneBarForTopPct(Adventure, 75)");
  });
});

// ---- AC3: a verdict moving a combo by >=2 flags it adjusted; Mark as seen clears it --------------------------

test("CAS-1340 AC3: |learned - seenAdj| >= 2 with no override flags the row adjusted, tags, badges and lights the nav dot; Mark as seen clears all three", () => {
  const evidence = [scoredFilm(["Science Fiction","Comedy"], 50), scoredFilm(["Science Fiction","Comedy"], 50)];
  withTasteFixture(evidence.map(m => [m, "disliked"]), () => {
    const key = "Science Fiction|Comedy";
    const learned = E.oneComboAdj(key);
    withCascades([oneAgent({ seenAdj: { [key]: learned + 5 } })], () => {   // stale "was" value, |diff|=5 >= 2, direction down
      const c = E.cascades[0];
      const rows = E.oaComboStats(c, "Science Fiction");
      const row = rows.find(r => r.key === key);
      assert.equal(row.adjusted, true);
      assert.equal(E.oaComboDirection(row), "down");
      const rowHTML = E.oaComboRowHTML(c, "Science Fiction", row);
      assert.ok(rowHTML.includes("▼ ADJUSTED"), rowHTML);
      assert.ok(rowHTML.includes(`${E.oaFmtPoints(learned + 5)} → ${E.oaFmtPoints(learned)}`), rowHTML);
      const badge = E.oaAdjustedBadgeHTML(c, "Science Fiction");
      assert.ok(badge.includes("▼1"), badge);
      assert.equal(E.oaAnyAdjusted(c), true, "the nav dot's own condition");

      E.oaMarkSeenAdjusted("Science Fiction");
      assert.equal(c.seenAdj[key], learned, "seenAdj[k] = comboAdj(k)");
      assert.equal(typeof c.seenAdjAt[key], "number", "a companion write-timestamp is recorded");
      const after = E.oaComboStats(c, "Science Fiction").find(r => r.key === key);
      assert.equal(after.adjusted, false, "marking seen clears the adjusted flag (tag/was-line/badge/dot all derive from it)");
      assert.equal(E.oaAnyAdjusted(c), false);
    });
  });
});

// ---- AC5: tapping "<liked> liked · <not> not ›" lists the films behind the combo -----------------------------

test("CAS-1340 AC5: oaComboFilms returns every judged film behind a combo, split liked/not", () => {
  const liked = [scoredFilm(["Adventure","Comedy"], 60, "Liked One"), scoredFilm(["Adventure","Comedy"], 60, "Liked Two")];
  const not = [scoredFilm(["Adventure","Comedy"], 60, "Not One"), scoredFilm(["Adventure","Comedy"], 60, "Not Two")];
  withTasteFixture([...liked.map(m=>[m,"liked"]), ...not.map(m=>[m,"disliked"])], () => {
    const key = "Adventure|Comedy";
    const films = E.oaComboFilms(key);
    assert.equal(films.length, 4);
    assert.equal(films.filter(f=>f.good).length, 2);
    assert.equal(films.filter(f=>!f.good).length, 2);
    assert.deepEqual(new Set(films.map(f=>f.title)), new Set(["Liked One","Liked Two","Not One","Not Two"]));

    withCascades([oneAgent()], () => {
      const c = E.cascades[0];
      const row = E.oaComboStats(c, "Adventure").find(r => r.key === key);
      const closedHTML = E.oaComboRowHTML(c, "Adventure", row);
      assert.ok(closedHTML.includes("2 liked · 2 not"), closedHTML);
      E.oaComboFilmsOpen.add(key);
      const openHTML = E.oaComboRowHTML(c, "Adventure", row);
      assert.ok(openHTML.includes("oacchips"), "chips render once the row is toggled open");
      ["Liked One","Liked Two","Not One","Not Two"].forEach(t => assert.ok(openHTML.includes(t), `${t} missing from ${openHTML}`));
      E.oaComboFilmsOpen.delete(key);
    });
  });
});

// ---- A zero-verdict combo renders greyed-out, not as a false "adjusted"/"overridden" row --------------------

test("CAS-1340: a combo with no verdicts shows 'no verdicts yet' and an empty bar, never adjusted", () => {
  withCascades([oneAgent()], () => {
    const c = E.cascades[0];
    const rows = E.oaComboStats(c, "Western");   // a style with essentially no fixture verdicts in this suite
    assert.ok(rows.length > 0, "the real catalogue still supplies candidate (style, other) combos");
    const row = rows[0];
    assert.equal(row.n, 0);
    assert.equal(row.adjusted, false);
    const html = E.oaComboRowHTML(c, "Western", row);
    assert.ok(html.includes("no verdicts yet"), html);
    assert.ok(html.includes("oacrow-empty"), html);
  });
});

// ---- Order: adjusted first, then |points| desc, then film count desc ----------------------------------------

test("CAS-1340: oaComboSort puts adjusted rows first, then sorts by |points| desc, 'never' sorting as the smallest magnitude", () => {
  const adjusted = { key:"a", adjusted:true, never:false, points:1, filmCount:1 };
  const big = { key:"b", adjusted:false, never:false, points:-20, filmCount:5 };
  const small = { key:"c", adjusted:false, never:false, points:3, filmCount:2 };
  const never = { key:"d", adjusted:false, never:true, points:0, filmCount:9 };
  const sorted = [small, never, big, adjusted].sort(E.oaComboSort);
  assert.deepEqual(sorted.map(r=>r.key), ["a","b","c","d"]);
});

// ---- Geometry: every mark this section draws shares section 1's own value->position formula -----------------

test("CAS-1351 AC4 (arithmetic half only — see file header): oaTrackPct matches section 1's own 0-100 SHARE domain", () => {
  assert.equal(E.oaTrackPct(0), 0);
  assert.equal(E.oaTrackPct(100), 100);
  assert.equal(E.oaTrackPct(50), 50);
  assert.equal(E.oaTrackPct(-10), 0, "clamped");
  assert.equal(E.oaTrackPct(110), 100, "clamped");
});
