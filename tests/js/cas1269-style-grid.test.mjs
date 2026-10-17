// CAS-1269 AC4: styleGridFlags() — the Style screen's suggestions-panel/cell-ring flag rule (rule 7). A
// pair is STRONG when its taste carries n>=3 verdicts and |lean|>=0.3, and FLAGGED when that taste leans
// one way but the agent's own setting (or, for a pair with no own setting, its derived effective state)
// says the other. Drives the real shipped engine (tests/js/engine.mjs's loadEngine(), reading the BUILT
// index.html) directly, never a re-derivation of tasteProfile's/styleGridState's rules.
// CAS-1282: a whole (primary) style never flags any more, however strong the disagreement — only a
// combination (pair) of two styles does. Which whole styles an agent lists stays the person's own choice.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

let _nextFixtureId = 910001;
// Pushes fixture films into MOVIES and gives each an exact verdict, with the real verdict sets emptied for
// the run and restored afterward — same isolation technique as cas1251-taste-profile.test.mjs's own
// withTasteFixture.
function withTasteFixture(assignments, fn){
  const saved = {
    watched: new Set(E.watched), disliked: new Set(E.disliked), indifferent: new Set(E.indifferent),
    wowed: new Set(E.wowed), enjoyed: new Set(E.enjoyed), blocked: new Set(E.blocked),
  };
  E.watched.clear(); E.disliked.clear(); E.indifferent.clear(); E.wowed.clear(); E.enjoyed.clear(); E.blocked.clear();
  const films = assignments.map(([genres]) => {
    const id = _nextFixtureId++;
    return { tmdb_id: id, title: `Grid fixture ${id}`, genres, status: ["included_streaming"] };
  });
  films.forEach(m => E.MOVIES.push(m));
  assignments.forEach(([, kind], i) => {
    const m = films[i];
    if(kind === "notfor"){ E.blocked.add(m.tmdb_id); return; }
    E.watched.add(m.tmdb_id);
    if(kind === "disliked") E.disliked.add(m.tmdb_id);
    if(kind === "soso") E.indifferent.add(m.tmdb_id);
    if(kind === "wow") E.wowed.add(m.tmdb_id);
    if(kind === "enjoyed") E.enjoyed.add(m.tmdb_id);
  });
  E.invalidateComputeCaches();
  try{ return fn(); }
  finally{
    films.forEach(m => { const i = E.MOVIES.indexOf(m); if(i !== -1) E.MOVIES.splice(i, 1); });
    E.watched.clear(); saved.watched.forEach(id => E.watched.add(id));
    E.disliked.clear(); saved.disliked.forEach(id => E.disliked.add(id));
    E.indifferent.clear(); saved.indifferent.forEach(id => E.indifferent.add(id));
    E.wowed.clear(); saved.wowed.forEach(id => E.wowed.add(id));
    E.enjoyed.clear(); saved.enjoyed.forEach(id => E.enjoyed.add(id));
    E.blocked.clear(); saved.blocked.forEach(id => E.blocked.add(id));
    E.invalidateComputeCaches();
  }
}

// Horror: 3 Never (strongly negative, strong) — agent lists it explicitly, so it's flagged "- Skip".
// Comedy+Family: 3 Wow each (strongly positive, strong) — agent lists neither style, so the pair's
// derived effective state is "not listed" and it's flagged "+ List" (same for each style alone).
// Action+Thriller: 2 Never only — strongly negative taste, but n=2 is below the n>=3 strong floor, so
// neither the pair nor either style may flag no matter what the agent's own setting says.
function fixtureAssignments(){
  return [
    [["Horror"], "notfor"], [["Horror"], "notfor"], [["Horror"], "notfor"],
    [["Comedy","Family"], "wow"], [["Comedy","Family"], "wow"], [["Comedy","Family"], "wow"],
    [["Action","Thriller"], "notfor"], [["Action","Thriller"], "notfor"],
  ];
}
function agentWith(overrides){
  return E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 0, premium: null, rent: 0, stream: 0 }, ...overrides });
}
const find = (flags, kind, a, b) => flags.find(f => f.kind === kind && f.a === a && f.b === (b ?? null));

test("CAS-1282: a whole style never flags, however strong the disagreement", () => {
  withTasteFixture(fixtureAssignments(), () => {
    // Horror: listed, taste strongly against (3 Never) — the exact shape rule 7 used to flag "- Skip"
    // for the style alone. It must now be silent, and no flag of kind "style" may exist at all.
    const c = agentWith({ genre: ["Action", "Horror"] });
    const flags = E.styleGridFlags(c);
    assert.equal(find(flags, "style", "Horror"), undefined);
    assert.ok(flags.every(f => f.kind !== "style"), "no flag may have kind \"style\"");
  });
});

test("CAS-1269 AC4: a strong pair flag — not listed (derived), taste strongly for", () => {
  withTasteFixture(fixtureAssignments(), () => {
    const c = agentWith({ genre: ["Action", "Horror"] });
    const flags = E.styleGridFlags(c);
    const f = find(flags, "pair", "Comedy", "Family");
    assert.ok(f, "Comedy+Family must be flagged");
    assert.equal(f.want, "+");
    assert.equal(f.n, 3);
    assert.ok(f.lean > 0.3);
  });
});

test("CAS-1269 AC4: a non-strong pair (n=2) never flags, whatever the agent's own setting", () => {
  withTasteFixture(fixtureAssignments(), () => {
    // Action listed, Thriller not — the pair's derived effective state is "listed" and the taste leans
    // strongly against, exactly the shape rule 7 flags at n>=3. At n=2 it must stay silent regardless.
    const listing = agentWith({ genre: ["Action"] });
    assert.equal(find(E.styleGridFlags(listing), "pair", "Action", "Thriller"), undefined);
    assert.equal(find(E.styleGridFlags(listing), "style", "Action"), undefined);
    assert.equal(find(E.styleGridFlags(listing), "style", "Thriller"), undefined);
    // And explicitly skipping the pair outright changes nothing either — still silent at n=2.
    const skipping = agentWith({ pairs: { "Action|Thriller": "-" } });
    assert.equal(find(E.styleGridFlags(skipping), "pair", "Action", "Thriller"), undefined);
  });
});

test("CAS-1269 AC4: an own pair setting beats the derived one for the flag rule", () => {
  withTasteFixture(fixtureAssignments(), () => {
    // Comedy/Family both unlisted (derived "not listed"), but the pair itself is explicitly listed — no
    // disagreement left to flag for the PAIR.
    const c = agentWith({ genre: ["Action", "Horror"], pairs: { "Comedy|Family": "+" } });
    const flags = E.styleGridFlags(c);
    assert.equal(find(flags, "pair", "Comedy", "Family"), undefined);
  });
});

test("CAS-1269 AC4: flags are ordered strongest disagreement first (|lean| x conf)", () => {
  withTasteFixture(fixtureAssignments(), () => {
    const c = agentWith({ genre: ["Action", "Horror"] });
    const flags = E.styleGridFlags(c);
    for(let i = 1; i < flags.length; i++){
      const prev = Math.abs(flags[i-1].lean) * flags[i-1].conf;
      const cur = Math.abs(flags[i].lean) * flags[i].conf;
      assert.ok(prev >= cur, `flag ${i-1} (${prev}) must not be weaker than flag ${i} (${cur})`);
    }
  });
});
