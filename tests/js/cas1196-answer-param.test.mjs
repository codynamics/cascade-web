// CAS-1196 (app side): the alert email's own `?answer=<value>#/film/<id>` link — applied through
// applyPendingAnswer(), which runs the exact same wire functions a tap on the card's own controls
// would (toggleFilmOpt/pickNever), and never records a verdict by itself for "seen" (item 10).
//
// The sign-in gate itself (AC12 — signed out, the answer is ignored) is enforced structurally:
// applyPendingAnswer() is only ever called from the two places a confirmed sign-in actually runs
// fireAccountFanout() from (see its own comment in app_template.html), so there is no separate
// "ignore it" branch inside the function to test — a signed-out boot simply never reaches it. This
// file exercises applyPendingAnswer()'s own mapping/consumption logic directly.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function freshFilmId(E, used){
  const m = E.MOVIES.find(x => !used.has(x.tmdb_id));
  used.add(m.tmdb_id);
  return m;
}

test("CAS-1196: cinema/rent/stream answers make the same manual tick toggleFilmOpt makes", () => {
  const E = loadEngine();
  const used = new Set();
  const cases = [["cinema", "in_cinema"], ["rent", "rent"], ["stream", "stream"]];
  for(const [answer, levelKey] of cases){
    const m = freshFilmId(E, used);
    E.location.hash = `#/film/${m.tmdb_id}`;
    E.setPendingAnswer(answer);
    E.applyPendingAnswer();
    assert.equal(E.notify[m.tmdb_id].wins[levelKey], true,
      `${answer} must set the ${levelKey} Watch On level, exactly like a tap on the card's own control`);
    assert.equal(E.notify[m.tmdb_id].winsSource[levelKey], "manual",
      `${answer} is the member's own choice, not an agent's auto-arm`);
  }
});

test("CAS-1196: never marks the film not interested, the same as pickNever", () => {
  const E = loadEngine();
  const m = E.MOVIES[0];
  E.location.hash = `#/film/${m.tmdb_id}`;
  E.setPendingAnswer("never");
  E.applyPendingAnswer();
  assert.equal(E.opinionOf(m.tmdb_id), "notfor");
});

test("CAS-1196: seen records no verdict by itself", () => {
  const E = loadEngine();
  const m = E.MOVIES[1];
  assert.notEqual(E.opinionOf(m.tmdb_id), "wow", "setup sanity: this film must not already carry a verdict");
  const before = E.opinionOf(m.tmdb_id);
  E.location.hash = `#/film/${m.tmdb_id}`;
  E.setPendingAnswer("seen");
  E.applyPendingAnswer();
  assert.equal(E.opinionOf(m.tmdb_id), before, "seen must not call setOpinion/pickWatch by itself");
});

test("CAS-1196: pendingAnswer is consumed once — a second call is a no-op", () => {
  const E = loadEngine();
  const m = E.MOVIES[0];
  E.location.hash = `#/film/${m.tmdb_id}`;
  E.setPendingAnswer("cinema");
  E.applyPendingAnswer();
  assert.equal(E.notify[m.tmdb_id].wins.in_cinema, true);
  E.applyPendingAnswer();   // pendingAnswer is already null — must not re-toggle the level back off
  assert.equal(E.notify[m.tmdb_id].wins.in_cinema, true);
});

test("CAS-1196: no pendingAnswer, or no film at the current route, is a silent no-op", () => {
  const E = loadEngine();
  assert.doesNotThrow(() => { E.setPendingAnswer(null); E.applyPendingAnswer(); });
  E.location.hash = "#/film/999999999";   // not in the harness catalogue
  E.setPendingAnswer("never");
  assert.doesNotThrow(() => E.applyPendingAnswer());
});

test("CAS-1196: filmPageHTML's seen landing shows the Watched ramp, the ordinary page does not", () => {
  const E = loadEngine();
  const m = E.MOVIES[0];
  const ordinary = E.filmPageHTML(m);
  const seenLanding = E.filmPageHTML(m, true);
  assert.ok(!ordinary.includes("cseg"), "the ordinary film page carries no Watched chooser");
  for(const step of ["wow", "liked", "enjoyed", "soso", "disliked"]){
    assert.ok(seenLanding.includes(`data-key="${step}"`),
      `the seen landing's ramp must offer every WATCH_STEPS key, including "${step}"`);
    assert.ok(seenLanding.includes(`pickWatch(${m.tmdb_id},'${step}')`),
      "each ramp button must be wired to the real pickWatch, so tapping one records a real verdict");
  }
});
