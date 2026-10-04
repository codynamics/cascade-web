// CAS-829: Moving used to attribute each row to every agent whose ledger entry ever named it
// (`agentNames`, built from `a.cascade_name`) — a list, not the single-owner answer the app's core rule
// promises and the card right below the row already resolves through filmOwnerCascade(). This drives
// movingData() directly against seeded notify/cascades/realAlerts/firstFound state (the same shape
// tests/js/invariants.test.mjs's CAS-667/670/671 Moving checks already use) to assert the row-selection
// arithmetic now goes through filmOwnerCascade() exclusively, in both branches.
// CAS-848: movingData() rows no longer carried a resolved agentName, and a row whose owner didn't resolve
// rendered in a final untinted "Other" lane (movingLanes()) instead of being dropped.
// CAS-858: that "Other" lane was wrong — Lee's decision is that a row which cannot name an agent is not a
// row. movingData() drops it again (as CAS-829 originally did), and movingLanes() no longer has an
// "Other" branch at all. The tests below were updated back to the CAS-829 "no owner, no row" shape, plus
// new coverage for the restored MOVING_EMPTY_NO_OWNER_COPY empty state and the unseen badge.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withState(fn){
  const savedNotify = { ...E.notify };
  const savedCascades = [...E.cascades];
  const savedRealAlerts = [...E.realAlerts];
  const savedFirstFound = { ...E.firstFound };
  const savedWatched = new Set(E.watched);
  const savedHadAccount = E.localStorage.getItem("cascade_had_account");
  // CAS-1028: these tests pick donor films out of the live catalogue by window/service/estimate, never by
  // language, so a fixture built from a non-English pick can fail listedBy() on the account's default
  // English-only taste base for a reason that has nothing to do with what the test is actually exercising.
  // Opened for the test's duration, same restore-in-finally shape as every other saved global here.
  const savedLangs = E.tasteBase.langs;
  E.tasteBase.langs = [];
  try{ fn(); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.realAlerts.length = 0; E.realAlerts.push(...savedRealAlerts);
    Object.keys(E.firstFound).forEach(k => delete E.firstFound[k]);
    Object.assign(E.firstFound, savedFirstFound);
    E.watched.clear(); savedWatched.forEach(id => E.watched.add(id));
    if(savedHadAccount === null) E.localStorage.removeItem("cascade_had_account");
    else E.localStorage.setItem("cascade_had_account", savedHadAccount);
    E.tasteBase.langs = savedLangs;
    E.setMovingReady(true);
  }
}
function ownerCascade(id, order, name){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = order; c.name = name;
  return c;
}
function pickFilms(n){
  return E.MOVIES.filter(m => !E.watched.has(m.tmdb_id)).slice(0, n);
}

test("CAS-829 AC2(a): every row movingData() returns names exactly one agent, from the film's owner", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas829-a-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const [film] = pickFilms(1);
  E.notify[film.tmdb_id] = { cascadeIds: [owner.id] };
  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
    cascade_name: "Some Other Name", emailed_at: new Date().toISOString(), read_at: null });
  E.setMovingReady(true);

  const { rows } = E.movingData();
  const row = rows.find(r => r.filmId === String(film.tmdb_id));
  assert.ok(row, "AC2(a): a row must exist for the owned film");
  assert.equal(row.agentId, owner.id, "AC2(a): the row must carry the owner's id");

  const lane = E.movingLanes(rows).find(l => l.cascade && l.cascade.id === owner.id);
  assert.ok(lane, "AC2(a): the owner's lane must exist");
  assert.equal(lane.cascade.name, owner.name, "AC2(a): the lane must resolve to the owner's current name");
}));

test("CAS-858 AC1: a realAlerts entry for a film with empty cascadeIds produces no row", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const [film] = pickFilms(1);
  E.notify[film.tmdb_id] = { cascadeIds: [] };
  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
    cascade_name: "Some Agent", emailed_at: new Date().toISOString(), read_at: null });
  E.setMovingReady(true);

  const { rows, dropped } = E.movingData();
  const row = rows.find(r => r.filmId === String(film.tmdb_id));
  assert.ok(!row, "AC1: an unowned film (filmOwnerCascade returns null) must produce no row");
  assert.equal(dropped.length, 1, "AC1: the ownerless entry must still be tracked as dropped");

  const lanes = E.movingLanes(rows);
  assert.ok(!lanes.some(l => !l.cascade), "AC1: there must be no fallback Other lane any more");
}));

test("CAS-829 AC2(c): a ledger entry naming a non-owner agent still produces a row naming the OWNER", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas829-c-owner", 0, "Owner Agent");
  const other = ownerCascade("cas829-c-other", 5, "Other Agent");
  E.cascades.push(owner, other);
  const [film] = pickFilms(1);
  E.notify[film.tmdb_id] = { cascadeIds: [owner.id] };   // owner.order (0) beats other.order (5)
  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
    cascade_name: other.name, emailed_at: new Date().toISOString(), read_at: null });
  E.setMovingReady(true);

  const { rows } = E.movingData();
  const row = rows.find(r => r.filmId === String(film.tmdb_id));
  assert.ok(row, "AC2(c): a row must exist");
  assert.equal(row.agentId, owner.id, "AC2(c): the row must name the owner, not the ledger's own agent name");
  assert.notEqual(row.agentId, other.id, "AC2(c): the row must not name the ledger's own agent");
}));

test("CAS-829 AC2(d): the guest branch emits at most one agent per row", () => withState(() => {
  E.localStorage.removeItem("cascade_had_account");   // no cascade_had_account -> guest device
  const owner = ownerCascade("cas829-d-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const [ownedFilm, unownedFilm] = pickFilms(2);
  E.notify[ownedFilm.tmdb_id] = { cascadeIds: [owner.id] };
  E.notify[unownedFilm.tmdb_id] = { cascadeIds: [] };
  E.firstFound[String(ownedFilm.tmdb_id)] = new Date().toISOString();
  E.firstFound[String(unownedFilm.tmdb_id)] = new Date().toISOString();

  const { rows } = E.movingData();
  const ownedRow = rows.find(r => r.filmId === String(ownedFilm.tmdb_id));
  assert.ok(ownedRow, "AC2(d): the owned film must still get a row on a guest device");
  assert.equal(ownedRow.agentId, owner.id, "AC2(d): the guest row must name the owner");

  // CAS-858: an unowned film on a guest device is dropped, same as the signed-in branch.
  const unownedRow = rows.find(r => r.filmId === String(unownedFilm.tmdb_id));
  assert.ok(!unownedRow, "CAS-858: an unowned film must produce no row on a guest device either");
}));

test("CAS-848 AC1: two agents of rank 1 and 2 each owning one row produce two lanes, rank 1 first", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const rank1 = ownerCascade("cas848-ac1-r1", 0, "Rank One Agent");
  const rank2 = ownerCascade("cas848-ac1-r2", 1, "Rank Two Agent");
  E.cascades.push(rank1, rank2);
  const [filmA, filmB] = pickFilms(2);
  E.notify[filmA.tmdb_id] = { cascadeIds: [rank2.id] };
  E.notify[filmB.tmdb_id] = { cascadeIds: [rank1.id] };
  E.realAlerts.length = 0;
  E.realAlerts.push(
    { id: 1, movie_id: filmA.tmdb_id, moment: "new_to_agent", title: filmA.title,
      cascade_name: rank2.name, emailed_at: new Date().toISOString(), read_at: null },
    { id: 2, movie_id: filmB.tmdb_id, moment: "new_to_agent", title: filmB.title,
      cascade_name: rank1.name, emailed_at: new Date().toISOString(), read_at: null },
  );
  E.setMovingReady(true);

  const { rows } = E.movingData();
  const lanes = E.movingLanes(rows).filter(l => l.cascade);
  assert.equal(lanes.length, 2, "AC1: two owning agents must produce two named lanes");
  assert.equal(lanes[0].cascade.id, rank1.id, "AC1: rank 1's lane must come first");
  assert.equal(lanes[1].cascade.id, rank2.id, "AC1: rank 2's lane must come second");
  assert.equal(lanes[0].rows.length, 1, "AC1: rank 1's lane must carry its one row");
  assert.equal(lanes[1].rows.length, 1, "AC1: rank 2's lane must carry its one row");
}));

test("CAS-848 AC2: new_to_agent renders the New tag, hits_stream renders the Changed tag", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas848-ac2-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const [filmNew, filmChanged] = pickFilms(2);
  E.notify[filmNew.tmdb_id] = { cascadeIds: [owner.id] };
  E.notify[filmChanged.tmdb_id] = { cascadeIds: [owner.id] };
  E.realAlerts.length = 0;
  E.realAlerts.push(
    { id: 1, movie_id: filmNew.tmdb_id, moment: "new_to_agent", title: filmNew.title,
      cascade_name: owner.name, emailed_at: new Date().toISOString(), read_at: null },
    { id: 2, movie_id: filmChanged.tmdb_id, moment: "hits_stream", title: filmChanged.title,
      cascade_name: owner.name, emailed_at: new Date().toISOString(), read_at: null },
  );
  E.setMovingReady(true);

  const { rows } = E.movingData();
  const newRow = rows.find(r => r.filmId === String(filmNew.tmdb_id));
  const changedRow = rows.find(r => r.filmId === String(filmChanged.tmdb_id));
  assert.equal(newRow.tag, "new", "AC2: new_to_agent must be tagged New");
  assert.equal(changedRow.tag, "changed", "AC2: hits_stream must be tagged Changed");
}));

// CAS-852: replaces CAS-848's own "rows inside one lane are ordered newest first" test — a lane now reads
// down the availability ladder first, newest-first only as the tiebreak within one window. older/newer here
// are picked from the SAME primaryStatus bucket, so the window-rank term is a no-op and this exercises the
// tiebreak in isolation; CAS-852 AC1 below covers the cross-window ordering itself.
function pickSameWindow(E, n){
  const byStatus = new Map();
  E.MOVIES.forEach(m => {
    if(E.watched.has(m.tmdb_id)) return;
    const ps = E.primaryStatus(m);
    if(!byStatus.has(ps)) byStatus.set(ps, []);
    byStatus.get(ps).push(m);
  });
  for(const list of byStatus.values()) if(list.length >= n) return list.slice(0, n);
  throw new Error(`no primaryStatus bucket has ${n} unwatched films`);
}
// CAS-861: movingData() now routes every row through listedBy (filmOwnerShown), which — like the real Watch
// listing — applies listWindowOK's CAS-481 clause and denies an ESTIMATED "upcoming" film regardless of
// ownership. Skip one here so this picker keeps choosing a film the listing would actually show, the same
// screen invariants.test.mjs's pickPinnableFilm already applies for the same reason.
function pickOneEach(E, statuses){
  const found = {};
  for(const m of E.MOVIES){
    if(E.watched.has(m.tmdb_id)) continue;
    const ps = E.primaryStatus(m);
    if(ps==="upcoming" && E.isEstimated(m)) continue;
    if(statuses.includes(ps) && !found[ps]) found[ps] = m;
    if(Object.keys(found).length === statuses.length) break;
  }
  return statuses.map(s => found[s]);
}

test("CAS-852 AC2: rows inside one lane, same window, are ordered newest first", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas852-ac2-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const [older, newer] = pickSameWindow(E, 2);
  E.notify[older.tmdb_id] = { cascadeIds: [owner.id] };
  E.notify[newer.tmdb_id] = { cascadeIds: [owner.id] };
  E.realAlerts.length = 0;
  const now = Date.now();
  E.realAlerts.push(
    { id: 1, movie_id: older.tmdb_id, moment: "new_to_agent", title: older.title,
      cascade_name: owner.name, emailed_at: new Date(now - 5 * 864e5).toISOString(), read_at: null },
    { id: 2, movie_id: newer.tmdb_id, moment: "new_to_agent", title: newer.title,
      cascade_name: owner.name, emailed_at: new Date(now - 1 * 864e5).toISOString(), read_at: null },
  );
  E.setMovingReady(true);

  const { rows } = E.movingData();
  const lane = E.movingLanes(rows).find(l => l.cascade && l.cascade.id === owner.id);
  // CAS-848: lane.rows is built inside the sandboxed engine — spread it into a literal first so .map()'s
  // result is a plain array, comparable to the literal on the right (see the CAS-667 AC2 test for why).
  assert.deepEqual([...lane.rows].map(r => r.filmId), [String(newer.tmdb_id), String(older.tmdb_id)],
    "AC2: two rows in the same window must be ordered newest first");
}));

test("CAS-852 AC1: a lane with one stream, one in-cinema and one upcoming film emits upcoming, in cinema, stream", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas852-ac1-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const [streamFilm, cinemaFilm, upcomingFilm] = pickOneEach(E, ["included_streaming", "in_cinema", "upcoming"]);
  assert.ok(streamFilm && cinemaFilm && upcomingFilm, "sanity: fixture must carry a film in each of the three windows");
  [streamFilm, cinemaFilm, upcomingFilm].forEach(m => { E.notify[m.tmdb_id] = { cascadeIds: [owner.id] }; });
  E.realAlerts.length = 0;
  const now = Date.now();
  // All emitted at the same moment — if the sort fell back to newest-first alone, insertion order (stream,
  // cinema, upcoming) would survive unchanged, so this also proves window rank is what's actually deciding.
  E.realAlerts.push(
    { id: 1, movie_id: streamFilm.tmdb_id, moment: "hits_stream", title: streamFilm.title,
      cascade_name: owner.name, emailed_at: new Date(now).toISOString(), read_at: null },
    { id: 2, movie_id: cinemaFilm.tmdb_id, moment: "hits_cinema", title: cinemaFilm.title,
      cascade_name: owner.name, emailed_at: new Date(now).toISOString(), read_at: null },
    { id: 3, movie_id: upcomingFilm.tmdb_id, moment: "announced", title: upcomingFilm.title,
      cascade_name: owner.name, emailed_at: new Date(now).toISOString(), read_at: null },
  );
  E.setMovingReady(true);

  const { rows } = E.movingData();
  const lane = E.movingLanes(rows).find(l => l.cascade && l.cascade.id === owner.id);
  assert.deepEqual([...lane.rows].map(r => r.filmId),
    [String(upcomingFilm.tmdb_id), String(cinemaFilm.tmdb_id), String(streamFilm.tmdb_id)],
    "AC1: the lane must emit upcoming, in cinema, stream, in that order");
}));

test("CAS-852 AC3: movingLedgerTruncated reads false under the 200-row cap and true at it", () => withState(() => {
  E.realAlerts.length = 0;
  const now = Date.now();
  for(let i = 0; i < 199; i++){
    E.realAlerts.push({ id: i, movie_id: 9990000 + i, moment: "new_to_agent", title: "x",
      cascade_name: "x", emailed_at: new Date(now - i * 3600e3).toISOString(), read_at: null });
  }
  assert.equal(E.movingLedgerTruncated("2weeks"), false,
    "AC3: below the 200-row cap, the truncation notice's predicate must read false");

  E.realAlerts.push({ id: 199, movie_id: 9990199, moment: "new_to_agent", title: "x",
    cascade_name: "x", emailed_at: new Date(now).toISOString(), read_at: null });
  assert.equal(E.realAlerts.length, 200, "sanity: exactly 200 seeded");
  assert.equal(E.movingLedgerTruncated("2weeks"), true,
    "AC3: at the 200-row cap, the truncation notice's predicate must read true");
}));

test("CAS-858 AC2: a window whose entries are ALL ownerless renders MOVING_EMPTY_NO_OWNER_COPY", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const [film] = pickFilms(1);
  E.notify[film.tmdb_id] = { cascadeIds: [] };
  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
    cascade_name: "Some Agent", emailed_at: new Date().toISOString(), read_at: null });
  E.setMovingReady(true);

  assert.equal(E.movingEmptyCopy("2weeks"), E.MOVING_EMPTY_NO_OWNER_COPY,
    "AC2: a window whose only entries were dropped for having no owner must get the no-owner empty copy, not the generic one");
}));

test("CAS-858 AC2(b): a window with no ledger entries at all still gets the generic empty copy", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  E.realAlerts.length = 0;
  E.setMovingReady(true);

  assert.equal(E.movingEmptyCopy("2weeks"), E.MOVING_EMPTY_COPY["2weeks"],
    "AC2(b): genuinely nothing having moved must still read the generic empty copy");
}));

// ---- CAS-861: membership may ignore the my-services gate (CAS-132/381); Moving may not (Lee, 2026-09-08) --
function withServicesOn(subs, run){
  const sub = new Set(E.prefs.sub), on = E.prefs.on;
  E.prefs.sub.clear(); subs.forEach(s => E.prefs.sub.add(s));
  E.prefs.on = true;
  try { return run(); }
  finally { E.prefs.sub.clear(); sub.forEach(s => E.prefs.sub.add(s)); E.prefs.on = on; }
}
// A confirmed, unwatched, subscription-window real film cloned onto a fake id and re-offered on Foxtel only
// — a service neither CAS-861's account nor this fixture's prefs.sub ever carries.
function foxtelOnlyFilm(){
  const source = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && E.primaryStatus(m) === "included_streaming"
    && !E.isEstimated(m) && (m.offers || []).some(o => o.type === "sub"));
  assert.ok(source, "no confirmed unwatched subscription-window film found — this test would prove nothing");
  return { ...source, tmdb_id: 8610001, title: "CAS-861 Foxtel Fixture",
    offers: [{ type: "sub", service: "Foxtel Now", price: null }] };
}
function netflixFilm(){
  const source = E.MOVIES.find(m => !E.watched.has(m.tmdb_id) && E.primaryStatus(m) === "included_streaming"
    && !E.isEstimated(m) && (m.offers || []).some(o => o.type === "sub"));
  assert.ok(source, "no confirmed unwatched subscription-window film found — this test would prove nothing");
  return { ...source, tmdb_id: 8610002, title: "CAS-861 Netflix Fixture",
    offers: [{ type: "sub", service: "Netflix", price: null }] };
}
function withExtraFilm(film, run){
  E.MOVIES.push(film);
  try { return run(); } finally { E.MOVIES.pop(); }
}

test("CAS-861 AC1: services-only ON, Foxtel not subscribed, a HELD film produces no Moving row", () => withState(() => withServicesOn([], () => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas861-ac1-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const film = foxtelOnlyFilm();
  withExtraFilm(film, () => {
    E.notify[film.tmdb_id] = { cascadeIds: [owner.id] };
    E.realAlerts.length = 0;
    E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
      cascade_name: owner.name, emailed_at: new Date().toISOString(), read_at: null });
    E.setMovingReady(true);

    const { rows } = E.movingData();
    const row = rows.find(r => r.filmId === String(film.tmdb_id));
    assert.ok(!row, "AC1: a film the listing excludes on services must produce no Moving row");
  });
})));

test("CAS-861 AC2: the same film stays HELD — cascadeIds is untouched by the Moving drop", () => withState(() => withServicesOn([], () => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas861-ac2-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const film = foxtelOnlyFilm();
  withExtraFilm(film, () => {
    E.notify[film.tmdb_id] = { cascadeIds: [owner.id] };
    E.realAlerts.length = 0;
    E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
      cascade_name: owner.name, emailed_at: new Date().toISOString(), read_at: null });
    E.setMovingReady(true);

    E.movingData();
    assert.ok(E.notify[film.tmdb_id].cascadeIds.length > 0,
      "AC2: dropping the Moving row must not clear the film's held membership");
    assert.deepEqual(E.notify[film.tmdb_id].cascadeIds, [owner.id],
      "AC2: cascadeIds must be exactly what it was before movingData() ran");
  });
})));

test("CAS-861 AC3: turning the account services switch off makes the row appear again", () => withState(() => withServicesOn([], () => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas861-ac3-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const film = foxtelOnlyFilm();
  withExtraFilm(film, () => {
    E.notify[film.tmdb_id] = { cascadeIds: [owner.id] };
    E.realAlerts.length = 0;
    E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
      cascade_name: owner.name, emailed_at: new Date().toISOString(), read_at: null });
    E.setMovingReady(true);

    assert.ok(!E.movingData().rows.find(r => r.filmId === String(film.tmdb_id)),
      "sanity: the switch on must still drop the row");
    E.prefs.on = false;
    const row = E.movingData().rows.find(r => r.filmId === String(film.tmdb_id));
    assert.ok(row, "AC3: switching the account services filter off must bring the row back");
    assert.equal(row.agentId, owner.id, "AC3: the restored row must still name the owner");
  });
})));

test("CAS-861 AC4: a film on a service the account DOES have is unaffected", () => withState(() => withServicesOn(["Netflix"], () => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas861-ac4-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const film = netflixFilm();
  withExtraFilm(film, () => {
    E.notify[film.tmdb_id] = { cascadeIds: [owner.id] };
    E.realAlerts.length = 0;
    E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
      cascade_name: owner.name, emailed_at: new Date().toISOString(), read_at: null });
    E.setMovingReady(true);

    const row = E.movingData().rows.find(r => r.filmId === String(film.tmdb_id));
    assert.ok(row, "AC4: a film on a service the account has must still get a Moving row");
    assert.equal(row.agentId, owner.id, "AC4: the row must name the owner");
  });
})));

test("CAS-861: the card's agent chip also cannot claim an owner for a film the listing excludes on services", () => withState(() => withServicesOn([], () => {
  const owner = ownerCascade("cas861-chip-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const film = foxtelOnlyFilm();
  withExtraFilm(film, () => {
    E.notify[film.tmdb_id] = { cascadeIds: [owner.id] };
    const chip = E.agentChipHTML(film.tmdb_id);
    assert.doesNotMatch(chip, new RegExp(owner.name), "the chip must not name an owner the listing would exclude");
    assert.ok(chip.includes("No agent"), "the chip must fall back to No agent");
  });
})));

test("CAS-858 AC3: the unseen badge count excludes ownerless entries", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas858-ac3-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const [ownedFilm, unownedFilm] = pickFilms(2);
  E.notify[ownedFilm.tmdb_id] = { cascadeIds: [owner.id] };
  E.notify[unownedFilm.tmdb_id] = { cascadeIds: [] };
  E.realAlerts.length = 0;
  E.realAlerts.push(
    { id: 1, movie_id: ownedFilm.tmdb_id, moment: "new_to_agent", title: ownedFilm.title,
      cascade_name: owner.name, emailed_at: new Date().toISOString(), read_at: null },
    { id: 2, movie_id: unownedFilm.tmdb_id, moment: "new_to_agent", title: unownedFilm.title,
      cascade_name: "Some Agent", emailed_at: new Date().toISOString(), read_at: null },
  );
  E.setMovingReady(true);

  // movingBadgeWindow() predicts "today" while Moving is closed (movingIsOpen is false by default here).
  assert.equal(E.movingUnseenCount(), 1,
    "AC3: the badge must count only the one owned, un-seen row — the ownerless entry must not contribute");
}));

// CAS-869: Moving groups by status (movingSections) then agent (movingLanes, unchanged). These drive
// movingSections directly against synthetic rows/films — the row-selection arithmetic (movingData, who
// owns what) is already covered above; this is only about how a given row set is sectioned and ordered.
function fakeFilm(id, status){
  return { tmdb_id: id, title: `Film ${id}`, status: [status] };
}
function fakeRow(m, agentId){
  return { filmId: String(m.tmdb_id), m, tag: "new", reason: "test", agentId, date: new Date().toISOString() };
}

test("CAS-869 AC1: movingSections orders by LISTING_ORDER (not row-arrival order), lanes in agent rank order", () => withState(() => {
  const lo = ownerCascade("cas869-a-lo", 0, "Low Rank");
  const hi = ownerCascade("cas869-a-hi", 5, "High Rank");
  E.cascades.push(lo, hi);
  const streamFilm = fakeFilm(900001, "included_streaming");
  const upcomingFilm = fakeFilm(900002, "upcoming");
  const rows = [
    fakeRow(streamFilm, hi.id),   // inserted first, but "included_streaming" sorts LAST in LISTING_ORDER
    fakeRow(upcomingFilm, hi.id),
    fakeRow(upcomingFilm, lo.id),
  ];
  const sections = E.movingSections(rows);
  // Compared index-by-index rather than via deepEqual on the whole array: `sections` is built inside the
  // sandboxed engine (see engine.mjs), so it (and anything .map()'d straight off it) is a cross-realm Array
  // — deepEqual's prototype check flags that as "not reference-equal" even when every element matches.
  assert.equal(sections.length, 2, "AC1: exactly two sections, one per status actually present");
  assert.equal(sections[0].g, "upcoming", "AC1: sections must follow LISTING_ORDER, never the order rows arrived in");
  assert.equal(sections[1].g, "included_streaming", "AC1: included_streaming must sort after upcoming");
  const upcoming = sections[0];
  assert.equal(upcoming.lanes.length, 2, "AC1: both agents' lanes must appear under upcoming");
  assert.equal(upcoming.lanes[0].cascade.id, lo.id, "AC1: rank 0 (lo) must lead");
  assert.equal(upcoming.lanes[1].cascade.id, hi.id, "AC1: rank 5 (hi) must follow");
}));

test("CAS-869 AC2: every row appears exactly once across sections, and the total matches the rows shown", () => withState(() => {
  const a = ownerCascade("cas869-b-a", 0, "Agent A");
  E.cascades.push(a);
  const films = [fakeFilm(900011, "upcoming"), fakeFilm(900012, "in_cinema"), fakeFilm(900013, "rental")];
  const rows = films.map(m => fakeRow(m, a.id));
  const sections = E.movingSections(rows);
  const seenIds = sections.flatMap(s => s.lanes.flatMap(l => l.rows.map(r => r.filmId)));
  assert.equal(seenIds.length, rows.length, "AC2: the total across all sections must equal the rows shown");
  assert.deepEqual(new Set(seenIds), new Set(rows.map(r => r.filmId)), "AC2: every row must appear, and only once");
}));

test("CAS-869 AC3: a status with no rows renders no section, and no lane is ever empty", () => withState(() => {
  const a = ownerCascade("cas869-c-a", 0, "Agent A");
  E.cascades.push(a);
  const rows = [fakeRow(fakeFilm(900021, "pvod"), a.id)];
  const sections = E.movingSections(rows);
  assert.equal(sections.length, 1, "AC3: only the status with rows renders a section");
  assert.equal(sections[0].g, "pvod", "AC3: the one section rendered must be pvod");
  assert.ok(sections.every(s => s.lanes.every(l => l.rows.length > 0)), "AC3: no section may hold an empty agent lane");
}));
