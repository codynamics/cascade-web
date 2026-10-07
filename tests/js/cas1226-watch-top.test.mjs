// CAS-1226: the Watch top area's agent-off rule. CAS-1223's watchScopeRows (when one or more agents were
// switched off) tested only filmOwnerCascade(m), dropping the listedBy test the all-on branch applies — so
// switching an agent off could make a stage's count go UP, never just down. Fix: the off branch now starts
// from the exact all-agents-on list and only ever subtracts a film whose owner is the switched-off agent;
// an unowned film is never touched. filmInWatchRows carries the identical rule. Also covers the lozenge
// row's own "every agent shows, no +N more" (renderWatchTop) and the Filters badge no longer counting agent
// selection (renderWatchSheet) — both DOM writes the engine.mjs stub can't capture, so each is tested via a
// small pure helper pulled out for exactly that reason (see their own CAS-1226 comments in app_template.html).
// AC5 (the pixel/layout checks) lives in tests/e2e/CAS-1226.spec.mjs per the ticket's own instruction.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

const PLACEMENT_WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try { fn(); } finally { E.setWatchPrefs(saved); }
}
// status:[] / imdb:10.1 agents admit nothing by criteria — only the explicit pinnedTo/cascadeIds wiring
// below decides what they list/own, the same synthetic-agent technique cas1146/cas1180 use.
function seedCascade(id, order){
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.order = order; c.paused = false; c.name = id;
  return c;
}
function withTestCascades(list, fn){
  const saved = E.cascades.slice();
  E.cascades.length = 0;
  list.forEach(c => E.cascades.push(c));
  try { fn(); } finally { E.cascades.length = 0; saved.forEach(c => E.cascades.push(c)); }
}
let cloneSeq = 0;
function plantFilm(status){
  const donor = E.MOVIES.find(m => !E.watched.has(m.tmdb_id));
  assert.ok(donor, "no unwatched film in the harness catalogue to clone — this test would prove nothing");
  cloneSeq++;
  const id = -1226000000 - cloneSeq;
  const film = { ...donor, tmdb_id: id, status: [status], cinema_date: null };
  E.MOVIES.push(film);
  return id;
}
function unplantFilm(id){
  const i = E.MOVIES.findIndex(m => m.tmdb_id === id);
  if (i !== -1) E.MOVIES.splice(i, 1);
  delete E.notify[id];
}
// Wires a film to a single owner: pinnedTo (so listedBy admits it for a status:[] agent trivially) and
// cascadeIds (filmOwnerCascade's own read) — same technique cas1146/cas1180's wireFilm use. winKey, when
// given, is the Watch On level the film carries (wins/winsSource, same shape cas1146's stream fixture
// uses); upcoming/in_cinema need none at all — CAS-823's "undecided film still standing in its own window"
// default bucket already admits them to the Cinema tab.
function wireFilm(id, cascadeId, winKey){
  const wins = { in_cinema: false, premium: false, rent: false, stream: false };
  const winsSource = {};
  if (winKey) { wins[winKey] = true; winsSource[winKey] = "manual"; }
  E.notify[id] = { source: "auto", cascadeIds: [cascadeId], pinnedTo: [cascadeId], notIn: [], wins, winsSource };
}

const STAGES = [
  { stageKey: "upcoming", tab: "in_cinema", cinemaStage: "upcoming", status: "upcoming", winKey: null },
  { stageKey: "in_cinema", tab: "in_cinema", cinemaStage: "in_cinema", status: "in_cinema", winKey: null },
  { stageKey: "rent", tab: "rent", cinemaStage: null, status: "rental", winKey: "rent" },
  { stageKey: "stream", tab: "stream", cinemaStage: null, status: "included_streaming", winKey: "stream" },
];

test("CAS-1226: switching an agent off only ever subtracts films, for every stage", () => {
  const agents = ["a", "b", "c", "d"].map((k, i) => seedCascade(`cas1226-${k}`, i));
  const savedTab = E.watchTab, savedStage = E.watchCinemaStage;
  withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
    withTestCascades(agents, () => {
      const planted = [];
      const byStage = STAGES.map(stage => {
        const idOwnedByFirst = plantFilm(stage.status);
        const idOwnedBySecond = plantFilm(stage.status);
        wireFilm(idOwnedByFirst, agents[0].id, stage.winKey);
        wireFilm(idOwnedBySecond, agents[1].id, stage.winKey);
        planted.push(idOwnedByFirst, idOwnedBySecond);
        return { ...stage, idOwnedByFirst, idOwnedBySecond };
      });
      E.watchAgentOff.clear();
      try {
        byStage.forEach(stage => {
          E.setWatchTab(stage.tab);
          if (stage.cinemaStage) E.setWatchCinemaStage(stage.cinemaStage);
          const ownerOf = id => E.filmOwnerCascade(E.MOVIES.find(m => m.tmdb_id === id));
          assert.equal(ownerOf(stage.idOwnedByFirst).id, agents[0].id, `setup: ${stage.stageKey} film 1 must be owned by agents[0]`);
          assert.equal(ownerOf(stage.idOwnedBySecond).id, agents[1].id, `setup: ${stage.stageKey} film 2 must be owned by agents[1]`);

          const allOnRows = E.watchScopeRows();
          assert.ok(allOnRows.some(m => m.tmdb_id === stage.idOwnedByFirst), `${stage.stageKey}: all-on must include film 1`);
          assert.ok(allOnRows.some(m => m.tmdb_id === stage.idOwnedBySecond), `${stage.stageKey}: all-on must include film 2`);

          // An agent with NO film in this stage switched off: both films must stand untouched.
          E.toggleWatchAgent(agents[3].id);
          const unrelatedOffRows = E.watchScopeRows();
          assert.ok(unrelatedOffRows.some(m => m.tmdb_id === stage.idOwnedByFirst), `${stage.stageKey}: unrelated agent off must not remove film 1`);
          assert.ok(unrelatedOffRows.some(m => m.tmdb_id === stage.idOwnedBySecond), `${stage.stageKey}: unrelated agent off must not remove film 2`);
          assert.ok(unrelatedOffRows.length <= allOnRows.length, `${stage.stageKey}: switching an agent off must never grow the count`);
          E.toggleWatchAgent(agents[3].id);   // re-tick

          // The actual owner switched off: its own film drops, the other owner's film stands, and the
          // result is exactly the all-on set minus the films that owner owns — never more than all-on.
          E.toggleWatchAgent(agents[0].id);
          const ownerOffRows = E.watchScopeRows();
          assert.ok(!ownerOffRows.some(m => m.tmdb_id === stage.idOwnedByFirst), `${stage.stageKey}: owner off must remove its own film`);
          assert.ok(ownerOffRows.some(m => m.tmdb_id === stage.idOwnedBySecond), `${stage.stageKey}: owner off must not remove the other owner's film`);
          assert.ok(ownerOffRows.length <= allOnRows.length, `${stage.stageKey}: owner off must never grow the count`);
          const expected = allOnRows.filter(m => {
            const o = E.filmOwnerCascade(m);
            return !o || o.id !== agents[0].id;
          }).map(m => m.tmdb_id).sort();
          assert.deepEqual(ownerOffRows.map(m => m.tmdb_id).sort(), expected,
            `${stage.stageKey}: with the owner off, the set must equal the all-on set minus that owner's films`);

          // filmInWatchRows (the single-card membership test) must agree with watchScopeRows for both
          // films while the owner is still off — checked on the Cinema tab only, where filmInWatchRows'
          // own downstream mineOnly/services gate (HOME_KEYS) never applies, so it tests only the
          // owner-off rule this ticket actually touches, not the donor film's real (unrelated) offers.
          if(stage.tab === "in_cinema"){
            [stage.idOwnedByFirst, stage.idOwnedBySecond].forEach(id => {
              const m = E.MOVIES.find(x => x.tmdb_id === id);
              assert.equal(E.filmInWatchRows(m), ownerOffRows.some(r => r.tmdb_id === id),
                `${stage.stageKey}: filmInWatchRows must agree with watchScopeRows for film ${id} with the owner off`);
            });
          }
          E.toggleWatchAgent(agents[0].id);   // re-tick, restore watchAgentOff to empty
        });
      } finally {
        E.watchAgentOff.clear();
        E.setWatchTab(savedTab); E.setWatchCinemaStage(savedStage);
        planted.forEach(unplantFilm);
      }
    });
  });
});

test('CAS-1226: renderWatchTop\'s own agent order carries every agent — no "+N more" overflow', () => {
  const agents = ["p", "q", "r", "s", "t"].map((k, i) => seedCascade(`cas1226-ov-${k}`, i));
  withTestCascades(agents, () => {
    const ranked = E.watchTopAgentsRanked();
    assert.equal(ranked.length, 5, "all five seeded agents must appear — the old overflow slice kicked in above 4");
    // Array.from (this realm's, not the vm sandbox's ranked array's own) so deepEqual compares two plain
    // arrays of primitive ids rather than tripping over the sandbox Array's own cross-realm identity.
    assert.deepEqual(Array.from(ranked, c => c.id), Array.from(agents, c => c.id),
      'every agent must appear in rank order, none dropped behind a "+N more" row');
  });
});

test("CAS-1226: an agent switched off, with no other filter set, leaves the Filters badge hidden", () => {
  const a = seedCascade("cas1226-badge-a", 0);
  const savedTab = E.watchTab;
  withTestCascades([a], () => {
    E.setWatchTab("stream");
    E.watchGenreOff.stream.clear();
    E.watchWatchedSel.stream.clear();
    E.watchHeldOpen.stream.clear();
    E.watchAgentOff.clear();
    try {
      assert.equal(E.watchFiltersActiveCount(), 0, "setup: nothing active before the agent switch");
      E.toggleWatchAgent(a.id);
      assert.equal(E.watchFiltersActiveCount(), 0,
        "AC: agent selection must no longer count toward the Filters badge");
    } finally {
      E.watchAgentOff.clear();
      E.setWatchTab(savedTab);
    }
  });
});
