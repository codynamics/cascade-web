// CAS-1407: Releases becomes "All Latest" — its window is its own How far back filter, not a fixed 365 days.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function monthsAgo(n){
  const d = new Date(); d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}
const film = { tmdb_id:91407001, title:"CAS-1407 fixture", cinema_release:true, cinema_date:monthsAgo(18), _fixture:true };

test("18-month-old cinema release: out at 1 yr, in at 2 yrs and Any", () => {
  assert.equal(E.oamFilmInReleasesWindow(film, { years:1 }), false);
  assert.equal(E.oamFilmInReleasesWindow(film, { years:2 }), true);
  assert.equal(E.oamFilmInReleasesWindow(film, { years:0 }), true);
});

test("starter Releases mood is All Latest, 1 yr, watched on", () => {
  const m = E.oneAgentStarterMoods()[0];
  assert.equal(m.name, "All Latest");
  assert.equal(m.years, 1);
  assert.equal(m.watched, true);
});
