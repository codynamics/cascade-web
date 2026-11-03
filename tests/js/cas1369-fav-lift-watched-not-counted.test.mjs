// CAS-1369: a film whose MAIN genre is a ♥ favourite in the agent (c.styles[style].fav) ranks as if its
// score were OAM_FAV_LIFT (+5) higher — ordering and the Best-N cut only; oamOrderScore is the one
// chokepoint that applies it, never oneScoreFor/oneScore itself (the score box, "score N+" text,
// membership and alerts all stay untouched). And a mood with watched:true no longer spends a Best-N slot
// on a watched film — oamApplyShowCap's own cut now counts only unwatched films against its budget, so
// "Best 40" lists the 40 best unwatched films plus any watched ones that rank among them. oaFav/oaToggleFav
// are the Agent screen's own read/write pair for the ♥ switch (CAS-1368's first run writes the same field).
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
  return { id:"cas1369-fixture", name:"My agent", v:2, styles:{}, combo:{}, seenAdj:{}, dismissed:[], ...overrides };
}
function styleOn(bar, extra){
  return { bar, al:{cinema:false, rent:false, stream:false}, ...extra };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"t-cas1369-mood", name:"Me", ...overrides };
}
// Same convention tests/js/cas1339-agent-screen.test.mjs's own ratingForScore/scoredFilm use: a binary
// search over E.wmScaled finds a wm_user_rating landing on an exact cascadeScore, so a fixture's real score
// is asserted up front rather than assumed from the rating alone.
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
let _nextId = 91690001;
// CAS-1374's own filmWith convention adds language/cinema_release/cinema_date too — passesTasteBase (the
// stage pool's own gate, oamStagePool) excludes a film with no language at all, which only the WIL-rank
// test below actually walks through; harmless for every other test here, which never reaches that gate.
function scoredFilm(genres, score){
  const id = _nextId++;
  const m = { tmdb_id:id, title:`CAS-1369 fixture ${id}`, genres, status:["included_streaming"],
    language:"en", wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true,
    availability_confidence:"confirmed", cinema_release:true, cinema_date:E.TODAY,
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };
  const got = E.cascadeScore(m);
  if(got !== score) throw new Error(`test setup: fixture ${id} cascadeScore computed ${got}, expected ${score}`);
  return m;
}
function withWatched(ids, fn){
  const saved = new Set(E.watched);
  E.watched.clear(); ids.forEach(id => E.watched.add(id));
  try{ return fn(); } finally{ E.watched.clear(); saved.forEach(x => E.watched.add(x)); }
}
// Same convention tests/js/cas1374-mood-show-reasons.test.mjs's own withMoviesAndMoods uses — oamWilCase/
// oamWilRankInMood read oneAgentCriteria()/oamMoodsListReal() (the account's own live state), not any `c`
// or mood handed to them directly, so a rank assertion needs its fixtures live in E.cascades/E.watchMoods
// too, and the real catalogue swapped out of E.MOVIES so it can never dilute a cut/rank assertion.
function withMoviesAndMoods(c, movies, moods, fn){
  const savedMovies = [...E.MOVIES];
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  const savedCascades = [...E.cascades];
  E.MOVIES.length = 0; movies.forEach(m => E.MOVIES.push(m));
  E.watchMoods.length = 0; moods.forEach(m => E.watchMoods.push(m));
  E.cascades.length = 0; E.cascades.push(c);
  try{ return fn(); }
  finally{
    E.MOVIES.length = 0; savedMovies.forEach(m => E.MOVIES.push(m));
    E.watchMoods.length = 0; savedMoods.forEach(m => E.watchMoods.push(m));
    E.cascades.length = 0; savedCascades.forEach(a => E.cascades.push(a));
  }
}

// ---- 1. oamOrderScore: the lift, and only the lift ------------------------------------------------------

test("CAS-1369: OAM_FAV_LIFT is 5", () => {
  assert.equal(E.OAM_FAV_LIFT, 5);
});

test("CAS-1369 AC1: oamOrderScore adds the lift only for a ♥ main genre; the real score is untouched", () => {
  const c = oneAgent({ styles: { Action: styleOn(1, { fav:true }), Drama: styleOn(1, { fav:false }) } });
  const favFilm = scoredFilm(["Action"], 70);
  const plainFilm = scoredFilm(["Drama"], 70);
  assert.equal(E.oneScore(favFilm, c), 70, "the real score the card shows never moves");
  assert.equal(E.oneScore(plainFilm, c), 70);
  assert.equal(E.oamOrderScore(favFilm, c), 75, "ordering sees the lifted score");
  assert.equal(E.oamOrderScore(plainFilm, c), 70, "no lift without the ♥");
});

test("CAS-1369 AC1: a film with no score (-1) gets no lift either way", () => {
  const c = oneAgent({ styles: { Action: styleOn(1, { fav:true }) } });
  const noScore = { tmdb_id:_nextId++, title:"no score", genres:["Action"], status:["included_streaming"],
    wm_user_rating:null, wm_critic_score:null, _fixture:true, availability_confidence:"confirmed", offers:[] };
  assert.equal(E.oneScore(noScore, c), -1);
  assert.equal(E.oamOrderScore(noScore, c), -1);
});

test("CAS-1369 AC1: a ♥ favourite outranks a non-favourite scoring up to 4 points higher, but not 6", () => {
  const c = oneAgent({ styles: { Action: styleOn(1, { fav:true }), Drama: styleOn(1, { fav:false }) } });
  const action = scoredFilm(["Action"], 70);
  const dramaClose = scoredFilm(["Drama"], 74);   // 4 points higher — inside the +5 lift
  const dramaFar = scoredFilm(["Drama"], 76);     // 6 points higher — outside it
  assert.ok(E.oamOrderScore(action, c) > E.oamOrderScore(dramaClose, c),
    "the lift puts Action ahead of a Drama film that only out-scores it by 4");
  assert.ok(E.oamOrderScore(action, c) < E.oamOrderScore(dramaFar, c),
    "a 6-point gap is too wide for the lift to close");
});

// ---- 2. oamApplyShowCap: the Best-N cut itself uses the lifted order -------------------------------------

test("CAS-1369 AC1: the Best-N cut uses oamOrderScore, not the raw score", () => {
  const c = oneAgent({ styles: { Action: styleOn(1, { fav:true }), Drama: styleOn(1, { fav:false }) } });
  const mood = moodWith({ show:"40" });
  // 40 Drama decoys, scores 90,88,...,12 (step 2) — a clean Best-40 pool on raw score alone.
  const decoys = Array.from({ length:40 }, (_, i) => scoredFilm(["Drama"], 90 - i*2));
  const weakest = decoys[decoys.length-1];   // scores 12, the last to survive on raw score
  // The ♥ Action target scores 10 — below every decoy on raw score, so it would be cut outright — but its
  // lift (+5, to 15) slots it between the decoys scoring 16 and 14, bumping the weakest (12) out instead.
  const target = scoredFilm(["Action"], 10);
  const kept = E.oamApplyShowCap([...decoys, target], mood, c, new Set());
  const keptIds = new Set(kept.map(m => m.tmdb_id));
  assert.equal(kept.length, 40);
  assert.ok(keptIds.has(target.tmdb_id), "the favourite's lift should have won it a slot");
  assert.ok(!keptIds.has(weakest.tmdb_id), "the weakest decoy should have been bumped out, not the favourite");
});

// ---- 3. Watched films don't spend a Best-N slot ----------------------------------------------------------

test("CAS-1369 AC2: a Best 40 mood with watched:true lists 50 cards — 40 unwatched plus 10 watched ranked among them", () => {
  const c = oneAgent({ styles: { Action: styleOn(1, { fav:false }) } });
  const mood = moodWith({ show:"40", watched:true });
  // 50 films, strictly descending score 99..50 — the top 10 (99..90) are watched, the rest unwatched.
  const films = Array.from({ length:50 }, (_, i) => scoredFilm(["Action"], 99 - i));
  const watchedIds = films.slice(0, 10).map(m => m.tmdb_id);
  withWatched(watchedIds, () => {
    const kept = E.oamApplyShowCap(films, mood, c, new Set());
    assert.equal(kept.length, 50, "40 unwatched + the 10 watched films ranked among them");
    const keptIds = new Set(kept.map(m => m.tmdb_id));
    films.forEach(m => assert.ok(keptIds.has(m.tmdb_id)));
  });
});

test("CAS-1369 AC2: a watched film ranked below the cut is still dropped — it's exempt from spending a slot, not from the cut itself", () => {
  const c = oneAgent({ styles: { Action: styleOn(1, { fav:false }) } });
  const mood = moodWith({ show:"40", watched:true });
  // 40 unwatched films (scores 99..60) fill the whole Best-40 budget on their own; one watched film scores
  // lower than all of them — it never ranks "among" the kept 40, so the cut still drops it.
  const unwatched = Array.from({ length:40 }, (_, i) => scoredFilm(["Action"], 99 - i));
  const watchedFilm = scoredFilm(["Action"], 20);
  withWatched([watchedFilm.tmdb_id], () => {
    const kept = E.oamApplyShowCap([...unwatched, watchedFilm], mood, c, new Set());
    const keptIds = new Set(kept.map(m => m.tmdb_id));
    assert.equal(kept.length, 40);
    assert.ok(!keptIds.has(watchedFilm.tmdb_id));
  });
});

test("CAS-1369 AC2: oamWilRankInMood's rank stays honest to the watched-doesn't-count cut", () => {
  // 40 unwatched decoys (scores 99,97,...,21) fill a Best 40 mood; a watched film ranks genuinely ahead of
  // several of them on score but spends no slot (CAS-1369's own rule) — it must not push a genuinely-41st
  // unwatched film's reported rank to 42.
  const decoys = Array.from({ length:40 }, (_, i) => scoredFilm(["Action"], 99 - i*2));
  const target = scoredFilm(["Action"], 20);        // one below the weakest decoy (21) — genuinely 41st
  const watchedAhead = scoredFilm(["Action"], 50);  // ranks ahead of target, but watched
  const c = oneAgent({ styles: { Action: styleOn(1, { fav:false }) } });
  const mood = moodWith({ show:"40", watched:true });
  withMoviesAndMoods(c, [...decoys, target, watchedAhead], [mood], () => {
    withWatched([watchedAhead.tmdb_id], () => {
      assert.equal(E.filmInOneAgentMood(target, mood, c), true, "sanity: it still passes the mood's own rules");
      const r = E.oamWilCase(target, c);
      assert.match(r.sentence, /ranks 41st, below its best 40/);
    });
  });
});

// ---- 4. oaFav / oaToggleFav: the Agent screen's own ♥ read/write -----------------------------------------

test("CAS-1369 AC3: oaFav reads c.styles[style].fav; false/absent for an untouched style", () => {
  const c = oneAgent({ styles: { Action: styleOn(50, { fav:true }), Drama: styleOn(50) } });
  assert.equal(E.oaFav(c, "Action"), true);
  assert.equal(E.oaFav(c, "Drama"), false);
  assert.equal(E.oaFav(c, "Horror"), false, "a style the agent has never touched at all");
});

test("CAS-1369 AC3: oaToggleFav flips fav without touching the bar", () => {
  withCascades([oneAgent({ styles: { War: styleOn(65) } })], () => {
    const c = E.cascades[0];
    assert.equal(E.oaFav(c, "War"), false);
    E.oaToggleFav("War");
    assert.equal(c.styles.War.fav, true, "turning ♥ on sets fav");
    assert.equal(c.styles.War.bar, 65, "turning ♥ on doesn't change the bar");
    E.oaToggleFav("War");
    assert.equal(c.styles.War.fav, false, "tapping it again clears it");
    assert.equal(c.styles.War.bar, 65);
  });
});

test("CAS-1369 AC3: the ♥ toggle only renders on an ON row", () => {
  const c = oneAgent({ styles: { War: styleOn(65, { fav:true }) } });
  const onHTML = E.oaRowHTML(c, "War", 3);
  assert.ok(onHTML.includes('class="oarowfav on"'), "an on, favourited row shows the filled ♥");
  const offHTML = E.oaRowHTML(oneAgent({ styles: {} }), "War", 0);
  assert.ok(!offHTML.includes("oarowfav"), "an off row carries no ♥ toggle at all");
});
