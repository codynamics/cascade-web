// CAS-1592: monitor/tasteline_shim.mjs answers the alert email's taste line with the APP's own decision.
// The member's verdicts are built from the shipped catalogue, searching for a split that gives the adjustment
// each case needs (so a catalogue refresh cannot hard-code the test into a corner).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
E.CascadePersistence.accountActive = () => true;
const SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "monitor", "tasteline_shim.mjs");

const byPair = {};
E.MOVIES.filter(m => m.genres && new Set(m.genres).size >= 2).forEach(m => {
  const k = [...new Set(m.genres)].sort().slice(0, 2).join("|");
  (byPair[k] = byPair[k] || []).push(m.tmdb_id);
});
const [bigA, bigB] = Object.values(byPair).sort((x, y) => y.length - x.length);
const rowsFor = (a, b) => [
  ...bigA.slice(0, a).map(id => ({ movie_id: String(id), status: "wow" })),
  ...bigB.slice(0, b).map(id => ({ movie_id: String(id), status: "enjoyed" }))];
const appSays = rows => { E.CascadePersistence.applyFilmRows(rows); return { n: E.rnudgeRatingsCount(), adj: E.rnudgeBestAdjustment() }; };
function find(total, pred){
  for(let a = 0; a <= total; a++){
    const rows = rowsFor(a, total - a), r = appSays(rows);
    if(r.n === total && pred(r.adj)) return { rows, adj: r.adj };
  }
  throw new Error("no split of the catalogue gives the wanted adjustment");
}
function shim(rows){
  const p = spawnSync("node", [SHIM], { input: JSON.stringify({ users: [{ userId: "u1", filmStatuses: rows }] }), encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  return JSON.parse(p.stdout).u1;
}

test("9 ratings: no line, however strong the adjustment", () => {
  const rows = rowsFor(4, 5);
  assert.equal(appSays(rows).n, 9);
  assert.equal(shim(rows).text, null);
});
test("10 ratings and a best adjustment of 4: no line", () => {
  const { rows } = find(10, adj => adj && Math.abs(adj.pts) === 4);
  const out = shim(rows);
  assert.equal(out.ratings, 10);
  assert.equal(out.text, null);
});
test("10 ratings and a 5+ adjustment: the line is exactly the app's own text", () => {
  const { rows, adj } = find(10, a => a && a.pts >= 5);
  assert.ok(adj.text.length > 0);
  assert.equal(shim(rows).text, adj.text);
  assert.equal(shim(rows).pts, adj.pts);
});
