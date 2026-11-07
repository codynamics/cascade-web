// CAS-1382: the card's "Series" row (credit-row builder) and Find's collection-mode listing both key off
// a film's collection.id (CAS-1381's backfill) — this asserts the two pieces of the ticket directly: the
// release-order member list (collectionFilmsSorted, shared by Find's findSortedRows branch) and the
// credit-row HTML's Series row gate (creditsHTML), the same clone-a-real-donor fixture technique
// cas1180's plantFilm uses so every incidental field another predicate reads stays valid.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

// The engine runs in its own vm realm — an array it hands back is a real Array by content but not by
// [[Prototype]], so assert.deepStrictEqual (what the "strict" assert's .deepEqual actually is) fails on two
// arrays that print identically. Spreading pulls the values into a plain array of THIS realm first, the
// same convention agents-placement.test.mjs's own `arr` helper uses.
const arr = a => [...(a || [])];

const SAGA = { id: 999001, name: "Test Saga Collection" };
const UNIQUE = { id: 999002, name: "Lone Entry Collection" };

let cloneSeq = 0;
function plantFilm(overrides){
  const donor = E.MOVIES.find(m => m.director && (m.cast || []).length);
  assert.ok(donor, "setup: need a catalogue film with director+cast to clone");
  cloneSeq++;
  const film = { ...donor, tmdb_id: -1382000000 - cloneSeq, ...overrides };
  E.MOVIES.push(film);
  return film;
}
function unplantFilm(film){
  const i = E.MOVIES.indexOf(film);
  if (i !== -1) E.MOVIES.splice(i, 1);
}

test("CAS-1382 AC1a: collection-mode row list returns exactly the saga's films, oldest release first", (t) => {
  const f2005 = plantFilm({ title: "Saga Two", year: 2005, collection: SAGA });
  const f1999 = plantFilm({ title: "Saga One", year: 1999, collection: SAGA });
  const f2015 = plantFilm({ title: "Saga Three", year: 2015, collection: SAGA });
  const other = plantFilm({ title: "Elsewhere", year: 2010, collection: UNIQUE });
  t.after(() => [f2005, f1999, f2015, other].forEach(unplantFilm));

  const rows = E.collectionFilmsSorted(SAGA.id);
  assert.deepEqual(arr(rows.map(m => m.year)), [1999, 2005, 2015],
    "AC1a: must return exactly the three saga films, ordered 1999, 2005, 2015");
  assert.ok(!rows.some(m => m.collection.id === UNIQUE.id), "AC1a: must not include the unrelated collection's film");
});

test("CAS-1382 AC1b: a saga film's credit-row HTML shows Series with the Collection suffix dropped", (t) => {
  const f1 = plantFilm({ title: "Saga One", year: 1999, collection: SAGA });
  const f2 = plantFilm({ title: "Saga Two", year: 2005, collection: SAGA });
  t.after(() => [f1, f2].forEach(unplantFilm));

  const html = E.creditsHTML(f1, false);
  assert.ok(html.includes("Series"), "AC1b: credit-row HTML must contain the Series label");
  assert.ok(html.includes("Test Saga"), "AC1b: credit-row HTML must contain the collection name with the suffix dropped");
  assert.ok(!html.includes("Test Saga Collection"), "AC1b: credit-row HTML must not contain the raw collection name");
});

test("CAS-1382 AC1c: a lone-member collection and a null collection never show Series", (t) => {
  const lone = plantFilm({ title: "Elsewhere", year: 2010, collection: UNIQUE });
  const none = plantFilm({ title: "Standalone", year: 2012, collection: null });
  t.after(() => [lone, none].forEach(unplantFilm));

  assert.ok(!E.creditsHTML(lone, false).includes("Series"),
    "AC1c: a collection with only one film Cascade holds must not show Series");
  assert.ok(!E.creditsHTML(none, false).includes("Series"),
    "AC1c: a film with collection:null must not show Series");
});
