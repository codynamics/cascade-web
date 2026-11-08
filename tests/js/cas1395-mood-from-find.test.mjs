// CAS-1395: Find's "Save as mood" — a new mood pre-filled from Find's current search and service, with a
// sheet line reporting how many of Find's own result set the new mood will actually include. Each moving
// part (the prefill, the live count and the button's own visibility) is a small pure helper, asserted
// directly here rather than through the sheet's DOM, which the engine harness's stub swallows.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1395-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"cas1395-mood", name:"Test mood", ...overrides };
}
let _nextId = 91950001;
function film(style, overrides){
  return { tmdb_id:_nextId++, title:"CAS-1395 fixture", genres:[style], status:["included_streaming"],
    wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
    cast:[], director:"",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}], ...overrides };
}

test("CAS-1395 AC1a: the prefill helper carries the search text and service straight through, with a matching name", () => {
  const fields = E.oamFindPrefillFields("Tom Cruise, Russo", "Netflix");
  assert.equal(fields.people, "Tom Cruise, Russo");
  assert.equal(fields.svc, "Netflix");
  assert.equal(fields.name, "Tom Cruise, Russo");
  assert.equal(fields.watched, false);
});

test("CAS-1395 AC1b: a search longer than 24 characters is cut to exactly 24 for the name", () => {
  const search = "123456789012345678901234567890"; // 30 chars
  assert.equal(search.length, 30);
  const fields = E.oamFindPrefillFields(search, null);
  assert.equal(fields.name.length, 24);
});

test("CAS-1395 AC1b: with no search text, the name falls back to the service's own display label", () => {
  const fields = E.oamFindPrefillFields("", "Netflix");
  assert.equal(fields.people, "");
  assert.equal(fields.name, E.oamSvcChipLabel("Netflix"));
});

test("CAS-1395 AC1c: the count helper counts only films the mood actually admits, never more than the list", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ people:"Tom Cruise" });
  const withHim = film("Action", { cast:["Tom Cruise"] });
  const withoutHim = film("Action", { cast:["Someone Else"] });
  const list = [withHim, withoutHim];
  const n = E.oamFromFindCount(list, mood, c);
  assert.equal(n, 1);
  assert.ok(n <= list.length);
});

test("CAS-1395 AC1c: a hand-added film still counts even when it fails the mood's own rules", () => {
  const c = criteriaWith("Action", 1);
  const m = film("Action", { cast:["Someone Else"] });
  const mood = moodWith({ people:"Nolan", in:[m.tmdb_id] });
  const n = E.oamFromFindCount([m], mood, c);
  assert.equal(n, 1);
});

test("CAS-1395 AC1d: the visibility helper", () => {
  const c = criteriaWith("Action", 1);
  assert.equal(E.findSaveAsMoodVisible(c, "tom cruise", null, {id:"x", name:"X"}, 1), false,
    "a Series filter hides it");
  assert.equal(E.findSaveAsMoodVisible(c, "", null, null, 1), false,
    "no search and no service hides it");
  assert.equal(E.findSaveAsMoodVisible(c, "tom cruise", null, null, E.MOOD_MAX), false,
    "a full mood row hides it");
  assert.equal(E.findSaveAsMoodVisible(c, "tom cruise", null, null, 1), true,
    "sanity: otherwise it shows");
  assert.equal(E.findSaveAsMoodVisible(null, "tom cruise", null, null, 1), false,
    "sanity: no v2 agent hides it");
  assert.equal(E.findSaveAsMoodVisible(c, "", "Netflix", null, 1), true,
    "a service alone, with no search text, still shows it");
});
