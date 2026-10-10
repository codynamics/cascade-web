// CAS-1233: a listed, unwatched film with no hand-set Watch On must always carry an automatic one — Lee's
// report was some Massive Movies films on Upcoming showing a blank "Watch On" chip while their neighbours
// showed "Cinema". Root cause (recomputeFound's CAS-727 placement loop, app_template.html): `earned`
// (earnedWindowForScore against the film's FROZEN admission_score) can legitimately come back null once an
// agent's own score marker moves past what the film was admitted at — the admission stays sticky (CAS-728),
// but the old code's `if(earned==null) return;` left that film's Watch On never written at all. The fix
// (autoPlacementFor) now falls back to the same forward "standing" walk already used for a non-null earned,
// extended to start from rung 0 (Upcoming), and finally to the agent's own last followed window — so a
// listed film always lands somewhere. The three other early returns the ticket asked to check against real
// data (no owner resolved, placementReady false forever, a manual-but-unticked level) were investigated and
// ruled out: `ids` is derived from `cascades` moments earlier in the same synchronous pass so `owner` cannot
// come back null in practice; `placementReady` is a single value for the whole pass, so it would blank EVERY
// unmanual film at once, not just some — neither matches Lee's per-film symptom; and the manual guard's own
// condition (`e.wins[k] && e.winsSource[k]==="manual"`) already requires the level to still be ticked, so a
// manual source left on an un-ticked level does not trip it.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withNotifyState(fn){
  const savedNotify = { ...E.notify };
  try{ fn(); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
  }
}
function unseedCascade(id){
  const i = E.cascades.findIndex(c => c.id === id);
  if(i >= 0) E.cascades.splice(i, 1);
}
function broadCascade(id, order){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = order;
  return c;
}
// A film whose CURRENT score is a real, usable number — needed so the agent's own marker can be set to
// exactly that score (clearing today's listing test) while the SEEDED admission_score is deliberately lower
// (simulating the score having moved on since admission, the real-world trigger for `earned==null`).
function pickScoredUpcomingFilm(){
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id)
    && E.primaryStatus(x) === "upcoming" && E.cascadeScore(x) >= 1);
  if(!m) throw new Error("no scored Upcoming film in the harness catalogue — this test would prove nothing");
  return m;
}

test("CAS-1233 AC2/AC4: earned==null (stale admission_score below the agent's current marker) falls back to the agent's earliest followed window on an Upcoming film", () => withNotifyState(() => {
  const owner = broadCascade("cas1233-ac2", 0);
  const film = pickScoredUpcomingFilm();
  const currentScore = E.cascadeScore(film);
  // in_cinema/rent/stream are ON by default (watchPrefsDefaults); premium is off. Setting every enabled
  // marker to the film's own current score means today's live listedBy()/matchesCriteria floor check
  // passes, while the SEEDED admission_score below stays deliberately stale.
  owner.watchMarkers = { in_cinema: currentScore, rent: currentScore, stream: currentScore };
  E.cascades.push(owner);
  try{
    const sig = E.cascSigOf(owner);
    E.CascadePersistence.setAgentFilm(owner.id, film.tmdb_id,
      { admission_score: 0, admission_status: "upcoming", agent_sig: sig });
    E.recomputeFound();

    const e = E.notify[film.tmdb_id];
    assert.ok(e && e.wins, "AC2: the film must have a wins object after recomputeFound");
    const onKeys = E.WATCH_LEVEL_KEYS.filter(k => e.wins[k]);
    assert.deepEqual(onKeys, ["in_cinema"],
      "AC2: an Upcoming film below every marker at admission must fall back to the agent's earliest followed window (Cinema)");
    assert.equal(e.winsSource.in_cinema, "auto", "AC2: the fallback placement must be sourced auto, not manual");

    // AC4: the monitor's placement_shim calls this exact function with the same inputs — it must agree.
    assert.equal(E.autoPlacementForAdmission(owner, film, 0), "in_cinema",
      "AC4: autoPlacementForAdmission must return the same level the device placed the film on");
  } finally{
    unseedCascade(owner.id);
  }
}));

test("CAS-1233 AC1: every unwatched, non-manual film watchScopeRows() returns on any stage has exactly one auto Watch On level", () => withNotifyState(() => {
  const owner = broadCascade("cas1233-ac1", 0);
  const film = pickScoredUpcomingFilm();
  const currentScore = E.cascadeScore(film);
  owner.watchMarkers = { in_cinema: currentScore, rent: currentScore, stream: currentScore };
  E.cascades.push(owner);
  const savedTab = E.watchTab, savedStage = E.watchCinemaStage;
  try{
    const sig = E.cascSigOf(owner);
    E.CascadePersistence.setAgentFilm(owner.id, film.tmdb_id,
      { admission_score: 0, admission_status: "upcoming", agent_sig: sig });
    E.recomputeFound();

    let checked = 0;
    E.WATCH_LEVEL_KEYS.filter(k => E.windowEnabled(k)).forEach(tab => {
      const stages = tab === "in_cinema" ? ["upcoming", "in_cinema"] : [null];
      stages.forEach(stage => {
        E.setWatchTab(tab);
        if(stage) E.setWatchCinemaStage(stage);
        E.watchScopeRows().forEach(m => {
          const id = m.tmdb_id;
          if(E.watched.has(id) || E.blocked.has(id)) return;
          const row = E.notify[id];
          const src = (row && row.winsSource) || {};
          if(E.WATCH_LEVEL_KEYS.some(k => src[k] === "manual")) return;   // AC3's own territory, not this one
          checked++;
          const autoKeys = E.WATCH_LEVEL_KEYS.filter(k => row && row.wins && row.wins[k] && src[k] === "auto");
          assert.equal(autoKeys.length, 1,
            `AC1: film ${id} on tab ${tab}${stage ? "/" + stage : ""} must carry exactly one auto Watch On level, got [${autoKeys}]`);
        });
      });
    });
    assert.ok(checked > 0, "setup: the sweep above must actually have examined at least one film");
  } finally{
    E.setWatchTab(savedTab); E.setWatchCinemaStage(savedStage);
    unseedCascade(owner.id);
  }
}));
