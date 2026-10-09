// CAS-1239: a film has ONE owner everywhere. filmOwnerCascade is now the single function the lane heading
// (splitByOwner), the agent chip (agentChipHTML), the agent-off rule (watchScopeRows/filmInWatchRows) and
// Moving's Alerts attribution (movingData) all resolve ownership through — see its own comment in
// app_template.html. These tests drive that function (and the surfaces built on it) directly, the same
// synthetic-cascade technique CAS-793/CAS-1146/CAS-1226's own owner tests already use.
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
function withState(fn){
  const savedNotify = { ...E.notify };
  const savedCascades = [...E.cascades];
  const savedRealAlerts = [...E.realAlerts];
  const savedFirstFound = { ...E.firstFound };
  const savedTab = E.watchTab, savedStage = E.watchCinemaStage;
  const savedHadAccount = E.localStorage.getItem("cascade_had_account");
  // CAS-1028: these tests pick a film by status/window, never by language — broaden the account's taste
  // base so a non-English pick can't fail listedBy() for a reason unrelated to what's under test.
  const savedLangs = E.tasteBase.langs;
  E.tasteBase.langs = [];
  try { fn(); }
  finally {
    E.tasteBase.langs = savedLangs;
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.realAlerts.length = 0; E.realAlerts.push(...savedRealAlerts);
    Object.keys(E.firstFound).forEach(k => delete E.firstFound[k]);
    Object.assign(E.firstFound, savedFirstFound);
    E.watchAgentOff.clear();
    E.setWatchTab(savedTab); E.setWatchCinemaStage(savedStage);
    if (savedHadAccount === null) E.localStorage.removeItem("cascade_had_account");
    else E.localStorage.setItem("cascade_had_account", savedHadAccount);
    E.setMovingReady(true);
  }
}
// status:[] admits any status; a real watchMarkers override (set AFTER normCascade, so none of its own
// zero-collapsing/defaulting logic ever re-touches it) decides whether this agent clears the score gate.
function broadCascade(id, order){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.order = order; c.paused = false; c.name = id;
  return c;
}
function pickFilm(){
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id)
    && E.primaryStatus(x) !== "upcoming");
  assert.ok(m, "no non-upcoming, unwatched film in the harness catalogue — this test would prove nothing");
  return m;
}
// Standing in included_streaming (WATCH_TAB_OWN_STANDING.stream) itself, so a film's presence on the
// "stream" tab never rides on the Also-show widening default (CAS-1235) instead of the owner rule this
// ticket is actually about.
function pickStreamingFilm(){
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id)
    && E.primaryStatus(x) === "included_streaming");
  assert.ok(m, "no unwatched included_streaming film in the harness catalogue — this test would prove nothing");
  return m;
}

test("CAS-1239 AC1: no-pin case — a stale membership owner that fails the score gate yields the agent that actually lists the film, never 'No agent'", () => withState(() => {
  const a = broadCascade("cas1239-ac1-a", 0);   // the recorded (stale) membership owner
  a.watchMarkers = { in_cinema: 1000, premium: null, rent: 1000, stream: 1000 };   // score gate always fails
  const b = broadCascade("cas1239-ac1-b", 1);   // actually lists the film today
  b.watchMarkers = { in_cinema: 0, premium: null, rent: 0, stream: 0 };
  E.cascades.push(a, b);
  const film = pickFilm();
  const id = film.tmdb_id;
  // Simulates recomputeFound's own (stale/sticky) membership answer: `a` is still the recorded owner even
  // though it no longer lists the film — CAS-1239's exact bug shape.
  E.notify[id] = { cascadeIds: [a.id], pinnedTo: [] };

  assert.equal(E.listedBy(film, a), false, "setup: a must fail its own score gate");
  assert.equal(E.listedBy(film, b), true, "setup: b must actually list the film");

  const owner = E.filmOwnerCascade(film);
  assert.ok(owner, "AC1: there must never be a lane for a with a chip saying No agent — the owner must resolve");
  assert.equal(owner.id, b.id, "AC1: ownership falls through to the agent that actually lists the film");

  const chip = E.agentChipHTML(id);
  assert.ok(chip.includes(b.name), "AC1: the chip must name the same agent as the lane heading");
  assert.ok(!chip.includes("No agent"), "AC1: the chip must not read No agent when b lists the film");
}));

test("CAS-1239 AC2: switching the fallback owner off drops the film; switching the stale membership owner off (with the lister on) keeps it", () => withState(() => withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
  const a = broadCascade("cas1239-ac2-a", 0);
  a.watchMarkers = { in_cinema: 1000, premium: null, rent: 1000, stream: 1000 };
  const b = broadCascade("cas1239-ac2-b", 1);
  b.watchMarkers = { in_cinema: 0, premium: null, rent: 0, stream: 0 };
  E.cascades.push(a, b);
  const film = pickStreamingFilm();
  const id = film.tmdb_id;
  E.notify[id] = {
    cascadeIds: [a.id], pinnedTo: [],
    wins: { in_cinema: false, premium: false, rent: false, stream: true },
    winsSource: { stream: "manual" },
  };
  E.setWatchTab("stream");
  assert.equal(E.filmOwnerCascade(film).id, b.id, "setup: b owns the film (a's membership has gone stale)");

  // b (the actual owner) switched off: the film must drop, whatever a's stale membership says.
  E.toggleWatchAgent(b.id);
  assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id), "AC2: switching the real owner off must drop the film");
  E.toggleWatchAgent(b.id);

  // a (the stale membership owner, not the real owner) switched off instead: the film must stand, since
  // the agent actually switched off never owned it.
  E.toggleWatchAgent(a.id);
  assert.ok(E.watchScopeRows().some(m => m.tmdb_id === id), "AC2: switching off a non-owner must not remove the film");
  E.toggleWatchAgent(a.id);
})));

test("CAS-1239 AC3: over the catalogue, every row's lane-heading agent equals its chip's agent, for every stage", () => withState(() => withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
  const a = broadCascade("cas1239-ac3-a", 0);
  a.watchMarkers = { in_cinema: 1000, premium: null, rent: 1000, stream: 1000 };
  const b = broadCascade("cas1239-ac3-b", 1);
  b.watchMarkers = { in_cinema: 0, premium: null, rent: 0, stream: 0 };
  E.cascades.length = 0; E.cascades.push(a, b);
  E.recomputeFound();   // populates real Watch On placements so rent/stream carry rows too, not just Cinema

  const STAGES = [
    { tab: "in_cinema", cinemaStage: "upcoming" }, { tab: "in_cinema", cinemaStage: "in_cinema" },
    { tab: "rent", cinemaStage: null }, { tab: "stream", cinemaStage: null },
  ];
  let checked = 0;
  STAGES.forEach(({ tab, cinemaStage }) => {
    E.setWatchTab(tab);
    if (cinemaStage) E.setWatchCinemaStage(cinemaStage);
    E.watchScopeRows().forEach(m => {
      checked++;
      const owner = E.filmOwnerCascade(m);
      const chip = E.agentChipHTML(m.tmdb_id);
      if (owner) {
        assert.ok(chip.includes(owner.name), `AC3: film ${m.tmdb_id}'s chip must name its lane's owner (${owner.name})`);
        assert.ok(!chip.includes("No agent"), `AC3: film ${m.tmdb_id} has an owner, so its chip must not say No agent`);
      } else {
        assert.ok(chip.includes("No agent"), `AC3: film ${m.tmdb_id} has no owner, so its chip must say No agent`);
      }
    });
  });
  assert.ok(checked > 0, "setup: the sweep above must actually have examined at least one film");
})));

test("CAS-1239 AC5: a pin wins over a higher-ranked matching agent for the lane, the chip, Watch On placement and Alerts — and switching the pinned owner off hides the film from every agent", () => withState(() => withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
  const h = broadCascade("cas1239-ac5-h", 0);   // higher-ranked, would otherwise win, follows only Rent
  h.watchMarkers = { in_cinema: null, premium: null, rent: 0, stream: null };
  const p = broadCascade("cas1239-ac5-p", 1);   // pinned, below its own bar, follows only Stream
  p.watchMarkers = { in_cinema: null, premium: null, rent: null, stream: 1000 };
  E.cascades.push(h, p);
  const film = pickStreamingFilm();
  const id = film.tmdb_id;
  assert.equal(E.listedBy(film, h), true, "setup: h would otherwise list/admit the film");
  E.entryFor(id).pinnedTo = [p.id];

  const owner = E.filmOwnerCascade(film);
  assert.equal(owner.id, p.id, "AC5: the pin must win the lane, whatever h's rank or criteria say");
  const chip = E.agentChipHTML(id);
  assert.ok(chip.includes(p.name), "AC5: the chip must name the pinned agent, not h");

  E.recomputeFound();
  assert.deepEqual([...E.notify[id].cascadeIds], [p.id], "AC5: membership itself must also be exactly the pin");
  assert.equal(E.notify[id].wins.stream, true, "AC5: Watch On placement must follow the pinned agent's own (Stream) window");
  assert.equal(E.notify[id].wins.rent, false, "AC5: Watch On placement must not follow h's (Rent) window");

  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: id, moment: "new_to_agent", title: film.title,
    cascade_name: h.name, emailed_at: new Date().toISOString(), read_at: null });
  E.localStorage.setItem("cascade_had_account", "1");
  E.setMovingReady(true);
  const { rows } = E.movingData();
  const row = rows.find(r => r.filmId === String(id));
  assert.ok(row, "AC5: the alert must still produce a Moving row");
  assert.equal(row.agentId, p.id, "AC5: Alerts attribution must name the pinned agent, not the ledger's own (h)");

  E.setWatchTab("stream");
  assert.ok(E.watchScopeRows().some(m => m.tmdb_id === id), "setup: the film must stand on Stream before the pinned owner is switched off");
  E.toggleWatchAgent(p.id);
  const STAGES = [
    { tab: "in_cinema", cinemaStage: "upcoming" }, { tab: "in_cinema", cinemaStage: "in_cinema" },
    { tab: "rent", cinemaStage: null }, { tab: "stream", cinemaStage: null },
  ];
  STAGES.forEach(({ tab, cinemaStage }) => {
    E.setWatchTab(tab);
    if (cinemaStage) E.setWatchCinemaStage(cinemaStage);
    assert.ok(!E.watchScopeRows().some(m => m.tmdb_id === id),
      `AC5: with the pinned owner off, the film must not show on ${tab}${cinemaStage ? "/" + cinemaStage : ""} even though h still lists it`);
  });
  E.toggleWatchAgent(p.id);
})));
