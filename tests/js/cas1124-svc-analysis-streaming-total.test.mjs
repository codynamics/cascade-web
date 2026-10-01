// CAS-1124: Service analysis becomes a STREAMING service analysis — the headline population is filmSvc
// (films with at least one sub/free offer), not svcAdviceFilms()'s full population, which also carries
// films no streaming service can ever cover (in cinemas, unreleased, rent/buy-only). These drive the real
// shipped engine (tests/js/engine.mjs) against cloned, currently-matching catalogue films whose offers are
// overridden — the same donor-clone technique tests/js/agents.test.mjs's withUnscoredMatch already uses —
// so this exercises the real listedBy/matchesCriteria gate rather than a hand-built fixture.
//
// Isolation from the rest of the live catalogue: a broad, floor-0 agent otherwise matches thousands of real
// films, which would swamp any fixed expected total. Every stub film here is pinned to a release year
// (2999) no real catalogue film carries, and the test cascade's own `year` filter is narrowed to exactly
// that year right before serviceAdvice() runs — so only this test's own clones are ever in scope.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
const FUTURE_YEAR = "2999";
const FUTURE_DATE = "2999-06-15";
const PRE_CINEMA = ["upcoming", "in_cinema", "opening_week"];

function withState(fn){
  const savedCascades = [...E.cascades];
  const savedWatched = new Set(E.watched), savedBlocked = new Set(E.blocked);
  const savedSub = new Set(E.prefs.sub);
  try{ fn(); }
  finally{
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.watched.clear(); savedWatched.forEach(id => E.watched.add(id));
    E.blocked.clear(); savedBlocked.forEach(id => E.blocked.add(id));
    E.prefs.sub.clear(); savedSub.forEach(s => E.prefs.sub.add(s));
  }
}

// A broad, unpaused agent with every window at a floor of 0 — matches whatever clears taste/genre/age/year,
// the same broadCascade shape tests/js/agents.test.mjs and tests/js/watch-follow.test.mjs already use.
function broadCascade(id){
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 0, premium: null, rent: 0, stream: 0 } });
  c.id = id; c.paused = false; c.order = 0;
  return c;
}

let cloneSeq = 0;
// Clones a real, currently-matching, non-estimated catalogue film and overrides only its offers and release
// year — the clone still has to clear the real showable/passesTasteBase/matchesCriteria gate svcAdviceFilms
// calls through listedBy, so this is the real population logic, not a re-implementation of it.
// `preCinema` picks a donor already in cinema/upcoming (showable with zero offers via isUpcoming/
// inCinemaConfirmed) rather than the default "already past cinema" donor hasConfirmedOffer needs.
function stubFilm(c, offers, preCinema){
  const donor = E.MOVIES.find(m =>
    m.availability_confidence !== "estimated" &&
    (preCinema ? PRE_CINEMA.includes(E.primaryStatus(m)) : !PRE_CINEMA.includes(E.primaryStatus(m))) &&
    E.matchesCriteria(m, c));
  if(!donor) throw new Error("no film in the harness catalogue matches this agent — this test would prove nothing");
  cloneSeq++;
  const clone = { ...donor, tmdb_id: -920000000 - cloneSeq, offers, cinema_date: FUTURE_DATE, year: FUTURE_YEAR };
  E.MOVIES.push(clone);
  return clone;
}
// Narrows the cascade to exactly the stub films' pinned year, then refreshes the catalogue-derived caches —
// called once per test, after every stub film for that test has been created.
function isolateToStubs(c){
  c.year = [FUTURE_YEAR];
  E.invalidateComputeCaches();
}
function cleanupFilms(films){
  films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); });
  E.invalidateComputeCaches();
}

test("CAS-1124 AC1: total/coveredTotal/notCovered/coveredPct count only streaming-reachable films, worth lists the lacked service", () => withState(() => {
  const c = broadCascade("cas1124-ac1");
  E.cascades.push(c);
  E.prefs.sub.clear(); E.prefs.sub.add("Havestream");

  // A: sub on a service the user has. B: sub on a service the user lacks. C: rent-only. D: no offers.
  const filmA = stubFilm(c, [{ type: "sub", service: "Havestream" }]);
  const filmB = stubFilm(c, [{ type: "sub", service: "Lackstream" }]);
  const filmC = stubFilm(c, [{ type: "rent", service: "Rentstore" }]);
  const filmD = stubFilm(c, [], true);
  isolateToStubs(c);

  try{
    const a = E.serviceAdvice();
    assert.equal(a.total, 2, "total must count only A and B — C (rent-only) and D (no offers) are never streaming-reachable");
    assert.equal(a.coveredTotal, 1);
    assert.equal(a.notCovered, 1);
    assert.equal(a.coveredPct, 50);
    const lack = a.worth.find(w => w.svc === "Lackstream");
    assert.ok(lack, `expected "Lackstream" in worth: ${JSON.stringify(a.worth)}`);
    assert.equal(lack.marginal, 1);
  } finally{
    cleanupFilms([filmA, filmB, filmC, filmD]);
  }
}));

test("CAS-1124 AC2: notCovered never exceeds the union of worth services' marginal films, and adding every worth service clears it to 0", () => withState(() => {
  const c = broadCascade("cas1124-ac2");
  E.cascades.push(c);
  E.prefs.sub.clear(); E.prefs.sub.add("Havestream");

  const filmA = stubFilm(c, [{ type: "sub", service: "Havestream" }]);
  const filmB = stubFilm(c, [{ type: "sub", service: "Lackstream" }]);
  const filmE = stubFilm(c, [{ type: "sub", service: "Otherlack" }]);
  isolateToStubs(c);

  try{
    const before = E.serviceAdvice();
    assert.equal(before.total, 3);
    assert.equal(before.notCovered, 2, "B and E are both uncovered");
    const marginalUnion = new Set();
    before.worth.forEach(w => { if(w.svc === "Lackstream") marginalUnion.add("B"); if(w.svc === "Otherlack") marginalUnion.add("E"); });
    assert.ok(before.notCovered <= marginalUnion.size,
      `notCovered (${before.notCovered}) must never exceed the union of worth services' marginal films (${marginalUnion.size})`);

    before.worth.forEach(w => E.prefs.sub.add(w.svc));
    const after = E.serviceAdvice();
    assert.equal(after.notCovered, 0, "adding every worth service must close the gap to 0, not leave it structurally unreachable");
    assert.equal(after.coveredTotal, after.total);
  } finally{
    cleanupFilms([filmA, filmB, filmE]);
  }
}));

test("CAS-1124 AC4 population: a zero streaming total is distinguishable from a zero svcAdviceFilms population", () => withState(() => {
  const c = broadCascade("cas1124-ac4");
  E.cascades.push(c);
  E.prefs.sub.clear();

  // Only rent/buy and no-offer (pre-cinema) films in the population — none of it is streaming-reachable, but
  // the underlying agent population (popTotal) is not empty.
  const filmC = stubFilm(c, [{ type: "rent", service: "Rentstore" }]);
  const filmD = stubFilm(c, [], true);
  isolateToStubs(c);

  try{
    const a = E.serviceAdvice();
    assert.ok(a.popTotal > 0, "the agent population itself must not read empty");
    assert.equal(a.total, 0, "none of the population is on a streaming service");
    assert.equal(a.coveredPct, 0);
    assert.equal(a.notCovered, 0, "notCovered is total - coveredTotal, both 0, not a false 100% gap");
  } finally{
    cleanupFilms([filmC, filmD]);
  }
}));
