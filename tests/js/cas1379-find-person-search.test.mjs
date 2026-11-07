// CAS-1379: Find's search box matched title only, so a named actor or director returned 0 movies even
// though every film already carries director/cast (poc_pipeline.py). filmMatchesSearch is the one shared
// matcher findSortedRows (Find) and the listing's own filt.search test both now call — asserted here
// directly against the real built catalogue, the same convention cas1180's watchSearchRows test uses.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

test("CAS-1379 AC1a: query 'tom hanks' returns exactly the films carrying him in cast", () => {
  const expected = E.MOVIES.filter(m => (m.cast || []).some(c => c.toLowerCase() === "tom hanks"));
  assert.ok(expected.length >= 1, "setup: the catalogue must have at least one Tom Hanks film");
  const matched = E.MOVIES.filter(m => E.filmMatchesSearch(m, "tom hanks"));
  matched.forEach(m => assert.ok((m.cast || []).some(c => c.toLowerCase() === "tom hanks"),
    `${m.title} was returned for "tom hanks" but does not carry him in cast`));
  assert.equal(matched.length, expected.length, "AC1a: the matched set must equal the cast-carrying set");
});

test("CAS-1379 AC1b: a director's own name, lowercased, returns a film they directed", () => {
  const donor = E.MOVIES.find(m => m.director && m.director.trim());
  assert.ok(donor, "setup: need a catalogue film with a director");
  const q = donor.director.toLowerCase();
  const matched = E.MOVIES.filter(m => E.filmMatchesSearch(m, q));
  assert.ok(matched.some(m => m.tmdb_id === donor.tmdb_id),
    `AC1b: querying "${q}" must return ${donor.title}`);
});

test("CAS-1379 AC1c: a query matching only the title still returns that film", () => {
  const donor = E.MOVIES.find(m => m.title && m.title.trim().length > 3);
  assert.ok(donor, "setup: need a catalogue film with a title");
  const q = donor.title.toLowerCase();
  assert.ok(E.filmMatchesSearch(donor, q), `AC1c: querying the film's own title must return it`);
});

test("CAS-1379 AC1d: a diacritic name matches its ASCII-folded query", (t) => {
  let targetFilm = null, targetName = null;
  for (const m of E.MOVIES) {
    const hit = (m.cast || []).find(c => /[^\x00-\x7F]/.test(c));
    if (hit) { targetFilm = m; targetName = hit; break; }
  }
  if (!targetFilm) { t.skip("no catalogue cast name contains a non-ASCII letter"); return; }
  const asciiQuery = targetName.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  assert.ok(E.filmMatchesSearch(targetFilm, asciiQuery),
    `AC1d: ASCII-folded query "${asciiQuery}" must still match ${targetFilm.title} (cast: "${targetName}")`);
});

test("CAS-1379 AC1e: a film with no director and no cast never throws", () => {
  const film = { title: "No Credits Film", director: null, cast: [] };
  assert.doesNotThrow(() => E.filmMatchesSearch(film, "anything"));
  assert.equal(E.filmMatchesSearch(film, "anything"), false);
  assert.equal(E.filmMatchesSearch(film, ""), true, "an empty query still matches everything");
});
