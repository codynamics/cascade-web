// CAS-1145: agentMetricsCompute's perMonth divided an agent's one-off back-catalogue fill by however many
// days the agent had existed — on a brand-new agent every held film was first found on day one, so spanDays
// was 1 and the whole fill got extrapolated to a month (77 films -> ~2310/month). This pins the replacement
// rule: perMonth anchors on `born` (the agent's own creation day, or its oldest find when created_at is
// missing), excludes anything found on or before that day, and prints nothing for an agent under a week old.
//
// Fixture films are clones of a real catalogue film, stamped with a sentinel release year ("1899") no real
// title will ever carry, and matched by an agent whose own `year` chip is pinned to that same sentinel — so
// each case's counts are exact and immune to the catalogue's daily data refresh, rather than depending on
// however many real films happen to match a broad agent today.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
const YEAR_SENTINEL = "1899";

function daysBeforeToday(n){
  const d = new Date(Date.parse(E.TODAY));
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function broadCascade(id, overrides){
  const c = E.normCascade({ kind: "stream", status: [], ...overrides });
  c.id = id;
  return c;
}
// A real film, CONFIRMED (not estimated) with an actual offer and not upcoming — so showable()/matchesCriteria
// pass it on grounds that never read cinema_date, leaving the sentinel-year override (below) as the only thing
// that decides whether a clone matches this ticket's test agents.
function findDonorTemplate(){
  const scout = broadCascade("cas1145-scout");
  const donor = E.MOVIES.find(m => !E.taggedOut(m) && E.primaryStatus(m) !== "upcoming"
    && m.availability_confidence !== "estimated" && Array.isArray(m.offers) && m.offers.length > 0
    && E.listedBy(m, scout));
  if(!donor) throw new Error("no confirmed, non-upcoming film with a real offer in the harness catalogue — this test would prove nothing");
  return donor;
}
const donorTemplate = findDonorTemplate();
let cloneSeq = 0;
// Clones `count` copies of the donor under fresh synthetic ids pinned to the sentinel year, stamps firstFound
// for each to `daysAgo`, and returns their ids.
function plantFinds(count, daysAgo){
  const ids = [];
  for(let i = 0; i < count; i++){
    cloneSeq++;
    const id = -960000000 - cloneSeq;
    E.MOVIES.push({ ...donorTemplate, tmdb_id: id, cinema_date: "1899-01-15", year: YEAR_SENTINEL });
    E.firstFound[id] = daysBeforeToday(daysAgo);
    ids.push(id);
  }
  return ids;
}
function withCase(fn){
  const plantedIds = [];
  try{
    fn(plantedIds);
  } finally{
    plantedIds.forEach(id => {
      delete E.firstFound[id];
      const i = E.MOVIES.findIndex(m => m.tmdb_id === id);
      if(i !== -1) E.MOVIES.splice(i, 1);
    });
    E.invalidateComputeCaches();
  }
}

test("AC1a: agent created 1 day ago, 77 films all found on its creation day — perMonth is null, not an extrapolated rate", () => withCase(ids => {
  const c = broadCascade("cas1145-1a", { year: [YEAR_SENTINEL] });
  c.created_at = daysBeforeToday(1);
  ids.push(...plantFinds(77, 1));

  const m = E.agentMetricsCompute(c);

  assert.equal(m.total, 77);
  assert.equal(m.perMonth, null, "AC1a: under a week old must print no rate at all");
  assert.equal(m.lastFind, daysBeforeToday(1));
  assert.equal(m.recentCount, 77);
}));

test("AC1b: agent created 10 days ago, 50 found on creation day and 5 found 3 days ago — perMonth counts only the 5", () => withCase(ids => {
  const c = broadCascade("cas1145-1b", { year: [YEAR_SENTINEL] });
  c.created_at = daysBeforeToday(10);
  ids.push(...plantFinds(50, 10));   // on born day — the back-catalogue fill, excluded
  ids.push(...plantFinds(5, 3));     // after born — genuinely new

  const m = E.agentMetricsCompute(c);

  assert.equal(m.total, 55);
  assert.equal(m.perMonth, 15, "AC1b: (5 / min(30,10)) * 30 = 15");
  assert.equal(m.lastFind, daysBeforeToday(3));
  assert.equal(m.recentCount, 55);
}));

test("AC1c: agent created 60 days ago, 4 found within the last 30 days and 20 found before that — perMonth counts only the 4", () => withCase(ids => {
  const c = broadCascade("cas1145-1c", { year: [YEAR_SENTINEL] });
  c.created_at = daysBeforeToday(60);
  ids.push(...plantFinds(4, 10));    // after born, within AGENT_NEW_TREND_DAYS
  ids.push(...plantFinds(20, 45));   // after born too, but outside the 30-day trend window

  const m = E.agentMetricsCompute(c);

  assert.equal(m.total, 24);
  assert.equal(m.perMonth, 4, "AC1c: (4 / min(30,60)) * 30 = 4");
  assert.equal(m.lastFind, daysBeforeToday(10));
  assert.equal(m.recentCount, 4, "AC1c: only the 4 recent finds fall inside NEW_DAYS");
}));

test("AC1d: agent with no created_at, oldest find 10 days ago (40 films) and 2 found yesterday — born falls back to oldestFound", () => withCase(ids => {
  const c = broadCascade("cas1145-1d", { year: [YEAR_SENTINEL] });   // no created_at at all
  ids.push(...plantFinds(40, 10));   // oldestFound day — becomes `born`, so excluded
  ids.push(...plantFinds(2, 1));     // after born

  const m = E.agentMetricsCompute(c);

  assert.equal(m.total, 42);
  assert.equal(m.perMonth, 6, "AC1d: (2 / min(30,10)) * 30 = 6");
  assert.equal(m.lastFind, daysBeforeToday(1));
  assert.equal(m.recentCount, 42);
}));

test("AC1e: agent created 10 days ago with no finds after its creation day — perMonth is 0, not null", () => withCase(ids => {
  const c = broadCascade("cas1145-1e", { year: [YEAR_SENTINEL] });
  c.created_at = daysBeforeToday(10);
  ids.push(...plantFinds(8, 10));   // all on born day — none after

  const m = E.agentMetricsCompute(c);

  assert.equal(m.total, 8);
  assert.equal(m.perMonth, 0, "AC1e: zero finds after born must print 0, not null — the agent is old enough to measure");
  assert.equal(m.lastFind, daysBeforeToday(10));
  assert.equal(m.recentCount, 8);
}));
