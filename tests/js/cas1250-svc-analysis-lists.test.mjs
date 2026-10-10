// CAS-1250: serviceAdvice()'s mine/worth entries gain onlyHereFilms/marginalFilms — the films behind each
// count, from the same filmSvc map the counts themselves come from, so the list and the number can never
// disagree. Built the same way CAS-1124's streaming-total tests are: real donor-clone films pinned to a
// future year no real catalogue film carries, isolated from the live catalogue via the cascade's own year
// filter, so serviceAdvice() runs its real listedBy/matchesCriteria gate rather than a hand-built fixture.
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

function broadCascade(id){
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 0, premium: null, rent: 0, stream: 0 } });
  c.id = id; c.paused = false; c.order = 0;
  return c;
}

let cloneSeq = 0;
function stubFilm(c, offers, title, preCinema){
  const donor = E.MOVIES.find(m =>
    m.availability_confidence !== "estimated" &&
    (preCinema ? PRE_CINEMA.includes(E.primaryStatus(m)) : !PRE_CINEMA.includes(E.primaryStatus(m))) &&
    E.matchesCriteria(m, c));
  if(!donor) throw new Error("no film in the harness catalogue matches this agent — this test would prove nothing");
  cloneSeq++;
  const clone = { ...donor, tmdb_id: -921000000 - cloneSeq, offers, title, cinema_date: FUTURE_DATE, year: FUTURE_YEAR };
  E.MOVIES.push(clone);
  return clone;
}
function isolateToStubs(c){
  c.year = [FUTURE_YEAR];
  E.invalidateComputeCaches();
}
function cleanupFilms(films){
  films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); });
  E.invalidateComputeCaches();
}

test("CAS-1250 AC1/AC2: onlyHereFilms matches onlyHere, each film carries exactly this one of the person's services, sorted by title", () => withState(() => {
  const c = broadCascade("cas1250-ac1-mine");
  E.cascades.push(c);
  E.prefs.sub.clear(); E.prefs.sub.add("Havestream"); E.prefs.sub.add("OtherHave");

  // A: only on Havestream (of the person's services) — onlyHere for Havestream.
  // B: on both Havestream and OtherHave the person has — onlyHere for neither.
  const filmA = stubFilm(c, [{ type: "sub", service: "Havestream" }], "Zebra Crossing");
  const filmB = stubFilm(c, [{ type: "sub", service: "Havestream" }, { type: "sub", service: "OtherHave" }], "Second Film");
  const filmA2 = stubFilm(c, [{ type: "sub", service: "Havestream" }], "Aardvark Rising");
  isolateToStubs(c);

  try{
    const a = E.serviceAdvice();
    const have = a.mine.find(x => x.svc === "Havestream");
    const other = a.mine.find(x => x.svc === "OtherHave");
    assert.ok(have, `expected a mine entry for Havestream: ${JSON.stringify(a.mine)}`);
    assert.ok(other, `expected a mine entry for OtherHave: ${JSON.stringify(a.mine)}`);

    assert.equal(have.onlyHereFilms.length, have.onlyHere);
    assert.equal(have.onlyHere, 2, "A and A2 are only on Havestream of the person's own services");
    have.onlyHereFilms.forEach(m => {
      const owned = [...a.mine].filter(e => E.prefs.sub.has(e.svc));
      const ownedBy = ["Havestream", "OtherHave"].filter(svc =>
        (m.offers || []).some(o => (o.type === "sub" || o.type === "free") && E.svcCanon(o.service) === svc));
      assert.deepEqual(ownedBy, ["Havestream"], `film ${m.title} must carry exactly Havestream among the person's own services`);
    });
    // AC2: sorted by title with localeCompare.
    for(let i = 1; i < have.onlyHereFilms.length; i++){
      assert.ok(have.onlyHereFilms[i-1].title.localeCompare(have.onlyHereFilms[i].title) <= 0,
        `onlyHereFilms must be sorted by title: ${have.onlyHereFilms.map(m=>m.title)}`);
    }
    assert.deepEqual([...have.onlyHereFilms.map(m => m.title)], ["Aardvark Rising", "Zebra Crossing"]);

    assert.equal(other.onlyHereFilms.length, other.onlyHere);
    assert.equal(other.onlyHere, 0, "B is also carried by Havestream, which the person also has");
  } finally{
    cleanupFilms([filmA, filmB, filmA2]);
  }
}));

test("CAS-1250 AC1/AC2: marginalFilms matches marginal, no film in it is carried by any of the person's services, sorted by title", () => withState(() => {
  const c = broadCascade("cas1250-ac1-worth");
  E.cascades.push(c);
  E.prefs.sub.clear(); E.prefs.sub.add("Havestream");

  // C: only on Lackstream, which the person lacks — marginal for Lackstream.
  // D: on Lackstream AND Havestream, which the person has — not marginal (already covered).
  const filmC = stubFilm(c, [{ type: "sub", service: "Lackstream" }], "Mango Street");
  const filmD = stubFilm(c, [{ type: "sub", service: "Lackstream" }, { type: "sub", service: "Havestream" }], "Other Film");
  const filmC2 = stubFilm(c, [{ type: "sub", service: "Lackstream" }], "Banana Republic");
  isolateToStubs(c);

  try{
    const a = E.serviceAdvice();
    const lack = a.worth.find(x => x.svc === "Lackstream");
    assert.ok(lack, `expected a worth entry for Lackstream: ${JSON.stringify(a.worth)}`);

    assert.equal(lack.marginalFilms.length, lack.marginal);
    assert.equal(lack.marginal, 2, "C and C2 are not carried by any service the person has; D is (Havestream)");
    lack.marginalFilms.forEach(m => {
      const carriedByMine = (m.offers || []).some(o =>
        (o.type === "sub" || o.type === "free") && E.prefs.sub.has(E.svcCanon(o.service)));
      assert.equal(carriedByMine, false, `film ${m.title} must not be carried by any of the person's own services`);
    });
    for(let i = 1; i < lack.marginalFilms.length; i++){
      assert.ok(lack.marginalFilms[i-1].title.localeCompare(lack.marginalFilms[i].title) <= 0,
        `marginalFilms must be sorted by title: ${lack.marginalFilms.map(m=>m.title)}`);
    }
    assert.deepEqual([...lack.marginalFilms.map(m => m.title)], ["Banana Republic", "Mango Street"]);
  } finally{
    cleanupFilms([filmC, filmD, filmC2]);
  }
}));
