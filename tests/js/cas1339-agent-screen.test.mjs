// CAS-1339: the Agent screen (v2 accounts) — style list, minimum score, agent suggestion, film alerts.
// Drives the real shipped engine (tests/js/engine.mjs's loadEngine(), reading the BUILT index.html)
// directly, the same convention tests/js/cas1337-one-agent.test.mjs and tests/js/cas1338-one-score-box.
// test.mjs use — never a re-derivation of the screen's own render/order/save rules.
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
let _nextFixtureId = 90700001;
function scoredFilm(genres, score){
  const id = _nextFixtureId++;
  const m = { tmdb_id:id, title:`CAS-1339 fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true,
    availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };
  const got = E.cascadeScore(m);
  if(got !== score) throw new Error(`test setup: fixture ${id} cascadeScore computed ${got}, expected ${score}`);
  return m;
}
function withMovies(films, fn){
  films.forEach(m => E.MOVIES.push(m));
  try{ return fn(); }
  finally{ films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); }); }
}
// For an aggregate (whole-catalogue) function like oaFilmCounts, adding a fixture isn't enough — the real
// ~5,800-film catalogue is still in MOVIES alongside it. This swaps it out entirely for the duration of fn,
// the same full-catalogue isolation tests/js/invariants.test.mjs already uses (MOVIES.length=0; push...).
function withOnlyMovies(films, fn){
  const original = [...E.MOVIES];
  E.MOVIES.length = 0;
  films.forEach(m => E.MOVIES.push(m));
  try{ return fn(); }
  finally{ E.MOVIES.length = 0; original.forEach(m => E.MOVIES.push(m)); }
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
  return { id:"cas1339-fixture", name:"My agent", v:2, styles:{}, combo:{}, seenAdj:{}, dismissed:[], ...overrides };
}
function styleOn(bar, al){
  return { bar, al: { cinema:false, rent:false, stream:false, ...al } };
}
// Always close any style a prior test left open, so each test starts from the screen's own fresh state.
function closeAnyOpenStyle(){
  if(E.oaOpenStyle) E.oaToggleStyle(E.oaOpenStyle);
}

// ---- AC1: row order — on styles by bar ascending then name, then off styles A-Z ---------------------------

test("CAS-1594 AC1: oaComputeOrder puts alerts-on genres first, then A-Z inside each group", () => {
  const c = oneAgent({ styles: {
    "Thriller": styleOn(75, {stream:true}), "Action": styleOn(65, {cinema:true}), "Adventure": styleOn(65, {rent:true}),
    "Drama": styleOn(null), "Comedy": styleOn(null),
  }});
  const order = E.oaComputeOrder(c);
  // [...order] normalises out of the engine's own VM realm before deepEqual — the array itself still works
  // fine for indexOf/filter cross-realm, but deepStrictEqual also checks the constructor, which differs.
  const onPart = [...order].filter(g => ["Action","Adventure","Thriller"].includes(g));
  assert.deepEqual(onPart, ["Action","Adventure","Thriller"], "alerts-on genres A-Z");
  assert.ok(order.indexOf("Comedy") < order.indexOf("Drama"), "no-alert genres are A-Z");
  assert.ok(order.indexOf("Thriller") < order.indexOf("Comedy"), "every alerts-on genre sorts before every no-alert genre");
});

// ---- AC2: opening a style freezes the row order until it closes ---------------------------------------------

test("CAS-1594 AC2: opening Thriller freezes order; turning an alert on for another genre does not move rows until it closes", () => {
  withCascades([oneAgent({ styles: {
    "Thriller": styleOn(65, {cinema:true}), "Action": styleOn(60, {cinema:true}), "Crime": styleOn(70),
  }})], () => {
    const c = E.cascades[0];
    const before = E.oaComputeOrder(c);
    assert.equal(before[0], "Action");
    assert.ok(E.oaAlertsOn(c, "Thriller") && !E.oaAlertsOn(c, "Crime"));
    E.oaToggleStyle("Thriller");
    assert.equal(E.oaOpenStyle, "Thriller");
    const frozen = E.oaOrder(c);
    assert.deepEqual(frozen, before, "the snapshot taken on open matches the pre-open order");
    E.oaToggleAlert("Crime", "stream");
    assert.deepEqual(E.oaOrder(c), frozen, "the row stays in its frozen position while still open");
    E.oaToggleStyle("Thriller");
    assert.equal(E.oaOpenStyle, null);
    const onStyles = [...E.oaOrder(c)].filter(g => ["Thriller","Action","Crime"].includes(g));
    assert.deepEqual(onStyles, ["Action","Crime","Thriller"], "closing re-sorts; Crime now has alerts on and joins the A-Z alerts-on group");
  });
  closeAnyOpenStyle();
});

test("CAS-1594 AC2: a closed row shows verdicts + Alerts state; the open row adds FILM ALERTS and no minimum-score section", () => {
  withCascades([oneAgent({ styles: { "Mystery": styleOn(65) } })], () => {
    const c = E.cascades[0];
    const closedHTML = E.oaRowHTML(c, "Mystery", 10);
    assert.ok(closedHTML.includes("10 verdicts") && closedHTML.includes("No alerts"), closedHTML);
    E.oaToggleStyle("Mystery");
    const openHTML = E.oaRowHTML(c, "Mystery", 10);
    assert.ok(openHTML.includes("FILM ALERTS") && openHTML.includes("SCORE ADJUSTMENTS"));
    assert.ok(!openHTML.includes("MOVIE MINIMUM SCORE") && !openHTML.includes("AGENT SUGGESTION"));
    E.oaToggleStyle("Mystery");
  });
});

// ---- CAS-1367: the slider no longer goes to off; releasing at its far left clamps to Top 20% -----------------

// Lee, 2026-11-22: the floor is now Top 5% (was 20%).
test("CAS-1367: releasing a drag at share 0 clamps to the slider's own floor (Top 5%), it does not turn the style off", () => {
  withCascades([oneAgent({ styles: { "War": styleOn(50) } })], () => {
    const c = E.cascades[0];
    E.oaOnRelease({ dataset:{style:"War"}, value:"0" });
    assert.equal(c.styles.War.bar, E.oneBarForTopPct("War", 5), "clamped to share 5, not Never");
    assert.notEqual(c.styles.War.bar, null);
  });
});

// ---- CAS-1367 AC1/AC2: the row's own tick is the only way a style turns off, and it remembers its share -----

test("CAS-1367 AC1: unticking a style off removes its films from admission; ticking it back on restores its prior bar", () => {
  withCascades([oneAgent({ styles: { "Horror": styleOn(50) } })], () => {
    const c = E.cascades[0];
    const film = scoredFilm(["Horror","Drama"], 70);
    withMovies([film], () => {
      assert.equal(E.matchesCriteria(film, c), true, "sanity: admitted while Horror is on");
      E.oaToggleStyleOn("Horror");
      assert.equal(c.styles.Horror.bar, null, "the tick turns it off");
      assert.equal(c.styles.Horror.lastBar, 50, "its prior bar is remembered as lastBar");
      assert.equal(E.matchesCriteria(film, c), false, "the film leaves admission once off");
      E.oaToggleStyleOn("Horror");
      assert.equal(c.styles.Horror.bar, 50, "ticking it back on restores the remembered bar");
      assert.equal(E.matchesCriteria(film, c), true, "the film is admitted again");
    });
  });
});

test("CAS-1367 AC1: a style with no remembered bar turns on at score 80", () => {
  withCascades([oneAgent({ styles: {} })], () => {
    const c = E.cascades[0];
    E.oaToggleStyleOn("Horror");
    assert.equal(c.styles.Horror.bar, 80);
  });
});

test("CAS-1594: a genre off in Latest and Best says so under the alert note; no range input", () => {
  withCascades([oneAgent({ styles: { "War": styleOn(50) } })], () => {
    const c = E.cascades[0];
    const onHtml = E.oaOpenBodyHTML(c, "War");
    assert.ok(!onHtml.includes("Alerts follow Latest and Best"), "no note while the genre is on");
    E.oaToggleStyleOn("War");
    const html = E.oaOpenBodyHTML(c, "War");
    assert.ok(!html.includes("oarange"), "no range input renders");
    assert.ok(html.includes("Alerts follow Latest and Best, where War is off. Tick it there to get alerts."), html);
  });
});

// ---- AC4: the agent suggestion box, and its two buttons ------------------------------------------------------

test("CAS-1339 AC4: a fixture barAdvice({dir:up}) renders the suggestion text, and each button commits the right change", () => {
  const style = "Horror";
  const low = [
    [scoredFilm([style,"Drama"], 64), "disliked"],
    [scoredFilm([style,"Drama"], 65), "disliked"],
    [scoredFilm([style,"Drama"], 66), "liked"],
    [scoredFilm([style,"Drama"], 77), "liked"],
    [scoredFilm([style,"Drama"], 78), "disliked"],
  ];
  const high = Array.from({length:7}, () => [scoredFilm([style,"Drama"], 81), "liked"]);
  withTasteFixture([...low, ...high], () => {
    withCascades([oneAgent({ styles: { [style]: styleOn(65) } })], () => {
      const c = E.cascades[0];
      const adv = E.barAdvice(style);
      assert.deepEqual({ ...adv, lo:undefined, hi:undefined }, { dir:"up", from:65, to:80, lo:undefined, hi:undefined });
      // CAS-1345 Part 5: collapsed by default — just the label row, no text or buttons yet.
      assert.equal(E.oaSuggestionOpen, false);
      const collapsed = E.oaSuggestionHTML(style);
      assert.ok(collapsed.includes("AGENT SUGGESTION ›"));
      assert.ok(!collapsed.includes("oasugtext") && !collapsed.includes("Change to"));
      // Tapping the row opens it: the short message, then the two buttons.
      E.oaToggleSuggestion();
      assert.equal(E.oaSuggestionOpen, true);
      const html = E.oaSuggestionHTML(style);
      // CAS-1351: the suggestion names the share, not the score.
      const toPct = E.oneTopPct(style, 80), fromPct = E.oneTopPct(style, 65);
      assert.ok(html.includes("AGENT SUGGESTION ⌄"));
      assert.ok(html.includes(`Your verdicts suggest <b>Top ${toPct}%</b> would suit you better.`));
      assert.ok(html.includes(`Change to Top ${toPct}%`));
      assert.ok(html.includes(`Keep Top ${fromPct}%`));
      // "Change to <to>+" sets the bar.
      E.oaApplySuggestion(style, 80);
      assert.equal(c.styles[style].bar, 80);
      c.styles[style].bar = 65; // reset for the Keep branch below
      // "Keep <from>+" dismisses the suggestion permanently (bar:<style> in dismissed).
      E.oaDismissSuggestion(style);
      assert.ok(c.dismissed.includes("bar:"+style));
      assert.equal(E.barAdvice(style), null, "a dismissed suggestion is silenced");
      assert.equal(E.oaSuggestionHTML(style), "", "the box itself disappears once dismissed");
      E.oaToggleSuggestion(); // leave it collapsed again for any test that runs after this one.
    });
  });
});

// ---- AC5: toggling an alert chip persists on the criteria object and feeds alert_moments --------------------

test("CAS-1339 AC5: toggling Cinema on Sci-fi flips styles[s].al.cinema and alert_moments gains hits_cinema", () => {
  withCascades([oneAgent({ styles: { "Science Fiction": styleOn(60) } })], () => {
    const c = E.cascades[0];
    assert.equal(c.styles["Science Fiction"].al.cinema, false);
    assert.ok(!E.CascadeShape.momentsOf(c).includes("hits_cinema"));
    E.oaToggleAlert("Science Fiction", "cinema");
    assert.equal(c.styles["Science Fiction"].al.cinema, true, "the toggle persists on the agent's own criteria");
    assert.ok(E.CascadeShape.momentsOf(c).includes("hits_cinema"), "alert_moments gains hits_cinema");
    const html = E.oaAlertsHTML(c, "Science Fiction");
    assert.ok(html.includes('class="oachip on"'), "the Cinema chip carries the on modifier class");
    assert.ok(html.includes("Cinema 🔔"), "an on chip shows the bell after its label");
    // toggling back off removes it again.
    E.oaToggleAlert("Science Fiction", "cinema");
    assert.equal(c.styles["Science Fiction"].al.cinema, false);
    assert.ok(!E.CascadeShape.momentsOf(c).includes("hits_cinema"));
  });
});

// ---- AC6: a non-v2 account is untouched -----------------------------------------------------------------------

test("CAS-1339 AC6: oneAgentCriteria() is null with no v2 agent, so the v2 screen never takes over", () => {
  withCascades([{ id:"v1-fixture", name:"Any new release", genre:[], exclude:[] }], () => {
    assert.equal(E.oneAgentCriteria(), null);
  });
});

// ---- the films-admitted count feeding each row's "<n> films" line -------------------------------------------

test("CAS-1339: oaFilmCounts counts each film once, under its own MAIN style only", () => {
  withCascades([oneAgent({ styles: { "Action": styleOn(50), "Adventure": styleOn(50) } })], () => {
    const c = E.cascades[0];
    const film = scoredFilm(["Action","Adventure"], 60);
    withOnlyMovies([film], () => {
      const counts = E.oaFilmCounts(c);
      assert.equal(counts.Action, 1, "counted under its main style");
      assert.equal(counts.Adventure || 0, 0, "not double-counted under a non-main style it also carries");
    });
  });
});
