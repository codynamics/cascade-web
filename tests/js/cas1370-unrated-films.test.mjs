// CAS-1370: most films carry no age_rating at all (63-80% across every status), so a mood with ages set was
// silently dropping almost everything, including Avengers: Doomsday from Releases → Upcoming. Three fixes:
// 1. oamFilmMeetsMoodRules/oamFilmMeetsReleasesRules's own ages gate now only ever excludes a film it can
//    actually rate — an unrated film always passes, in every mood including Family.
// 2. cardTopHTML shows "Not rated" where the certificate normally sits, so people can judge for themselves.
// 3. oamWilCase ("Where it lists") no longer blames a ticked genre when the true reason a mood excludes the
//    film is its own ages/awards/years gate.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function criteriaWith(style, bar){
  return { id:"cas1370-fixture", name:"Agent", v:2,
    styles:{ [style]: { bar, al:{cinema:false,rent:false,stream:false} } }, combo:{} };
}
function moodWith(overrides){
  return { ...E.oamMoodDefaultFields(), id:"t-cas1370-mood", name:"Test mood", ...overrides };
}
let _nextId = 91700001;
function filmWith(overrides){
  return { tmdb_id:_nextId++, title:"CAS-1370 fixture", genres:["Action"], status:["included_streaming"],
    wm_critic_score:null, wm_user_rating:9, _fixture:true, availability_confidence:"confirmed",
    offers:[{service:"Amazon Prime Video", type:"sub", price:null, format:null}],
    cinema_release:true, cinema_date:E.TODAY, ...overrides };
}

test("CAS-1370: oamFilmAge is null for an unrated film, the canonical rating otherwise", () => {
  assert.equal(E.oamFilmAge(filmWith({ age_rating:null })), null);
  assert.equal(E.oamFilmAge(filmWith({ age_rating:"MA15+" })), "MA 15+");
  assert.equal(E.oamFilmAge(filmWith({ age_rating:"M" })), "M");
});

test("CAS-1370 AC2: an ordinary mood's ages gate admits an unrated film but still excludes a rated film outside it", () => {
  const c = criteriaWith("Action", 1);
  const mood = moodWith({ ages:["M"] });
  assert.equal(E.oamFilmMeetsMoodRules(filmWith({ age_rating:null }), mood, c), true,
    "unrated must pass, not be assumed unsuitable");
  assert.equal(E.oamFilmMeetsMoodRules(filmWith({ age_rating:"R 18+" }), mood, c), false,
    "a real rating outside the mood's ages is still excluded");
  assert.equal(E.oamFilmMeetsMoodRules(filmWith({ age_rating:"M" }), mood, c), true);
});

test("CAS-1370 AC1: Releases' own ages gate admits an unrated film too (the actual Doomsday bug)", () => {
  const c = criteriaWith("Science Fiction", 1);
  const releases = { ...E.oamMoodDefaultFields(), id:"releases", name:"Releases",
    ages:["M","MA 15+","R 18+","PG"] };
  const doomsday = filmWith({ genres:["Science Fiction"], age_rating:null, status:["upcoming"] });
  assert.equal(E.oamFilmMeetsReleasesRules(doomsday, releases, c), true);
  assert.equal(E.filmInOneAgentMood(doomsday, releases, c), true);
  const rated = filmWith({ genres:["Science Fiction"], age_rating:"X", status:["upcoming"] });
  assert.equal(E.oamFilmMeetsReleasesRules(rated, releases, c), false,
    "sanity: a real, non-matching rating is still excluded by this same gate");
});

test("CAS-1370 AC2: the card shows \"Not rated\" instead of silently dropping the certificate", () => {
  const unrated = E.cardTopHTML(filmWith({ age_rating:null }));
  assert.match(unrated, /<span class="cert unrated">Not rated<\/span>/);
  const rated = E.cardTopHTML(filmWith({ age_rating:"M" }));
  assert.match(rated, /<span class="cert ">M<\/span>/);
});

test("CAS-1370 AC4: Find names the real ages mismatch instead of falsely blaming a ticked genre", () => {
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  E.watchMoods.length = 0;
  E.watchMoods.push(moodWith({ name:"Family Night", ages:["PG"] }));   // styles:[] => every on genre ticked
  try{
    const c = criteriaWith("Action", 1);
    const film = filmWith({ age_rating:"MA 15+" });
    assert.equal(E.filmInOneAgentMood(film, E.watchMoods[0], c), false, "sanity: excluded by this mood's own rules");
    const r = E.oamWilCase(film, c);
    assert.match(r.sentence, /Not shown in Family Night:/);
    assert.match(r.sentence, /it's rated MA 15\+ and this mood shows PG/);
    assert.doesNotMatch(r.sentence, /none of your moods include/,
      "must never fall through to the generic genre-missing claim when the genre IS ticked");
  } finally {
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
  }
});

test("CAS-1370 AC4: Find still uses the generic genre-missing reason when no mood has the genre ticked at all", () => {
  const savedMoods = [...E.watchMoods].map(m => ({ ...m }));
  E.watchMoods.length = 0;
  E.watchMoods.push(moodWith({ name:"Comedies only", styles:["Comedy"] }));
  try{
    const c = criteriaWith("Action", 1);
    const film = filmWith({ age_rating:"M" });
    const r = E.oamWilCase(film, c);
    assert.match(r.sentence, /none of your moods include/);
  } finally {
    E.watchMoods.length = 0; E.watchMoods.push(...savedMoods);
  }
});
