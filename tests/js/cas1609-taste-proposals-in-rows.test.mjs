// CAS-1609: the agent's proposals are marked inside the open genre's sub-genre rows (a gold .prop step + value),
// with a Skip / Apply legend (.oaprop) in place of the old "Recent recommendations" box (.oalog).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function ratingForScore(target){
  let lo = 0, hi = 100;
  for(let i = 0; i < 60; i++){ const mid = (lo + hi) / 2; if(Math.round(E.wmScaled(mid)) < target) lo = mid; else hi = mid; }
  let v = hi;
  for(let i = 0; i < 2000 && Math.round(E.wmScaled((v/10)*10)) !== target; i++) v += 0.01;
  return v / 10;
}
let _id = 91609001;
function scoredFilm(genres, score){
  const id = _id++;
  const m = { tmdb_id:id, title:`CAS-1609 fixture ${id}`, genres, status:["included_streaming"],
    wm_critic_score:null, wm_user_rating: ratingForScore(score), _fixture:true, availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}] };
  if(E.cascadeScore(m) !== score) throw new Error("fixture setup: score mismatch");
  return m;
}
const SETS = ["watched","disliked","indifferent","wowed","enjoyed","blocked"];
const agent = () => ({ id:"cas1609", name:"Pixel", v:2, combo:{}, seenAdj:{}, dismissed:[],
  styles:{ "Science Fiction": {bar:60, al:{cinema:false,rent:false,stream:false}} } });
const dislike = () => { const m = scoredFilm(["Science Fiction","Thriller"], 50); E.MOVIES.push(m); E.watched.add(m.tmdb_id); E.disliked.add(m.tmdb_id); return m; };

test("CAS-1609: a pending proposal shows a legend and one gold step; the old log box is gone", () => {
  const saved = {}; SETS.forEach(k => { saved[k] = new Set(E[k]); E[k].clear(); });
  const savedAgents = [...E.cascades];
  const films = [];
  try{
    const c = agent(); E.cascades.length = 0; E.cascades.push(c);
    films.push(dislike(), dislike());
    E.invalidateComputeCaches();
    E.tasteSeedApplied(c);
    for(let i = 0; i < 4; i++) films.push(dislike());
    E.invalidateComputeCaches();
    const rec = E.tasteRecs().find(r => r.style === "Science Fiction");
    assert.ok(rec, "a pending proposal exists");
    const html = E.oaAdjustSectionHTML(c, "Science Fiction");
    assert.ok(html.includes('class="oaprop"'), "legend rendered");
    assert.ok(html.includes("tasteApply('Science Fiction')") && html.includes("tasteSkip('Science Fiction')"));
    assert.ok(!html.includes('class="oalog"'), "recent recommendations box not rendered");
    const row = E.oaComboRowHTML(c, "Science Fiction", E.oaComboStats(c, "Science Fiction").find(r => r.key === rec.keys[0].key), rec.keys[0]);
    assert.equal((row.match(/oacstep[^"]*\bprop\b/g) || []).length, 1, "exactly one proposed step");
    assert.ok(row.includes('class="oacval prop"'));
    // no proposal -> no legend
    E.tasteSkip("Science Fiction");
    assert.ok(!E.oaAdjustSectionHTML(c, "Science Fiction").includes('class="oaprop"'));
  } finally {
    films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); });
    SETS.forEach(k => { E[k].clear(); saved[k].forEach(id => E[k].add(id)); });
    E.cascades.length = 0; savedAgents.forEach(a => E.cascades.push(a));
    E.invalidateComputeCaches();
  }
});
